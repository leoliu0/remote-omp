# Plan 65 — Send files to the phone, and know when the user is on it

Status: approved 2026-10-20; steps 1–4 dispatched to `pi-extension/` and `app/`. Targets `pi-extension/` and `app/`. The relay does not change.

## Context

The user asked for two things on 2026-10-19:

1. The agent on the PC can send a file (APK, PDF, zip, log, image) to the phone over the relay. The trigger was installing a 33 MB APK on the phone while away from the PC.
2. The agent knows when the user is on the phone, so it delivers finished files there instead of naming a path on a PC the user cannot see.

What exists today (scout reports, 2026-10-19):

- **Relay:** only frames with `ct` ≤ 4 MiB decoded pass (`relay/src/protocol/outer.rs:25`, env `RELAY_MAX_CT_MIB`). Bigger frames are dropped silently (`relay/src/handlers/peer.rs:361`). There is no backpressure (`unbounded_channel`, `peer.rs:148`), and frames for an offline peer are dropped (`peers/registry.rs:260`). There is no blob endpoint. rp-s3 accepts only manifests.
- **Extension:** frames are NDJSON. `PlainPeerChannel.send` base64-encodes the JSON into `ct` (`transport/peer_channel.ts:62`), so base64 data inside a frame grows about 1.78× on the wire. Tool images ride inline in the `tool_result` string with no cap. Phone-to-PC images are capped at 10 MiB (`index.ts:205`). Tools are registered with `pi.registerTool` (`session/tools.ts`, `session/ask_tool.ts:211`). Online peers are tracked in `_activePeers` (`index.ts:2040`). New frame types must go into `SERVER_TYPES` (`protocol/codec.ts`).
- **App:** tool images are stored as base64 inside `messages.payload_json` in SQLite. The app has no `share_plus` or `open_filex`, no FileProvider, and no `REQUEST_INSTALL_PACKAGES` permission. The update banner sends APK downloads to the browser through `url_launcher`. `minSdk` is 34.

## Design

**Transport: chunked frames over the existing peer channel.** Each chunk carries 1 MiB of raw data, about 1.8 MiB in `ct`, which stays well under the relay's 4 MiB cap. All frames go to one target phone.

| Frame | Direction | Fields |
|---|---|---|
| `file_offer` | ext → app | `file_id`, `name`, `mime`, `size`, `sha256`, `caption?`, `turn_id?` |
| `file_chunk` | ext → app | `file_id`, `seq`, `data` (base64) |
| `file_end` | ext → app | `file_id`, `chunks` |
| `file_ack` | app → ext | `file_id`, `next_seq` (cumulative) |
| `file_done` / `file_error` | app → ext | `file_id`, `reason?` (`sha_mismatch`, `no_space`, `cancelled`) |
| `file_cancel` | either | `file_id` |

- **Flow control:** the sender keeps at most 4 chunks in flight beyond the last `file_ack`. The relay has no backpressure, so the sender must pace itself.
- **Resume:** if the phone drops and reconnects within 10 minutes, it sends `file_ack` with its `next_seq` and the sender continues from there. After that the transfer fails, and the tool reports it.
- **Cap:** 256 MiB per file, set by `REMOTE_PI_MAX_SEND_MIB`.
- **Target phone:** the phone that sent the latest user input. If that phone is offline, the target is the only other online phone. If no phone is online, the tool fails with `phone_offline` and the agent says so. Nothing is queued.

**Agent tool `send_to_phone({ path, caption? })`.** It checks that the file exists, is a regular file and is under the cap. It returns when the app sends `file_done`, with `{name, size, device}`, or when the transfer fails. The transfer is cancelled on abort. The tool description tells the agent to use it for finished files the user should open on the phone, not for files the agent is still working on.

**Knowing the user is on the phone.** The extension records where the latest input came from: `phone:<device>` when `routeClientMessage` handles a `user_input`, `terminal` when `pi.on("input")` fires with a non-extension source. While the source is `phone` and that phone is online, the `context` hook appends one short note to the request: *"The user is on Remote Pi (phone app or web) and cannot see this PC's screen or files. To show an image, `read` the image file: it appears in their chat. Use `send_to_phone` only when the user asks for a file on their phone."* (Revised 2026-10-21: the first wording made the agent send pictures it should show, and web input counts as the phone because the web signs in with the phone's owner key.) The note changes only when the source changes, so it does not break prompt caching on every turn. Terminal input removes the note.

**App.**

- Chunks stream into `filesDir/received/<file_id>/<name>.part`. The file is renamed after its SHA-256 matches. Only metadata and the path go into SQLite, never the bytes.
- The chat shows a file card with name, size, a progress bar during transfer and the caption. Actions are Open (`open_filex` through a FileProvider), Share (`share_plus`) and Save to Downloads (MediaStore, which needs no permission on API 34).
- APKs also get **Install**: `REQUEST_INSTALL_PACKAGES` plus `ACTION_VIEW` through the FileProvider. Android's own confirmation always runs, and nothing opens or installs without a tap.
- Received files can be cleared in Settings → Storage.

## Steps with acceptance criteria

### 1. Protocol frames — `pi-extension/` + `app/`
- Add the six frame types to `protocol/types.ts`, `codec.ts` `SERVER_TYPES`/client types and `app/lib/protocol/protocol.dart`.
- Acceptance: TS and Dart codec round-trip tests for each frame; an unknown `file_*` field is ignored, not fatal.

### 2. Sender and `send_to_phone` — `pi-extension/`
- New `session/send_file.ts`: chunker, in-flight window, ack handling, resume window, cancel on abort, target-phone choice.
- Acceptance (unit, fake channel): a 5 MiB file arrives as 5 chunks with the right SHA; the window never exceeds 4 unacked; a reconnect with `next_seq=3` resumes at 3; no online phone → `phone_offline`; a missing path, directory or file over the cap is rejected before any frame is sent; abort sends `file_cancel`.

### 3. Phone-presence note — `pi-extension/`
- Track the latest input source and add the `context` note.
- Acceptance: input from the phone adds the note to the next request; terminal input removes it; the note is identical across turns while the source is unchanged; a disconnected phone removes it.

### 4. Receiver and file card — `app/`
- Add `share_plus`, `open_filex`, the FileProvider (`res/xml/file_paths.xml`), `REQUEST_INSTALL_PACKAGES`, a receiver service that writes `.part` files, a SQLite record and a `FileCard` widget.
- Acceptance (tests): out-of-order or duplicate chunks are handled; a SHA mismatch deletes the file and sends `file_error`; low disk space sends `no_space`; the card shows progress → done → actions; an APK card shows Install and a PDF card does not; restarting the app keeps finished cards and drops `.part` files older than 10 minutes.

### 5. Real-surface check
- Emulator: from a paired omp session, ask the agent to send `README.md`, a 20 MB PDF and the arm64 APK. Screenshot the progress card, the done card, Open (PDF viewer), Share sheet and Install (system prompt).
- Turn emulator networking off halfway through the APK and back on within a minute: the transfer resumes, not restarts.
- Phone (SM-S948B): the same APK install, over mobile data.
- Presence: type on the phone, then ask "build the APK". The agent calls `send_to_phone` without being told to.

## Definition of done

- Steps 1–4 merged with tests; `flutter analyze` and `tsc` clean; extension and app suites green.
- Step 5 screenshots in `review/screens/` and a dated row in `review/TESTING.md`.
- `pi-extension/README.md` documents the tool, the frames and `REMOTE_PI_MAX_SEND_MIB`.

## Risks

- **The app channel is not encrypted** (`peer_channel.ts:9`: "no cipher, no MAC"), although `00-decisions.md` describes the relay as forwarding ciphertext. Files would be readable by whoever runs the relay, the same as chat today. This plan does not fix that. It is a known gap to address separately.
- An agent can push any file to the phone. Mitigations: nothing auto-opens, APK install always goes through Android's prompt, and the card shows the source session.
- Large transfers share the socket with chat. The 4-chunk window keeps chat frames from waiting behind more than about 7 MB.

## Next plans

- Phone → PC files beyond images (plan 30's follow-up), reusing these frames in the other direction.
- Sending to the web client (`site/`) with the same frames.

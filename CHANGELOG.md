# Changelog

All notable changes to Remote OMP (formerly Remote Pi) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the canonical protocol specification, see [PROTOCOL.md](PROTOCOL.md).

---

## [2.0.0] — Remote OMP (unreleased)

Remote Pi is now **Remote OMP** and supports [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)
only. Plans 68 (phone features) and 69 (rename, omp compatibility). The relay wire
protocol is unchanged, so older apps and PCs keep talking to the relay.

### Changed

- **Renamed everywhere.** CLI `remote-omp` (`remote-omp-supervisord`, unit `remote-omp-supervisord.service`, launchd `dev.remoteomp.supervisord`, Windows task `RemoteOmpSupervisor`), npm package and omp plugin `remote-omp`, slash command `/remote-omp` (`/rc` stays), environment `REMOTE_OMP_*` (the old `REMOTE_PI_*` names are not read), data in `~/.omp/remote`, per-folder config `<folder>/.omp/remote-omp/config.json`, extension source `omp-extension/`, repository github.com/leoliu0/remote-omp.
- **Android app** is `work.jacobmoura.remoteomp` "Remote OMP" 2.0.0 (`RemoteOMP.apk`). It installs next to the old app; pair it again.
- **Migration:** the first start copies `~/.pi/remote` (identity, paired devices, settings, daemons, uploads) into `~/.omp/remote` once and leaves the old folder alone for sessions still running the old version; the keyring identity is copied to `dev.remoteomp.omp`; per-folder config is copied from `.pi/remote-pi/`. `remote-omp install` removes the old service.
- **omp only.** Upstream Pi support is gone: no `--harness`, daemons always run omp, the plugin manifest is `omp`, thinking levels follow omp's `/effort` list.
- The scheduled upstream merge workflow is manual-only.

### Added (plan 68)

- **New session from the phone.** Home → a PC's "New session": recent folders, a folder browser, an optional name and "Keep always on". Without it the session ends for good when you quit it; with it the folder becomes a permanent daemon. Refuses a folder that already has a live session; needs `remote-omp install`.
- **Upload any file to the PC.** Attach → File. 256 KiB acknowledged chunks over the relay with progress and Cancel; the file lands in `~/.omp/remote/uploads/<date>/<name>` after size and SHA-256 checks, and its path is added to your message. Cap 256 MiB (`REMOTE_OMP_MAX_UPLOAD_MIB`), 1 GiB of disk kept free (`REMOTE_OMP_UPLOAD_RESERVE_MIB`); a slow uplink is told apart from loss, so it does not resend.
- **`@` file autocomplete** in the composer, ranked from the session folder (`rg`, then `git ls-files`, then a bounded walk).
- **Saved prompts** behind a bookmark in the composer: one tap inserts, save the current text, delete, reorder.
- **Session switcher:** tap the chat title for all sessions, live first, with working/idle state; every session has its own colour, shown in the app bar and on Home.
- **Retry** under a failed turn re-runs it with omp's `retry()`, without sending the prompt twice.
- **Questions one at a time.** A multi-question ask shows one question per page with Back/Next; Submit stays disabled until every question is answered (optional ones have an explicit Skip), and closing with answers asks first.
- The `/` menu lists the commands the PC actually has (omp builtins, extension and prompt commands, skills).

### Fixed on omp (plan 69)

- Plan review: Refine and Save and quit pressed the wrong rows on omp 19; the phone now answers omp's plan review through its API, and the loop badge follows omp's session modes.
- A phone message is echoed as soon as omp accepts it, not after the whole reply (it vanished for ~20 s in daemons).
- Slash commands typed on the phone run as commands, also in daemons (through the supervisor into omp's prompt pipeline); commands omp cannot run there answer `command_unavailable`. Cockpit control frames no longer reach the model, and prompts sent to a busy daemon queue instead of failing.
- A daemon's `ask` with no phone attached is pushed and replayed to the phone and waits up to 30 min (`REMOTE_OMP_ASK_TIMEOUT_MS`); other extensions' dialogs there are cancelled after the same time instead of hanging.
- Model and thinking picks are saved through omp's settings; nothing is written under `~/.pi` or `<folder>/.pi` any more. The model-roles tab works with omp's bundled build.
- omp's intermediate `agent_end` no longer reports the turn done early; data-only notices stay out of the model's context; `/new`, `/clear` and `/resume` on the PC reset the phone's chat; injected prompts no longer replay as your messages; daemon restart and exit shut omp down cleanly.
- A multi-choice answer with typed text now reaches the agent with both.

## [Unreleased] — PC mesh foundation

This release consolidates the work that turned Remote Pi from "phone controls
one Pi" into a **mesh of coding agents** running on multiple machines, with
the phone acting purely as the initial authenticator. Covers plans 23, 24, 25,
and 27 (see [`plan/`](plan/) directory for design history).

### Android storage and synchronization

- Replace active Hive/secure-store metadata persistence with transactional SQLite for saved peers, rooms, finalized history, session indexes, preferences, and drafts. Signing keys remain in the existing native identity store.
- Import legacy data without deleting its source; retain stable message IDs and complete rendering payloads. Runtime presence resets on restart rather than showing stale online state.
- Persist owner-and-configured-relay-scoped membership operations separately from verified snapshots. Conflict reconciliation replays explicit intent, not every cached peer; publication acknowledgment clears only the captured operations.
- Preserve configured-relay routing when legacy peer metadata contains a different relay URL. Cached Home/history remain available offline.
- Reject callbacks from replaced connection attempts. Storage initialization failures have a recovery path instead of silently presenting an empty pairing list.

### Fixed

- `send_to_phone` no longer blocks the agent for 10 minutes when the phone is not connected. It checks the relay's presence for the phone and fails within 20 s if Remote Pi is closed, the phone must acknowledge the file within 30 s, and a transfer that stops making progress for 60 s fails with the percentage received. A phone that drops and returns within 60 s resumes where it stopped, including when it missed the file's announcement.
- `/remote-pi` in a folder with no setup no longer crashes with `t?.trim is not a function`; the setup prompt opens.
- The app now shows images that tools return, such as a `read` of a png or webp, in every tool display mode, as the terminal does. In brief mode the picture sits under the tool pill, and those `read` calls are no longer hidden. With tool calls hidden, only the picture shows. The full card shows the picture instead of its base64 text. The extension already sent the image; only the app changed.
- TeX Guard's patch review now also opens on the app, with the diff, and Yes or No there answers it; whichever of terminal and app answers first wins. Any extension with a terminal-only prompt can do the same through the new `remote-pi:confirm` events (see `pi-extension/README.md`).
- Long confirm messages in the app scroll and render as markdown, so a diff shows as a code block instead of overflowing the screen.
- `ask` with a paired phone connected no longer leaves the terminal without a selector: the native dialog opens alongside the mobile modal and the first answer wins, dismissing the other. Previously the question went only to the phone and the terminal showed it as plain text.
- Mobile prompts now inject directly into the interactive terminal editor and input pipeline (`_tryExecuteTerminalInput`), executing natively as interactive turns or steers instead of bypassing the prompt and steering background subagents.
- Mobile prompts no longer remain queued without starting an idle OMP session.
- Fixed queue draining head-of-line blocking on wake failures in `pi-extension`.
- Eliminated vertical gaps and leaked reasoning traces in mobile chat by filtering empty assistant turns and stripping unclosed `<think>` blocks in finalized messages.
- Added authentic terminal Braille spinner (`⠋⠙⠹...`), text shimmer wave animation, and inline interactive `[■ Stop]` cancel button to the mobile working indicator.
- Added global rooms discovery to relay (`all_rooms`) for empty-peer checks and updated web client relay bridge connection handling.
- Web client: `error`, `cancelled` and `bye` frames now stop the working state and close the streamed reply; `error` shows a `⚠ code: message` row as the app does. Stop works before any text has streamed.
- Web client: images on `user_message`/`user_input` (live and in history) render in the user bubble. A `tool_result` whose request is outside the history window shows as an `unknown` tool. A resync keeps sends that have not been confirmed yet.
- Web client: the slash menu lists the Pi's `skills_list`. Quick actions load the Pi's real models (`list_models` → `models_list`), send `model_set` with the picked provider and id, offer each model's `thinking_levels`, and show `action_error`/timeout failures instead of dropping them.
- Web client: Home session rows have restart and delete icons, like the app's tiles. Restart is shown only for live rooms and sends `/restart`. Delete on a live room sends `/exit` and drops the tile. On an offline room it only removes the cached tile. Both ask for confirmation first and warn when a turn is running.
- Web client: Home opens on the Online tab, as the app does. If the relay can't be reached, Online shows its empty state instead of spinning forever.
- Web client: on wide screens the chat has a session sidebar on the left with the same tabs, grouping and status badges as Home. One click switches session. It collapses to a rail of avatars, and that choice is remembered. Home keeps its tab after you leave a chat.
### Added

#### Push notifications & mobile Git Diff viewer
- Offline-aware webhook / `ntfy` push notifications in `pi-extension/` (`REMOTE_PI_NOTIFY_URL`, `REMOTE_PI_NOTIFY_TOKEN`, `REMOTE_PI_NOTIFY_MODE`, `/remote-pi notify`, `/remote-pi set-notify`, CLI `remote-pi notify`): notifies on turn completion (debounced & coalesced with interactive prompts), `ask_user` / `confirm` / `plan_review` requests (`needs_input`), and errors, gated by live relay phone presence (`OwnerPresence.anyOnline()`), with payload adapters for `ntfy`, Discord, Slack, and JSON webhooks.
- Mobile Git Diff & Changed Files viewer (`git_status` / `git_diff` protocol frames, `pi-extension/src/actions/git_diff.ts`, and Flutter `GitChangesSheet` reachable from the chat top bar and Quick Actions): lists branch and modified/staged/untracked/renamed/conflicted files with line stats, renders syntax-colored unified diffs with Staged/Unstaged toggle and Copy, and rejects repo-root path escapes (`128 KB` / `200 files` cap).

#### Always-on door (plan/67)
- A registered daemon now stays up until you stop it on the machine. The supervisor restarts a daemon that crashes, is killed, or is closed with the app's Quit session (it returns as a fresh session). Retries back off to every 5 minutes and no longer stop after four attempts. `remote-pi daemon stop` during a retry wait now sticks, and a harness binary that was missing at boot is picked up once it is on PATH.
- `remote-pi create <cwd> --harness omp` runs a daemon on omp. The default is `REMOTE_PI_HARNESS`, then the harness the command runs in, then `pi`.
- Daemons get a new terminal's environment: the supervisor reads it from the login shell at start (via Node JSON dump between per-call nonce markers, without waiting on background rc helpers), so API keys and proxies from rc files apply under systemd/launchd without truncating env vars.
- Hardened daemon lifetime & control: fixed `_tryExecuteTerminalInput` hijacking phone messages/commands on `pi --mode rpc` daemons, added boot-time initial relay retry + 15 s WS handshake timeout, guarded `child.stdin` EPIPE / UDS / cron errors, awaited old child teardown before respawn, added `omp` `set_event_filter` + single-pass bounded RPC stdout/line-buffered stderr, atomic/strict `daemons.json` registry updates with stat cache, parallel `daemon stop` + 15 s CLI timeout, non-zero CLI error exit codes, and hardened systemd unit ordering/limits/stop policy (`After=basic.target`, `StartLimitIntervalSec=0`, `KillMode=mixed`, `TimeoutStopSec=15s`, `OOMPolicy=continue`, `Restart=always`).

#### omp model roles from the app (plan/66)
- The app's model sheet has a Roles tab listing omp's model roles (default, plan, task, smol, advisor and the rest) with model, thinking level and description. Pick a role, then a model and thinking level, or Reset it; the change goes through omp's own settings into `~/.omp/agent/config.yml` and applies to every session, as in the terminal.
- A role's eligible models are fetched when it is tapped, so the roles list stays about 3 KB.

#### Send files to the phone (plan/65)
- New agent tool `send_to_phone(path, caption?)` sends a file of up to 256 MiB (`REMOTE_PI_MAX_SEND_MIB`) to the paired phone over the relay, in 1 MiB chunks with acknowledgements. A transfer resumes where it stopped after a dropped connection, for up to 10 minutes.
- The app shows a file card with progress, then Open, Share, Save to Downloads and, for APKs, Install. Received files can be cleared in Settings → Storage.
- When the latest message came from the phone or web, the agent is told the user cannot see the PC: it shows images by reading them into the chat and sends files only when asked. Typing in the terminal removes that note.
- Phone APK builds are smaller: `--target-platform android-arm64` now also drops plugin libraries for other CPUs, and native libraries are compressed (arm64 17.6 MB instead of 87.8 MB).

#### Owner-key sync (plan/23)
- New Flutter plugin `remote_pi_identity` for storing the Owner-key in the
  platform credential store (iOS Keychain with iCloud sync, Android Block Store
  with Google account sync), enabling the same logical Owner across multiple
  mobile devices without re-pairing.
- Owner-key is the cryptographic root of authority — Ed25519 keypair signing
  every `mesh_versions` blob and authorizing pair/revoke operations.

#### Mesh membership (plan/24)
- Relay gained a SQLite-backed `mesh_versions` store. Each Owner publishes a
  signed blob listing the PCs (Pi-pubkeys + nicknames) that belong to their
  mesh. Relay verifies Ed25519 signatures and enforces monotonic versions for
  anti-rollback; never decides membership.
- New endpoints: `POST /mesh/<owner_pk_hash>` (write) and
  `GET /mesh/<owner_pk_hash>` (read).
- `MeshClient` + `MeshSyncService` on the app side, with on-demand pull and
  60-second foreground polling.
- Self-revoke on the Pi: when the Pi detects its own pubkey is no longer in
  the Owner's `mesh_versions`, it exits gracefully.
- Reinstalling the app restores peers automatically once the Owner-key is
  recovered (no manual re-pairing needed).

#### Cross-PC envelope routing (plan/25)
- New WebSocket frames between Pi-extension and relay:
  - `pi_envelope` (Pi-A → Relay): request forwarding to another Pi of the
    same Owner.
  - `pi_envelope_in` (Relay → Pi-B): delivers the envelope verbatim, plus
    `from_pc` ground-truth pubkey for anti-spoof.
- `MeshAuthCache` on the relay (60-second TTL, keyed by Pi-pubkey →
  set-of-siblings) verifies `same Owner` per forward without hitting SQLite
  on every message.
- Transport errors (`offline`, `not_authorized`, `bad_envelope`) flow back as
  **normal envelopes** with `body.type = "transport_error"` and
  `from = "_relay"` — no custom WS error frames. The sender's ACK machinery
  correlates them via `re: <original-envelope-id>`.

#### ACK protocol (plan/25 Wave 0)
- `agent_send` now waits for an ACK (`received | busy | denied | timeout`)
  generated by the destination Pi's TypeScript wrapper — not by the LLM. No
  tokens, no turn required. Default timeout: 5 seconds.
- The wrapper tracks `turn_in_progress` via Pi SDK hooks
  (`pi.on("turn_start"|"turn_end")`); concurrent messages during a turn get
  `busy` and are dropped.
- Replies with `re != null` bypass the busy gate — necessary for parallel
  send patterns and reply correlation.
- Reply content remains asynchronous: the destination peer responds with
  another `send` carrying `re: <original-id>`. Sender sees it in its inbox
  on a future turn. No `agent_wait` tool — the model is event-driven by
  design.
- `agent_request` is deprecated (still functional, emits a one-shot warning).

#### Broker remote + prefix routing (plan/25 Waves B + C)
- New module `broker_remote.ts` in the Pi-extension: caches sibling peers
  (`Map<pc_label, {peers, pc_pubkey, ts}>` with 5-min TTL), proactively pushes
  `peers_update` on local `peer_joined`/`peer_left`, and intercepts control
  envelopes (`peers_update`, `peers_request`, `transport_error`).
- New `pi_forward_client.ts`: thin wrapper over the existing relay WS client
  that emits `pi_envelope` frames.
- Broker's `_resolveTargets` parses prefix addressing: envelopes with
  `to = "<pc>:<peer>"` are handed off to `broker_remote` when the prefix is a
  known sibling; envelopes without prefix or with `self_pc_label` continue via
  UDS locally (backward-compatible with peer names containing `:`).
- New privileged API `Broker.injectFromRemote(env)` bypasses the local
  `force from = conn.name` rule (the per-conn anti-spoof) because cross-PC has
  its own defense via `from_pc` in the relay wrapper.
- Anti-spoof on inbound: `envelope.from` prefix must match the `pc_label`
  registered for the authenticated `from_pc` — otherwise dropped with a log.
- `list_peers` aggregates locals (no prefix) and remotes (prefixed by
  `pc_label`).

#### Cross-PC polish (plan/25 Wave D)
- ACK matcher in `peer.ts` now accepts both `from === "broker"` and
  `from.endsWith(":broker")` — cross-PC ACKs (`from = "<pc_label>:broker"`)
  now resolve `sendWithAck` instead of timing out.
- Failover hook: when the leader UDS reconnects, `broker_remote` is torn down
  and recreated, preventing aliasing bugs if the previous leader died.
- Sibling membership now reactive: a callback in `self_revoke.ts` polling
  re-invokes `broker_remote.setSiblings()` whenever the union of members
  across all paired Owners changes. No restart needed.
- New CLI `/remote-pi peers`: lists local and remote peers grouped by
  `pc_label`, locally-sorted alphabetically.
- `audit.jsonl` gained a `via` field (`"uds" | "relay"`) per route so
  cross-PC envelopes are distinguishable in logs.

#### Pairing polish (plan/27 Wave A)
- After a successful pair, the app shows a nickname sheet asking the user to
  label the newly paired PC (defaults to the Pi's `hostname` if provided,
  otherwise "Pi"). Skipping still persists the fallback so the mesh entry
  never has an empty nickname.
- The Pi-extension now includes optional fields in the `pair_ok` payload:
  - `harness: { name: "Pi coding agent", version: "<package.json version>" }`
  - `hostname: os.hostname()`
- `PeerRecord` in the app gained an optional `harness` field. The
  `PeerSectionHeader` renders `via Pi coding agent` (or another harness
  string when wrappers for Claude Code / OpenCode arrive in the future).

#### Pi-key cross-platform storage (plan/27 Wave E1)
- Migrated from `keytar` (deprecated) to `@napi-rs/keyring` for cross-platform
  Pi-secret storage:
  - macOS: Keychain (Apple Silicon transparently delegates to Secure Enclave)
  - Linux desktop: libsecret (GNOME Keyring / KWallet)
  - Windows: Credential Manager (DPAPI-backed)
- Service name renamed `dev.remotepi.mac` → `dev.remotepi.pi` (neutral).
- Migration is silent: on first boot post-upgrade, the new entry is read
  first; if missing, the old `dev.remotepi.mac` entry is read directly via
  the new library (the underlying native APIs are the same), copied to the
  new service, and deleted. Existing Pi-keys are preserved.
- Headless Linux fallback: when keyring is unavailable (no D-Bus session in
  containers / VPS without a desktop), Pi-secret falls back to
  `~/.pi/remote/identity.json` with `chmod 0600` and a loud warning.
- New `KeyStoreBackend` abstraction with `InMemoryBackend` enables
  reproducible tests without touching the developer's real Keychain.

#### Protocol & security documentation
- New canonical document [`PROTOCOL.md`](PROTOCOL.md) at the repo root covering:
  wire format, identity model, ACK protocol, cross-PC routing, mesh
  membership, pairing flow, honest trust model, threat model, failure modes,
  and architectural roadmap.
- Linked from `pi-extension/README.md`, `pi-extension/CLAUDE.md`,
  `relay/README.md`, and the site's `/docs#protocol` section (plus footer).

#### Daemon mode (pi-extension)
- Pi can now run as a managed background daemon (`launchd` on macOS,
  `systemd --user` on Linux) for "always on" coding-agent mesh participation.

#### Multi-channel pi-extension (Wave 2D)
- Pi-extension now accepts multiple paired Owners simultaneously via
  `_activePeers: Map<peer_id, PlainPeerChannel>` (no longer a singleton). The
  pair flow no longer rejects new pair requests when one Owner is already
  paired ("concurrency by design").
- `user_message` is rebroadcast to **all active peers** (source-of-truth
  pattern): when any device sends a message, the Pi echoes the canonical
  version with the same `id` to every paired device. Senders render their
  own bubble as `pending` and promote to `confirmed` when the echo arrives;
  other devices insert the message as `confirmed` directly.

### Changed

#### Relay control-frame deduplication
- `peer_online` now fires **only on real offline→online transitions**, not
  on every `register` call. Re-registers from peers that already had a live
  connection are silently absorbed without spamming subscribers.
- `presence_check` and `rooms_check` responses are deduplicated per
  connection: identical replies are suppressed; only changes produce new
  snapshots. Subscribers always receive the initial backfill correctly.
- New `FirehoseMetrics` emits a structured log line every 10 seconds with
  emit/suppress counters per frame type (silent when all counters are zero).
- Closes a regression observed in production where 2 active mobile devices
  caused ~10 redundant `peer_online` per peer per 30 seconds, contributing
  to CPU spikes on Android.

#### Reconnect resilience (app)
- `requestSync` no longer drops requests silently when the WebSocket is not
  yet ready. A `_pendingSyncRequest` flag defers the sync until
  `_onlineActivated` fires.
- `_clearAllPending` now only cancels pending timers without touching the
  message state; a new `_rearmPendingAfterReconnect` re-arms timers for
  surviving `pending` messages after reconnection.
- `_applyHistory` is now an intelligent merge instead of a destructive
  replace: pending messages whose `id` is present in the history are
  confirmed (timers cancelled); pending messages absent from the history
  are preserved in the tail. The merged state is persisted, so cold restarts
  with pending messages re-arm their timers.

#### Site copy
- Reframed from "control your Pi from your phone" to "mesh of coding agents
  on every machine you work from; the phone is just the authenticator."
- All four feature cards rewritten; hero, OG image, docs intro, daemon
  section, and final CTA updated. Layout and components unchanged — diff is
  string-only.

#### Plan/03-protocol historical update
- `plan/03-protocol.md` (MVP-era spec) now opens with an alert pointing to
  `PROTOCOL.md` as the current canonical document, plus a "Post-MVP changes"
  section summarizing the evolution. The rest of the file is preserved as
  historical reference.

### Fixed

#### Self-revoke encoding inconsistency
- After pairing, the Pi-extension occasionally triggered self-revoke because
  the Owner-pubkey stored in `peers.json` was in standard base64 while the
  `remote_epk` carried by the app was in URL-safe base64. Comparison now
  decodes both forms and compares bytes (new `mesh/encoding.ts` helper).

#### "Already paired" rejection on second pairing
- The first iteration of pi-extension treated a non-idle paired state as a
  hard refusal of new pair requests. With concurrent Owners (`plan/25` Wave
  2D), this blocked legitimate pair attempts. `_cmdPair` is now permissive
  and routes a new pair through the multi-channel registry.

#### Mobile chat regression after iPhone joins
- On Android, sending a message right after the iPhone joined the same Pi
  could leave the bubble stuck at `pending` even though the echo arrived.
  Root cause: a transient WS reconnect during the join wiped pending state.
  Fixed by combining the resilience changes above (`_clearAllPending` no
  longer destroys state; `_applyHistory` merges instead of replaces).

#### Chat title flashing "Remote Pi" on open
- Home now passes a title hint via `go_router` extra (room name → cwd
  basename → peer nickname → session name → epk prefix). `ChatPage` renders
  the hint immediately so the AppBar shows the correct label on frame 1.

#### Pi-extension docker image build
- `Dockerfile` was missing `COPY migrations ./migrations`. Builds failed at
  `cargo build` because `store.rs` uses `include_str!` for the SQL schema.
  Added the missing line; verified end-to-end with `docker build` and a
  container smoke test against the three runtime surfaces (`/health`,
  `GET /mesh/<unknown>`, WS upgrade).

#### App session_sync silent drop
- `requestSync` returned early without action when the channel was not yet
  ready, leading to empty chat history after a cold open. Now it defers and
  fires automatically on the next `StatusOnline`.

### Security

- **Honest trust model documentation.** Removed every claim of end-to-end
  encryption from user-facing surfaces:
  - `site/src/app/layout.tsx` global meta tags (description, OG, Twitter
    cards, keywords) — was leaking E2E claims into link previews on
    WhatsApp / Slack / search results.
  - `site/src/app/terms/page.tsx` §2 (Account & Pairing) and §5 (Prohibited
    Conduct) — replaced "end-to-end encrypted channel" with "mutually
    authenticated channel (Ed25519 challenge-response)" and similar.
  - `site/src/app/docs/page.tsx` "The relay" section — now points to the
    real trust model in `PROTOCOL.md`.
  - `pi-extension/README.md` — substituted "Encryption uses Curve25519 +
    ChaCha20-Poly1305; the relay sees only ciphertext" with a TLS-only
    statement and a pointer to `PROTOCOL.md`. (Two further occurrences
    flagged in the file for a follow-up cleanup wave.)
- **No new E2E primitives introduced.** TLS protects traffic in transit; the
  relay sees plaintext envelopes at rest and in forwarding. Self-hosting is
  the recommended path for sensitive deployments. E2E payload encryption is
  on the public roadmap (see `PROTOCOL.md` "Roadmap").

### Removed

- `keytar` dependency removed from pi-extension (deprecated upstream;
  replaced by `@napi-rs/keyring`). 29 transitive packages dropped.

### Decided (architectural)

These decisions were resolved during this cycle but produce no code change.
Documented for context:

- **PC-to-PC direct transport** (WebRTC/QUIC) deferred to a future plan;
  relay remains the cross-PC transport for the MVP. Cross-PC latency hop
  (~100ms via relay) is acceptable.
- **Relay-via-UDS broker gateway** was investigated and discarded. The
  alternative is **wrappers**: when Claude Code or OpenCode support is
  needed, `remote-pi claude` will spawn the harness and register as a peer
  on the existing local UDS broker. Reuses the envelope JSONL protocol,
  requires zero pi-extension refactor, and keeps each harness isolatable.
- **Pi-key hardware-bound storage** (Secure Enclave / TPM / CNG) discarded
  for now. Constraint accepted: "one Pi-key per PC; hardware swap = re-pair".
  Software user-bound storage (Keychain / libsecret / Credential Manager)
  is sufficient given the constraint.

---

## [0.1.3] — 2026-05-22

### Added

- Privacy Policy and Terms of Service pages (`/privacy`, `/terms`).
- Site documentation layout improvements: sidebar + table of contents.
- Multi-platform Docker build for the relay (`linux/amd64`, `linux/arm64`).
- Relay published at `wss://relay-rp1.jacobmoura.work` (default community
  endpoint).
- Visual identity and launch icons for Android, iOS, and macOS.

### Changed

- Native display name "Remote Pi" applied across platforms.
- Pi-extension prepared for npm publishing.

### Fixed

- App: empty custom relay URL allowed in onboarding (previously rejected).

### Removed

- macOS desktop platform from the Flutter build (focus on mobile only).

---

## Earlier history

Plans 01–22 covered bootstrap, AI orchestration, protocol MVP, pairing,
rollback E2E (later reverted), revoke + multi-pairing, presence,
chat-state recovery, onboarding, mirror cache, rooms, agent network, agent
tools, setup wizard, and the site MVP. See [`plan/`](plan/) for the design
history of each.

[Unreleased]: https://github.com/jacobaraujo7/remote_pi/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/jacobaraujo7/remote_pi/releases/tag/v0.1.3

<p align="center">
  <img src="https://raw.githubusercontent.com/leoliu0/remote-omp/main/branding/logo-full.svg" width="160" alt="Remote OMP logo" />
</p>

<h1 align="center">Remote OMP</h1>

> Extend the [omp coding agent](https://github.com/can1357/oh-my-pi) (oh-my-pi)
> with two superpowers: agents that talk to each other on the same machine, and
> a mobile app that drives omp from your phone.

**Homepage:** <https://remote-pi.jacobmoura.work>

Remote OMP is a fork of [Remote Pi](https://github.com/jacobaraujo7/remote_pi)
by Jacob Moura (MIT), reworked to target omp only. Coming from Remote Pi? See
[Upgrading from Remote Pi](#upgrading-from-remote-pi).

`/remote-omp` is a single slash command that wires both at once. Run it; the
first time it asks a couple of questions and you are done.

## Protocol & Security

For wire format, identity model, ACK protocol, cross-PC routing, mesh
membership, and the trust model (what the relay sees and doesn't see),
read [`PROTOCOL.md`](../PROTOCOL.md) at the repo root. It is the canonical
document — this README only covers user-facing setup.

---

## Quick start

Install [omp](https://github.com/can1357/oh-my-pi) if you don't have it, then
add the plugin (one-time):

```bash
omp plugin install remote-omp
```

Working from a clone of this repository instead? Build it and link it:

```bash
cd omp-extension && pnpm install && pnpm build
omp plugin link "$PWD"
```

Or run the [one-command installer](#one-command-installer), which sets up omp,
the plugin, the CLI links and the supervisor service in one go.

Then in any omp terminal:

```text
/remote-omp
```

The first run shows a short interactive wizard (agent name, whether to use the
relay). On every following run, `/remote-omp` joins the local agent session and
starts the relay automatically — no extra typing. To drive omp from your phone,
pair the Remote OMP app once with `/remote-omp pair`.

### Try the agent network in 30 seconds

Open **two** omp terminals in the same directory and run `/remote-omp` in each.
Both join the same session. Now just talk to the LLM — it has the tools.

In terminal A (say it ended up named `agent-A`):

```text
Who else is connected in our agent session? List them.
```

The LLM calls `list_peers` and reports the complete routing addresses it sees.

Then, still in terminal A:

```text
Send a ping to agent-B using its listed address and ask it to reply later.
```

omp calls `agent_send({ to: "<exact address from list_peers>", body: {
type: "ping" } })`. For unicast, the call waits only for the broker's delivery
ACK. Terminal B receives the message as a user-facing turn and can answer later
with `agent_send`, setting `re` to the ping's message id; that reply arrives in
terminal A's inbox or a later turn. It does not block terminal A waiting for
agent-B's content reply.

Copy the complete address exactly as listed. Do not build, parse, decode, or
normalize it.

---

## What it does

Remote OMP adds two independent layers on top of omp. You can use either, or
both:

### 1) Agent network (local broker, optional cross-PC relay)

Several omp instances running side-by-side in different terminals can discover
each other and exchange messages. Each instance is a peer in a named
*session*. The LLM uses:

- `list_peers` — discover current peer routing addresses
- `agent_send` — unicast waits for the broker delivery ACK; broadcast is
  fire-and-forget

The legacy `agent_request` tool is deprecated because it blocks while
waiting for another agent's content reply. Use `agent_send`, continue the
current turn, and receive any later reply through the inbox/turn flow with
`re` correlating it to the original message id.

Peers on the same machine talk over a Unix domain socket at
`~/.omp/remote/sessions/<session-name>/broker.sock`. When sibling PCs are paired,
a leader-capable Extension or MCP participant bridges the opaque cross-PC
addresses over the relay; local-only use stays on UDS when relay access is off.
Useful for splitting work across roles (`backend`, `frontend`, `tests`,
`orchestrator`, …) and letting them coordinate.

The first agent to enter a session becomes the *leader* (hosts the broker);
the rest are *followers*. If the leader exits, a follower automatically takes
over — the failover is invisible to the LLMs.

### 2) Mobile app (over the relay)

The companion mobile app lets you send prompts to omp and read its responses
from your phone. The phone and the omp process find each other through a
**relay**: a small WebSocket server that ferries messages between them.
Pairing is one-time and per device, via QR code.

Mobile text, image, and drained queued prompts check the live session's
`isIdle()` synchronously immediately before SDK handoff, after image preparation.
Idle sends omit `deliverAs` so omp starts a turn instead of stranding it in
an explicit queue. Confirmed busy sends use `deliverAs: "steer"`. Missing state
falls back to omp's default start/auto-steer
behavior; room metadata and the mobile wire mode never select SDK delivery.
Failed handoffs are not retried with alternate modes because acceptance may
precede an error. A failed queued item remains editable but blocks automatic
draining until the mobile client replaces or clears it.

Communication uses WebSocket over TLS to the relay. Fields such as `ct` are
wire containers, not a systemwide end-to-end confidentiality guarantee: current
Pi-forward, cross-PC, app, and control envelopes visible to the relay are not
fully opaque or E2E encrypted. A relay operator can see routed plaintext
protocol content and metadata; see [`PROTOCOL.md`](../PROTOCOL.md) for the exact
trust boundaries.

**Get the app** — the Remote OMP Android app is a sideloaded APK
(`RemoteOMP.apk`) on the [GitHub Releases](https://github.com/leoliu0/remote-omp/releases)
page. The site lists the current download options:

<https://remote-pi.jacobmoura.work/#get-the-app>

---

## Mobile app actions

Beyond the chat, the app surfaces a small set of typed actions you can run
on the paired omp session. Tap the ⚙ button next to the message input (visible
when the input is empty) to open the Quick Actions sheet:

| Action | What it does |
|---|---|
| **Compact context** | Runs `ctx.compact()` — same as `/compact` in the TUI. |
| **New session** | Runs `ctx.newSession()` — equivalent to `/new`, asks for confirmation first. |
| **Model** | Opens a model picker fed by your authenticated providers (same source the TUI uses) and switches via `pi.setModel(model)`. The pick is also saved as omp's default model (`modelRoles.default`), so a restart keeps it. |
| **Thinking** | Segmented control with the levels the active model supports (`auto` · `off` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max`). Changes via `pi.setThinkingLevel(level)`; omp also keeps the pick as its default thinking level (it never stores `off`). |

Each action gets a structured `action_ok` / `action_error` reply so the app
can show a SnackBar on failure. Visible side-effects (chat output, model
change broadcasts, compaction notice) still flow through the normal chat
channels. The wire schema is documented in [`PROTOCOL.md`](../PROTOCOL.md)
under "App actions".

**Slash commands.** A message that starts with `/` runs on the PC the way omp
would run it, and the app's `/` menu lists what the running omp offers (its
builtins, extension commands, skills and custom commands). In a terminal
session the line is typed into omp's editor, so anything you can run at the
keyboard runs. A supervised daemon (`omp --mode rpc`) has no terminal UI: the
supervisor hands the line to omp's RPC input, which runs skills, extension and
custom commands and the builtins that have a text-mode handler. In a daemon
`/new`, `/restart` and `/exit` are done by the extension itself, and builtins
that need the interactive UI (plan mode included) are refused with an error
instead of being sent to the model as text.

### Model roles

The app can also change omp's **model roles** (`modelRoles` in
`~/.omp/agent/config.yml`: `default`, `plan`, `task`, `smol`, custom roles…).
Roles are global, exactly as when set from omp's `/model` view: a change
applies to every running omp session and to the terminal.

| Frame | Direction | Fields |
|---|---|---|
| `list_model_roles` | app → ext | `id`, `role?` |
| `model_roles` | ext → app | `in_reply_to?`, `roles: [{ role, name, description, model?: WireModel, thinking?, source, candidates?: [{ provider, model_id }] }]` |
| `model_role_set` | app → ext | `id`, `role`, `provider?`, `model_id?`, `thinking?` |

- `model_roles` answers `list_model_roles` (with `in_reply_to`). After every
  successful `model_role_set` the extension broadcasts a fresh `model_roles`
  **without** `in_reply_to` to all connected owners. The full list and the
  broadcast never carry `candidates`.
- `list_model_roles` with `role` replies a `model_roles` whose `roles` holds
  just that role, with its `candidates` (an unknown role gets an `error`).
- `source` is omp's `getModelRoleSource(role)`: `global`, `project` or
  `default` (unset; omp picks a model itself). `model` reuses the
  `models_list` `WireModel`; `thinking` is the role value's `:level` suffix.
  `candidates` is omp's `roleCandidatePool(role)` (authenticated models of the
  role's kind) as bare `{ provider, model_id }` pairs. In a role reply it is
  left out when the pool equals the `models_list` list (`getAvailable()`),
  meaning "the full models_list list". Measured with ~875 chat models: the
  full list is ~2.9 KB, a `web` role reply ~47 KB (765 pairs).
- `model_role_set` writes `provider/model_id[:thinking]` (omp's TUI form) with
  `settings.setModelRole`, then flushes config.yml. Omitting `provider` and
  `model_id` clears the role. It replies `action_ok` / `action_error`
  (`action: "model_role_set"`); errors: unknown or hidden role, model not in
  the role's candidate pool, thinking level the model doesn't support,
  project-scoped role (read-only from the app), half-specified model, not omp.
- `description` comes from the extension (omp has names, no descriptions);
  custom roles get `""`.

**How the extension reaches omp's settings.** Roles are read and written
through the live main session's `settings`, which omp hands every extension
through `ExtensionAPI.pi.AgentRegistry`: importing omp's `config/settings` from
a plugin would give a second, uninitialized copy of the bundled module. The
pure helpers (`getKnownRoleIds`, `getRoleInfo` and `roleCandidatePool` from
`config/model-roles`, `resolveModelRoleValue` from `config/model-resolver` for
aliases and patterns) come from omp's own modules: its extension loader maps
imports of `@oh-my-pi/pi-coding-agent/*` in the extension's module graph to the
modules bundled into the running omp binary. The YAML file is never written
directly: omp's next save would overwrite it. These are omp internals, not its
documented extension API; checked on omp 19.0.1.

### Images

The app can attach **one image** (camera or gallery) to a message. It's
compressed on the device and rides **inline** in the `user_message` — the
optional `images` field carries `{ data: <base64>, mime }`. The extension
turns it into the SDK's multimodal content (an `ImageContent` followed by the
caption `TextContent`) and calls `sendUserMessage(content)`, so the model sees
the picture plus your text.

Whether a model accepts images is surfaced as a `vision` flag on each
`WireModel` (derived from the SDK's `Model.input` including `"image"`); the app
greys out the attach button when the active model is text-only.

The **relay is unchanged** — the image travels inside the same application
message container as the text, so there's no binary channel (large files are a
future track). Base64 or a field named `ct` is not an E2E confidentiality
boundary; the current Relay visibility follows the trust model above. Text-only
messages are unaffected.

### Files to the phone

The agent tool **`send_to_phone({ path, caption? })`** sends a finished file
(an APK, a PDF, a zip, a log) from this PC to the paired phone, where it shows
up as a file card in the chat. Nothing opens or installs on the phone without
a tap. The tool checks that `path` exists, is a regular file and is under the
cap before any frame is sent. A relative `path` resolves against the session
cwd. It returns `{ name, size, device }` once the phone confirms receipt, and
it cancels the transfer when the tool call is aborted.

The target is the phone that sent the latest user input. If that phone is
offline, the target is the other online phone. When no phone is online the
tool fails with `phone_offline` and nothing is queued. "Online" follows the
relay's presence for the owner: the extension sends `subscribe_presence` and
`presence_check` for its paired owners on every relay (re)connect and tracks
`peer_online` / `peer_offline`. A target that is offline there gets 20 s to
come back; then the tool fails with `phone_offline: Remote OMP is not connected
on the phone. Ask the user to open the app, then try again.` Before the first
presence frame the attached channel is used and the timeouts below apply.

The file travels as chunked frames over the normal peer channel, so the relay
does not change:

| Frame | Direction | Fields |
|---|---|---|
| `file_offer` | ext → app | `file_id`, `name`, `mime`, `size`, `sha256` (hex), `caption?`, `turn_id?` |
| `file_chunk` | ext → app | `file_id`, `seq` (0-based), `data` (base64 of up to 1 MiB) |
| `file_end` | ext → app | `file_id`, `chunks` |
| `file_ack` | app → ext | `file_id`, `next_seq` (cumulative: the first chunk the phone still needs) |
| `file_done` / `file_error` | app → ext | `file_id`, `reason?` (`sha_mismatch`, `no_space`, `cancelled`) |
| `file_cancel` | either | `file_id` |

The sender keeps at most 4 chunks in flight beyond the last `file_ack`. The
phone acks the offer with `next_seq` 0; with no ack within 30 s the transfer
fails with `phone_unreachable`. Once acks flow, 60 s without ack progress
fails it with `stalled`. Both send `file_cancel`. When acks stop, the sender
probes (after 15 s, doubling up to 30 s): it re-sends `file_offer`, then the
first unacked chunk, so a phone that missed the offer can start; a
re-attached phone is probed at once. The phone answers a repeated offer with
`file_ack` and its current `next_seq` (keeping its `.part`), and the transfer
continues from there. A `peer_offline` for the target pauses the transfer; a
`peer_online` within 60 s resumes it with the same probe, otherwise it fails
with `phone_offline` and the share the phone received. Receivers ignore
unknown fields on `file_*` frames.

The per-file cap is 256 MiB. Set **`REMOTE_OMP_MAX_SEND_MIB`** to change it
(for example `REMOTE_OMP_MAX_SEND_MIB=512`).

While the latest input came from a phone that is online, every provider
request carries one short note: *"The user is on Remote OMP (phone app or web)
and cannot see this PC's screen or files. To show an image, `read` the image
file: it appears in their chat. Use `send_to_phone` only when the user asks for
a file on their phone."* The web client signs in with the phone's owner key, so
its input counts as the same peer. The note keeps the same bytes and position until the input
source changes, so prompt caching still works. Input typed in the terminal (or
sent by an RPC client) removes it, and so does that phone disconnecting.

### Files from the phone

The app's attach sheet has **File**: pick any file and it is uploaded to the PC
the session runs on, then the absolute path is added to the message you are
typing. Files land in `~/.omp/remote/uploads/YYYY-MM-DD/<name>` (below
`$REMOTE_OMP_HOME/.omp/remote` when `REMOTE_OMP_HOME` is set). The name is the phone's file name reduced to one
safe segment (no separators, control characters, or leading or trailing dots
and spaces); an existing name gets ` (1)`, ` (2)`… and never replaces a file.

The phone sends `upload_start { id, upload_id, name, size, mime?, sha256? }`,
`upload_chunk { id, upload_id, seq, data }` (base64 of at most 2 MiB of raw
bytes; the app sends 256 KiB, with at most 4 in flight beyond the last ack),
`upload_end { id, upload_id, sha256? }` and `upload_cancel { id, upload_id }`.
The `sha256` (lowercase hex of the whole file) may come with `upload_start` or,
when the phone hashes while it sends, with `upload_end`; it is checked when
given. The extension answers `upload_ack { upload_id, seq, received,
in_reply_to? }` (cumulative: `seq` is the first chunk still needed, which also
covers duplicates, gaps and a phone resuming after a dropped connection;
`in_reply_to` echoes the `id` of the frame it answers), then `upload_done
{ upload_id, path, size }` or `upload_error { upload_id, code, message }`
(`code` is one of `too_large`, `no_space`, `invalid_upload`, `size_mismatch`,
`sha_mismatch`, `timeout`, `unknown_upload`, `too_many_uploads`,
`write_failed`; `message` is for the user).

A slow uplink only delays acks, so the phone does not resend chunks when acks
stop. It sends `upload_start` again as a probe instead: frames are processed in
order, so the ack that echoes the probe's `id` is the position after everything
that reached the PC before it. Chunks beyond that position were lost and are
sent again from there. An `upload_end` that arrives early is answered with the
current position, not an error.

Bytes go to `<uploads>/.incoming/<random>.part` (a folder of their own, mode
0600) and are linked to the final name only after the size, and the sha256
when sent, check out, so a stored file never appears half-written. A cancel, an
error or 60 s without a frame from the phone deletes the temp file; stopping
Remote OMP drops uploads in progress; leftovers of a crash older than a day are
removed once per run. A finished upload is remembered for ten minutes, so a
repeated `upload_end` is answered with `upload_done` again.

The per-file cap is 256 MiB. Set **`REMOTE_OMP_MAX_UPLOAD_MIB`** to change it
(for example `REMOTE_OMP_MAX_UPLOAD_MIB=512`). Up to 8 uploads run at once. An
upload is refused with `no_space` when it would leave less than 1 GiB free on
the disk, counting the bytes promised to uploads in progress; set
**`REMOTE_OMP_UPLOAD_RESERVE_MIB`** to change the reserve.

### Prompts from other extensions

A prompt drawn with `ctx.ui.custom` lives only in the terminal. An extension
can also put it on the app as a yes/no question through `pi.events`; the
first answer, terminal or app, wins:

| Channel | Sent by | Payload |
|---|---|---|
| `remote-omp:confirm:request` | the extension, when its prompt opens | `{ id, title, message }` (`message` is markdown) |
| `remote-omp:confirm:answer` | remote-omp, when the app answers | `{ id, confirmed }` (the app's cancel is `false`) |
| `remote-omp:confirm:closed` | the extension, once its prompt resolved | `{ id }`, which closes the question on the app |

TeX Guard's patch review uses it, so a `tex_edit` diff can be approved from
the phone. An extension that emits or listens for these events must use the
`remote-omp:confirm:*` names (see
[Upgrading from Remote Pi](#upgrading-from-remote-pi) for the old ones).
Without remote-omp loaded the events go nowhere.

---

## Install

Requirements: [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi), and Node
20.6+ for the `remote-omp` command line and the supervisor (omp itself does not
need Node).

```bash
omp plugin install remote-omp
```

omp keeps the plugin in `~/.omp/plugins/node_modules/remote-omp` and loads it
through the `omp.extensions` field of its `package.json` (`./dist/index.js`).
The extension self-registers the `/remote-omp` slash command (`/rc` is a
shorthand) and deploys an agent skill that teaches the LLM how to use
`list_peers`, `agent_send`, and the event-driven inbox/reply flow.

From a clone of this repository (to work on it, or before a release is
published) build it and link it instead:

```bash
cd omp-extension
pnpm install && pnpm build
omp plugin link "$PWD"
```

omp keeps a symlink to the folder, so after a change `pnpm build` plus a restart
of omp is all an update takes.

To verify:

```text
/remote-omp config
```

It should print the effective relay URL and where it came from
(`env` / `config` / `default`). `omp plugin list` shows the plugin too.

### One-command installer

```bash
curl -fsSL https://remote-pi.jacobmoura.work/install.sh | bash
```

macOS and Linux, no sudo, safe to re-run. In order, it sets up: Node (only when
the system has no 20.6+; installed with nvm under `~/.nvm`), omp (with omp's
official installer when `omp` is not on your PATH), the plugin (`omp plugin
install remote-omp`; with `REMOTE_OMP_FROM_CLONE=<dir>`, or when the script is
run from a clone, it links that checkout instead), the `remote-omp` and
`remote-omp-supervisord` links in `~/.local/bin`, and the supervisor as a
per-user service. It stops there: pair your phone with `/remote-omp pair`
inside omp. On Windows, use WSL.

### The `remote-omp` command line

The plugin gives you the slash command inside omp. The shell command
`remote-omp` (daemon fleet, cron, devices, ...) needs the CLI on your PATH: run
`/remote-omp install` inside omp (it installs the supervisor service and links
`remote-omp` and `remote-omp-supervisord` into `~/.local/bin`), use the
installer above, or `npm install -g remote-omp`.

---

## Using `/remote-omp`

The bare command is the everyday entry point:

```text
/remote-omp
```

Behavior depends on whether there's a local config for this directory:

| State | What happens |
|---|---|
| First run (no `.omp/remote-omp/config.json`) | Interactive wizard → saves config → joins agent session → starts relay (if you opted in) |
| Returning user, auto-start enabled | Joins agent session + starts relay automatically, then prints status |
| Returning user, auto-start disabled | Joins the agent session without the relay (start it with `/remote-omp relay start`), then prints status |

Once a folder has a config with auto-start enabled, omp sessions started there
join the agent session and start the relay on their own, so you don't type the
command again (one-shot `omp -p` runs are left alone). A folder with no config
stays idle until you run `/remote-omp` in it once.

The wizard asks two questions, then a final "Save and activate?":

1. **Agent name** — the presentation leaf name for this agent. Senders still
   copy the complete opaque address returned by `list_peers`; they never build
   an address from this name. Defaults to the directory name.
2. **Use the relay on this terminal to connect to the remote mesh (mobile +
   PCs)?** — `Yes` if you want `/remote-omp` to also connect to the relay so
   the mobile app can reach this omp. `No` for local-only use (agent network
   without mobile access).

Every omp on a machine joins one local agent session (`local`), so there is no
session name to pick.

Re-run the wizard later with `/remote-omp setup`.

---

## Pairing a mobile device

Once the relay is up (`/remote-omp relay status` shows `started` or `paired`):

```text
/remote-omp pair
```

A QR code is printed in the terminal. Scan it with the Remote OMP mobile app.
Pairing is **per machine** — once a device is paired, every omp process on
this machine accepts it (it lives in `~/.omp/remote/peers.json`).

To list paired devices:

```text
/remote-omp devices
```

To remove one:

```text
/remote-omp revoke <shortid>
```

The shortid is the first 8 chars shown by `devices`.

---

## The relay

The relay is the network boundary. TLS protects transit, but the Relay can see
routed plaintext protocol content and metadata; use a relay you trust or
self-host. There is no systemwide or PC-mesh E2E guarantee. For PC-to-PC
forwarding, the Relay currently permits a route when any correctly signed Owner
blob lists both canonical PC keys (`Pi-key` in the protocol). That does not
prove the Owner paired with or controls either PC.

### Upgrade order (Relay 0.3 first, then Extension 0.6)

Upgrade the **Relay to 0.3 first**: an old Extension can consume the new
Relay's UUID errors. Extension 0.6 carries a one-release legacy wire-label
shim, so mixed new/old Extensions interoperate when both select the same unique
colon-free signed nickname label, or when neither has one and both use the
canonical standard-padded key prefix. Delimiter or collision cases, like
divergent nickname views, are unsupported and may be silently dropped by the
old receiver. Upgrade all Extension/MCP participants in one maintenance window.
The shim does not replace the receiver-local aliases returned by `list_peers`;
addresses remain opaque.

Extension 0.6 accepts an old Relay's lowercase 32-hex trusted error ID only as
a narrow shim for an old Relay or Relay rollback; that shim is not why
Relay-first is safe.

You have two options:

### Option A — Use the community relay

`https://relay-rp1.jacobmoura.work` (default). Zero setup. Good for trying
things out or for casual use. (The extension converts to `wss://…`
internally when opening the connection — both schemes point at the same
endpoint.)

Caveats:

- Shared infrastructure — availability is best-effort.
- **There is no IP allow-listing or VPN gating**.

### Option B — Self-host (recommended for privacy)

Run the relay yourself in Docker and put it behind a VPN like
[Tailscale](https://tailscale.com), [WireGuard](https://www.wireguard.com),
or your own VPC. Because the relay's network-level protection is just TLS +
keypair authentication, layering a VPN on top means **only your devices** can
even reach the WebSocket port — defense in depth.

Quick Docker outline (see the
[relay README](https://github.com/leoliu0/remote-omp/blob/main/relay/README.md#self-hosted-relay-recommended-for-privacy)
for the full setup, environment variables, and reverse-proxy guidance):

```bash
docker run -d \
  --name remote-omp-relay \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/jacobaraujo7/remote-pi-relay:latest
```

Bind the container to your VPN interface, terminate TLS in a reverse proxy,
and point both your PC and your phone at the resulting `https://…` URL. The
relay image is published by the upstream project and keeps its original name;
the relay protocol is unchanged.

### Pointing the extension at your own relay

Once your relay is reachable, tell the extension:

```text
/remote-omp relay url https://relay.yourdomain.tld
```

The URL **must** be `http://` or `https://` — `ws://` / `wss://` are
rejected at validation. The extension converts to WebSocket internally when
it opens the connection. Same canonical form for the mobile app and any
self-hosting docs: paste the URL your reverse proxy exposes.

This writes `~/.omp/remote/config.json` with `{ "relay": "..." }`. Resolution
order (highest precedence first):

1. `REMOTE_OMP_RELAY` environment variable (CI / one-off overrides)
2. `~/.omp/remote/config.json`
3. The built-in default (`https://relay-rp1.jacobmoura.work`)

Verify the active URL and its source with:

```text
/remote-omp config
```

If you change the URL while connected, run `/remote-omp relay stop` then
`/remote-omp relay start` (or `/remote-omp relay` to toggle).

The mobile app has its own relay-URL setting in its preferences pane — keep
both pointing at the same relay.

---

## Agent network: deeper look

Each session is one Unix-domain-socket broker plus N peers. The broker
multiplexes messages by opaque `to` address and broadcasts system events
(`peer_joined`, `peer_left`).

Inside the LLM, the agent skill uses `list_peers` for discovery and
`agent_send` for delivery:

```jsonc
list_peers() // copy a complete address from this result

agent_send({
  to: "/repo/api@backend", // exact opaque address returned by list_peers
  body: { task: "add /healthz endpoint" },
  re: "<id>" // set to the received message id when replying
})
```

A unicast `agent_send` waits for the broker delivery ACK and returns the public
status `received`, `denied`, or `timeout`; broadcast is fire-and-forget. A
trusted Relay's closed transport reason is returned in `details` without
changing those statuses: `offline` maps to `timeout`, while `not_authorized`
and `bad_envelope` map to `denied`. Genuine silence is a reasonless `timeout`.
Do not blindly retry authorization or envelope failures. Trusted Relay errors
are consumed internally to settle pending sends; forged or invalid reserved
bodies do not gain that authority.

Mesh addresses are opaque routing values: echo them verbatim, including
receiver-local PC aliases with percent-encoded bytes (such as `%3A` or `%25`)
or collision suffixes containing `~`. Never parse, build, decode, or normalize
an address for routing or security. A PC alias is receiver-local presentation
and routing only, so different PCs may list the same sibling under different
aliases. The canonical 32-byte Ed25519 PC public key (the protocol's `Pi-key`) is the PC's technical
identity; never use an alias as proof of identity.

`agent_request` remains available only as a deprecated legacy tool. Prefer
`agent_send`, then handle any later inbox/turn reply whose `re` matches the
original message id.

The wire format is a 5-field envelope `{ from, to, id, re, body }` serialized
as one JSON line per message. The leader's broker writes an `audit.jsonl`
log at `~/.omp/remote/sessions/<name>/audit.jsonl` for postmortem inspection.

Useful commands:

| Command | What it does |
|---|---|
| `/remote-omp` | Join the local mesh (and start the relay, if enabled) |
| `/remote-omp peers` | List local + cross-PC mesh peers, grouped by PC |
| `/remote-omp rename <new>` | Rename this agent in the current session |
| `/remote-omp stop` | Leave the local mesh and disconnect the relay |

Name collisions inside a session get a numeric suffix automatically
(`backend`, `backend#2`, `backend#3`). The broker assigns it and returns the
real name to the peer.

---

## Command reference

### Local session (one omp, one terminal)

| Command | Description |
|---|---|
| `/remote-omp` | Connect (join local mesh + start relay), or run setup on first use |
| `/remote-omp setup` | Run the setup wizard and update local config |
| `/remote-omp status` | Show local mesh + relay status |
| `/remote-omp stop` | Stop everything for **this** terminal (mesh + relay) |
| `/remote-omp restart` | Restart omp with the same launch flags, resuming this session |
| `/remote-omp pair [--ttl <seconds>]` | Show QR code + copy-paste pairing URI for a new mobile device |
| `/remote-omp devices` | List paired mobile devices (online/offline per device) |
| `/remote-omp revoke <shortid>` | Revoke a paired device by its shortid |
| `/remote-omp rename <new>` | Rename this agent in the current session |
| `/remote-omp peers` | List local + cross-PC mesh peers, grouped by PC |
| `/remote-omp set-relay <url>` | Persist a new relay URL (http:// or https://) |
| `/remote-omp relay [start\|stop\|status]` | Relay-only control — leaves local mesh membership untouched (no verb = toggle) |
| `/remote-omp relay url <url>` | Same as `set-relay` |
| `/remote-omp config` | Show the effective relay URL and its source (env / config / default) |
| `/remote-omp notify [status\|set <url>\|mode <m>\|test\|clear]` | Webhook / ntfy push alerts (see [Notifications](#notifications)) |
| `/remote-omp web` | Open the web client in browser (auto-detects local server on port 3000, falls back to hosted) |

`/rc` is a shorthand that routes to `/remote-omp`.

### Daemon fleet (one supervisor, N background omp agents — see [Daemon mode](#daemon-mode))

| Command | Description |
|---|---|
| `/remote-omp create <cwd> [--name X]` | Register a folder as a daemon (it runs `omp --mode rpc`) |
| `/remote-omp remove <id>` | Unregister a daemon from `~/.omp/remote/daemons.json` |
| `/remote-omp daemons` | List registered daemons + state |
| `/remote-omp daemon start [<id>]` | Start all registered daemons, or one by id |
| `/remote-omp daemon stop [<id>]` | Stop all running daemons, or one by id (`/remote-omp stop` stops only the local terminal) |
| `/remote-omp daemon restart [<id>]` | Restart all daemons, or one by id |
| `/remote-omp daemon status` | Detailed runtime status (pid, uptime, restart count) |
| `/remote-omp daemon send <id> "<text>"` | Send a prompt to a specific daemon |
| `/remote-omp cron add <id> "<expr>" "<prompt>"` | Schedule a recurring prompt (`--tz`, `--wake`, `--no-skip-busy`, `--catchup`) |
| `/remote-omp cron list` | List scheduled jobs (schedule, enabled, next run, last status) |
| `/remote-omp cron run <jobId>` | Fire a job now (ignores its schedule) |
| `/remote-omp cron enable\|disable <jobId>` | Toggle a job on/off |
| `/remote-omp cron remove <jobId>` | Delete a job |
| `/remote-omp cron log [<jobId>] [--tail N]` | Read the fire/skip audit log |
| `/remote-omp install` | Install `remote-omp-supervisord` as a per-user system service (and link the CLI into `~/.local/bin`) |
| `/remote-omp uninstall` | Remove the system service and the CLI links (registry preserved) |

All commands in this table work both as omp slash commands (interactive) and
as shell-level `remote-omp <subcommand>` once the CLI is on your PATH (see
[Install](#install)). The shell form also has `remote-omp restart-supervisor`,
which restarts the supervisor process (for example after an upgrade).

### Scheduled prompts (`cron`)

`remote-omp cron` schedules **recurring prompts** to daemons through the
supervisor — e.g. a daily "summarise new PRs". Output flows fire-and-forget to
the mesh/app like any prompt; the cron layer only audits the dispatch.

- **Schedule** is a cron expression (croner syntax; an optional 6th *seconds*
  field is supported), with an optional IANA timezone via `--tz`:

  ```sh
  remote-omp cron add a1b2c3d4 "0 9 * * *" "Summarise new PRs" --tz America/Sao_Paulo
  ```

- **Minimum interval is 60s** — more frequent schedules are rejected (guards
  token cost + pileup). A fire is **skipped when the daemon is mid-turn**
  (`--no-skip-busy` to override); `--wake` starts a stopped daemon first;
  `--catchup` runs once on supervisor start if the previous run was missed.
- **Prerequisite**: the supervisor must run as a service (`remote-omp install`).
  Without it there is no scheduler, and `cron` commands say so instead of
  silently pretending to schedule.
- **Audit**: every fire **and** every skip appends one line to
  `~/.omp/remote/cron.jsonl` with a `result` of `delivered`,
  `woke_and_delivered`, `deliver_failed`, `skipped_busy`, `skipped_down`, or
  `skipped_disabled` — read it with `remote-omp cron log`.

Step-by-step walkthrough: the [daemon tutorial](https://remote-pi.jacobmoura.work/tutorials/daemon).

### Footer + title

- `📡 local (N)` — current agent session and peer count (local mesh)
- `🟢 relay` — relay connected, at least one device paired (globally)
- `🟡 relay waiting for pairing` — relay connected, no device paired yet
- `📱 <shortid>` — a mobile device is actively connected right now

Window title: `<agent-name> · On` when relay is up, `<agent-name> · Off`
otherwise. Tells your terminals apart at a glance in `cmux`/`tmux`/iTerm
tabs.

---

## Notifications

The extension can push an alert to a webhook or an [ntfy](https://ntfy.sh)
topic when an agent finishes a turn, needs your input (a plan review, a
question, a confirmation) or hits an error, so you can leave the desk and still
know. It is separate from the phone app: the alert is a plain HTTP POST sent by
the PC.

```text
/remote-omp notify set https://ntfy.sh/my-topic --token <bearer-token> --mode offline
/remote-omp notify test
```

| Command | What it does |
|---|---|
| `/remote-omp notify` (or `notify status`) | Show the effective URL and where it comes from, the mode, whether a token is set, and whether a phone is online |
| `/remote-omp notify set <http(s)://url> [--token <tok>] [--mode offline\|always\|off]` | Save the endpoint (`/remote-omp set-notify <url>` is the same) |
| `/remote-omp notify mode <offline\|always\|off>` | Change when alerts are sent |
| `/remote-omp notify test` | Send a test alert now (ignores the phone-online gate; fails when the mode is `off`) |
| `/remote-omp notify clear` | Forget the URL and the token |

- **Modes.** `offline` (default) sends only while no phone is online for this
  PC; `always` sends regardless; `off` never sends.
- **Environment overrides.** `REMOTE_OMP_NOTIFY_URL`, `REMOTE_OMP_NOTIFY_TOKEN`
  and `REMOTE_OMP_NOTIFY_MODE` win over the values saved in
  `~/.omp/remote/config.json` (`notify_url`, `notify_token`, `notify_mode`).
- **Events.** `turn_done` (a short snippet of the answer; held for half a second
  so a turn that ends in a plan review sends only the `needs_input` alert),
  `needs_input` and `error`; the last two have `high` priority.
- **Payload.** Discord (`/api/webhooks/...`) and Slack (`hooks.slack.com`)
  webhook URLs get their native JSON. A URL ending in `.json` (or with
  `?format=json`) gets `{ event, title, body, session, cwd, hostname, priority,
  ts }`. Anything else, ntfy included, gets a plain-text POST with the message
  as the body and `Title`, `Priority`, `Tags` and `X-Remote-Omp-*` headers. A
  token is sent as `Authorization: Bearer <token>`.

---

## Daemon mode

When you want an omp agent to keep running in the background (responding to
mobile prompts at 3am, processing cron jobs, monitoring a folder while
you're not at the keyboard), promote it to a **daemon** managed by a
single OS-level supervisor. Every daemon is an `omp --mode rpc` process with
this extension loaded.

See [`docs/daemon.md`](./docs/daemon.md) for troubleshooting.

### One-time setup

```bash
# Put the CLI on your PATH. `omp plugin install remote-omp` makes the slash
# command available inside omp but does NOT expose the CLI binaries. Either
# run `/remote-omp install` inside omp (it installs the service below AND links
# `remote-omp` + `remote-omp-supervisord` into ~/.local/bin), or install the
# package globally:
npm install -g remote-omp

# Install the supervisor as a user-level system service. Linux uses
# systemd --user; macOS uses a launchd LaunchAgent; Windows uses a Task
# Scheduler task. All auto-start at login and survive reboots.
remote-omp install
```

The `install` command:
- Writes `~/.config/systemd/user/remote-omp-supervisord.service` (Linux),
  `~/Library/LaunchAgents/dev.remoteomp.supervisord.plist` (macOS), or
  registers the `RemoteOmpSupervisor` scheduled task (Windows)
- Activates it via `systemctl --user enable --now`, `launchctl bootstrap` or
  `schtasks`
- The supervisor starts immediately and re-starts on every login
- Removes the service a Remote Pi install left behind (see
  [Upgrading from Remote Pi](#upgrading-from-remote-pi))

### Per-folder workflow

Once pairing has been completed on this machine, any folder can be promoted to
a 24/7 daemon with no per-folder setup:

```bash
# Promote to a daemon. The id is derived from the cwd
# (sha256(realpath)[:8]), stable across machines. If the supervisor is already
# running, `create` starts the daemon immediately.
remote-omp create ~/Movies --name "Video Editor"
# → Daemon registered: id=4e39152d name="Video Editor" cwd=/Users/x/Movies

# If the supervisor was offline during `create`, start it after `install`:
remote-omp daemon start
```

The supervisor finds `omp` on the `PATH` it takes from your login shell and
starts it as `omp --mode rpc` with this extension loaded; there is nothing else
to choose per daemon.

### Staying reachable with every session closed

A registered daemon is the door that stays open when no terminal is. Only the
supervisor ends it, and only when you say so on the machine (`remote-omp daemon
stop`, `remove`, `uninstall`):

- A daemon that exits by itself is started again — a crash, a `kill`, or the
  app's **Quit session** (which then comes back as a fresh session). Retries
  back off (1 s, 5 s, 30 s, then every 5 min) and never stop.
- The supervisor is restarted by systemd/launchd whenever it exits, and starts
  at boot. On Linux run `loginctl enable-linger $USER` once so it starts
  without anyone logging in.
- On POSIX (Linux/macOS), daemons get the environment of a new terminal: at
  start the supervisor reads it from your login shell (`$SHELL -ilc`), so API
  keys and proxies exported in your rc files apply.

One always-on agent for the whole machine:

```bash
remote-omp install
remote-omp create ~ --name always-on
```

Now you can:

```bash
remote-omp daemons                  # list + state
remote-omp daemon status            # uptime, pid, restart count
remote-omp daemon send 4e39152d "Cut the first 30 seconds of latest clip"
remote-omp daemon stop              # stop all
remote-omp daemon restart           # restart all
```

The agent receives the prompt as if a user typed it; its response flows
back through the relay/mesh you configured during interactive setup —
mobile app sees it live, other agents on the same machine can see it
via the local UDS mesh.

### Removing or uninstalling

```bash
remote-omp remove <id>              # unregister one daemon (folder files untouched)
remote-omp uninstall                # remove the supervisor service (registry kept)
```

`uninstall` is reversible — re-running `install` later brings every
registered daemon back. To wipe the registry entirely, `rm
~/.omp/remote/daemons.json`.

### Where to find logs

| Platform | Command |
|---|---|
| Linux | `journalctl --user -u remote-omp-supervisord -f` |
| macOS | `tail -f ~/.omp/remote/supervisord.log` |
| Windows (PowerShell) | `Get-Content -Wait $HOME\.omp\remote\supervisord.log` |

Each spawned daemon's stderr is forwarded into the supervisor's log
with a `[<cwd>]` prefix, so a single log stream shows every agent.

### Caveats (plan/26 trade-offs)

- **Tool approval is not gated.** Daemons inherit the same omp config
  the interactive run uses — Bash, Edit, Write etc. all execute without
  prompting. Configure tool permissions to taste before promoting
  a folder to daemon.
- **Pairing still happens interactively.** Daemons don't show a QR
  themselves; the keypair + paired devices in `~/.omp/remote/` come from any
  prior interactive `/remote-omp` session on the same machine.
- **Single supervisor.** If `remote-omp-supervisord` crashes all daemons go
  down with it. systemd/launchd restarts it within seconds; daemons
  come back automatically.
- **One daemon per cwd.** The `roomIdForCwd` derivation makes daemons
  by-path; two daemons in the same folder is rejected at `create` time.

---

## Configuration files

| Path | Scope | What's in it |
|---|---|---|
| `<cwd>/.omp/remote-omp/config.json` | Per-directory (interactive) | `agent_name`, `auto_start_relay` |
| `~/.omp/remote/daemons.json` | Per-machine | Registered daemons (`cwd`, `name`) |
| `~/.omp/remote/config.json` | Per-user | `relay` URL, notification settings (`notify_url`, `notify_token`, `notify_mode`) |
| `~/.omp/remote/peers.json` | Per-machine | Paired mobile devices |
| `~/.omp/remote/identity.json` | Per-machine | The PC's key, where it is not kept in the system keyring (see below) |
| `~/.omp/remote/cron.json`, `cron.jsonl` | Per-machine | Scheduled prompts, and their fire/skip audit log |
| `~/.omp/remote/sessions/local/` | Per-machine | Broker socket + `audit.jsonl` |
| `~/.omp/remote/uploads/` | Per-machine | Files uploaded from the phone |
| `~/.omp/remote/skills/agent-network/SKILL.md` | Per-user | Agent skill the LLM reads |
| `~/.omp/remote/supervisord.log` | Per-machine | Supervisor log (macOS and Windows; on Linux it goes to the journal) |

`REMOTE_OMP_HOME` moves the whole tree: it replaces your home directory as the
parent, so the data lives in `$REMOTE_OMP_HOME/.omp/remote`.

The PC's Ed25519 key lives in the system keyring (service `dev.remoteomp.omp`)
on macOS and Windows. On Linux it is also kept in `identity.json` (mode `0600`),
because the keyring there may not survive a reboot;
`REMOTE_OMP_ALLOW_FILE_IDENTITY=1` makes a headless macOS or Windows host use
the file too.

### Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `REMOTE_OMP_HOME` | Replaces your home directory as the parent of the data directory | the OS home |
| `REMOTE_OMP_RELAY` | Relay URL for this run (wins over `config.json`) | none |
| `REMOTE_OMP_NOTIFY_URL`, `REMOTE_OMP_NOTIFY_TOKEN`, `REMOTE_OMP_NOTIFY_MODE` | Push notification endpoint, bearer token and mode; win over `config.json` (see [Notifications](#notifications)) | none, none, `offline` |
| `REMOTE_OMP_MAX_SEND_MIB` | Per-file cap of `send_to_phone`, in MiB | 256 |
| `REMOTE_OMP_MAX_UPLOAD_MIB` | Per-file cap of uploads from the phone, in MiB | 256 |
| `REMOTE_OMP_UPLOAD_RESERVE_MIB` | Free disk space uploads never use, in MiB | 1024 |
| `REMOTE_OMP_SYNC_LIMIT` | Most events the app gets in one `session_sync`; the app's own limit is clamped to it | 200 |
| `REMOTE_OMP_ASK_TIMEOUT_MS` | Daemons: how long an unanswered `ask` question or extension prompt waits for a phone before it gives up | 1800000 (30 min) |
| `REMOTE_OMP_ALLOW_FILE_IDENTITY` | `1` keeps the PC's key in `identity.json` instead of the keyring (headless hosts) | unset |
| `REMOTE_OMP_DAEMON`, `REMOTE_OMP_DAEMON_ID`, `REMOTE_OMP_DIRECT_CONFIG` | Set by the supervisor for each daemon: the `1` marker, its id, and the per-folder config as inline JSON. Not for everyday use; they are how you reproduce a daemon by hand (see [`docs/daemon.md`](./docs/daemon.md)) | none |
| `REMOTE_OMP_MCP_CWD`, `REMOTE_OMP_MCP_NAME` | Folder and agent name for the mesh MCP server that `remote-omp claude` starts; explicit overrides for manual launches | the launch folder and its name |

Override the relay for a single run without persisting:

```bash
REMOTE_OMP_RELAY=https://staging.example.tld omp
```

---

## Troubleshooting

**Footer says `🟡 relay waiting for pairing` even though I paired a device.**
The icon reflects whether *any* device has been paired on this machine, not
whether one is connected right now. If you really have a paired device in
`/remote-omp devices`, restart omp — the cache may be stale (fixed in current
release; report a bug if it recurs).

**Mobile app times out connecting.** Verify the same relay URL is configured
on both sides. If you self-host behind a VPN, your phone must also be on the
VPN (Tailscale on iOS/Android works fine).

**`agent_request` keeps timing out.** It is deprecated because it blocks the
turn while waiting for another agent's content reply. Migrate to `agent_send`;
a unicast waits only for the delivery ACK, and the receiver can reply later
with `agent_send` including `re: "<original-id>"` for correlation.

**Multiple terminals in the same directory.** Supported. They share the same
agent-network session (UDS broker) and the relay handles each omp process
independently. If the relay refuses with `RoomAlreadyOpenError`, stop the
other terminal first.

**The plugin is installed but `/remote-omp` does nothing.** Check that
`omp plugin list` shows `remote-omp` and that `omp plugin doctor` is clean. A
plugin linked from a clone must be built first (`pnpm build`): omp loads
`dist/index.js`. Make sure the pre-rename plugin is not installed next to it
(see [Upgrading from Remote Pi](#upgrading-from-remote-pi)).

**The log says the keyring is unavailable and the identity is file-backed.**
Expected on a headless Linux host, and in an omp built with Bun, which cannot
load the keyring binding: the PC's key then lives in `~/.omp/remote/identity.json`
(mode `0600`), and devices paired against an earlier keyring identity have to
pair again. On macOS or Windows the message means the keychain is locked or
access was denied: unlock it and run `/remote-omp` again — your pairing is not
lost.

---

## Upgrading from Remote Pi

Remote OMP is the renamed, omp-only successor of Remote Pi; the Pi coding agent
is no longer supported. The first start of the new version carries your setup
over by itself, so the steps below are mostly checks.

| | Remote Pi | Remote OMP |
|---|---|---|
| Slash command / CLI / supervisor | `/remote-pi`, `remote-pi`, `pi-supervisord` | `/remote-omp`, `remote-omp`, `remote-omp-supervisord` (`/rc` is unchanged) |
| Data directory | `~/.pi/remote` | `~/.omp/remote` |
| Per-folder config | `<cwd>/.pi/remote-pi/config.json` | `<cwd>/.omp/remote-omp/config.json` |
| Keyring service | `dev.remotepi.pi` | `dev.remoteomp.omp` |
| Supervisor service | `remote-pi-supervisord.service` · `dev.remotepi.supervisord` · `RemotePiSupervisor` | `remote-omp-supervisord.service` · `dev.remoteomp.supervisord` · `RemoteOmpSupervisor` |
| Environment variables | `REMOTE_PI_*` | `REMOTE_OMP_*` |
| Phone app | Remote Pi | Remote OMP (a separate app) |

1. **Swap the plugin.** Two Remote plugins would fight over the relay, so remove
   the old one and install the new one: `omp plugin uninstall remote-pi`, then
   `omp plugin install remote-omp` (or link your clone, see [Install](#install)).
   If you also ran `npm install -g remote-pi`, uninstall that too, and delete the
   stale CLI links `~/.local/bin/remote-pi` and `~/.local/bin/pi-supervisord`.
2. **The data directory is copied once, never moved.** The first time the new
   version starts (omp loading the extension, or the supervisor booting) it
   copies `~/.pi/remote` to `~/.omp/remote`. `~/.pi/remote` stays untouched, so
   old sessions that are still running keep working from it while you switch
   over. Everything durable is copied — `identity.json`, `web_identity.json`,
   `peers.json`, `config.json`, `daemons.json`, the cron state, `uploads/`,
   `skills/` and the logs — with its permission bits (keys stay `0600`) and
   modification times. Runtime state is not: the `locks/` folder, sockets, and
   `*.sock`, `*.pid` and `*.tmp` files. A file that already exists in
   `~/.omp/remote` is never overwritten. `~/.omp/remote/.migrated-from-pi` marks
   the copy as done; delete it to copy again. If the copy fails (disk full,
   permissions) the extension and the supervisor refuse to start, rather than run
   with an empty directory while the old one still holds your identity: fix the
   cause and start again. Delete `~/.pi/remote` by hand once no old session is
   left. With `REMOTE_OMP_HOME` set, both directories are resolved under it.
3. **The keyring entry is copied.** The PC's key moves from the keyring service
   `dev.remotepi.pi` to `dev.remoteomp.omp`; the old entry is kept (delete it in
   your keychain app when you no longer need it). On Linux the key is the file
   `identity.json`, which travels with the data directory.
4. **Per-folder config.** The first time a folder is used, its
   `.pi/remote-pi/config.json` is read once and its values are written to
   `.omp/remote-omp/config.json`; the old file is left in place.
5. **Replace the service.** `remote-omp install` stops and removes the old
   supervisor service (systemd unit, launchd label or Windows task) — the daemons
   it ran go down with it — and installs the new one. The daemons in the copied
   registry start again under it. A `harness` field in `daemons.json` is ignored
   (and dropped the next time the file is saved): every daemon now runs
   `omp --mode rpc`.
6. **Rename the environment variables.** `REMOTE_PI_*` are no longer read. In
   your shell rc, change them to `REMOTE_OMP_*` with the same suffix
   (`REMOTE_PI_HOME` → `REMOTE_OMP_HOME`, `REMOTE_PI_RELAY` → `REMOTE_OMP_RELAY`,
   …). `REMOTE_PI_HARNESS` is gone.
7. **Update extensions that talk to Remote Pi.** The in-process confirm events
   are now `remote-omp:confirm:request`, `remote-omp:confirm:answer` and
   `remote-omp:confirm:closed`; an extension such as TeX Guard must emit and
   listen for these names, because `remote-pi:confirm:*` is no longer
   recognised.
8. **Pair the phone again.** The Remote OMP app has its own application id and
   installs next to the Remote Pi app, with no pairings: run `/remote-omp pair`
   and scan the QR. You can remove the old app afterwards.

---

## Branding

Official brand assets live in
[`/branding`](https://github.com/leoliu0/remote-omp/tree/main/branding) —
SVG sources for the logo (full, foreground, background, monochrome) plus a
banner. See the
[branding README](https://github.com/leoliu0/remote-omp/blob/main/branding/README.md)
for palette and export sizes.

<table>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/leoliu0/remote-omp/main/branding/logo-full.svg" width="96" alt="logo-full" /><br/>
      <sub><code>logo-full</code></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/leoliu0/remote-omp/main/branding/logo-foreground.svg" width="96" alt="logo-foreground" /><br/>
      <sub><code>logo-foreground</code></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/leoliu0/remote-omp/main/branding/logo-monochrome.svg" width="96" alt="logo-monochrome" /><br/>
      <sub><code>logo-monochrome</code></sub>
    </td>
  </tr>
</table>

---

## Links

- Homepage: <https://remote-pi.jacobmoura.work>
- Source: <https://github.com/leoliu0/remote-omp>
- Upstream (Remote Pi, by Jacob Moura): <https://github.com/jacobaraujo7/remote_pi>
- omp (oh-my-pi): <https://github.com/can1357/oh-my-pi>
- Relay (self-hosting guide): <https://github.com/leoliu0/remote-omp/blob/main/relay/README.md>
- Issues / bugs: <https://github.com/leoliu0/remote-omp/issues>

---

## License

MIT — see [`LICENSE`](./LICENSE). Copyright (c) 2026 Jacob Moura, author of the
upstream Remote Pi project; this fork keeps that notice.

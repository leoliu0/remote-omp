<p align="center">
  <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-full.svg" width="160" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

> Extend the [Pi coding agent](https://github.com/earendil-works/pi) with two
> superpowers: agents that talk to each other on the same machine, and a mobile
> app that drives Pi from your phone.

**Homepage:** <https://remote-pi.jacobmoura.work>

`/remote-pi` is a single slash command that wires both at once. Run it; the
first time it asks a couple of questions and you are done.

## Protocol & Security

For wire format, identity model, ACK protocol, cross-PC routing, mesh
membership, and the trust model (what the relay sees and doesn't see),
read [`PROTOCOL.md`](../PROTOCOL.md) at the repo root. It is the canonical
document — this README only covers user-facing setup.

---

## Quick start

Install the extension (one-time):

```bash
pi install npm:remote-pi
```

Then in any Pi terminal:

```text
/remote-pi
```

The first run shows a short interactive wizard (agent name, default session,
whether to auto-start the relay). On every following run, `/remote-pi` joins
the local agent session and starts the relay automatically — no extra typing.

### Try the agent network in 30 seconds

Open **two** Pi terminals in the same directory and run `/remote-pi` in each.
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

Pi calls `agent_send({ to: "<exact address from list_peers>", body: {
type: "ping" } })`. For unicast, the call waits only for the broker's delivery
ACK. Terminal B receives the message as a user-facing turn and can answer later
with `agent_send`, setting `re` to the ping's message id; that reply arrives in
terminal A's inbox or a later turn. It does not block terminal A waiting for
agent-B's content reply.

Copy the complete address exactly as listed. Do not build, parse, decode, or
normalize it.

---

## What it does

Remote Pi adds two independent layers on top of Pi. You can use either, or
both:

### 1) Agent network (local broker, optional cross-PC relay)

Several Pi instances running side-by-side in different terminals can discover
each other and exchange messages. Each instance is a peer in a named
*session*. The LLM uses:

- `list_peers` — discover current peer routing addresses
- `agent_send` — unicast waits for the broker delivery ACK; broadcast is
  fire-and-forget

The legacy Pi-only `agent_request` tool is deprecated because it blocks while
waiting for another agent's content reply. Use `agent_send`, continue the
current turn, and receive any later reply through the inbox/turn flow with
`re` correlating it to the original message id.

Peers on the same machine talk over a Unix domain socket at
`~/.pi/remote/sessions/<session-name>/broker.sock`. When sibling PCs are paired,
a leader-capable Extension or MCP participant bridges the opaque cross-PC
addresses over the relay; local-only use stays on UDS when relay access is off.
Useful for splitting work across roles (`backend`, `frontend`, `tests`,
`orchestrator`, …) and letting them coordinate.

The first agent to enter a session becomes the *leader* (hosts the broker);
the rest are *followers*. If the leader exits, a follower automatically takes
over — the failover is invisible to the LLMs.

### 2) Mobile app (over the relay)

The companion mobile app lets you send prompts to Pi and read its responses
from your phone. The phone and the Pi process find each other through a
**relay**: a small WebSocket server that ferries messages between them.
Pairing is one-time and per device, via QR code.

Mobile text, image, and drained queued prompts check the live session's
`isIdle()` synchronously immediately before SDK handoff, after image preparation.
Idle sends omit `deliverAs` so Oh My Pi starts a turn instead of stranding it in
an explicit queue. Confirmed busy sends use `deliverAs: "steer"` for compatibility
with upstream Pi 0.79. Missing state falls back to OMP's default start/auto-steer
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

**Get the app** — all current download options (Google Play, App Store, and
direct builds while public releases roll out):

<https://remote-pi.jacobmoura.work/#get-the-app>

---

## Mobile app actions

Beyond the chat, the app surfaces a small set of typed actions you can run
on the paired Pi session. Tap the ⚙ button next to the message input (visible
when the input is empty) to open the Quick Actions sheet:

| Action | What it does |
|---|---|
| **Compact context** | Runs `ctx.compact()` — same as `/compact` in the TUI. |
| **New session** | Runs `ctx.newSession()` — equivalent to `/new`, asks for confirmation first. |
| **Model** | Opens a model picker fed by your authenticated providers (same source the TUI uses) and switches via `pi.setModel(model)`. |
| **Thinking** | Segmented control with the 6 SDK levels (`off` · `minimal` · `low` · `medium` · `high` · `xhigh`). Changes via `pi.setThinkingLevel(level)`. |

Each action gets a structured `action_ok` / `action_error` reply so the app
can show a SnackBar on failure. Visible side-effects (chat output, model
change broadcasts, compaction notice) still flow through the normal chat
channels. The wire schema is documented in [`PROTOCOL.md`](../PROTOCOL.md)
under "App actions".

It is **not** a generic slash-command picker. The Pi SDK does not expose
programmatic invocation for most builtins (those live in the TUI's
interactive loop), so the app exposes only the actions that have a clean
SDK call. The [`pi-telegram`](https://github.com/llblab/pi-telegram) adapter
follows the same pattern.

### Model roles (omp only)

Under omp, the app can also change omp's **model roles** (`modelRoles` in
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

**How the extension reaches omp's settings.** omp's extension loader maps
imports of `@oh-my-pi/pi-coding-agent/*` (and the `@earendil-works/…` alias)
in the extension's module graph to the modules bundled into the running omp
binary. `src/actions/model_roles.ts` dynamically imports
`config/settings` (`settings`, the live singleton), `config/model-roles`
(`getKnownRoleIds`, `getRoleInfo`, `roleCandidatePool`) and
`config/model-resolver` (`resolveModelRoleValue`, for aliases and patterns).
It requires `isSettingsInitialized()` to be true, so a stray separate copy of
omp's package is refused instead of edited. The YAML file is never written
directly: omp's next save would overwrite it. Under upstream pi the imports
fail and both frames answer with an error. These are omp internals, not its
documented extension API; checked on omp 18.12.2.

### Images

The app can attach **one image** (camera or gallery) to a message. It's
compressed on the device and rides **inline** in the `user_message` — the
optional `images` field carries `{ data: <base64>, mime }`. The pi-extension
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
come back; then the tool fails with `phone_offline: Remote Pi is not connected
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

The per-file cap is 256 MiB. Set **`REMOTE_PI_MAX_SEND_MIB`** to change it
(for example `REMOTE_PI_MAX_SEND_MIB=512`).

While the latest input came from a phone that is online, every provider
request carries one short note: *"The user is on Remote Pi (phone app or web)
and cannot see this PC's screen or files. To show an image, `read` the image
file: it appears in their chat. Use `send_to_phone` only when the user asks for
a file on their phone."* The web client signs in with the phone's owner key, so
its input counts as the same peer. The note keeps the same bytes and position until the input
source changes, so prompt caching still works. Input typed in the terminal (or
sent by an RPC client) removes it, and so does that phone disconnecting.

### Prompts from other extensions

A prompt drawn with `ctx.ui.custom` lives only in the terminal. An extension
can also put it on the app as a yes/no question through `pi.events`; the
first answer, terminal or app, wins:

| Channel | Sent by | Payload |
|---|---|---|
| `remote-pi:confirm:request` | the extension, when its prompt opens | `{ id, title, message }` (`message` is markdown) |
| `remote-pi:confirm:answer` | remote-pi, when the app answers | `{ id, confirmed }` (the app's cancel is `false`) |
| `remote-pi:confirm:closed` | the extension, once its prompt resolved | `{ id }`, which closes the question on the app |

TeX Guard's patch review uses it, so a `tex_edit` diff can be approved from
the phone. Without remote-pi loaded the events go nowhere.

---

## Install

Requirements: Node 20+, Pi (the host coding agent).

```bash
pi install npm:remote-pi
```

The extension self-registers the `/remote-pi` slash command and deploys an
agent skill that teaches the LLM how to use `list_peers`, `agent_send`, and the
event-driven inbox/reply flow.

To verify:

```text
/remote-pi config
```

It should print the effective relay URL and where it came from
(`env` / `config` / `default`).

---

## Using `/remote-pi`

The bare command is the everyday entry point:

```text
/remote-pi
```

Behavior depends on whether there's a local config for this directory:

| State | What happens |
|---|---|
| First run (no `.pi/remote-pi/config.json`) | Interactive wizard → saves config → joins agent session → starts relay (if you opted in) |
| Returning user, auto-start enabled | Joins agent session + starts relay automatically, then prints status |
| Returning user, auto-start disabled | Prints status only; join/relay must be run manually |

The wizard asks three questions:

1. **Agent name** — the presentation leaf name for this agent. Senders still
   copy the complete opaque address returned by `list_peers`; they never build
   an address from this name. Defaults to the directory name.
2. **Default session** — the name of the agent-network room for this
   directory. Multiple terminals in the same directory join the same session.
3. **Auto-start relay (for mobile app access)?** — `Yes` if you want
   `/remote-pi` to also connect to the relay so the mobile app can reach this
   Pi. `No` for local-only use (agent network without mobile access).

Re-run the wizard later with `/remote-pi setup`.

---

## Pairing a mobile device

Once the relay is up (`/remote-pi relay status` shows `started` or `paired`):

```text
/remote-pi pair
```

A QR code is printed in the terminal. Scan it with the Remote Pi mobile app.
Pairing is **per machine** — once a device is paired, every Pi process on
this machine accepts it (it lives in `~/.pi/remote/peers.json`).

To list paired devices:

```text
/remote-pi devices
```

To remove one:

```text
/remote-pi revoke <shortid>
```

The shortid is the first 8 chars shown by `devices`.

---

## The relay

The relay is the network boundary. TLS protects transit, but the Relay can see
routed plaintext protocol content and metadata; use a relay you trust or
self-host. There is no systemwide or PC-mesh E2E guarantee. For Pi-to-Pi
forwarding, the Relay currently permits a route when any correctly signed Owner
blob lists both canonical Pi keys. That does not prove the Owner paired with or
controls either Pi.

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
[relay README](https://github.com/jacobaraujo7/remote_pi/blob/main/relay/README.md#self-hosted-relay-recommended-for-privacy)
for the full setup, environment variables, and reverse-proxy guidance):

```bash
docker run -d \
  --name remote-pi-relay \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/jacobaraujo7/remote-pi-relay:latest
```

Bind the container to your VPN interface, terminate TLS in a reverse proxy,
and point both your Pi and your phone at the resulting `https://…` URL.

### Pointing Pi at your own relay

Once your relay is reachable, tell the extension:

```text
/remote-pi relay url https://relay.yourdomain.tld
```

The URL **must** be `http://` or `https://` — `ws://` / `wss://` are
rejected at validation. The extension converts to WebSocket internally when
it opens the connection. Same canonical form for the mobile app and any
self-hosting docs: paste the URL your reverse proxy exposes.

This writes `~/.pi/remote/config.json` with `{ "relay": "..." }`. Resolution
order (highest precedence first):

1. `REMOTE_PI_RELAY` environment variable (CI / one-off overrides)
2. `~/.pi/remote/config.json`
3. The built-in default (`https://relay-rp1.jacobmoura.work`)

Verify the active URL and its source with:

```text
/remote-pi config
```

If you change the URL while connected, run `/remote-pi relay stop` then
`/remote-pi relay start` (or `/remote-pi relay` to toggle).

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
aliases. The canonical 32-byte Ed25519 Pi public key is the PC's technical
identity; never use an alias as proof of identity.

`agent_request` remains available only as a deprecated legacy Pi tool. Prefer
`agent_send`, then handle any later inbox/turn reply whose `re` matches the
original message id.

The wire format is a 5-field envelope `{ from, to, id, re, body }` serialized
as one JSON line per message. The leader's broker writes an `audit.jsonl`
log at `~/.pi/remote/sessions/<name>/audit.jsonl` for postmortem inspection.

Useful commands:

| Command | What it does |
|---|---|
| `/remote-pi` | Join the local mesh (and start the relay, if enabled) |
| `/remote-pi peers` | List local + cross-PC mesh peers, grouped by PC |
| `/remote-pi rename <new>` | Rename this agent in the current session |
| `/remote-pi stop` | Leave the local mesh and disconnect the relay |

Name collisions inside a session get a numeric suffix automatically
(`backend`, `backend#2`, `backend#3`). The broker assigns it and returns the
real name to the peer.

---

## Command reference

### Local session (one Pi, one terminal)

| Command | Description |
|---|---|
| `/remote-pi` | Connect (join local mesh + start relay), or run setup on first use |
| `/remote-pi setup` | Run the setup wizard and update local config |
| `/remote-pi status` | Show local mesh + relay status |
| `/remote-pi stop` | Stop everything for **this** terminal (mesh + relay) |
| `/remote-pi pair` | Show QR code + copy-paste pairing URI for a new mobile device |
| `/remote-pi devices` | List paired mobile devices (online/offline per device) |
| `/remote-pi revoke <shortid>` | Revoke a paired device by its shortid |
| `/remote-pi set-relay <url>` | Persist a new relay URL (http:// or https://) |
| `/remote-pi relay [start\|stop\|status]` | Relay-only control — leaves local mesh membership untouched (no verb = toggle) |
| `/remote-pi relay url <url>` | Same as `set-relay` |
| `/remote-pi config` | Show the effective relay URL and its source (env / config / default) |
| `/remote-pi web` | Open the web client in browser (auto-detects local server on port 3000, falls back to hosted) |

### Daemon fleet (one supervisor, N background Pis — see [Daemon mode](#daemon-mode))

| Command | Description |
|---|---|
| `/remote-pi create <cwd> [--name X] [--harness pi\|omp]` | Register a folder as a daemon |
| `/remote-pi remove <id>` | Unregister a daemon from `~/.pi/remote/daemons.json` |
| `/remote-pi daemons` | List registered daemons + state |
| `/remote-pi daemon start [<id>]` | Start all registered daemons, or one by id |
| `/remote-pi daemon stop [<id>]` | Stop all running daemons, or one by id (`/remote-pi stop` stops only the local terminal) |
| `/remote-pi daemon restart [<id>]` | Restart all daemons, or one by id |
| `/remote-pi daemon status` | Detailed runtime status (pid, uptime, restart count) |
| `/remote-pi daemon send <id> "<text>"` | Send a prompt to a specific daemon |
| `/remote-pi cron add <id> "<expr>" "<prompt>"` | Schedule a recurring prompt (`--tz`, `--wake`, `--no-skip-busy`, `--catchup`) |
| `/remote-pi cron list` | List scheduled jobs (schedule, enabled, next run, last status) |
| `/remote-pi cron run <jobId>` | Fire a job now (ignores its schedule) |
| `/remote-pi cron enable\|disable <jobId>` | Toggle a job on/off |
| `/remote-pi cron remove <jobId>` | Delete a job |
| `/remote-pi cron log [<jobId>] [--tail N]` | Read the fire/skip audit log |
| `/remote-pi install` | Install `pi-supervisord` as a system service |
| `/remote-pi uninstall` | Remove the system service (registry preserved) |

All commands above work both as Pi slash commands (interactive) and as
shell-level `remote-pi <subcommand>` when the package is installed
globally (`npm install -g remote-pi`).

### Scheduled prompts (`cron`)

`remote-pi cron` schedules **recurring prompts** to daemons through the
supervisor — e.g. a daily "summarise new PRs". Output flows fire-and-forget to
the mesh/app like any prompt; the cron layer only audits the dispatch.

- **Schedule** is a cron expression (croner syntax; an optional 6th *seconds*
  field is supported), with an optional IANA timezone via `--tz`:

  ```sh
  remote-pi cron add a1b2c3d4 "0 9 * * *" "Summarise new PRs" --tz America/Sao_Paulo
  ```

- **Minimum interval is 60s** — more frequent schedules are rejected (guards
  token cost + pileup). A fire is **skipped when the daemon is mid-turn**
  (`--no-skip-busy` to override); `--wake` starts a stopped daemon first;
  `--catchup` runs once on supervisor start if the previous run was missed.
- **Prerequisite**: the supervisor must run as a service (`remote-pi install`).
  Without it there is no scheduler, and `cron` commands say so instead of
  silently pretending to schedule.
- **Audit**: every fire **and** every skip appends one line to
  `~/.pi/remote/cron.jsonl` with a `result` of `delivered`,
  `woke_and_delivered`, `deliver_failed`, `skipped_busy`, `skipped_down`, or
  `skipped_disabled` — read it with `remote-pi cron log`.

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

## Daemon mode

When you want a Pi to keep running in the background (responding to
mobile prompts at 3am, processing cron jobs, monitoring a folder while
you're not at the keyboard), promote it to a **daemon** managed by a
single OS-level supervisor.

See [`docs/daemon.md`](./docs/daemon.md) for troubleshooting.

### One-time setup

```bash
# Install the package globally so `remote-pi` and `pi-supervisord`
# are on your PATH (`pi install npm:remote-pi` alone makes the Pi
# extension available but does NOT expose the CLI binaries — see
# https://docs.npmjs.com/cli/v10/configuring-npm/package-json#bin).
npm install -g remote-pi

# Install the supervisor as a user-level system service. Linux uses
# systemd --user; macOS uses launchd LaunchAgent. Both auto-start at
# login and survive reboots.
remote-pi install
```

The `install` command:
- Writes `~/.config/systemd/user/remote-pi-supervisord.service` (Linux)
  or `~/Library/LaunchAgents/dev.remotepi.supervisord.plist` (macOS)
- Activates it via `systemctl --user enable --now` or `launchctl bootstrap`
- The supervisor starts immediately and re-starts on every login

### Per-folder workflow

Once pairing has been completed on this machine, any folder can be promoted to
a 24/7 daemon with no per-folder setup:

```bash
# Promote to a daemon. The id is derived from the cwd
# (sha256(realpath)[:8]), stable across machines. If the supervisor is already
# running, `create` starts the daemon immediately.
remote-pi create ~/Movies --name "Video Editor"
# → Daemon registered: id=4e39152d name="Video Editor" harness=pi cwd=/Users/x/Movies

# If the supervisor was offline during `create`, start it after `install`:
remote-pi daemon start
```

`--harness omp` runs the daemon on [oh-my-pi](https://github.com/can1357/oh-my-pi)
instead of Pi. Without the flag `create` uses `REMOTE_PI_HARNESS`, else the
harness you ran the command from, else `pi`.

### Staying reachable with every session closed

A registered daemon is the door that stays open when no terminal is. Only the
supervisor ends it, and only when you say so on the machine (`remote-pi daemon
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
remote-pi install
remote-pi create ~ --name always-on --harness omp
```

Now you can:

```bash
remote-pi daemons                  # list + state
remote-pi daemon status            # uptime, pid, restart count
remote-pi daemon send 4e39152d "Cut the first 30 seconds of latest clip"
remote-pi daemon stop              # stop all
remote-pi daemon restart           # restart all
```

The agent receives the prompt as if a user typed it; its response flows
back through the relay/mesh you configured during interactive setup —
mobile app sees it live, other agents on the same machine can see it
via the local UDS mesh.

### Removing or uninstalling

```bash
remote-pi remove <id>              # unregister one daemon (folder files untouched)
remote-pi uninstall                # remove the supervisor service (registry kept)
```

`uninstall` is reversible — re-running `install` later brings every
registered daemon back. To wipe the registry entirely, `rm
~/.pi/remote/daemons.json`.

### Where to find logs

| Platform | Command |
|---|---|
| Linux | `journalctl --user -u remote-pi-supervisord -f` |
| macOS | `tail -f ~/.pi/remote/supervisord.log` |

Each spawned daemon's stderr is forwarded into the supervisor's log
with a `[<cwd>]` prefix, so a single log stream shows every agent.

### Caveats (plan/26 trade-offs)

- **Tool approval is not gated.** Daemons inherit the same Pi/omp config
  the interactive run uses — Bash, Edit, Write etc. all execute without
  prompting. Configure tool permissions to taste before promoting
  a folder to daemon.
- **Pairing still happens interactively.** Daemons don't show a QR
  themselves; the keypair + paired devices in `~/.pi/remote/` come from any
  prior interactive `/remote-pi` session on the same machine.
- **Single supervisor.** If `pi-supervisord` crashes all daemons go
  down with it. systemd/launchd restarts it within seconds; daemons
  come back automatically.
- **One daemon per cwd.** The `roomIdForCwd` derivation makes daemons
  by-path; two daemons in the same folder is rejected at `create` time.

---

## Configuration files

| Path | Scope | What's in it |
|---|---|---|
| `<cwd>/.pi/remote-pi/config.json` | Per-directory (interactive) | `agent_name`, `auto_start_relay` |
| `~/.pi/remote/daemons.json` | Per-machine | Registered daemons (`cwd`, `name`, `harness`) |
| `~/.pi/remote/config.json` | Per-user | `relay` URL |
| `~/.pi/remote/peers.json` | Per-machine | Paired mobile devices |
| `~/.pi/remote/sessions/<name>/` | Per-session | Broker socket + `audit.jsonl` |
| `~/.pi/remote/skills/agent-network/SKILL.md` | Per-user | Agent skill the LLM reads |

`REMOTE_PI_MAX_SEND_MIB` (environment) sets the per-file cap of
`send_to_phone` in MiB (default 256).

Override the relay for a single run without persisting:

```bash
REMOTE_PI_RELAY=https://staging.example.tld pi
```

---

## Troubleshooting

**Footer says `🟡 relay waiting for pairing` even though I paired a device.**
The icon reflects whether *any* device has been paired on this machine, not
whether one is connected right now. If you really have a paired device in
`/remote-pi devices`, restart Pi — the cache may be stale (fixed in current
release; report a bug if it recurs).

**Mobile app times out connecting.** Verify the same relay URL is configured
on both sides. If you self-host behind a VPN, your phone must also be on the
VPN (Tailscale on iOS/Android works fine).

**`agent_request` keeps timing out.** It is deprecated because it blocks the
turn while waiting for another agent's content reply. Migrate to `agent_send`;
a unicast waits only for the delivery ACK, and the receiver can reply later
with `agent_send` including `re: "<original-id>"` for correlation.

**Multiple terminals in the same directory.** Supported. They share the same
agent-network session (UDS broker) and the relay handles each Pi process
independently. If the relay refuses with `RoomAlreadyOpenError`, stop the
other terminal first.

---

## Branding

Official brand assets live in
[`/branding`](https://github.com/jacobaraujo7/remote_pi/tree/main/branding) —
SVG sources for the logo (full, foreground, background, monochrome) plus a
banner. See the
[branding README](https://github.com/jacobaraujo7/remote_pi/blob/main/branding/README.md)
for palette and export sizes.

<table>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-full.svg" width="96" alt="logo-full" /><br/>
      <sub><code>logo-full</code></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-foreground.svg" width="96" alt="logo-foreground" /><br/>
      <sub><code>logo-foreground</code></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-monochrome.svg" width="96" alt="logo-monochrome" /><br/>
      <sub><code>logo-monochrome</code></sub>
    </td>
  </tr>
</table>

---

## Links

- Homepage: <https://remote-pi.jacobmoura.work>
- Source: <https://github.com/jacobaraujo7/remote_pi>
- Pi coding agent: <https://github.com/earendil-works/pi>
- Relay (self-hosting guide): <https://github.com/jacobaraujo7/remote_pi/blob/main/relay/README.md>
- Issues / bugs: <https://github.com/jacobaraujo7/remote_pi/issues>

---

## License

MIT

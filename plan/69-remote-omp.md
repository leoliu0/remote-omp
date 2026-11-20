# Plan 69 - Remote OMP: rename and omp-first compatibility

## Context

2026-11-20 the user asked: "change this repo to remote-omp, fully compatible with omp", and chose
the deepest rename ("Everything, incl. Android app id + GitHub repo"). Decision recorded in
`plan/00-decisions.md` ("Remote OMP rename"). omp = oh-my-pi (`@oh-my-pi/pi-coding-agent`,
https://github.com/can1357/oh-my-pi, 19.0.1 on x3d). The user chose **omp only**: upstream Pi
support is removed (harness option, Pi-only code paths, Pi docs). Runs after plan 68 is
integrated and committed, so the rename lands on a clean tree.

## Naming contract

| Thing | Old | New |
|---|---|---|
| Product name | Remote Pi | Remote OMP |
| GitHub repo | `leoliu0/remote_pi` | `leoliu0/remote-omp` (GitHub redirects the old URL) |
| Extension subproject | `pi-extension/` | `omp-extension/` |
| npm package | `remote-pi` | `remote-omp` |
| CLI | `remote-pi` | `remote-omp` |
| Supervisor binary | `pi-supervisord` | `remote-omp-supervisord` |
| systemd unit | `remote-pi-supervisord.service` | `remote-omp-supervisord.service` (`install` removes the old unit) |
| launchd label | `dev.remotepi.supervisord` | `dev.remoteomp.supervisord` (old one booted out) |
| Windows task | `RemotePiSupervisor` | `RemoteOmpSupervisor` (old one deleted) |
| Slash command | `/remote-pi` (+ `/rc`) | `/remote-omp` (+ `/rc`) |
| Env vars | `REMOTE_PI_*` | `REMOTE_OMP_*` (old names not read) |
| Data dir | `~/.pi/remote` | `~/.omp/remote` (`REMOTE_OMP_HOME` overrides home) — moved once |
| Keyring service | `dev.remotepi.pi` | `dev.remoteomp.omp` — copied once |
| Per-folder config | `<cwd>/.pi/remote-pi/config.json` | `<cwd>/.omp/remote-omp/config.json` — read old once, write new |
| Android application id | `work.jacobmoura.remotepi` | `work.jacobmoura.remoteomp` |
| Android label / APK | `Remote Pi` / `RemotePi.apk` | `Remote OMP` / `RemoteOMP.apk` |
| Cockpit | branding text only | application id unchanged |

Unchanged: relay wire protocol and message names, relay/rp-s3 crate names, the local checkout
path `/home/leo/Documents/remote_pi`, the `RemotePi_Pixel` AVD, and historical records
(plans 01-68, past CHANGELOG entries, `review/TESTING.md` rows, screenshots). License keeps
Jacob Moura's copyright; README credits the upstream project.

## Steps

1. **Extension** - `git mv pi-extension omp-extension`; package/bin/CLI/slash/env/data-dir/keyring/
   per-folder renames; one-time migrations with tests (move `~/.pi/remote` when the new dir is
   absent and no live lock sockets answer; copy keyring entry; per-folder config). Service install
   removes the old unit/label/task. Install path for omp: `omp plugin link <dir>` / `omp plugin
   install remote-omp`; README leads with omp.
2. **App** - application id, namespace, Kotlin package dir, label, APK name, in-app text, update
   channel names; tests.
3. **Cockpit, site, relay, rp-s3, branding, root docs, scripts** - text and references; site
   download names; scripts referencing `pi-extension`.
4. **omp compatibility audit** - every app/web feature against a real omp session in TUI and
   `--mode rpc`: chat, steering, queue, cancel, model/thinking/roles, plan mode, ask_user, goals,
   todos, subagents, restart/new/compact, retry, git sheet, upload, `@` files, new session,
   send_to_phone, mesh. Fix gaps; record a matrix in `review/TESTING.md`.
5. **Cutover on x3d** - migrate data, reinstall the service, relink the omp plugin, update
   `~/.zshrc` env names, restart sessions, rename the GitHub repo and `origin`.

## Definition of done

Typecheck/tests/build green for every subproject touched; the new APK installs next to the old
app on the emulator and pairs; the omp matrix is green or each gap is listed; the always-on
daemon runs under `remote-omp-supervisord.service`; GitHub shows `leoliu0/remote-omp`.

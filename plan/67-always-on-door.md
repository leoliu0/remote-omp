# Plan 67 — Always-on door: the PC stays controllable with zero sessions open

## Context

Reported (2026-11-19): "sometimes I closed all sessions so lost control, I need
to have control all the time."

Control today is a side effect of an interactive Pi/omp terminal: the extension
inside that process holds the relay connection. No process, no door. The
supervisor from plan 26 (`pi-supervisord`, systemd user unit) was built to keep
agents alive without a terminal, but it does not yet guarantee the door:

| # | How control is lost | Evidence | Fix |
|---|---|---|---|
| 1 | Every terminal session is closed | relay connection lives in the terminal process | supervisor-owned daemon (exists, plan 26) |
| 2 | Phone "quit session" (bin icon) on a daemon | app sends `/exit` → `process.exit(0)` → supervisor treats a clean exit as final | respawn on every exit the supervisor did not request |
| 3 | Daemon crash-loops for ~6 min | `RESTART_BACKOFFS_MS` exhausted → "giving up" | never give up; cap the backoff, reset it after a stable run |
| 4 | Harness binary missing at spawn (PATH not ready) | `error` handler leaves `child` set → every later `spawn()` is a no-op | clear the handle on spawn failure so the retry is real |
| 5 | `daemon stop` during a backoff does not stick | pending restart timer survives `_opStop` when state ≠ running | stop always cancels the pending restart |
| 6 | Supervisor exits 0 (stray SIGTERM) | unit has `Restart=on-failure` | `Restart=always` |
| 7 | User runs omp, supervisor spawns `pi` | `piBin` defaults to `pi`; omp has no `--approve`/`--name`, needs `--allow-home` in `~` | per-daemon harness (`pi` \| `omp`) with its own argv |
| 8 | Daemon lacks the terminal's environment | unit carries only `PATH` + `HOME`; clean-env probe lost the `gemini-search` MCP server | supervisor loads the login-shell environment at start |
| 9 | Reboot, nobody logged in | — | already covered: unit enabled + `loginctl enable-linger` |
| 10 | Network down / relay restart | — | already covered: relay reconnect ladder retries forever at 30 s |

## Invariant

While the PC is powered and online, at least one paired, relay-connected agent
exists, and no action available from the phone can remove it. Only local
authority ends a daemon: `remote-pi daemon stop|remove`, `remote-pi uninstall`.

Consequence: **the supervisor is the only authority over a daemon's lifetime.**
A child that exits for any reason the supervisor did not ask for is respawned.

## Scope

`pi-extension/` only. No protocol, relay, or app change. No new daemon: this
extends the plan-26 supervisor, as plan 63 requires.

## Steps

### 1. Supervisor owns the lifetime (`daemon/supervisor.ts`, `daemon/rpc_child.ts`)

- Exit event carries `requested` (supervisor called `stop()`) and `uptimeMs`
  instead of `isCrash`.
- `requested` → stays down. Private codes 42/43 → immediate recycle (unchanged).
  Anything else, exit 0 included → respawn after
  `backoff[min(attempt, last)]`; `attempt` resets once a run lasted ≥ 60 s.
- Exit 0 that nobody requested is the app's "quit session": the next spawn
  starts a fresh session (no `--continue`), same as `/new`.
- Spawn failure clears the child handle.
- `stop` / `stop_all` cancel a pending restart whatever the child state.

Acceptance: fake-harness tests — self-exit 0 respawns without `--continue`;
an always-failing harness is still being retried past the ladder length; a
missing binary is retried; `stop` during backoff produces no further spawn.

### 2. Harness per daemon (`daemon/harness.ts`, `daemon/registry.ts`, `index.ts`)

- `daemons.json` entry gains `harness` (`"pi"` default, so old files keep working).
- `remote-pi create <cwd> [--name X] [--harness pi|omp]`. Default: flag →
  `REMOTE_PI_HARNESS` → the harness running the command → `pi`. The supervisor
  exports `REMOTE_PI_HARNESS` to each child, so a daemon that creates another
  daemon from its shell keeps its own harness.
- argv: pi `--mode rpc --approve [--continue] [--name N] -e EXT`;
  omp `--mode rpc --allow-home [--continue] -e EXT`.

Acceptance: registry round-trip test; argv tests per harness; live omp daemon
answers a prompt (probe 2026-11-19: `omp --mode rpc -e dist/index.js` with
`REMOTE_PI_DAEMON=1` joined the mesh, opened one relay socket, took one cwd
lock, ran a bash tool call).

### 3. Login-shell environment (`daemon/shell_env.ts`, `bin/supervisord.ts`)

POSIX only. At start the supervisor runs `$SHELL -ilc 'env -0'` between
markers (10 s timeout) and overlays the result on its own environment; on any
failure it logs one line and continues with the unit's environment. Nothing is
written to disk, and a reboot picks up edited rc files.

Acceptance: parser test with rc noise around the block; fake-shell test;
missing shell → falls back.

### 4. Unit (`service-templates/systemd.service.template`)

`Restart=always`.

### 5. Docs

README daemon section + `docs/daemon.md` (drop "gives up after 4 attempts",
add harness flag, quit-respawn behaviour), CHANGELOG.

## Deploy on the reporting PC

```
remote-pi install
remote-pi create ~ --name always-on --harness omp
```

## Definition of Done

- [ ] `pnpm typecheck` + `pnpm test` green in `pi-extension/`
- [ ] Unit active after `systemctl --user restart`, daemon `running`
- [ ] `kill -9` of the daemon → respawned
- [ ] Clean exit of the daemon (the phone-quit path) → respawned, fresh session
- [ ] `kill` of the supervisor → systemd restarts it, daemon back
- [ ] Daemon visible on the local mesh and holding a relay socket
- [ ] Row in `review/TESTING.md`

## Not in this plan

- Relay-level health watchdog (process alive but relay rejected). The reconnect
  ladder already retries forever; add a watchdog only if a real stall is seen.
- Spawning sessions from the app UI. The door agent can run `remote-pi create`.
- macOS/Windows deploy verification (templates there already keep the
  supervisor alive: `KeepAlive`, Task Scheduler).

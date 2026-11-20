# Daemon mode — troubleshooting

Companion to the README's [Daemon mode](../README.md#daemon-mode) section.
Each scenario starts with the symptom you'd actually observe, followed by
likely causes and how to fix.

---

## 1. `remote-pi install` fails

### "supervisor script not found"

```
[remote-pi] install failed: Error: supervisor script not found at
/Users/x/dist/bin/supervisord.js. Run `pnpm build` (dev) or
`npm install -g remote-pi` (prod) first.
```

You're running `remote-pi install` from a dev clone where `dist/` doesn't
exist yet, or from a partial install.

```bash
# Dev clone:
cd pi-extension && pnpm build

# Production install:
npm install -g remote-pi      # or pnpm install -g remote-pi
which pi-supervisord          # confirm bin is on PATH
remote-pi install
```

### "launchctl: bootstrap … already running"

A previous install left a stale entry. The fix is built into `install` —
re-run it and the supervisor unloads the old entry before bootstrapping
the new one. If it still fails:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.remotepi.supervisord.plist
launchctl unload ~/Library/LaunchAgents/dev.remotepi.supervisord.plist 2>/dev/null
rm ~/Library/LaunchAgents/dev.remotepi.supervisord.plist
remote-pi install
```

### "systemctl --user … No such file or directory"

Linux without a logged-in graphical session (headless server). On most
distros `systemctl --user` requires `loginctl enable-linger <user>` so
the unit survives logout:

```bash
loginctl enable-linger $USER
systemctl --user daemon-reload
remote-pi install
```

---

## 2. Supervisor doesn't start at login

### Check the service status

```bash
# Linux
systemctl --user status remote-pi-supervisord
journalctl --user -u remote-pi-supervisord -n 50

# macOS
launchctl list | grep remotepi
tail -100 ~/.pi/remote/supervisord.log
```

### Common failures

- **`pi: command not found` / `omp: command not found`** in the log — the
  harness binary isn't on the PATH the supervisor resolved. On POSIX the
  supervisor overlays your login-shell environment at start, and the unit
  captures `process.env.PATH` at `remote-pi install` time; if you installed Pi
  or omp *after* installing the service, run `remote-pi restart-supervisor` (or
  `remote-pi install`).
- **`Cannot find module …`** — the path baked into the unit doesn't
  match where `dist/bin/supervisord.js` actually lives. Happens if you
  uninstalled then reinstalled the package to a different location.
  Fix: `remote-pi uninstall && remote-pi install`.
- **Permission denied on UDS** — `~/.pi/remote/` exists with wrong
  perms (rare; only happens if you ran `pi` as `sudo` once). Delete
  the dir and let it re-create: `rm -rf ~/.pi/remote && remote-pi install`.

### Run the supervisor in the foreground for debugging

Bypass systemd/launchd and run it directly so you can see startup
errors live:

```bash
pi-supervisord
# or: node /path/to/remote-pi/dist/bin/supervisord.js
```

Ctrl-C to stop. If that works but the service doesn't, check what
`systemctl --user show-environment` / `$SHELL -ilc` exports and re-run
`remote-pi install`.

---

## 3. A specific daemon keeps crashing

`remote-pi daemon status` shows one row flipping between `crashed` and
`running` with a growing restart count. The supervisor never gives up on a
registered daemon: it retries after 1s, 5s, 30s, then every 5min, and starts
the ladder over once a run has lasted a minute. To make it stay down, stop it:
`remote-pi daemon stop <id>`.

### Step 1 — read the daemon's stderr

The supervisor forwards each daemon's stderr with a `[<cwd>]` prefix:

```bash
# Linux
journalctl --user -u remote-pi-supervisord -f | grep '\[/Users/x/Movies\]'

# macOS
tail -f ~/.pi/remote/supervisord.log | grep '\[/Users/x/Movies\]'
```

### Step 2 — run that daemon manually

Reproduce the failure with full visibility:

```bash
cd /Users/x/Movies
# Pi daemon:
REMOTE_PI_DAEMON=1 REMOTE_PI_DIRECT_CONFIG='{"agent_name":"Movies","auto_start_relay":true}' \
  pi --mode rpc --approve -e $(npm root -g)/remote-pi/dist/index.js
# omp daemon:
REMOTE_PI_DAEMON=1 REMOTE_PI_DIRECT_CONFIG='{"agent_name":"Movies","auto_start_relay":true}' \
  omp --mode rpc --allow-home -e $(npm root -g)/remote-pi/dist/index.js
```

Common reasons a daemon won't start:

- **Registry entry missing or corrupt.** Run `remote-pi daemons` or inspect
  `~/.pi/remote/daemons.json` (`name`, `harness`, `cwd`). The supervisor
  injects `REMOTE_PI_DIRECT_CONFIG` from the registry; no per-cwd config file
  is needed.
- **Pi/omp auth or config drift.** Harness settings (model, API keys)
  failed → daemon fails to authenticate to the provider. Run
  `cd <cwd> && pi` (or `omp`) interactively to fix, or check your shell rc
  exports if keys come from env vars.
- **Port/UDS collision.** Another Pi/omp process is already running with the
  same `(cwd, name)`. Stop the other process, then restart the daemon; check
  `ls ~/.pi/remote/locks/` or `lsof ~/.pi/remote/locks/<roomId>.sock`.

### Step 3 — force a re-spawn

After fixing the underlying problem, kick the supervisor:

```bash
remote-pi daemon restart      # bounces every daemon
```

---

## 4. `daemon send` says "daemon not running"

The supervisor has the registry entry but no live child for that id.
Most common cause: the daemon is stopped or currently waiting between
crash-backoff retries.

```bash
remote-pi daemon status       # is state running?
remote-pi daemon start        # spawn any that aren't running
# Then retry send.
```

If `daemon start` shows `started=0, already_running=N`, the supervisor
isn't actually spawning. Possible reasons:
- Registry empty: `remote-pi daemons` to verify.
- Child crashes faster than the status check: `daemon status` immediately
  after start may still show `starting`/`running` for a moment before the
  exit event marks it crashed. Re-check 2-3 seconds later.

---

## 5. Mobile app doesn't connect to a daemon

The daemon is up but the app doesn't see it.

### Confirm the machine is paired

`pair_request` must have happened **before** the folder became a daemon
(daemons don't show QRs themselves; pairings in `~/.pi/remote/peers.json`
are machine-wide):

```bash
cd <daemon-cwd>
pi
> /remote-pi devices         # confirm the device is listed
> /remote-pi stop            # stop interactive session — daemon takes over
remote-pi daemon restart
```

### Confirm the relay URL matches

The daemon uses `agent_name` from `~/.pi/remote/daemons.json` (injected via
`REMOTE_PI_DIRECT_CONFIG`) and the relay URL from `~/.pi/remote/config.json`
(or `REMOTE_PI_RELAY`). Verify with:

```bash
remote-pi config
```

The relay line should match what the mobile app is connecting to. If
not, update the relay URL and bounce the daemon:

```bash
remote-pi set-relay https://relay.example.tld
remote-pi daemon restart
```

---

## 6. Registry corrupted / partial

Symptom: `remote-pi daemons` shows nothing or `remote-pi create` / `remove`
fails with a parse error despite having registered daemons.

```bash
cat ~/.pi/remote/daemons.json    # inspect
```

The file should be:

```json
{
  "daemons": [
    { "cwd": "/Users/x/Movies", "name": "Video Editor", "harness": "pi" },
    { "cwd": "/Users/x/Projects/backend", "name": "Backend", "harness": "omp" }
  ]
}
```

Fix the JSON manually if needed (or wipe and re-create):

```bash
rm ~/.pi/remote/daemons.json
remote-pi create ~/Movies --name "Video Editor" --harness pi
remote-pi create ~/Projects/backend --name "Backend" --harness omp
remote-pi daemon restart
```

---

## 7. Uninstall cleanly + re-install from scratch

When you suspect everything is misconfigured:

```bash
remote-pi uninstall              # removes service, keeps registry
rm -rf ~/.pi/remote               # nukes registry + paired devices + keys
npm uninstall -g remote-pi
npm install -g remote-pi
remote-pi install
# Then re-pair once on this machine + re-create daemons.
```

This is the "nuke everything" path. After this, `~/.pi/remote` is clean;
any interactive `<cwd>/.pi/remote-pi/config.json` files you created earlier
are untouched.

---

## 8. Diagnostic commands cheat-sheet

```bash
# Where is the supervisor's UDS?
ls -la ~/.pi/remote/supervisor.sock

# Talk to the supervisor manually (raw JSONL):
echo '{"op":"list"}' | nc -U ~/.pi/remote/supervisor.sock

# Where is the daemon registry?
cat ~/.pi/remote/daemons.json

# Where are the cwd locks?
ls ~/.pi/remote/locks/

# Where are the paired devices?
cat ~/.pi/remote/peers.json

# What unit / binary path is installed?
cat ~/.config/systemd/user/remote-pi-supervisord.service 2>/dev/null || cat ~/Library/LaunchAgents/dev.remotepi.supervisord.plist 2>/dev/null

# Quick liveness check
remote-pi daemon status
```

If after walking the list you're still stuck, file an issue with the
output of `remote-pi daemon status`, the recent supervisor log, and
the contents of `~/.pi/remote/daemons.json`.

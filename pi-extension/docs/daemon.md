# Daemon mode — troubleshooting

Companion to the README's [Daemon mode](../README.md#daemon-mode) section.
Each scenario starts with the symptom you'd actually observe, followed by
likely causes and how to fix.

---

## 1. `remote-omp install` fails

### "supervisor script not found"

```
[remote-omp] install failed: Error: supervisor script not found at
/Users/x/dist/bin/supervisord.js. Run `pnpm build` (dev) or
`npm install -g remote-omp` (prod) first.
```

You're running `remote-omp install` from a dev clone where `dist/` doesn't
exist yet, or from a partial install.

```bash
# Dev clone:
cd omp-extension && pnpm build

# Production install (pick one):
omp plugin install remote-omp   # then `/remote-omp install` inside omp links the CLI
npm install -g remote-omp       # or pnpm install -g remote-omp
which remote-omp-supervisord    # confirm bin is on PATH
remote-omp install
```

### "launchctl: bootstrap … already running"

A previous install left a stale entry. The fix is built into `install` —
re-run it and the supervisor unloads the old entry before bootstrapping
the new one. If it still fails:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.remoteomp.supervisord.plist
launchctl unload ~/Library/LaunchAgents/dev.remoteomp.supervisord.plist 2>/dev/null
rm ~/Library/LaunchAgents/dev.remoteomp.supervisord.plist
remote-omp install
```

### "systemctl --user … No such file or directory"

Linux without a logged-in graphical session (headless server). On most
distros `systemctl --user` requires `loginctl enable-linger <user>` so
the unit survives logout:

```bash
loginctl enable-linger $USER
systemctl --user daemon-reload
remote-omp install
```

---

## 2. Supervisor doesn't start at login

### Check the service status

```bash
# Linux
systemctl --user status remote-omp-supervisord
journalctl --user -u remote-omp-supervisord -n 50

# macOS
launchctl list | grep remoteomp
tail -100 ~/.omp/remote/supervisord.log
```

### Common failures

- **`omp: command not found`** in the log — omp isn't on the PATH the
  supervisor resolved. On POSIX the supervisor overlays your login-shell
  environment at start, and the unit captures `process.env.PATH` at
  `remote-omp install` time; if you installed omp *after* installing the
  service, run `remote-omp restart-supervisor` (or `remote-omp install`).
- **`Cannot find module …`** — the path baked into the unit doesn't
  match where `dist/bin/supervisord.js` actually lives. Happens if you
  uninstalled and reinstalled the plugin, or linked it from another clone
  (`omp plugin link`), after installing the service.
  Fix: `remote-omp uninstall && remote-omp install`.
- **Permission denied on UDS** — `~/.omp/remote/` exists with wrong
  perms (rare; only happens if you ran `omp` as `sudo` once). Give it back to
  your user and reinstall: `sudo chown -R "$USER" ~/.omp/remote && remote-omp install`.

### Run the supervisor in the foreground for debugging

Bypass systemd/launchd and run it directly so you can see startup
errors live:

```bash
remote-omp-supervisord
# or: node ~/.omp/plugins/node_modules/remote-omp/dist/bin/supervisord.js
```

Ctrl-C to stop. If that works but the service doesn't, check what
`systemctl --user show-environment` / `$SHELL -ilc` exports and re-run
`remote-omp install`.

---

## 3. A specific daemon keeps crashing

`remote-omp daemon status` shows one row flipping between `crashed` and
`running` with a growing restart count. The supervisor never gives up on a
registered daemon: it retries after 1s, 5s, 30s, then every 5min, and starts
the ladder over once a run has lasted a minute. To make it stay down, stop it:
`remote-omp daemon stop <id>`.

### Step 1 — read the daemon's stderr

The supervisor forwards each daemon's stderr with a `[<cwd>]` prefix:

```bash
# Linux
journalctl --user -u remote-omp-supervisord -f | grep '\[/Users/x/Movies\]'

# macOS
tail -f ~/.omp/remote/supervisord.log | grep '\[/Users/x/Movies\]'
```

### Step 2 — run that daemon manually

Reproduce the failure with full visibility:

```bash
cd /Users/x/Movies
REMOTE_OMP_DAEMON=1 REMOTE_OMP_DIRECT_CONFIG='{"agent_name":"Movies","auto_start_relay":true}' \
  omp --mode rpc --allow-home -e ~/.omp/plugins/node_modules/remote-omp/dist/index.js
```

`-e` takes the plugin's compiled entry, the same file the supervisor passes
(`omp plugin list --json` shows where your install keeps it).

Common reasons a daemon won't start:

- **Registry entry missing or corrupt.** Run `remote-omp daemons` or inspect
  `~/.omp/remote/daemons.json` (`name`, `cwd`). The supervisor
  injects `REMOTE_OMP_DIRECT_CONFIG` from the registry; no per-cwd config file
  is needed.
- **omp auth or config drift.** omp's settings (model, API keys)
  failed → daemon fails to authenticate to the provider. Run
  `cd <cwd> && omp` interactively to fix, or check your shell rc
  exports if keys come from env vars.
- **Port/UDS collision.** Another omp process is already running with the
  same `(cwd, name)`. Stop the other process, then restart the daemon; check
  `ls ~/.omp/remote/locks/` or `lsof ~/.omp/remote/locks/<roomId>.sock`.

### Step 3 — force a re-spawn

After fixing the underlying problem, kick the supervisor:

```bash
remote-omp daemon restart      # bounces every daemon
```

---

## 4. `daemon send` says "daemon not running"

The supervisor has the registry entry but no live child for that id.
Most common cause: the daemon is stopped or currently waiting between
crash-backoff retries.

```bash
remote-omp daemon status       # is state running?
remote-omp daemon start        # spawn any that aren't running
# Then retry send.
```

If `daemon start` shows `started=0, already_running=N`, the supervisor
isn't actually spawning. Possible reasons:
- Registry empty: `remote-omp daemons` to verify.
- Child crashes faster than the status check: `daemon status` immediately
  after start may still show `starting`/`running` for a moment before the
  exit event marks it crashed. Re-check 2-3 seconds later.

---

## 5. Mobile app doesn't connect to a daemon

The daemon is up but the app doesn't see it.

### Confirm the machine is paired

`pair_request` must have happened **before** the folder became a daemon
(daemons don't show QRs themselves; pairings in `~/.omp/remote/peers.json`
are machine-wide):

```bash
cd <daemon-cwd>
omp
> /remote-omp devices         # confirm the device is listed
> /remote-omp stop            # stop interactive session — daemon takes over
remote-omp daemon restart
```

### Confirm the relay URL matches

The daemon uses its `name` from `~/.omp/remote/daemons.json` (injected as
`agent_name` via `REMOTE_OMP_DIRECT_CONFIG`) and the relay URL from
`~/.omp/remote/config.json` (or `REMOTE_OMP_RELAY`). Verify with:

```bash
cat ~/.omp/remote/config.json    # {"relay": "https://…"}; no relay key = the community default
```

Inside any omp session, `/remote-omp config` prints the effective URL and where
it came from (`env` / `config` / `default`).

The relay line should match what the mobile app is connecting to. If
not, update the relay URL and bounce the daemon:

```bash
remote-omp set-relay https://relay.example.tld
remote-omp daemon restart
```

---

## 6. Registry corrupted / partial

Symptom: `remote-omp daemons` shows nothing or `remote-omp create` / `remove`
fails with a parse error despite having registered daemons.

```bash
cat ~/.omp/remote/daemons.json    # inspect
```

The file should be:

```json
{
  "daemons": [
    { "cwd": "/Users/x/Movies", "name": "Video Editor" },
    { "cwd": "/Users/x/Projects/backend", "name": "Backend" }
  ]
}
```

Fix the JSON manually if needed (or wipe and re-create):

```bash
rm ~/.omp/remote/daemons.json
remote-omp create ~/Movies --name "Video Editor"
remote-omp create ~/Projects/backend --name "Backend"
remote-omp daemon restart
```

---

## 7. Uninstall cleanly + re-install from scratch

When you suspect everything is misconfigured:

```bash
remote-omp uninstall             # removes the service and the ~/.local/bin links, keeps the registry
rm -rf ~/.omp/remote             # nukes the registry, paired devices and any file-backed identity
omp plugin uninstall remote-omp
omp plugin install remote-omp
# then, inside omp: /remote-omp install   (re-installs the service and re-links the CLI)
# Then re-pair once on this machine + re-create daemons.
```

This is the "nuke everything" path. After this, `~/.omp/remote` is clean;
any interactive `<cwd>/.omp/remote-omp/config.json` files you created earlier
are untouched. On macOS and Windows the PC's identity lives in the system
keyring instead of a file: remove the `dev.remoteomp.omp` entry there as well
for a truly fresh identity. If you upgraded from Remote Pi, also delete the old
data directory (see [Upgrading from Remote Pi](../README.md#upgrading-from-remote-pi)):
the next start would otherwise copy it back.

---

## 8. Diagnostic commands cheat-sheet

```bash
# Where is the supervisor's UDS?
ls -la ~/.omp/remote/supervisor.sock

# Talk to the supervisor manually (raw JSONL):
echo '{"op":"list"}' | nc -U ~/.omp/remote/supervisor.sock

# Where is the daemon registry?
cat ~/.omp/remote/daemons.json

# Where are the cwd locks?
ls ~/.omp/remote/locks/

# Where are the paired devices?
cat ~/.omp/remote/peers.json

# What unit / binary path is installed?
cat ~/.config/systemd/user/remote-omp-supervisord.service 2>/dev/null || cat ~/Library/LaunchAgents/dev.remoteomp.supervisord.plist 2>/dev/null

# Quick liveness check
remote-omp daemon status
```

If after walking the list you're still stuck, file an issue with the
output of `remote-omp daemon status`, the recent supervisor log, and
the contents of `~/.omp/remote/daemons.json`.

---

## 9. Sessions started from the phone

Home → your PC → **New session** starts an omp session in a folder you pick.
By default it is *ephemeral*: the supervisor runs it, but it has no entry in
`daemons.json`. It ends for good when its process does — the app's Quit, a
crash, `remote-omp daemon stop <id>` — and nothing restarts it. A supervisor
restart (reboot, `remote-omp restart-supervisor`) drops it. `remote-omp daemon
status` lists it as `ephemeral`; the app's New context and Restart still work
on it. **Keep always on** registers an ordinary daemon instead (section 3).

| The phone says | Why |
|---|---|
| "Run remote-omp install on the PC" | The supervisor is not running; phone-started sessions need it. |
| "…supervisor … is out of date" | The running supervisor predates this feature: `remote-omp restart-supervisor`. |
| "A session is already running in that folder" | A live agent holds that folder's lock: close it, or pick another folder. |
| "That folder is already an always-on session" | It is registered as a daemon: open its tile instead. |
| "omp did not start" | The supervisor could not launch `omp`; check it is on the PATH the supervisor imports from your login shell (section 2). |

---

## 10. After upgrading from Remote Pi

The upgrade steps are in the README ([Upgrading from Remote Pi](../README.md#upgrading-from-remote-pi));
these are the symptoms people hit.

| What you see | Why / fix |
|---|---|
| The supervisor or omp refuses to start: "Refusing to start with an empty `~/.omp/remote`" | The one-time copy of the old data directory failed (disk full, permissions). The old directory was not modified. Fix the cause and start omp again; the service manager retries the supervisor every few seconds, so it comes up by itself. |
| `remote-omp daemons` is empty | The copy has not run yet, or the new directory already had its own (empty) `daemons.json`: a copy never overwrites a file that exists. Remove that file, delete `~/.omp/remote/.migrated-from-pi` (no marker means "copy again") and restart the supervisor. |
| Two supervisors, or the old slash command still answers | The previous service or the previous omp plugin is still installed; the README's upgrade steps remove both. |
| The app shows no pairing | Remote OMP is a separate app from Remote Pi and starts unpaired: run `/remote-omp pair` and scan the QR. |

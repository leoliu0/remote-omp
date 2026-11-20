#!/usr/bin/env node
/**
 * `remote-omp-supervisord` — long-running daemon supervisor.
 *
 * Entry point of the `remote-omp-supervisord` binary (plan/26 W2, plan/67). Run by
 * systemd/launchd/Task Scheduler in production, or directly during dev:
 *
 *   pnpm build
 *   node dist/bin/supervisord.js
 *
 * Once running, it:
 *   - Copies `~/.pi/remote` to `~/.omp/remote` on the first start after the Remote
 *     OMP rename (the old directory is left untouched; plan 69)
 *   - Reads `~/.omp/remote/daemons.json`
 *   - Binds `~/.omp/remote/supervisor.sock` (or Windows named pipe) for CLI control
 *   - Loads the login-shell environment on POSIX so daemons get terminal API keys/proxies
 *   - Spawns `omp --mode rpc -e <remote-omp/dist/index.js>` per entry
 *   - Respawns any daemon exit it did not request (crash, kill, or clean exit)
 *
 * Exits cleanly on SIGTERM/SIGINT (used by `remote-omp uninstall` / service stop).
 */
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { filterLoginShellEnv, loginShellEnv } from "../daemon/shell_env.js";
import {
  getSupervisorSockPath,
  Supervisor,
  SupervisorAlreadyRunningError,
} from "../daemon/supervisor.js";
import {
  DataDirMigrationError,
  describeDataDirMigration,
  ensureDataDirMigrated,
} from "../legacy_migration.js";

/** The migration module tags its messages `[remote-omp]`; here they carry the supervisor's own prefix. */
const MODULE_TAG = /^\[remote-omp\]\s*/;

const HELP_TEXT = `remote-omp-supervisord — Remote OMP daemon supervisor

Usage: remote-omp-supervisord

Runs the long-lived supervisor: reads ~/.omp/remote/daemons.json, spawns one
omp --mode rpc child per entry, and listens on the control socket
(~/.omp/remote/supervisor.sock on POSIX) for requests from \`remote-omp\`.

This binary takes NO arguments — it is normally launched by systemd/launchd
(via \`remote-omp install\`), not by hand. Manage the fleet with:
  remote-omp daemon start | stop | restart | status
  remote-omp daemons

Options:
  -h, --help      Show this help and exit
  -v, --version   Print version and exit
`;

async function resolveChildEnvFromLoginShell(): Promise<NodeJS.ProcessEnv | undefined> {
  if (process.platform === "win32") return undefined;

  let shell = process.env["SHELL"]?.trim();
  if (!shell) {
    try {
      shell = userInfo().shell?.trim() || undefined;
    } catch (err) {
      process.stderr.write(
        `[remote-omp-supervisord] could not determine login shell via userInfo: ${String(err)}\n`,
      );
    }
  }
  if (!shell) {
    process.stderr.write("[remote-omp-supervisord] SHELL is unset; using the service environment\n");
    return undefined;
  }

  const res = await loginShellEnv({ shell });
  if (!res.ok) {
    process.stderr.write(
      `[remote-omp-supervisord] could not read env from ${shell} (${res.reason})` +
        `${res.stderr ? `: ${res.stderr}` : ""}; using the service environment\n`,
    );
    return undefined;
  }

  const filtered = filterLoginShellEnv(res.env, process.env);
  process.stderr.write(
    `[remote-omp-supervisord] loaded ${Object.keys(filtered).length} env vars from ${shell}\n`,
  );
  return { ...process.env, ...filtered };
}

async function main(): Promise<void> {
  // Guard: any stray argument used to fall through and start a FULL
  // supervisor (a `remote-omp-supervisord --help` once ran for days). Handle the
  // conventional flags explicitly and reject unknown args instead of
  // silently spawning the daemon fleet.
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    process.stdout.write("remote-omp-supervisord (remote-omp)\n");
    return;
  }
  if (args.length > 0) {
    process.stderr.write(
      `remote-omp-supervisord: unexpected argument(s): ${args.join(" ")}\n` +
        "This binary takes no arguments. Run `remote-omp-supervisord --help`.\n",
    );
    process.exit(2);
  }

  // Carry the data directory over from the pre-rename location (a COPY: sessions of the old
  // version may still run from it) before anything reads the registry or binds the socket.
  // `Supervisor` itself never migrates. A failure throws `DataDirMigrationError`, handled
  // below: starting on an empty directory would mint a new identity and orphan every paired phone.
  const copied = describeDataDirMigration(await ensureDataDirMigrated());
  if (copied) process.stderr.write(`[remote-omp-supervisord] ${copied.replace(MODULE_TAG, "")}\n`);

  // The supervisor needs to point each spawned daemon at the extension
  // entry it's bundled with. We're at `dist/bin/supervisord.js` after
  // build; the extension is the sibling `dist/index.js`.
  const here = fileURLToPath(import.meta.url);
  const distRoot = dirname(dirname(here)); // dist/bin → dist
  const extensionPath = join(distRoot, "index.js");

  // Load the login-shell environment AFTER UDS binding succeeds (via loadChildEnv)
  // so colliding instances fail fast without spawning an interactive shell, and
  // keep shell ephemera out of the supervisor's own process.env.
  const supervisor = new Supervisor({
    extensionPath,
    loadChildEnv: resolveChildEnvFromLoginShell,
  });
  await supervisor.start();
  process.stderr.write(
    `[remote-omp-supervisord] up — UDS: ${getSupervisorSockPath()}, extension: ${extensionPath}\n`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[remote-omp-supervisord] received ${signal}, shutting down\n`);
    try {
      await supervisor.stop();
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `[remote-omp-supervisord] shutdown error on ${signal}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // "Already running" is expected when a manual supervisor overlaps systemd/launchd:
  // exit 0 so the unit isn't marked `failed`, while `Restart=always` / `KeepAlive`
  // retries cleanly after `RestartSec=5s` until the other instance exits.
  if (err instanceof SupervisorAlreadyRunningError) {
    process.stderr.write(`[remote-omp-supervisord] ${err.message}\n`);
    process.exit(0);
  }
  // The data directory could not be carried over: exit non-zero (the service manager retries)
  // instead of starting on an empty one while the old directory holds the paired identity.
  if (err instanceof DataDirMigrationError) {
    process.stderr.write(`[remote-omp-supervisord] ${err.message.replace(MODULE_TAG, "")}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `[remote-omp-supervisord] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});

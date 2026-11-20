#!/usr/bin/env node
/**
 * `pi-supervisord` — long-running daemon supervisor.
 *
 * Entry point of the `pi-supervisord` binary (plan/26 W2, plan/67). Run by
 * systemd/launchd/Task Scheduler in production, or directly during dev:
 *
 *   pnpm build
 *   node dist/bin/supervisord.js
 *
 * Once running, it:
 *   - Reads `~/.pi/remote/daemons.json`
 *   - Binds `~/.pi/remote/supervisor.sock` (or Windows named pipe) for CLI control
 *   - Loads the login-shell environment on POSIX so daemons get terminal API keys/proxies
 *   - Spawns `<harness> --mode rpc -e <remote-pi/dist/index.js>` (`pi` or `omp`) per entry
 *   - Respawns any daemon exit it did not request (crash, kill, or clean exit)
 *
 * Exits cleanly on SIGTERM/SIGINT (used by `remote-pi uninstall` / service stop).
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

const HELP_TEXT = `pi-supervisord — Remote Pi daemon supervisor

Usage: pi-supervisord

Runs the long-lived supervisor: reads ~/.pi/remote/daemons.json, spawns one
<harness> --mode rpc child (pi or omp) per entry, and listens on the control
socket (~/.pi/remote/supervisor.sock on POSIX) for requests from \`remote-pi\`.

This binary takes NO arguments — it is normally launched by systemd/launchd
(via \`remote-pi install\`), not by hand. Manage the fleet with:
  remote-pi daemon start | stop | restart | status
  remote-pi daemons

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
        `[pi-supervisord] could not determine login shell via userInfo: ${String(err)}\n`,
      );
    }
  }
  if (!shell) {
    process.stderr.write("[pi-supervisord] SHELL is unset; using the service environment\n");
    return undefined;
  }

  const res = await loginShellEnv({ shell });
  if (!res.ok) {
    process.stderr.write(
      `[pi-supervisord] could not read env from ${shell} (${res.reason})` +
        `${res.stderr ? `: ${res.stderr}` : ""}; using the service environment\n`,
    );
    return undefined;
  }

  const filtered = filterLoginShellEnv(res.env, process.env);
  process.stderr.write(
    `[pi-supervisord] loaded ${Object.keys(filtered).length} env vars from ${shell}\n`,
  );
  return { ...process.env, ...filtered };
}

async function main(): Promise<void> {
  // Guard: any stray argument used to fall through and start a FULL
  // supervisor (a `pi-supervisord --help` once ran for days). Handle the
  // conventional flags explicitly and reject unknown args instead of
  // silently spawning the daemon fleet.
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    process.stdout.write("pi-supervisord (remote-pi)\n");
    return;
  }
  if (args.length > 0) {
    process.stderr.write(
      `pi-supervisord: unexpected argument(s): ${args.join(" ")}\n` +
        "This binary takes no arguments. Run `pi-supervisord --help`.\n",
    );
    process.exit(2);
  }

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
    `[pi-supervisord] up — UDS: ${getSupervisorSockPath()}, extension: ${extensionPath}\n`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[pi-supervisord] received ${signal}, shutting down\n`);
    try {
      await supervisor.stop();
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `[pi-supervisord] shutdown error on ${signal}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
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
    process.stderr.write(`[pi-supervisord] ${err.message}\n`);
    process.exit(0);
  }
  process.stderr.write(
    `[pi-supervisord] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});

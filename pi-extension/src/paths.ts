import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Remote OMP keeps its machine-wide state.
 *
 * Every module that touches the data directory (peers, identity, daemon
 * registry, sockets, uploads, logs…) resolves it through {@link remoteOmpHome}
 * at CALL time — never at import time — so `REMOTE_OMP_HOME` can redirect the
 * whole tree (tests, a daemon run as another user, a sandbox) and the one-time
 * migration from the pre-rename location (`legacy_migration.ts`) can run before
 * anything is created in the new directory.
 */

/** Env var that replaces the OS home directory as the root of {@link remoteOmpHome}. */
export const REMOTE_OMP_HOME_ENV = "REMOTE_OMP_HOME";

/** The directory the data tree hangs off: `$REMOTE_OMP_HOME`, else the OS home. */
export function homeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[REMOTE_OMP_HOME_ENV] || homedir();
}

/**
 * `<home>/.omp/remote` — the Remote OMP data directory (`peers.json`,
 * `identity.json`, `daemons.json`, `config.json`, `supervisor.sock`, `locks/`,
 * `sessions/`, `uploads/`, `supervisord.log`…). `<home>` is `$REMOTE_OMP_HOME`
 * when set, else the OS home.
 */
export function remoteOmpHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), ".omp", "remote");
}

/**
 * `<home>/.pi/remote` — where the same data lived before the Remote OMP rename.
 * Only the one-time migration reads it; nothing else may write there.
 */
export function legacyRemotePiHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeRoot(env), ".pi", "remote");
}

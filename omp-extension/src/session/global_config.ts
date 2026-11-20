import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { remoteOmpHome } from "../paths.js";
import { ipcAddress, usesNamedPipe } from "./ipc.js";

/**
 * Fixed UDS session name. The local mesh is single per machine — every omp
 * process on the host shares this broker. Previous versions exposed
 * multi-session support (named sessions, leave/rename/sessions commands);
 * those were removed in the 2026-05-23 simplification because in practice
 * every install converged on one session anyway and multi-session UX added
 * friction without value.
 */
export const LOCAL_SESSION_NAME = "local";

/** Ensures the new subdirs exist inside the existing ~/.omp/remote/. */
export function ensureGlobalDirs(): void {
  mkdirSync(sessionsDir(), { recursive: true });
  mkdirSync(skillsDir(), { recursive: true });
}

/**
 * Local-IPC address for a session's broker. POSIX → a `.sock` file under the
 * session dir; Windows → a per-user named pipe (plan/40). The `net` API treats
 * both the same; only the address string differs.
 */
export function sessionSockPath(name: string): string {
  return ipcAddress(`broker-${name}`, join(sessionsDir(), name, "broker.sock"));
}

/** Path to the audit log for a named session. */
export function sessionAuditPath(name: string): string {
  return join(sessionsDir(), name, "audit.jsonl");
}

/** Path to the session metadata JSON. */
export function sessionMetaPath(name: string): string {
  return join(sessionsDir(), name, "session.json");
}

// Both dirs hang off `remoteOmpHome()`, resolved at call time (never at import
// time) so `REMOTE_OMP_HOME` can redirect the whole tree and the one-time
// legacy data-dir migration (`legacy_migration.ts`) can run before anything is created.
export function sessionsDir(): string {
  return join(remoteOmpHome(), "sessions");
}

export function skillsDir(): string {
  return join(remoteOmpHome(), "skills");
}

/** Lists discovered session names from disk. */
export function listSessions(): string[] {
  ensureGlobalDirs();
  try {
    return readdirSync(sessionsDir()).filter((entry) => {
      try {
        return statSync(join(sessionsDir(), entry)).isDirectory();
      } catch { return false; }
    });
  } catch {
    return [];
  }
}

/**
 * Heuristic: a session has an existing broker socket FILE (POSIX only). On
 * Windows the broker is a named pipe with no file to stat, so this returns
 * false — the authoritative liveness check there is a connect-probe
 * (`leader_election.tryConnect` / `client.supervisorOnline`), not this. Only
 * legacy `session/wizard.ts` consumes this.
 */
export function sessionHasSock(name: string): boolean {
  if (usesNamedPipe()) return false;
  return existsSync(sessionSockPath(name));
}

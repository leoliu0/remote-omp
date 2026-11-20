/**
 * CLI ↔ supervisor IPC contract for `~/.omp/remote/supervisor.sock`.
 *
 * Framing: one JSON object per line, newline-terminated. The CLI sends a
 * single `ControlRequest`, the supervisor sends a single `ControlReply`,
 * both close the connection. No multiplexing, no streaming — each command
 * is a short round-trip.
 *
 * Plan/26 W2. The `omp --mode rpc` protocol used by the daemon children
 * themselves is a separate contract — see omp's `modes/rpc/rpc-types.ts`.
 * This file is strictly the supervisor's own control plane.
 */

import type { CronJob } from "./cron_registry.js";
import type { CronLogEntry } from "./cron_log.js";

/** Per-daemon runtime state observable through the supervisor. */
export type DaemonState = "running" | "stopped" | "starting" | "crashed";

export interface DaemonInfo {
  id: string;            // sha256(cwd)[0..8] — see daemon/id.ts
  cwd: string;           // absolute realpath
  name: string;          // from ~/.omp/remote/daemons.json (fallback: defaultAgentName(cwd))
  state: DaemonState;
  pid?: number;          // current process pid, when running
  uptime_s?: number;     // since last successful spawn, when running
  restart_count?: number;
  /** Plan/68: started from the phone, not stored in daemons.json. The supervisor
   *  never respawns it after a crash or quit and drops it on shutdown. */
  ephemeral?: boolean;
}

/** Requests sent CLI → supervisor. */
export type ControlRequest =
  | { op: "list" }
  | { op: "status" }
  | { op: "start_all" }
  // `fresh`: the first spawn starts a new session instead of resuming the folder's latest (`--continue`).
  | { op: "start"; id: string; fresh?: boolean }
  | { op: "stop_all" }
  | { op: "stop"; id: string }
  | { op: "restart_all" }
  | { op: "restart"; id: string }
  // `streaming_behavior`: how omp queues the prompt when the child is mid-run (omp refuses a
  // `prompt` frame without one then). Default `followUp`: a CLI `send` waits for the run to end.
  | { op: "send"; id: string; text: string; streaming_behavior?: "steer" | "followUp" }
  | { op: "register"; cwd: string; name?: string }
  | { op: "unregister"; id: string }
  // Plan/68: run a session the registry does not know (see Supervisor._opSpawnEphemeral).
  | { op: "spawn_ephemeral"; cwd: string; name: string }
  // ── cron (plan/39) ──
  | { op: "cron_add"; daemon_id: string; schedule: string; prompt: string; tz?: string; skip_if_busy?: boolean; wake?: boolean; catchup?: boolean }
  | { op: "cron_list" }
  | { op: "cron_remove"; job_id: string }
  | { op: "cron_enable"; job_id: string; enabled: boolean }
  | { op: "cron_run"; job_id: string }
  | { op: "cron_log"; job_id?: string; tail?: number };

/** Replies sent supervisor → CLI. Tagged by `ok` boolean. */
export type ControlReply<T = unknown> =
  | { ok: true; data?: T }
  // `code` is a stable machine-readable reason (e.g. `cwd_busy`); `error` is for humans.
  | { ok: false; error: string; code?: string };

/**
 * Response shapes per op. Keep in sync with the supervisor handlers in
 * `daemon/supervisor.ts`. Used for typed client calls.
 */
export interface ControlReplyShapes {
  list: { daemons: DaemonInfo[] };
  status: { daemons: DaemonInfo[] };
  start_all: { started: string[]; already_running: string[] };
  start: { id: string; state: DaemonState; started: boolean };
  stop_all: { stopped: string[]; already_stopped: string[] };
  stop: { id: string; state: DaemonState; stopped: boolean };
  restart_all: { restarted: string[] };
  restart: { id: string; state: DaemonState; restarted: boolean };
  send: { id: string; delivered: boolean };
  register: { id: string; cwd: string; name: string };
  unregister: { removed: boolean; cwd?: string };
  spawn_ephemeral: { id: string; cwd: string; name: string; state: DaemonState };
  // ── cron (plan/39) ──
  cron_add: { job: CronJobView };
  cron_list: { jobs: CronJobView[] };
  cron_remove: { removed: boolean };
  cron_enable: { job_id: string; enabled: boolean; updated: boolean };
  cron_run: { job_id: string; result: string };
  cron_log: { entries: CronLogEntry[] };
}

/** A cron job plus its computed `next_run` (ISO), for `cron list`. */
export type CronJobView = CronJob & { next_run?: string | null };

/** Convenience for typed `Client.request<...>("op")` calls. */
export type ControlReplyFor<Op extends ControlRequest["op"]> =
  Op extends keyof ControlReplyShapes ? ControlReplyShapes[Op] : never;

// ── Serialization helpers ────────────────────────────────────────────────────

const TRAILING_NEWLINE = "\n";

export function encodeRequest(req: ControlRequest): string {
  return JSON.stringify(req) + TRAILING_NEWLINE;
}

export function encodeReply<T>(reply: ControlReply<T>): string {
  return JSON.stringify(reply) + TRAILING_NEWLINE;
}

/**
 * Parses a single JSON line into a request. Throws on malformed input —
 * the supervisor catches and replies `{ok:false, error}` so the client
 * gets a clean error rather than an unframed disconnect.
 */
export function parseRequest(line: string): ControlRequest {
  let obj: unknown;
  try { obj = JSON.parse(line); }
  catch (e) { throw new Error(`malformed control request: ${(e as Error).message}`); }
  if (!obj || typeof obj !== "object") {
    throw new Error("control request must be a JSON object");
  }
  const op = (obj as { op?: unknown }).op;
  if (typeof op !== "string") {
    throw new Error("control request missing string `op` field");
  }
  // Field validation is handled in the supervisor per-op where specific errors apply.
  return obj as ControlRequest;
}

export function parseReply(line: string): ControlReply<unknown> {
  let obj: unknown;
  try { obj = JSON.parse(line); }
  catch (e) { throw new Error(`malformed control reply: ${(e as Error).message}`); }
  if (!obj || typeof obj !== "object") {
    throw new Error("control reply must be a JSON object");
  }
  const ok = (obj as { ok?: unknown }).ok;
  if (typeof ok !== "boolean") {
    throw new Error("control reply missing boolean `ok` field");
  }
  return obj as ControlReply<unknown>;
}

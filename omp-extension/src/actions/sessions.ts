import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  callSupervisor,
  supervisorOnline,
  SupervisorOfflineError,
  SupervisorReplyError,
} from "../daemon/client.js";
import type { ControlReplyFor, ControlRequest } from "../daemon/control_protocol.js";
import {
  addDaemon,
  listDaemons,
  normalizeCwd,
  removeDaemon,
  type DaemonRecord,
} from "../daemon/registry.js";
import type {
  ClientMessage,
  DirsListMessage,
  SpawnResultMessage,
  WireDirEntry,
  WireRecentDir,
} from "../protocol/types.js";
import { roomIdFor, roomIdForCwd } from "../rooms.js";
import { lockPathFor } from "../session/cwd_lock.js";
import { tryConnect } from "../session/leader_election.js";
import { defaultAgentName, loadLocalConfig, migrateAgentName } from "../session/local_config.js";
import type { ActionReplySender } from "./handlers.js";

/**
 * Plan/68 — new session from the phone.
 *
 * `list_dirs` lets the phone browse the PC's folders and offers the ones used
 * recently; `spawn_session` starts an omp session in one of them through the
 * supervisor. Any live room's extension can answer: the folder tree and the
 * supervisor are machine-wide, not per session.
 */

/** Subfolders returned per listing; the rest is reported as `truncated`. */
export const MAX_LISTED_DIRS = 500;
/** Entries in `recent`. */
export const MAX_RECENT_DIRS = 15;
/** Session-log folders whose mtime is read to find the recent ones. Ranking
 *  needs every folder's mtime, so this is a safety ceiling, not a sampling rate. */
export const MAX_SESSION_DIRS = 1000;
/** Newest session-log folders whose files are opened to learn their cwd. Over-
 *  fetched on purpose: some cwds are gone, and both roots may name one. */
const RECENT_CANDIDATES = 60;
/** Session files tried per folder before giving up on its cwd. */
const SESSION_FILES_PER_DIR = 3;
/** The `session` header is within the first lines (omp writes a padded `title`
 *  record first); 16 KiB covers them with room to spare. */
const HEADER_READ_BYTES = 16 * 1024;
const HEADER_LINES = 6;
const MAX_NAME_LENGTH = 80;
const STAT_BATCH = 64;
const OFFLINE_MESSAGE = "Run remote-omp install on the PC";

type ListDirsMsg = Extract<ClientMessage, { type: "list_dirs" }>;
type SpawnSessionMsg = Extract<ClientMessage, { type: "spawn_session" }>;

type SupervisorCall = <Op extends ControlRequest["op"]>(
  req: Extract<ControlRequest, { op: Op }>,
) => Promise<ControlReplyFor<Op>>;

/** Everything the handlers touch outside their arguments; tests replace it. */
export interface SessionsDeps {
  home(): string;
  /** Folders holding `<encoded-cwd>/<timestamp>_<id>.jsonl` session logs. */
  sessionRoots(): string[];
  listDaemons(): DaemonRecord[];
  addDaemon(cwd: string, name: string): DaemonRecord;
  removeDaemon(id: string): { removed: boolean; cwd?: string };
  /** True while a live agent holds the cwd lock for `(cwd, name)`. */
  cwdLockHeld(cwd: string, name: string): Promise<boolean>;
  supervisorOnline(): Promise<boolean>;
  callSupervisor: SupervisorCall;
}

/** A failure the phone gets as `error { code, message }`. */
class SessionsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function defaultSessionRoots(home: string): string[] {
  const roots = [join(home, ".omp", "agent", "sessions")];
  // omp: "PI_CODING_AGENT_DIR - Session storage directory (default: ~/.omp/agent)".
  const agentDir = process.env["PI_CODING_AGENT_DIR"];
  if (agentDir) roots.push(join(agentDir, "sessions"));
  return roots;
}

/** Probes the cwd lock without taking it: a live holder accepts the connect. */
async function probeCwdLock(cwd: string, name: string): Promise<boolean> {
  // The folder's default lock (any unnamed session there), plus the lock of the
  // exact name the new session would claim.
  const paths = new Set([lockPathFor(cwd), lockPathFor(cwd, migrateAgentName(name) ?? defaultAgentName(cwd))]);
  for (const path of paths) {
    const sock = await tryConnect(path);
    if (sock) {
      sock.destroy();
      return true;
    }
  }
  return false;
}

export function defaultSessionsDeps(): SessionsDeps {
  return {
    home: () => homedir(),
    sessionRoots: () => defaultSessionRoots(homedir()),
    listDaemons,
    addDaemon,
    removeDaemon,
    cwdLockHeld: probeCwdLock,
    supervisorOnline,
    callSupervisor,
  };
}

// ── list_dirs ───────────────────────────────────────────────────────────────

/** `~`, `~/x` and relative paths resolve against `home`; no path means `home`. */
export function resolveBrowsePath(raw: string | undefined, home: string): string {
  const p = typeof raw === "string" ? raw.trim() : "";
  if (!p) return resolve(home);
  if (p === "~") return resolve(home);
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(join(home, p.slice(2)));
  return resolve(isAbsolute(p) ? p : join(home, p));
}

function fsFailure(err: unknown, path: string): SessionsError {
  const code = err instanceof Error && "code" in err ? err.code : undefined;
  if (code === "EACCES" || code === "EPERM") {
    return new SessionsError("permission_denied", `No permission to read ${path}`);
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new SessionsError("not_found", `Folder not found: ${path}`);
  }
  return new SessionsError("internal_error", err instanceof Error ? err.message : String(err));
}

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then((s) => s.isDirectory(), () => false);

const exists = (path: string): Promise<boolean> =>
  stat(path).then(() => true, () => false);

function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Runs `fn` over `items` a batch at a time, so thousands of stats never queue at once. */
async function mapBatched<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

async function listSubdirs(dir: string): Promise<{ dirs: WireDirEntry[]; truncated: boolean }> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw fsFailure(err, dir);
  }
  const visible = entries.filter((e) => !e.name.startsWith("."));
  // A symlink counts when it points at a folder.
  const linkIsDir = await mapBatched(visible, STAT_BATCH, (e) =>
    e.isSymbolicLink() ? isDirectory(join(dir, e.name)) : Promise.resolve(false),
  );
  const names = visible
    .filter((e, i) => e.isDirectory() || linkIsDir[i])
    .map((e) => e.name)
    .sort(compareNames);
  const truncated = names.length > MAX_LISTED_DIRS;
  const page = truncated ? names.slice(0, MAX_LISTED_DIRS) : names;
  const dirs = await mapBatched(page, STAT_BATCH, async (name): Promise<WireDirEntry> => {
    const path = join(dir, name);
    return { name, path, is_git: await exists(join(path, ".git")) };
  });
  return { dirs, truncated };
}

/** The newest session-log folders, by folder mtime (a new session adds a file). */
async function newestSessionDirs(roots: readonly string[]): Promise<string[]> {
  const found: Array<{ dir: string; mtimeMs: number }> = [];
  let budget = MAX_SESSION_DIRS;
  for (const root of roots) {
    if (budget <= 0) break;
    let names: string[];
    try {
      names = (await readdir(root)).slice(0, budget);
    } catch {
      continue; // this root does not exist: omp never ran under it
    }
    budget -= names.length;
    await mapBatched(names, STAT_BATCH, async (name) => {
      const dir = join(root, name);
      try {
        const st = await stat(dir);
        if (st.isDirectory()) found.push({ dir, mtimeMs: st.mtimeMs });
      } catch {
        /* vanished or unreadable: not a candidate */
      }
    });
  }
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, RECENT_CANDIDATES)
    .map((f) => f.dir);
}

/** The cwd in a session log's `session` header, or null. Reads only the file's head. */
async function sessionCwd(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8", 0, bytesRead).split("\n").slice(0, HEADER_LINES)) {
      try {
        const rec = JSON.parse(line) as { type?: unknown; cwd?: unknown };
        if (rec.type === "session" && typeof rec.cwd === "string" && isAbsolute(rec.cwd)) return rec.cwd;
      } catch {
        /* a partial or non-JSON line */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Folder and last-use time of the newest readable session in a session-log folder. */
async function lastSessionIn(dir: string): Promise<{ cwd: string; lastUsed: number } | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  // Session files start with an ISO timestamp, so name order is creation order.
  const logs = names.filter((n) => n.endsWith(".jsonl")).sort().reverse().slice(0, SESSION_FILES_PER_DIR);
  for (const name of logs) {
    const file = join(dir, name);
    const cwd = await sessionCwd(file);
    if (!cwd) continue;
    try {
      return { cwd, lastUsed: Math.round((await stat(file)).mtimeMs) };
    } catch {
      /* removed since: try the next */
    }
  }
  return null;
}

/**
 * Folders worth offering for a new session: registered always-on folders plus
 * the cwd of the newest omp session in each session-log folder. Existing
 * folders only, deduplicated, newest first, capped. Registered folders without
 * any session log carry no `last_used` and sort last.
 */
export async function collectRecentDirs(deps: Pick<SessionsDeps, "sessionRoots" | "listDaemons">): Promise<WireRecentDir[]> {
  const byPath = new Map<string, WireRecentDir>();
  for (const d of deps.listDaemons()) byPath.set(d.cwd, { path: d.cwd, name: d.name });

  const dirs = await newestSessionDirs(deps.sessionRoots());
  const sessions = await mapBatched(dirs, 8, lastSessionIn);
  for (const s of sessions) {
    if (!s) continue;
    const prev = byPath.get(s.cwd);
    if (prev && (prev.last_used ?? -1) >= s.lastUsed) continue;
    byPath.set(s.cwd, { path: s.cwd, name: prev?.name ?? (basename(s.cwd) || s.cwd), last_used: s.lastUsed });
  }

  const entries = [...byPath.values()];
  const alive = await mapBatched(entries, STAT_BATCH, (e) => isDirectory(e.path));
  return entries
    .filter((_, i) => alive[i])
    .sort((a, b) => (b.last_used ?? -1) - (a.last_used ?? -1))
    .slice(0, MAX_RECENT_DIRS);
}

function sendError(sender: ActionReplySender, inReplyTo: string, err: unknown): void {
  const reply = toWireError(err);
  sender.send({ type: "error", in_reply_to: inReplyTo, code: reply.code, message: reply.message });
}

export async function handleListDirs(
  sender: ActionReplySender,
  msg: ListDirsMsg,
  overrides: Partial<SessionsDeps> = {},
): Promise<void> {
  const deps = { ...defaultSessionsDeps(), ...overrides };
  try {
    if (msg.path !== undefined && typeof msg.path !== "string") {
      throw new SessionsError("invalid_message", "path must be a string");
    }
    const home = resolve(deps.home());
    const path = resolveBrowsePath(msg.path, home);
    let info;
    try {
      info = await stat(path);
    } catch (err) {
      throw fsFailure(err, path);
    }
    if (!info.isDirectory()) throw new SessionsError("not_found", `Not a folder: ${path}`);

    const [{ dirs, truncated }, recent] = await Promise.all([listSubdirs(path), collectRecentDirs(deps)]);
    const parent = dirname(path);
    const reply: DirsListMessage = {
      type: "dirs_list",
      in_reply_to: msg.id,
      path,
      parent: parent === path ? null : parent,
      home,
      dirs,
      recent,
      truncated,
    };
    sender.send(reply);
  } catch (err) {
    sendError(sender, msg.id, err);
  }
}

// ── spawn_session ───────────────────────────────────────────────────────────

/** Maps anything a handler can throw to the `error` frame the phone shows. */
function toWireError(err: unknown): { code: string; message: string } {
  if (err instanceof SessionsError) return { code: err.code, message: err.message };
  if (err instanceof SupervisorOfflineError) {
    return { code: "supervisor_offline", message: OFFLINE_MESSAGE };
  }
  if (err instanceof SupervisorReplyError) {
    // A supervisor from before plan/68 does not know the op.
    if (err.message.startsWith("unknown op")) {
      return {
        code: "supervisor_outdated",
        message: "The Remote OMP supervisor on the PC is out of date: run remote-omp restart-supervisor",
      };
    }
    if (err.code === "bad_request") return { code: "invalid_message", message: err.message };
    return { code: err.code ?? "internal_error", message: err.message };
  }
  return { code: "internal_error", message: err instanceof Error ? err.message : String(err) };
}

/** The folder to run in: absolute (or `~`), existing, a directory, symlinks resolved. */
async function resolveFolder(raw: string, home: string): Promise<string> {
  const p = raw.trim();
  const tilde = p === "~" || p.startsWith("~/") || p.startsWith("~\\");
  if (!tilde && !isAbsolute(p)) {
    throw new SessionsError("invalid_message", "cwd must be an absolute path");
  }
  let cwd: string;
  try {
    cwd = normalizeCwd(tilde ? resolveBrowsePath(p, home) : p);
  } catch {
    throw new SessionsError("not_found", `Folder not found: ${p}`);
  }
  if (!(await isDirectory(cwd))) throw new SessionsError("not_found", `Not a folder: ${cwd}`);
  return cwd;
}

/** Undoes an `addDaemon` whose start failed, so the folder is not left registered but dead. */
async function rollbackRegistration(id: string, deps: SessionsDeps): Promise<void> {
  try {
    await deps.callSupervisor({ op: "unregister", id });
  } catch {
    try {
      deps.removeDaemon(id);
    } catch {
      /* the registry is unreadable: nothing more to undo */
    }
  }
}

/** `remote-omp create` plus an immediate start: the folder gets an always-on daemon (plan/67). */
async function startPersistent(cwd: string, name: string, deps: SessionsDeps, fresh = true): Promise<string> {
  if (!(await deps.supervisorOnline())) throw new SessionsError("supervisor_offline", OFFLINE_MESSAGE);
  let record: DaemonRecord;
  try {
    record = deps.addDaemon(cwd, name);
  } catch (err) {
    if (err instanceof Error && /already registered/i.test(err.message)) {
      throw new SessionsError("already_registered", "That folder is already an always-on session");
    }
    throw err;
  }
  try {
    await deps.callSupervisor({ op: "start", id: record.id, fresh });
  } catch (err) {
    await rollbackRegistration(record.id, deps);
    throw err;
  }
  return record.id;
}

/**
 * Resolves the `agent_name` that reproduces `expectedRoomId` for `cwd` when
 * reviving an offline session (the user may have renamed the room locally on
 * the phone).
 */
export function resolveReviveName(
  cwd: string,
  requestedName: string | undefined,
  expectedRoomId: string | undefined,
): string {
  const candidate = ((requestedName ?? "").trim() || defaultAgentName(cwd)).slice(0, MAX_NAME_LENGTH);
  if (!expectedRoomId || roomIdFor(cwd, candidate) === expectedRoomId) {
    return candidate;
  }
  if (expectedRoomId === roomIdForCwd(cwd)) {
    return defaultAgentName(cwd);
  }
  const cfgName = loadLocalConfig(cwd, { ignoreDirectConfig: true }).agent_name;
  if (cfgName && roomIdFor(cwd, cfgName) === expectedRoomId) {
    return cfgName;
  }
  return candidate;
}

export async function handleSpawnSession(
  sender: ActionReplySender,
  msg: SpawnSessionMsg,
  overrides: Partial<SessionsDeps> = {},
): Promise<void> {
  const deps = { ...defaultSessionsDeps(), ...overrides };
  try {
    if (typeof msg.cwd !== "string" || !msg.cwd.trim()) {
      throw new SessionsError("invalid_message", "cwd is required");
    }
    if (msg.name !== undefined && typeof msg.name !== "string") {
      throw new SessionsError("invalid_message", "name must be a string");
    }
    if (msg.persistent !== undefined && typeof msg.persistent !== "boolean") {
      throw new SessionsError("invalid_message", "persistent must be a boolean");
    }
    if (msg.resume !== undefined && typeof msg.resume !== "boolean") {
      throw new SessionsError("invalid_message", "resume must be a boolean");
    }
    if (msg.room_id !== undefined && typeof msg.room_id !== "string") {
      throw new SessionsError("invalid_message", "room_id must be a string");
    }
    const persistent = msg.persistent === true;
    const resume = msg.resume === true;
    const expectedRoomId = typeof msg.room_id === "string" && msg.room_id.trim() ? msg.room_id.trim() : undefined;

    const cwd = await resolveFolder(msg.cwd, resolve(deps.home()));
    const name = resume
      ? resolveReviveName(cwd, msg.name, expectedRoomId)
      : ((msg.name ?? "").trim() || defaultAgentName(cwd)).slice(0, MAX_NAME_LENGTH);

    const existing = deps.listDaemons().find((d) => d.cwd === cwd);
    if (existing) {
      if (!resume) {
        throw new SessionsError("already_registered", "That folder is already an always-on session");
      }
      if (await deps.cwdLockHeld(cwd, existing.name)) {
        throw new SessionsError("cwd_busy", "A session is already running in that folder");
      }
      if (!(await deps.supervisorOnline())) {
        throw new SessionsError("supervisor_offline", OFFLINE_MESSAGE);
      }
      await deps.callSupervisor({ op: "start", id: existing.id, fresh: false });
      sender.send({
        type: "spawn_result",
        in_reply_to: msg.id,
        cwd,
        name: existing.name,
        persistent: true,
        daemon_id: existing.id,
      });
      return;
    }

    if (await deps.cwdLockHeld(cwd, name)) {
      throw new SessionsError("cwd_busy", "A session is already running in that folder");
    }

    const daemonId = persistent
      ? await startPersistent(cwd, name, deps, !resume)
      : (
          await deps.callSupervisor(
            resume ? { op: "spawn_ephemeral", cwd, name, resume: true } : { op: "spawn_ephemeral", cwd, name },
          )
        ).id;

    const reply: SpawnResultMessage = {
      type: "spawn_result",
      in_reply_to: msg.id,
      cwd,
      name,
      persistent,
      daemon_id: daemonId,
    };
    sender.send(reply);
  } catch (err) {
    sendError(sender, msg.id, err);
  }
}

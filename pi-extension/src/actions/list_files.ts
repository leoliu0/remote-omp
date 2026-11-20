import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ActionReplySender } from "./handlers.js";
import type { ClientMessage, FilesListMessage } from "../protocol/types.js";

/** Mobile `@` autocomplete: file listing + fuzzy ranking for the session cwd. */
export const LIST_FILES_TIMEOUT_MS = 3_000;
export const LIST_FILES_CACHE_TTL_MS = 10_000;
/** Largest path list kept in the per-cwd cache; bigger trees are re-streamed per query. */
export const MAX_LISTED_PATHS = 50_000;
export const DEFAULT_LIST_LIMIT = 30;
export const MAX_LIST_LIMIT = 100;
export const WALK_MAX_DEPTH = 8;
export const WALK_MAX_ENTRIES = 20_000;
const WALK_SKIP_DIRS: Record<string, true> = { node_modules: true, ".git": true };

type ListFilesMsg = Extract<ClientMessage, { type: "list_files" }>;

// ── ranking ─────────────────────────────────────────────────────────────────

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack.charCodeAt(j) === needle.charCodeAt(i)) i++;
  }
  return i === needle.length;
}

/** 0 exact basename … 4 subsequence; `-1` = no match. `q` is lower-case. */
function tier(path: string, q: string): number {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === q) return 0;
  if (base.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (lower.includes(q)) return 3;
  if (isSubsequence(q, lower)) return 4;
  return -1;
}

function segmentCount(p: string): number {
  let n = 1;
  for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) === 47) n++;
  return n;
}

function byLength(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function byDepth(a: string, b: string): number {
  return segmentCount(a) - segmentCount(b) || byLength(a, b);
}

/**
 * Incremental ranker: feed paths one by one, keeping only the best `limit`
 * per tier, so memory stays bounded however many paths stream through and the
 * result never depends on arrival order. Tiers: exact basename > basename
 * prefix > basename substring > path substring > subsequence; ties shorter
 * path first. An empty query is a single tier ordered shallowest first.
 */
export class FileRanker {
  private readonly q: string;
  private readonly buckets: string[][];
  private readonly compare: (a: string, b: string) => number;
  total = 0;

  constructor(
    query: string,
    private readonly limit: number,
  ) {
    this.q = query.trim().toLowerCase();
    this.buckets = this.q ? [[], [], [], [], []] : [[]];
    this.compare = this.q ? byLength : byDepth;
  }

  add(path: string): void {
    const t = this.q ? tier(path, this.q) : 0;
    if (t < 0) return;
    this.total++;
    const bucket = this.buckets[t]!;
    if (bucket.length >= this.limit && this.compare(path, bucket[bucket.length - 1]!) >= 0) {
      return;
    }
    let i = bucket.length;
    while (i > 0 && this.compare(path, bucket[i - 1]!) < 0) i--;
    bucket.splice(i, 0, path);
    if (bucket.length > this.limit) bucket.pop();
  }

  result(): { files: string[]; total: number } {
    return { files: this.buckets.flat().slice(0, this.limit), total: this.total };
  }
}

/** Ranks [paths] against [query]; at most [limit] paths plus the total match count. */
export function rankFiles(
  paths: readonly string[],
  query: string,
  limit: number,
): { files: string[]; total: number } {
  const ranker = new FileRanker(query, limit);
  for (const p of paths) ranker.add(p);
  return ranker.result();
}

export function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(raw)));
}

// ── sources ─────────────────────────────────────────────────────────────────

/** Strips `./` and (on Windows) backslashes; null for an empty path. */
function normalizePath(raw: string): string | null {
  let p = raw;
  if (process.platform === "win32") p = p.replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  return p || null;
}

interface StreamResult {
  /** False only when the command produced nothing usable (missing, failed). */
  usable: boolean;
  /** The command was killed at the deadline; its list may be incomplete. */
  timedOut: boolean;
}

/**
 * Runs `cmd args`, handing every NUL-separated stdout path to `onPath` as it
 * arrives. Output is kept whatever the exit code (`rg` exits 2 on one
 * unreadable directory yet still lists the rest) and when the deadline
 * kills the process. Unusable means no path was produced and the exit was
 * not a clean 0/1, so the caller may try the next source.
 */
function streamPaths(
  cwd: string,
  cmd: string,
  args: string[],
  timeoutMs: number,
  onPath: (path: string) => void,
): Promise<StreamResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve({ usable: false, timedOut: false });
      return;
    }
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let count = 0;
    let timedOut = false;
    let settled = false;
    const emit = (raw: string): void => {
      const p = normalizePath(raw);
      if (p === null) return;
      count++;
      onPath(p);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1, timeoutMs));
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A killed process may have been cut mid-path; a clean one ends in NUL.
      if (!timedOut && pending) emit(pending);
      resolve({ usable: count > 0 || (!timedOut && (code === 0 || code === 1)), timedOut });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let start = 0;
      for (let i = pending.indexOf("\0", start); i >= 0; i = pending.indexOf("\0", start)) {
        emit(pending.slice(start, i));
        start = i + 1;
      }
      pending = pending.slice(start);
    });
    child.stdout.on("error", () => {});
    child.on("error", () => finish(null)); // ENOENT etc.
    child.on("close", (code) => finish(code));
  });
}

/**
 * Bounded breadth-first directory walk, used only when neither `rg` nor
 * `git` is usable. Skips `node_modules` and `.git`; does not follow symlinked
 * directories.
 */
export async function walkFiles(
  root: string,
  opts: { maxDepth?: number; maxEntries?: number } = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? WALK_MAX_DEPTH;
  const maxEntries = opts.maxEntries ?? WALK_MAX_ENTRIES;
  const out: string[] = [];
  let level: Array<{ rel: string }> = [{ rel: "" }];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: Array<{ rel: string }> = [];
    for (const { rel } of level) {
      let dirents;
      try {
        dirents = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (!WALK_SKIP_DIRS[d.name]) next.push({ rel: childRel });
        } else if (d.isFile()) {
          out.push(childRel);
          if (out.length >= maxEntries) return out;
        }
      }
    }
    level = next;
  }
  return out;
}

/** Streams every file under `cwd` (rg → git → bounded walk) into `onPath`. */
async function scanFiles(
  cwd: string,
  timeoutMs: number,
  onPath: (path: string) => void,
): Promise<{ timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  const sources: Array<[string, string[]]> = [
    ["rg", ["--files", "--hidden", "--null", "-g", "!.git"]],
    ["git", ["--no-optional-locks", "ls-files", "-co", "--exclude-standard", "-z"]],
  ];
  for (const [cmd, args] of sources) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const r = await streamPaths(cwd, cmd, args, remaining, onPath);
    if (r.usable) return { timedOut: r.timedOut };
  }
  for (const p of await walkFiles(cwd)) {
    const n = normalizePath(p);
    if (n !== null) onPath(n);
  }
  return { timedOut: false };
}

// ── cache + entry points ────────────────────────────────────────────────────

const _cache = new Map<string, { at: number; paths: string[] }>();

/** Test hook: drop the per-cwd file list cache. */
export function clearListFilesCache(): void {
  _cache.clear();
}

/** Number of cached cwd lists (test hook for eviction). */
export function listFilesCacheSize(): number {
  return _cache.size;
}

function storeInCache(cwd: string, at: number, paths: string[]): void {
  const entry = { at, paths };
  _cache.set(cwd, entry);
  // Free the list once it expires rather than holding it for the process life.
  setTimeout(() => {
    if (_cache.get(cwd) === entry) _cache.delete(cwd);
  }, LIST_FILES_CACHE_TTL_MS).unref();
}

/**
 * Lists/ranks files under `cwd` and returns the `files_list` payload. Every
 * path is considered: lists up to [MAX_LISTED_PATHS] are cached for
 * [LIST_FILES_CACHE_TTL_MS]; larger trees are streamed through the ranker per
 * query. `truncated` is set when more matches exist than returned or the scan
 * hit the time limit.
 */
export async function listProjectFiles(
  cwd: string,
  query: string,
  limit: number,
  now: number = Date.now(),
  timeoutMs: number = LIST_FILES_TIMEOUT_MS,
): Promise<Omit<FilesListMessage, "type" | "in_reply_to">> {
  const hit = _cache.get(cwd);
  if (hit) {
    if (now - hit.at < LIST_FILES_CACHE_TTL_MS) {
      const { files, total } = rankFiles(hit.paths, query, limit);
      return { root: cwd, files, truncated: total > files.length };
    }
    _cache.delete(cwd);
  }

  const ranker = new FileRanker(query, limit);
  const collected: string[] = [];
  let overflow = false;
  let timedOut = false;
  try {
    ({ timedOut } = await scanFiles(cwd, timeoutMs, (p) => {
      ranker.add(p);
      if (collected.length < MAX_LISTED_PATHS) collected.push(p);
      else overflow = true;
    }));
  } catch {
    /* unreadable cwd: an empty list */
  }
  if (!overflow && !timedOut) storeInCache(cwd, now, collected);
  const { files, total } = ranker.result();
  return { root: cwd, files, truncated: timedOut || total > files.length };
}

export async function handleListFiles(
  cwd: string,
  sender: ActionReplySender,
  msg: ListFilesMsg,
): Promise<void> {
  const query = typeof msg.query === "string" ? msg.query : "";
  const result = await listProjectFiles(cwd, query, clampLimit(msg.limit));
  sender.send({ type: "files_list", in_reply_to: msg.id, ...result });
}

import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { daemonIdForCwd } from "./id.js";
import { defaultAgentName } from "../session/local_config.js";
import { remoteOmpHome } from "../paths.js";

/**
 * The global daemon registry: which working directories are promoted to
 * always-on daemons under the supervisor.
 *
 * Schema: `~/.omp/remote/daemons.json` persists `{ cwd, name }` per entry. The
 * supervisor injects `{ agent_name: name, auto_start_relay: true }` into each
 * child via `REMOTE_OMP_DIRECT_CONFIG` (no per-cwd config file needed). Legacy
 * `{ cwd }` entries fall back to `defaultAgentName(cwd)`. Any other key an older
 * file carries (it also recorded which agent CLI to run) is ignored without a
 * warning and left out of the next save.
 * The daemon `id` is always derived from `cwd` via `daemonIdForCwd`, never persisted.
 *
 * Cwds are always normalized to an **absolute realpath** before storage.
 * A user typing `/remote-omp create ~/Movies` or `/remote-omp create .`
 * results in the same entry as `/remote-omp create /Users/x/Movies` — no
 * surprise duplicates, symlinks collapse correctly.
 */

/** Resolved at call time so tests can redirect it via `REMOTE_OMP_HOME`. The
 *  prod path is always `~/.omp/remote/daemons.json`. */
function registryPathInternal(): string {
  return join(remoteOmpHome(), "daemons.json");
}

export interface DaemonEntry {
  /** Absolute realpath of the cwd this daemon manages. */
  cwd: string;
  /**
   * Display name (mesh `agent_name`). Persisted here because the supervisor
   * injects the daemon's config via `REMOTE_OMP_DIRECT_CONFIG` at spawn
   * instead of relying on a per-cwd `.omp/remote-omp/config.json`. Legacy entries
   * (cwd only) fall back to `defaultAgentName(cwd)`.
   */
  name?: string;
}

/** A registry entry as the supervisor consumes it: id derived, defaults filled. */
export interface DaemonRecord {
  readonly id: string;
  readonly cwd: string;
  readonly name: string;
}

export interface DaemonRegistry {
  daemons: DaemonEntry[];
}

interface RegistryCache {
  path: string;
  mtimeNs: bigint;
  size: bigint;
  ino: bigint;
  records: DaemonRecord[];
}

let _cache: RegistryCache | null = null;

function _invalidateCache(): void {
  _cache = null;
}

/**
 * Normalizes a user-provided path: expands `~`/`~/...`, resolves relative
 * components against `process.cwd()`, and runs `realpath` to canonicalize
 * symlinks. Throws if the resulting path doesn't exist on disk.
 *
 * `/remote-omp create` always stores normalized paths so two registrations
 * of the same logical folder via different aliases produce a single entry.
 */
export function normalizeCwd(input: string): string {
  if (!input || !input.trim()) {
    throw new Error("cwd is required");
  }
  let p = input.trim();
  // Expand `~` / `~/relative`. Shell wouldn't expand inside slash command args.
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) p = resolvePath(process.cwd(), p);
  // realpath canonicalizes symlinks + throws if path doesn't exist.
  return realpathSync(p);
}

function _parseRegistryFile(path: string, strict: boolean): DaemonRegistry {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { daemons: [] };
    }
    const msg = `Failed to read daemon registry ${path}: ${err instanceof Error ? err.message : String(err)}`;
    if (strict) throw new Error(msg);
    process.stderr.write(`[remote-omp] ${msg}\n`);
    return { daemons: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = `Malformed daemon registry JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`;
    if (strict) throw new Error(msg);
    process.stderr.write(`[remote-omp] ${msg}\n`);
    return { daemons: [] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const msg = `Invalid daemon registry at ${path}: expected JSON object`;
    if (strict) throw new Error(msg);
    process.stderr.write(`[remote-omp] ${msg}\n`);
    return { daemons: [] };
  }

  const arr = (parsed as { daemons?: unknown }).daemons;
  if (!Array.isArray(arr)) {
    const msg = `Invalid daemon registry shape at ${path}: expected { "daemons": [...] }`;
    if (strict) throw new Error(msg);
    process.stderr.write(`[remote-omp] ${msg}\n`);
    return { daemons: [] };
  }

  const daemons: DaemonEntry[] = [];
  for (const [idx, item] of arr.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      process.stderr.write(`[remote-omp] skipping malformed registry entry #${idx} in ${path}\n`);
      continue;
    }
    const cwd = (item as { cwd?: unknown }).cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      process.stderr.write(`[remote-omp] skipping registry entry #${idx} without valid cwd in ${path}\n`);
      continue;
    }
    const entry: DaemonEntry = { cwd };
    const rawName = (item as { name?: unknown }).name;
    const trimmedName = typeof rawName === "string" ? rawName.trim() : "";
    if (trimmedName.length > 0) entry.name = trimmedName;
    daemons.push(entry);
  }
  return { daemons };
}

/** Reads the registry, returning an empty one when the file is absent or unreadable. */
export function loadRegistry(): DaemonRegistry {
  return _parseRegistryFile(registryPathInternal(), false);
}

/** Reads the registry strictly for mutations so corrupt JSON is never silently overwritten. */
function _loadRegistryStrict(): DaemonRegistry {
  return _parseRegistryFile(registryPathInternal(), true);
}

export function saveRegistry(reg: DaemonRegistry): void {
  const path = registryPathInternal();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
    throw err;
  } finally {
    _invalidateCache();
  }
}

/**
 * Adds a daemon entry. Refuses duplicates (same normalized cwd already
 * present) and refuses to overwrite a corrupted registry file. Returns the
 * full `DaemonRecord` (`{ id, cwd, name }`).
 */
export function addDaemon(rawCwd: string, name?: string): DaemonRecord {
  const cwd = normalizeCwd(rawCwd);
  const reg = _loadRegistryStrict();
  if (reg.daemons.some((d) => d.cwd === cwd)) {
    throw new Error(`Daemon already registered for cwd: ${cwd}`);
  }
  // Always persist a name (the registry is the source of truth now that the
  // supervisor injects config via env instead of a local config file).
  const resolvedName = name?.trim() || defaultAgentName(cwd);
  reg.daemons.push({ cwd, name: resolvedName });
  saveRegistry(reg);
  return { id: daemonIdForCwd(cwd), cwd, name: resolvedName };
}

/**
 * Removes the daemon entry whose derived id matches `id`. Returns whether an
 * entry was removed and its `cwd`. Does NOT touch any files inside `cwd`.
 * Refuses to overwrite a corrupted registry file.
 */
export function removeDaemon(id: string): { removed: boolean; cwd?: string } {
  const reg = _loadRegistryStrict();
  const idx = reg.daemons.findIndex((d) => daemonIdForCwd(d.cwd) === id);
  if (idx === -1) return { removed: false };
  const [removed] = reg.daemons.splice(idx, 1);
  saveRegistry(reg);
  return { removed: true, cwd: removed!.cwd };
}

function _toRecords(reg: DaemonRegistry): DaemonRecord[] {
  return reg.daemons.map((d) => ({
    id: daemonIdForCwd(d.cwd),
    cwd: d.cwd,
    // Legacy entries (cwd only) fall back to the folder-derived name so a
    // daemon is never nameless. New entries already carry an explicit name.
    name: d.name ?? defaultAgentName(d.cwd),
  }));
}

/**
 * Snapshot of all registered daemons with derived ids. Order matches the
 * file's insertion order — first-registered first. Uses an mtime/size/inode
 * stat cache so repeated status/list calls avoid redundant disk reads,
 * `realpathSync`, and hashing while still reflecting out-of-band edits.
 */
export function listDaemons(): DaemonRecord[] {
  const path = registryPathInternal();
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      _invalidateCache();
      return [];
    }
    const reg = loadRegistry();
    return _toRecords(reg);
  }
  if (
    _cache &&
    _cache.path === path &&
    _cache.mtimeNs === st.mtimeNs &&
    _cache.size === st.size &&
    _cache.ino === st.ino
  ) {
    return _cache.records.slice();
  }
  const records = _toRecords(_parseRegistryFile(path, false));
  _cache = { path, mtimeNs: st.mtimeNs, size: st.size, ino: st.ino, records };
  return records.slice();
}

/**
 * One-shot migration: backfill `name` (folder-derived) into legacy entries
 * that predate the name field, persisting the change to `daemons.json`.
 * Idempotent — writes only when something was missing. Returns how many
 * entries were backfilled. The supervisor runs this on start.
 */
export function migrateRegistryNames(): number {
  const reg = loadRegistry();
  let changed = 0;
  for (const d of reg.daemons) {
    if (!d.name) {
      d.name = defaultAgentName(d.cwd);
      changed++;
    }
  }
  if (changed > 0) saveRegistry(reg);
  return changed;
}

/** Test/diag-only: returns the resolved registry file path (honoring `REMOTE_OMP_HOME`). */
export function registryPath(): string {
  return registryPathInternal();
}

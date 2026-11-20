import {
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { legacyRemotePiHome, remoteOmpHome } from "./paths.js";

/**
 * One-time COPY of the data directory from its pre-rename location
 * (`~/.pi/remote`, written by Remote Pi) to `~/.omp/remote` (plan 69).
 *
 * Old-version omp sessions can keep running from `~/.pi/remote` while the new
 * version starts, so the old directory is never moved, modified or deleted —
 * only read.
 *
 *   - Runs when the legacy directory exists and `<new>/.migrated-from-pi` does
 *     not. The marker is written last; a failed or interrupted copy leaves it
 *     out and the next start finishes the job.
 *   - Copies every durable file and directory (identity, peers, config, daemon
 *     registry, cron state, uploads, skills, logs…) with its permission bits
 *     (keys stay `0600`) and mtime. Never overwrites a file the new directory
 *     already has. Each file is written under a temporary name and renamed into
 *     place, so a crash never leaves a half-written key or registry behind.
 *   - Skips runtime state that cannot be carried over: sockets, FIFOs, devices,
 *     `*.sock` / `*.pid` / `*.tmp` files and the top-level `locks/` directory.
 *   - Never throws. A failed copy is reported as `status: "failed"`; callers
 *     must refuse to start rather than run with an empty directory while the
 *     old one holds the paired identity (use {@link ensureDataDirMigrated}).
 *
 * Call it before anything creates files in the new directory (`index.ts` does
 * at load, `bin/supervisord.ts` at start).
 */

export type DataDirMigration =
  /** No legacy directory: nothing to carry over. */
  | { status: "none" }
  /** `<new>/.migrated-from-pi` exists: an earlier start already copied it. */
  | { status: "already" }
  | { status: "copied"; from: string; to: string; files: number; skipped: string[] }
  | { status: "failed"; from: string; to: string; error: string };

export interface DataDirMigrationOptions {
  /** Environment used to resolve both directories (`REMOTE_OMP_HOME`). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Test seam: replaces the byte copy of one file (`fs.copyFileSync` with COPYFILE_EXCL). */
  copyFile?: (from: string, to: string) => void;
}

/** Name of the marker file inside the new data directory. */
export const MIGRATION_MARKER = ".migrated-from-pi";

/** Thrown by {@link ensureDataDirMigrated}; the message is user-facing. */
export class DataDirMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataDirMigrationError";
  }
}

export async function migrateDataDir(opts: DataDirMigrationOptions = {}): Promise<DataDirMigration> {
  const env = opts.env ?? process.env;
  const from = legacyRemotePiHome(env);
  const to = remoteOmpHome(env);
  try {
    const source = statOrNull(from);
    if (!source?.isDirectory()) return { status: "none" };
    if (lstatOrNull(join(to, MIGRATION_MARKER))) return { status: "already" };

    mkdirSync(to, { recursive: true, mode: source.mode & 0o777 });
    const tally: Tally = { files: 0, skipped: [] };
    copyDirectory(from, to, [], opts.copyFile ?? copyExclusive, tally);

    const marker = JSON.stringify(
      { migratedFrom: from, at: (opts.now ?? (() => new Date()))().toISOString(), files: tally.files },
      null,
      2,
    );
    writeFileAtomic(join(to, MIGRATION_MARKER), marker);
    return { status: "copied", from, to, files: tally.files, skipped: tally.skipped };
  } catch (err) {
    return { status: "failed", from, to, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs {@link migrateDataDir} and turns a failure into a {@link DataDirMigrationError}:
 * starting with an empty directory while `~/.pi/remote` still holds the paired
 * identity would mint a new one and orphan every paired phone.
 */
export async function ensureDataDirMigrated(opts: DataDirMigrationOptions = {}): Promise<DataDirMigration> {
  const result = await migrateDataDir(opts);
  if (result.status === "failed") {
    throw new DataDirMigrationError(
      `${describeDataDirMigration(result)} Refusing to start with an empty ${result.to}: ` +
      `fix the cause and start again (${result.from} was not modified).`,
    );
  }
  return result;
}

/** One-line, user-facing summary of a migration that did something; undefined when there is nothing to say. */
export function describeDataDirMigration(result: DataDirMigration): string | undefined {
  if (result.status === "copied") {
    return `[remote-omp] copied ${result.files} file(s) from ${result.from} to ${result.to}; ${result.from} was left untouched.`;
  }
  if (result.status === "failed") {
    return `[remote-omp] could not copy ${result.from} to ${result.to}: ${result.error}.`;
  }
  return undefined;
}

// ── Copying ──────────────────────────────────────────────────────────────────

interface Tally { files: number; skipped: string[] }

const RUNTIME_SUFFIXES = [".sock", ".pid", ".tmp"];

/** Why `name` (a child of `parent`, at `depth`) is runtime state that must not be copied; undefined → copy it. */
function runtimeReason(name: string, depth: number, stat: Stats): string | undefined {
  if (depth === 0 && name === "locks" && stat.isDirectory()) return "lock sockets";
  if (RUNTIME_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "runtime file";
  if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) return "socket or special file";
  return undefined;
}

function copyDirectory(
  from: string,
  to: string,
  rel: string[],
  copyFile: (from: string, to: string) => void,
  tally: Tally,
): void {
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const target = join(to, name);
    const stat = lstatOrNull(source);
    if (!stat) continue; // vanished since readdir: an old process cleaned it up
    const reason = runtimeReason(name, rel.length, stat);
    if (reason) {
      tally.skipped.push([...rel, name].join("/"));
      continue;
    }
    if (stat.isDirectory()) {
      const existing = lstatOrNull(target);
      if (!existing) {
        mkdirSync(target, { mode: stat.mode & 0o777 });
        chmodSync(target, stat.mode & 0o777);
      } else if (!existing.isDirectory()) {
        continue; // never replace a file with a directory
      }
      copyDirectory(source, target, [...rel, name], copyFile, tally);
    } else if (stat.isSymbolicLink()) {
      if (!lstatOrNull(target)) symlinkSync(readlinkSync(source), target);
    } else if (copyFileOnce(source, target, stat, copyFile)) {
      tally.files += 1;
    }
  }
}

/** Atomic, no-clobber copy: the file appears under its final name complete, with its mode, or not at all. */
function copyFileOnce(
  source: string,
  target: string,
  stat: Stats,
  copyFile: (from: string, to: string) => void,
): boolean {
  if (lstatOrNull(target)) return false;
  const temp = `${target}.${process.pid}.migrating`;
  try {
    copyFile(source, temp);
    chmodSync(temp, stat.mode & 0o777);
    utimesSync(temp, stat.atime, stat.mtime);
    if (lstatOrNull(target)) {
      rmSync(temp, { force: true }); // another starting process got there first
      return false;
    }
    renameSync(temp, target);
    return true;
  } catch (err) {
    rmSync(temp, { force: true });
    if (errorCode(err) === "ENOENT" && !lstatOrNull(source)) return false; // source vanished mid-copy
    throw err;
  }
}

function copyExclusive(from: string, to: string): void {
  copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
}

function writeFileAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.migrating`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

// ── Small fs helpers ─────────────────────────────────────────────────────────

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  return undefined;
}

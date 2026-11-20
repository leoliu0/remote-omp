import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const LOCAL_DIR = ".omp/remote-omp";
// Where Remote Pi (before plan/69) kept the same file. Read once by the migration
// in `loadLocalConfig`; never written.
const LEGACY_LOCAL_DIR = ".pi/remote-pi";
const LOCAL_FILE = "config.json";

/**
 * Escape hatch: when set, carries the WHOLE local config as inline JSON,
 * bypassing the on-disk `config.json`. For CI/ops/daemons that inject config
 * via env instead of writing a file — mirrors `REMOTE_OMP_RELAY` for the relay
 * URL. Takes precedence over the file; an unset/empty/unparseable value falls
 * back to the file (never fatal).
 */
const DIRECT_CONFIG_ENV = "REMOTE_OMP_DIRECT_CONFIG";

export interface LocalConfig {
  agent_name?: string;
  /**
   * If true (default), `/remote-omp` with no args auto-joins the local UDS
   * mesh and starts the relay on a fresh terminal. The field name is
   * historical (plano 21); the UX wording was reworked to "use the relay
   * on this terminal to connect to the remote mesh (mobile + PCs)". Legacy
   * configs without this field are treated as `true` for backward compat.
   */
  auto_start_relay?: boolean;
  // `workspace?`/`worktree?` were removed (plan/38, reescrito 2026-06-08): the
  // mesh identity is `(cwd, nome)`, with `cwd` subsuming folder + worktree
  // disambiguation. Neither axis is derived anymore, so the config fields are
  // gone. Any stale `workspace`/`worktree` key in an on-disk/inline config is
  // simply ignored on read (parseLocalConfig surfaces only known fields).
}

function pathFor(cwd: string, dir: string = LOCAL_DIR): string {
  return join(cwd, dir, LOCAL_FILE);
}

/**
 * Normalize a name segment to a mesh-safe token: trim, replace the addressing
 * separators (`/ : @ #`) and whitespace runs with `-`, collapse repeats, strip
 * edges. The `@` is included so a sanitized name can never contain the address
 * separator — `<cwd>@<name>` stays unambiguous on the wire. Returns undefined
 * when the input isn't a usable non-empty string, sanitizes to empty, or is a
 * reserved addressing keyword (`broadcast` / `broker`). Used by the broker's
 * `sanitizeMeshName` to keep the `<nome>` half of a peer address safe to
 * compose (plan/38).
 */
export function sanitizeSegment(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const token = v.trim().replace(/[/:@#\s]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (!token) return undefined;
  if (token.toLowerCase() === "broadcast" || token.toLowerCase() === "broker") return undefined;
  return token;
}

/**
 * Migrate a persisted `agent_name` to the plan/38 leaf-name model (decision E).
 * Two legacy shapes get rewritten on read so a pre-fix config never fossilizes a
 * runtime accident as if it were an explicit choice:
 *
 *   - **`#N` collision suffix** — could only have come from a broker/lock
 *     assignment (the user can't type `#`: `sanitizeSegment` maps it to `-`), so
 *     a trailing `#<digits>` is stripped and the clean base re-derived.
 *   - **legacy `parent/folder`** — the old `defaultAgentName` shape; the `/`
 *     means it predates the leaf-only model, so we keep only the leaf segment.
 *
 * Returns the cleaned name, or undefined when nothing usable remains (so the
 * caller falls back to `defaultAgentName(cwd)`).
 */
export function migrateAgentName(raw: string): string | undefined {
  // Legacy `parent/folder` (or any path-ish value) → keep the trailing segment.
  const leaf = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  // Drop a runtime collision suffix a pre-fix build may have frozen into config.
  const clean = leaf.replace(/#\d+$/, "").trim();
  return clean.length > 0 ? clean : undefined;
}

/**
 * Parse a raw JSON string into a LocalConfig, surfacing only known fields.
 * Returns null when the input isn't a usable JSON object. Legacy `session_name`
 * from pre-refactor configs is silently dropped — the local UDS mesh is now
 * always a single fixed session, so the field has no meaning.
 */
function parseLocalConfig(raw: string): LocalConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const src = parsed as Record<string, unknown>;
  const cfg: LocalConfig = {};
  if (typeof src["agent_name"] === "string") {
    // Migrate on read (plan/38 decision E): strip a frozen `#N` and the legacy
    // `parent/folder` shape so neither fossilizes as an explicit name.
    const migrated = migrateAgentName(src["agent_name"]);
    if (migrated) cfg.agent_name = migrated;
  }
  if (typeof src["auto_start_relay"] === "boolean") cfg.auto_start_relay = src["auto_start_relay"];
  return cfg;
}

/** Inline config from `REMOTE_OMP_DIRECT_CONFIG`, when set + parseable; else null. */
function directConfig(): LocalConfig | null {
  const raw = process.env[DIRECT_CONFIG_ENV];
  if (!raw || raw.trim().length === 0) return null;
  const parsed = parseLocalConfig(raw);
  if (!parsed) {
    process.stderr.write("[remote-omp] ignoring malformed REMOTE_OMP_DIRECT_CONFIG\n");
  }
  return parsed;
}

/**
 * True when a local config is available for this cwd — inline via
 * `REMOTE_OMP_DIRECT_CONFIG`, as `<cwd>/.omp/remote-omp/config.json` on disk, or
 * as the pre-rename `<cwd>/.pi/remote-pi/config.json` (which `loadLocalConfig`
 * carries over on first read).
 */
export function localConfigExists(cwd: string): boolean {
  return (
    directConfig() !== null ||
    existsSync(pathFor(cwd)) ||
    existsSync(pathFor(cwd, LEGACY_LOCAL_DIR))
  );
}

/** Parses the config file at `p`; null (after a note on stderr) when it is unreadable or invalid. */
function readConfigFile(p: string): LocalConfig | null {
  try {
    const parsed = parseLocalConfig(readFileSync(p, "utf8"));
    if (!parsed) process.stderr.write(`[remote-omp] ignoring invalid local config at ${p}\n`);
    return parsed;
  } catch (err) {
    process.stderr.write(
      `[remote-omp] could not read ${p}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

/**
 * Best-effort persistence: returns the failure message instead of throwing. A
 * read-only config.json is a legitimate deployment (NixOS/Home Manager symlink
 * into the immutable Nix store, read-only root, EPERM). The name/config sync is
 * cosmetic — it must NEVER crash the omp process with an uncaughtException.
 * `saveLocalConfig` is reached via fire-and-forget async paths (the agent-name
 * sync from `turn_start` / `session_start`), so a sync throw from `mkdirSync` /
 * `writeFileSync` sails past the runner's per-handler try/catch and takes down
 * omp. Both fs calls are guarded together so a partial attempt can't throw past
 * the caller.
 */
function writeConfigFile(p: string, cfg: LocalConfig): string | null {
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function loadLocalConfig(cwd: string, opts?: { ignoreDirectConfig?: boolean }): LocalConfig {
  // Precedence: inline `REMOTE_OMP_DIRECT_CONFIG` env wins over the files. An
  // unset/empty/malformed env falls through to the on-disk config.json.
  if (!opts?.ignoreDirectConfig) {
    const direct = directConfig();
    if (direct) return direct;
  }

  const p = pathFor(cwd);
  if (existsSync(p)) return readConfigFile(p) ?? {};

  // One-time migration (plan/69): a folder Remote Pi configured only has the
  // legacy `.pi/remote-pi/config.json`. Carry its values over into the new
  // file so later reads and saves use it; the old file is left untouched (an
  // older install may still read it). The write is best-effort — in a
  // read-only folder every load simply serves the legacy file again — and a
  // failure must never surface to the caller.
  const legacyPath = pathFor(cwd, LEGACY_LOCAL_DIR);
  if (!existsSync(legacyPath)) return {};
  const migrated = readConfigFile(legacyPath);
  if (!migrated) return {};
  writeConfigFile(p, migrated);
  return migrated;
}

export function saveLocalConfig(cwd: string, patch: Partial<LocalConfig>): void {
  const p = pathFor(cwd);
  // `loadLocalConfig` also serves a folder that only has the legacy file, so
  // its fields carry over into the new file on the first save.
  const current = loadLocalConfig(cwd);
  const next: LocalConfig = { ...current, ...patch };
  // Always persist auto_start_relay explicitly (default true) so future reads
  // never need to guess. Backward-compat: legacy files without the field
  // are treated as true on read; we lock that intent in on first save.
  if (typeof next.auto_start_relay !== "boolean") next.auto_start_relay = true;
  const failure = writeConfigFile(p, next);
  if (failure !== null) console.warn(`[remote-omp] could not persist local config ${p}: ${failure}`);
}

/**
 * Default agent name when none is configured (plan/38 decision D): the **leaf**
 * of the cwd, `basename(cwd)`. The cwd now travels as its own address axis
 * (`<cwd>@<nome>`), so the name no longer needs the `parent/folder` prefix that
 * used to disambiguate folders — the broker keys peers by `(cwd, nome)`, and a
 * clean leaf means `#N` almost never fires. Falls back to `"agent"` for a
 * path with no usable basename (root / empty).
 */
export function defaultAgentName(cwd: string): string {
  return basename(cwd) || "agent";
}

/** Resolves auto_start_relay with backward-compat (undefined → true). */
export function effectiveAutoStartRelay(cfg: LocalConfig): boolean {
  return cfg.auto_start_relay !== false;
}

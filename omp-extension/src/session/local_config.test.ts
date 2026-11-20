import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalConfig, localConfigExists, saveLocalConfig } from "./local_config.js";
import { _detectGoalStatus } from "../index.js";

const ENV = "REMOTE_OMP_DIRECT_CONFIG";

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), "rp-localcfg-"));
}

/** Write a config.json into <cwd>/.omp/remote-omp/. */
function writeFileConfig(cwd: string, obj: unknown): void {
  const dir = join(cwd, ".omp", "remote-omp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

/** Write what Remote Pi left behind: <cwd>/.pi/remote-pi/config.json. Returns its path. */
function writeLegacyConfig(cwd: string, obj: unknown): string {
  const dir = join(cwd, ".pi", "remote-pi");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe("loadLocalConfig — file vs REMOTE_OMP_DIRECT_CONFIG", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reads the on-disk file when env is unset", () => {
    writeFileConfig(cwd, { agent_name: "fromfile", auto_start_relay: false });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile", auto_start_relay: false });
  });

  test("empty config when neither env nor file present", () => {
    expect(loadLocalConfig(cwd)).toEqual({});
  });

  test("inline env takes precedence over the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile", auto_start_relay: false });
    process.env[ENV] = JSON.stringify({ agent_name: "fromenv", auto_start_relay: true });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromenv", auto_start_relay: true });
  });

  test("inline env works with no file on disk", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "envonly" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "envonly" });
  });

  test("malformed env JSON falls back to the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" });
    process.env[ENV] = "{not valid json";
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" });
  });

  test("empty/whitespace env falls back to the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" });
    process.env[ENV] = "   ";
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" });
  });

  test("only known fields are surfaced (unknown keys dropped)", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "a", auto_start_relay: true, session_name: "x", junk: 1 });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "a", auto_start_relay: true });
  });

  test("non-object env (array/number) falls back to the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" });
    process.env[ENV] = "[1,2,3]";
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" });
  });
});

describe("loadLocalConfig — workspace / worktree removed (plan 38)", () => {
  // The fields were dropped: the mesh identity is `(cwd, nome)`, with `cwd`
  // subsuming folder + worktree disambiguation. A stale key from an old config
  // (or one the Cockpit still injects) must be silently ignored on read.
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(cwd, { recursive: true, force: true });
  });

  test("ignores a stale workspace/worktree key from the file", () => {
    writeFileConfig(cwd, { agent_name: "app", workspace: "acme", worktree: "feat-login" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "app" });
  });

  test("ignores a stale workspace/worktree key from the inline env", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "app", workspace: "acme", worktree: "feat-login" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "app" });
  });
});

describe("localConfigExists — honors env + file", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(cwd, { recursive: true, force: true });
  });

  test("false when neither env nor file present", () => {
    expect(localConfigExists(cwd)).toBe(false);
  });

  test("true when only the file exists", () => {
    writeFileConfig(cwd, { agent_name: "a" });
    expect(localConfigExists(cwd)).toBe(true);
  });

  test("true when only the legacy .pi/remote-pi file exists", () => {
    writeLegacyConfig(cwd, { agent_name: "a" });
    expect(localConfigExists(cwd)).toBe(true);
  });

  test("true when only the inline env is set", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "a" });
    expect(localConfigExists(cwd)).toBe(true);
  });

  test("false when env is set but malformed and no file", () => {
    process.env[ENV] = "nope";
    expect(localConfigExists(cwd)).toBe(false);
  });
});

describe("saveLocalConfig — unaffected by env (still writes the file)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(cwd, { recursive: true, force: true });
  });

  test("auto_start_relay defaults to true on save", () => {
    saveLocalConfig(cwd, { agent_name: "saved" });
    delete process.env[ENV]; // ensure we read the file back, not any env
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "saved", auto_start_relay: true });
  });
});

describe("migration from the pre-rename <cwd>/.pi/remote-pi/config.json (plan/69)", () => {
  let cwd: string;
  const newFile = () => join(cwd, ".omp", "remote-omp", "config.json");

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Makes the new location unwritable on every platform (even as root): `.omp` becomes a regular file. */
  function blockNewLocation(): void {
    writeFileSync(join(cwd, ".omp"), "not a directory");
  }

  test("legacy-only folder: values are served, copied to the new file, legacy file left untouched", () => {
    const legacy = writeLegacyConfig(cwd, { agent_name: "legacy", auto_start_relay: false });
    const before = readFileSync(legacy, "utf8");

    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "legacy", auto_start_relay: false });

    expect(JSON.parse(readFileSync(newFile(), "utf8"))).toEqual({
      agent_name: "legacy",
      auto_start_relay: false,
    });
    expect(readFileSync(legacy, "utf8")).toBe(before);
  });

  test("the copy holds the parsed values only (stale / unknown keys dropped)", () => {
    writeLegacyConfig(cwd, { agent_name: "app", workspace: "acme", session_name: "x", junk: 1 });
    loadLocalConfig(cwd);
    expect(JSON.parse(readFileSync(newFile(), "utf8"))).toEqual({ agent_name: "app" });
  });

  test("both present: the new file wins and neither file is rewritten", () => {
    const legacy = writeLegacyConfig(cwd, { agent_name: "legacy", auto_start_relay: false });
    writeFileConfig(cwd, { agent_name: "current", auto_start_relay: true });
    const legacyBefore = readFileSync(legacy, "utf8");
    const newBefore = readFileSync(newFile(), "utf8");

    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "current", auto_start_relay: true });

    expect(readFileSync(legacy, "utf8")).toBe(legacyBefore);
    expect(readFileSync(newFile(), "utf8")).toBe(newBefore);
  });

  test("the copy happens once: a later edit of the legacy file does not override the new file", () => {
    const legacy = writeLegacyConfig(cwd, { agent_name: "legacy" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "legacy" });

    writeFileSync(legacy, JSON.stringify({ agent_name: "edited-by-an-old-install" }));
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "legacy" });
  });

  test("a failed copy never throws: the legacy values are still served", () => {
    writeLegacyConfig(cwd, { agent_name: "legacy", auto_start_relay: false });
    blockNewLocation();

    expect(() => loadLocalConfig(cwd)).not.toThrow();
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "legacy", auto_start_relay: false });
    expect(existsSync(newFile())).toBe(false);
  });

  test("an invalid legacy file yields {} and no new file is created", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = join(cwd, ".pi", "remote-pi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{not json");

    expect(loadLocalConfig(cwd)).toEqual({});
    expect(existsSync(newFile())).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("ignoring invalid local config"));
  });

  test("inline env still wins over a legacy file and skips the copy", () => {
    writeLegacyConfig(cwd, { agent_name: "legacy" });
    process.env[ENV] = JSON.stringify({ agent_name: "fromenv" });

    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromenv" });
    expect(existsSync(newFile())).toBe(false);
  });

  test("save after a legacy read keeps the legacy fields and writes only the new file", () => {
    const legacy = writeLegacyConfig(cwd, { agent_name: "legacy", auto_start_relay: false });
    const before = readFileSync(legacy, "utf8");
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "legacy", auto_start_relay: false });

    saveLocalConfig(cwd, { agent_name: "renamed" });

    expect(JSON.parse(readFileSync(newFile(), "utf8"))).toEqual({
      agent_name: "renamed",
      auto_start_relay: false,
    });
    expect(readFileSync(legacy, "utf8")).toBe(before);
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "renamed", auto_start_relay: false });
  });

  test("save on a legacy-only folder without a prior read also keeps the legacy fields", () => {
    writeLegacyConfig(cwd, { agent_name: "legacy", auto_start_relay: false });

    saveLocalConfig(cwd, { agent_name: "renamed" });

    expect(JSON.parse(readFileSync(newFile(), "utf8"))).toEqual({
      agent_name: "renamed",
      auto_start_relay: false,
    });
  });

  test("save never throws when the new location is unwritable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeLegacyConfig(cwd, { agent_name: "legacy" });
    blockNewLocation();

    expect(() => saveLocalConfig(cwd, { agent_name: "renamed" })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not persist local config"));
    expect(existsSync(newFile())).toBe(false);
  });
});

describe("_detectGoalStatus", () => {
  test("detects active goal from direct getGoalModeState", () => {
    const ctx = {
      getGoalModeState: () => ({ enabled: true, goal: { status: "active" } }),
    };
    expect(_detectGoalStatus(ctx)).toBe("active");
  });

  test("detects paused goal from direct getGoalModeState", () => {
    const ctx = {
      getGoalModeState: () => ({ enabled: false, goal: { status: "paused" } }),
    };
    expect(_detectGoalStatus(ctx)).toBe("paused");
  });

  test("detects paused goal from sessionManager entries fallback", () => {
    const ctx = {
      sessionManager: {
        getEntries: () => [
          { type: "user_message", id: "1" },
          { type: "mode_change", id: "2", mode: "goal_paused", data: { goal: { status: "paused" } } },
        ],
      },
    };
    expect(_detectGoalStatus(ctx)).toBe("paused");
  });

  test("detects active goal from sessionManager entries fallback", () => {
    const ctx = {
      sessionManager: {
        getEntries: () => [
          { type: "user_message", id: "1" },
          { type: "mode_change", id: "2", mode: "goal_paused" },
          { type: "mode_change", id: "3", mode: "goal" },
        ],
      },
    };
    expect(_detectGoalStatus(ctx)).toBe("active");
  });

  test("detects idle when latest mode_change is none", () => {
    const ctx = {
      sessionManager: {
        getEntries: () => [
          { type: "mode_change", id: "1", mode: "goal" },
          { type: "mode_change", id: "2", mode: "none" },
        ],
      },
    };
    expect(_detectGoalStatus(ctx)).toBe("idle");
  });

  test("returns undefined when no context or entries provided", () => {
    expect(_detectGoalStatus(null)).toBeUndefined();
    expect(_detectGoalStatus({})).toBeUndefined();
  });
});

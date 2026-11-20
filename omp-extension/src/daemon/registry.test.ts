import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  addDaemon,
  listDaemons,
  loadRegistry,
  migrateRegistryNames,
  normalizeCwd,
  registryPath,
  removeDaemon,
  saveRegistry,
} from "./registry.js";
import { daemonIdForCwd } from "./id.js";
import { defaultAgentName } from "../session/local_config.js";

/** Each test runs against an isolated $HOME-like directory so the registry
 *  writes never touch the developer's real `~/.omp/remote/daemons.json`, and
 *  every scratch folder is created under `testHome` so `afterEach` cleans it. */
let testHome: string;
let prevOmpHome: string | undefined;

const makeCwd = (prefix = "cwd-"): string => mkdtempSync(join(testHome, prefix));

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "omp-regtest-"));
  prevOmpHome = process.env["REMOTE_OMP_HOME"];
  process.env["REMOTE_OMP_HOME"] = testHome;
});

afterEach(() => {
  if (prevOmpHome === undefined) delete process.env["REMOTE_OMP_HOME"];
  else process.env["REMOTE_OMP_HOME"] = prevOmpHome;
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("registryPath", () => {
  test("honors REMOTE_OMP_HOME env override", () => {
    expect(registryPath()).toBe(join(testHome, ".omp", "remote", "daemons.json"));
  });

  test("does not read the registry an older version left in ~/.pi/remote (the supervisor's startup copies it)", () => {
    const old = join(testHome, ".pi", "remote");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "daemons.json"), JSON.stringify({ daemons: [{ cwd: "/tmp/old" }] }));
    expect(loadRegistry()).toEqual({ daemons: [] });
    expect(listDaemons()).toEqual([]);
  });
});

describe("normalizeCwd", () => {
  test("canonicalizes an existing path", () => {
    const tmp = makeCwd("norm-");
    expect(normalizeCwd(tmp)).toBe(realpathSync(tmp));
  });

  test("resolves relative paths against process.cwd()", () => {
    const got = normalizeCwd(".");
    expect(isAbsolute(got)).toBe(true);
    expect(got).toBe(realpathSync("."));
  });

  test("throws on empty input", () => {
    expect(() => normalizeCwd("")).toThrow(/required/i);
    expect(() => normalizeCwd("   ")).toThrow(/required/i);
  });

  test("throws on non-existent path (realpath ENOENT)", () => {
    expect(() => normalizeCwd("/no/such/path/anywhere/xyz-omp-test")).toThrow();
  });

  test("symlinks resolve to canonical realpath", () => {
    const tmp = makeCwd("symlink-");
    const real = join(tmp, "real");
    mkdirSync(real);
    const link = join(tmp, "link");
    symlinkSync(real, link);
    expect(normalizeCwd(link)).toBe(normalizeCwd(real));
  });
});

describe("loadRegistry / saveRegistry", () => {
  test("empty when file absent", () => {
    const reg = loadRegistry();
    expect(reg).toEqual({ daemons: [] });
  });

  test("round-trip: save then load", () => {
    saveRegistry({ daemons: [{ cwd: "/tmp/a" }, { cwd: "/tmp/b" }] });
    expect(loadRegistry()).toEqual({ daemons: [{ cwd: "/tmp/a" }, { cwd: "/tmp/b" }] });
  });

  test("creates parent dirs on save", () => {
    saveRegistry({ daemons: [] });
    expect(existsSync(registryPath())).toBe(true);
  });

  test("malformed JSON tolerated on read (returns empty)", () => {
    const path = registryPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not-json");
    expect(loadRegistry()).toEqual({ daemons: [] });
  });

  test("unknown shape tolerated on read", () => {
    const path = registryPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ foo: "bar" }));
    expect(loadRegistry()).toEqual({ daemons: [] });
  });

  test("mutations refuse to overwrite a corrupted registry file", () => {
    const path = registryPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{broken-json");
    const cwd = makeCwd("strict-");
    expect(() => addDaemon(cwd, "door")).toThrow(/malformed/i);
    expect(() => removeDaemon("deadbeef")).toThrow(/malformed/i);
    expect(readFileSync(path, "utf8")).toBe("{broken-json");
  });
});

describe("addDaemon", () => {
  test("registers a fresh cwd and returns derived id", () => {
    const tmp = makeCwd("add-");
    const result = addDaemon(tmp);
    expect(result.id).toBe(daemonIdForCwd(realpathSync(tmp)));
    expect(result.cwd).toBe(realpathSync(tmp));
    expect(listDaemons().map((d) => d.cwd)).toEqual([realpathSync(tmp)]);
  });

  test("rejects duplicate cwd (same normalized path)", () => {
    const tmp = makeCwd("dup-");
    addDaemon(tmp);
    expect(() => addDaemon(tmp)).toThrow(/already registered/i);
  });

  test("relative path / symlink canonicalizes to same entry as absolute", () => {
    const tmp = makeCwd("relabs-");
    addDaemon(tmp);
    const link = join(testHome, `relabs-link-${Date.now()}`);
    symlinkSync(tmp, link);
    expect(() => addDaemon(link)).toThrow(/already registered/i);
  });

  test("on-disk file matches loadRegistry output", () => {
    const tmp = makeCwd("disk-");
    addDaemon(tmp);
    const onDisk = JSON.parse(readFileSync(registryPath(), "utf8")) as { daemons: Array<{ cwd: string }> };
    expect(onDisk.daemons).toHaveLength(1);
    expect(onDisk.daemons[0]!.cwd).toBe(realpathSync(tmp));
  });

  test("returns, lists and persists exactly { id, cwd, name }", () => {
    const tmp = makeCwd("shape-");
    const real = realpathSync(tmp);
    expect(addDaemon(tmp, "door")).toEqual({ id: daemonIdForCwd(real), cwd: real, name: "door" });
    expect(listDaemons()).toEqual([{ id: daemonIdForCwd(real), cwd: real, name: "door" }]);
    const onDisk = JSON.parse(readFileSync(registryPath(), "utf8")) as { daemons: Array<Record<string, unknown>> };
    expect(onDisk.daemons).toEqual([{ cwd: real, name: "door" }]);
  });

  test("whitespace-only names fall back to the folder name", () => {
    saveRegistry({ daemons: [{ cwd: "/tmp/a", name: "   " }] });
    expect(listDaemons()).toMatchObject([{ cwd: "/tmp/a", name: "a" }]);
  });
});

// Registries written before Remote OMP was omp-only also stored which agent CLI a daemon ran.
describe("a `harness` key left in daemons.json by an older version", () => {
  const writeOldRegistry = (): void => {
    mkdirSync(dirname(registryPath()), { recursive: true });
    writeFileSync(
      registryPath(),
      JSON.stringify({
        daemons: [
          { cwd: "/tmp/a", name: "A", harness: "omp" },
          { cwd: "/tmp/b", name: "B", harness: "pi" },
          { cwd: "/tmp/c", name: "C", harness: "nonsense" },
        ],
      }),
    );
  };

  test("is ignored without a warning, whatever its value", () => {
    writeOldRegistry();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(loadRegistry()).toEqual({
        daemons: [{ cwd: "/tmp/a", name: "A" }, { cwd: "/tmp/b", name: "B" }, { cwd: "/tmp/c", name: "C" }],
      });
      expect(listDaemons().map((d) => [d.cwd, d.name])).toEqual([["/tmp/a", "A"], ["/tmp/b", "B"], ["/tmp/c", "C"]]);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  test("never reaches a record", () => {
    writeOldRegistry();
    for (const record of listDaemons()) expect(Object.keys(record).sort()).toEqual(["cwd", "id", "name"]);
  });

  test("is left out of the file by the next save", () => {
    writeOldRegistry();
    addDaemon(makeCwd("extra-"), "E");
    const onDisk = JSON.parse(readFileSync(registryPath(), "utf8")) as { daemons: Array<Record<string, unknown>> };
    expect(onDisk.daemons).toHaveLength(4);
    for (const entry of onDisk.daemons) expect(Object.keys(entry).sort()).toEqual(["cwd", "name"]);
  });
});

describe("removeDaemon", () => {
  test("removes by id and returns the cwd", () => {
    const tmp = makeCwd("rm-");
    const { id } = addDaemon(tmp);
    const result = removeDaemon(id);
    expect(result.removed).toBe(true);
    expect(result.cwd).toBe(realpathSync(tmp));
    expect(listDaemons()).toEqual([]);
  });

  test("unknown id is a no-op (removed=false)", () => {
    const result = removeDaemon("ffffffff");
    expect(result.removed).toBe(false);
    expect(result.cwd).toBeUndefined();
  });

  test("only removes the matching entry — others stay", () => {
    const a = makeCwd("multi-a-");
    const b = makeCwd("multi-b-");
    const { id: idA } = addDaemon(a);
    addDaemon(b);
    removeDaemon(idA);
    const remaining = listDaemons();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.cwd).toBe(realpathSync(b));
  });
});

describe("listDaemons", () => {
  test("returns derived ids alongside cwds, in insertion order", () => {
    const a = makeCwd("list-a-");
    const b = makeCwd("list-b-");
    addDaemon(a);
    addDaemon(b);
    const out = listDaemons();
    expect(out).toEqual([
      { id: daemonIdForCwd(realpathSync(a)), cwd: realpathSync(a), name: defaultAgentName(realpathSync(a)) },
      { id: daemonIdForCwd(realpathSync(b)), cwd: realpathSync(b), name: defaultAgentName(realpathSync(b)) },
    ]);
  });

  test("legacy entry without a name falls back to the folder-derived name", () => {
    const dir = makeCwd("legacy-");
    const cwd = realpathSync(dir);
    saveRegistry({ daemons: [{ cwd }] });
    const out = listDaemons();
    expect(out).toEqual([{ id: daemonIdForCwd(cwd), cwd, name: defaultAgentName(cwd) }]);
  });

  test("stat cache picks up out-of-band file modifications immediately", () => {
    const a = makeCwd("cache-a-");
    const b = makeCwd("cache-b-");
    addDaemon(a, "first");
    expect(listDaemons().map((d) => d.name)).toEqual(["first"]);
    writeFileSync(registryPath(), JSON.stringify({ daemons: [{ cwd: realpathSync(b), name: "edited" }] }));
    expect(listDaemons().map((d) => d.name)).toEqual(["edited"]);
  });

  test("empty registry yields []", () => {
    expect(listDaemons()).toEqual([]);
  });
});

describe("migrateRegistryNames", () => {
  test("backfills folder names into legacy entries and persists", () => {
    const dir = makeCwd("mig-");
    const cwd = realpathSync(dir);
    saveRegistry({ daemons: [{ cwd }] });

    const changed = migrateRegistryNames();
    expect(changed).toBe(1);

    const onDisk = JSON.parse(readFileSync(registryPath(), "utf8")) as {
      daemons: Array<{ cwd: string; name?: string }>;
    };
    expect(onDisk.daemons[0]!.name).toBe(defaultAgentName(cwd));
  });

  test("is idempotent — a second run changes nothing", () => {
    const dir = makeCwd("mig2-");
    addDaemon(dir);
    expect(migrateRegistryNames()).toBe(0);
  });
});

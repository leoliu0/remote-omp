import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ServerMessage } from "../protocol/types.js";
import {
  clampLimit,
  clearListFilesCache,
  FileRanker,
  handleListFiles,
  listFilesCacheSize,
  listProjectFiles,
  MAX_LIST_LIMIT,
  MAX_LISTED_PATHS,
  rankFiles,
  walkFiles,
} from "./list_files.js";

function makeSender() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send(msg: ServerMessage): void {
      sent.push(msg);
    },
  };
}

function touch(root: string, rel: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "x");
}

describe("rankFiles", () => {
  const files = [
    "docs/supervisor-notes.md", // basename prefix
    "src/daemon/supervisor.ts", // basename prefix, longer than exact below
    "src/supervisor", // exact basename
    "src/a/b/my-supervisor-x.ts", // basename substring
    "supervisor/README.md", // path substring only
    "s/u/p/e/r/v.ts", // subsequence only
    "unrelated.ts",
  ];

  test("orders exact > prefix > substring > path substring > subsequence", () => {
    const { files: out } = rankFiles(files, "supervisor", 10);
    expect(out).toEqual([
      "src/supervisor",
      "docs/supervisor-notes.md",
      "src/daemon/supervisor.ts",
      "src/a/b/my-supervisor-x.ts",
      "supervisor/README.md",
    ]);
  });

  test("subsequence matches rank last", () => {
    const { files: out } = rankFiles(files, "sprvs", 10);
    expect(out).toContain("s/u/p/e/r/v.ts");
    expect(out).not.toContain("unrelated.ts");
  });

  test("is case-insensitive and ties prefer the shorter path", () => {
    const { files: out } = rankFiles(
      ["a/long/dir/Readme.md", "Readme.md", "x/readme.md"],
      "README.MD",
      10,
    );
    expect(out).toEqual(["Readme.md", "x/readme.md", "a/long/dir/Readme.md"]);
  });

  test("empty query returns shallow, short paths first", () => {
    const { files: out } = rankFiles(
      ["a/b/c/deep.ts", "z.ts", "src/x.ts", "bb.ts"],
      "  ",
      10,
    );
    expect(out).toEqual(["z.ts", "bb.ts", "src/x.ts", "a/b/c/deep.ts"]);
  });

  test("limit cuts the result and reports the total", () => {
    const many = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
    const r = rankFiles(many, "f", 5);
    expect(r.files).toHaveLength(5);
    expect(r.total).toBe(50);
  });
});

describe("clampLimit", () => {
  test("defaults, floors and caps", () => {
    expect(clampLimit(undefined)).toBe(30);
    expect(clampLimit("5")).toBe(30);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(10_000)).toBe(MAX_LIST_LIMIT);
  });
});

describe("list_files handler", () => {
  const dirs: string[] = [];
  beforeEach(() => clearListFilesCache());
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "pi-listfiles-"));
    dirs.push(d);
    return d;
  }

  function gitRepo(): string {
    const dir = tempDir();
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    touch(dir, ".gitignore");
    writeFileSync(join(dir, ".gitignore"), "ignored/\n*.log\n");
    touch(dir, "src/daemon/supervisor.ts");
    touch(dir, "src/index.ts");
    touch(dir, "README.md");
    touch(dir, ".github/workflows/ci.yml");
    touch(dir, "ignored/secret.ts");
    touch(dir, "debug.log");
    touch(dir, "node_modules/pkg/index.js");
    return dir;
  }

  test("replies files_list with root, ranked files and in_reply_to", async () => {
    const dir = gitRepo();
    const sender = makeSender();
    await handleListFiles(dir, sender, { type: "list_files", id: "a1", query: "sup" });
    expect(sender.sent).toHaveLength(1);
    const reply = sender.sent[0]!;
    expect(reply).toMatchObject({ type: "files_list", in_reply_to: "a1", root: dir });
    if (reply.type !== "files_list") throw new Error("unreachable");
    expect(reply.files[0]).toBe("src/daemon/supervisor.ts");
    expect(reply.truncated).toBe(false);
  });

  test("respects .gitignore and includes hidden files", async () => {
    const dir = gitRepo();
    const r = await listProjectFiles(dir, "", 100);
    expect(r.files).toContain("README.md");
    expect(r.files).toContain(".github/workflows/ci.yml");
    expect(r.files).not.toContain("ignored/secret.ts");
    expect(r.files).not.toContain("debug.log");
    expect(r.files.some((f) => f.startsWith(".git/"))).toBe(false);
  });

  test("limit truncates and flags truncated", async () => {
    const dir = gitRepo();
    const r = await listProjectFiles(dir, "", 2);
    expect(r.files).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  test("works outside a git repository", async () => {
    const dir = tempDir();
    touch(dir, "app/main.dart");
    touch(dir, "app/lib/widget.dart");
    const r = await listProjectFiles(dir, "widget", 30);
    expect(r.files).toEqual(["app/lib/widget.dart"]);
  });

  test("caches the file list per cwd for a short window", async () => {
    const dir = tempDir();
    touch(dir, "a.ts");
    const t0 = 1_000_000;
    expect((await listProjectFiles(dir, "", 30, t0)).files).toEqual(["a.ts"]);
    touch(dir, "b.ts");
    expect((await listProjectFiles(dir, "", 30, t0 + 5_000)).files).toEqual(["a.ts"]);
    expect((await listProjectFiles(dir, "", 30, t0 + 11_000)).files.sort()).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  test("a missing cwd yields an empty list instead of throwing", async () => {
    const dir = tempDir();
    const r = await listProjectFiles(join(dir, "nope"), "x", 30);
    expect(r.files).toEqual([]);
  });
});

describe("walkFiles (last-resort fallback)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "pi-walk-"));
    dirs.push(d);
    return d;
  }

  test("skips node_modules and .git, honours depth and entry caps", async () => {
    const dir = tempDir();
    touch(dir, "a.ts");
    touch(dir, "src/b.ts");
    touch(dir, "node_modules/x/c.js");
    touch(dir, ".git/HEAD");
    touch(dir, "l1/l2/l3/deep.ts");
    const all = (await walkFiles(dir)).sort();
    expect(all).toEqual(["a.ts", "l1/l2/l3/deep.ts", "src/b.ts"]);
    expect((await walkFiles(dir, { maxDepth: 1 })).sort()).toEqual(["a.ts", "src/b.ts"]);
    expect(await walkFiles(dir, { maxEntries: 1 })).toHaveLength(1);
  });
});

describe("FileRanker", () => {
  test("result is independent of arrival order and bounded per tier", () => {
    const paths = Array.from({ length: 500 }, (_, i) => `d${i % 7}/file${i}.ts`);
    paths.push("deep/er/needle.ts", "needle.ts", "x/needle.txt");
    const forward = rankFiles(paths, "needle", 2);
    const backward = rankFiles([...paths].reverse(), "needle", 2);
    expect(forward).toEqual(backward);
    expect(forward.files).toEqual(["needle.ts", "x/needle.txt"]);
    expect(forward.total).toBe(3);
    const r = new FileRanker("file", 3);
    for (const p of paths) r.add(p);
    expect(r.result().files).toHaveLength(3);
    expect(r.result().total).toBe(500);
  });
});

// A fake `rg` first on PATH lets us script exit codes, huge output and hangs.
describe.skipIf(process.platform === "win32")("rg edge cases (scripted rg)", () => {
  const dirs: string[] = [];
  const oldPath = process.env.PATH;
  beforeEach(() => clearListFilesCache());
  afterEach(() => {
    process.env.PATH = oldPath;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fakeRg(script: string): string {
    const bin = mkdtempSync(join(tmpdir(), "pi-fakerg-"));
    dirs.push(bin);
    writeFileSync(join(bin, "rg"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "rg"), 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    const cwd = mkdtempSync(join(tmpdir(), "pi-fakerg-cwd-"));
    dirs.push(cwd);
    return cwd;
  }

  test("exit 2 (unreadable dir) still uses the printed list", async () => {
    const cwd = fakeRg(`printf 'src/a.ts\\0src/b.ts\\0'; exit 2`);
    const r = await listProjectFiles(cwd, "", 30);
    expect(r.files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a timeout keeps what was listed so far and flags truncated", async () => {
    const cwd = fakeRg(`printf 'src/a.ts\\0src/need'; exec sleep 30`);
    const t0 = Date.now();
    const r = await listProjectFiles(cwd, "", 30, Date.now(), 300);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.files).toEqual(["src/a.ts"]); // the path cut mid-way is dropped
    expect(r.truncated).toBe(true);
    expect(listFilesCacheSize()).toBe(0); // incomplete lists are not cached
  });

  test("an rg that fails without output falls back to git/walk", async () => {
    const cwd = fakeRg(`exit 127`);
    touch(cwd, "only.ts");
    const r = await listProjectFiles(cwd, "only", 30);
    expect(r.files).toEqual(["only.ts"]);
  });

  test("more than 50k paths: the match arriving last is still found", async () => {
    const n = MAX_LISTED_PATHS + 10_000;
    const cwd = fakeRg(
      `seq 1 ${n} | sed 's|^|gen/f|; s|$|.txt|' | tr '\\n' '\\0'; printf 'late/needle.ts\\0'`,
    );
    const r = await listProjectFiles(cwd, "needle", 5);
    expect(r.files).toEqual(["late/needle.ts"]);
    expect(r.truncated).toBe(false);
    // Deterministic top of an empty query over the whole stream.
    const top = await listProjectFiles(cwd, "", 3);
    expect(top.files).toEqual(["gen/f1.txt", "gen/f2.txt", "gen/f3.txt"]);
    expect(top.truncated).toBe(true);
    expect(listFilesCacheSize()).toBe(0); // too big to cache
  });
});

describe("cache eviction", () => {
  test("a fresh list is cached and an expired one is dropped on next use", async () => {
    clearListFilesCache();
    const dir = mkdtempSync(join(tmpdir(), "pi-evict-"));
    try {
      touch(dir, "a.ts");
      await listProjectFiles(dir, "", 30, 1_000);
      expect(listFilesCacheSize()).toBe(1);
      touch(dir, "b.ts");
      const r = await listProjectFiles(dir, "", 30, 1_000 + 11_000);
      expect(r.files.sort()).toEqual(["a.ts", "b.ts"]);
      expect(listFilesCacheSize()).toBe(1); // replaced, not accumulated
    } finally {
      clearListFilesCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

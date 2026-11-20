import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ServerMessage } from "../protocol/types.js";
import {
  handleGitDiff,
  handleGitStatus,
  MAX_DIFF_BYTES,
} from "./git_diff.js";

function makeSender() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send(msg: ServerMessage): void {
      sent.push(msg);
    },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("git_status & git_diff action handlers", () => {
  const dirs: string[] = [];

  function makeTempDir(prefix = "pi-gitdiff-"): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  function initRepo(branch = "main"): string {
    const dir = makeTempDir();
    git(dir, "init", "-b", branch);
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test User");
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const d = dirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test("non-git directory returns is_repo: false and empty files", async () => {
    const dir = makeTempDir();
    const sender = makeSender();
    await handleGitStatus(dir, sender, { type: "git_status", id: "g1" });
    expect(sender.sent).toEqual([
      { type: "git_status_result", in_reply_to: "g1", is_repo: false, files: [] },
    ]);
  });

  test("clean repository returns is_repo: true, branch name, and empty files", async () => {
    const repo = initRepo("feature/test");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "init");

    const sender = makeSender();
    await handleGitStatus(repo, sender, { type: "git_status", id: "g2" });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      type: "git_status_result",
      in_reply_to: "g2",
      is_repo: true,
      branch: "feature/test",
      files: [],
    });
  });

  test("handles unborn HEAD staged file", async () => {
    const repo = initRepo("main");
    writeFileSync(join(repo, "first.txt"), "alpha\nbeta\n");
    git(repo, "add", "first.txt");

    const s1 = makeSender();
    await handleGitStatus(repo, s1, { type: "git_status", id: "g3" });
    expect(s1.sent[0]).toMatchObject({
      type: "git_status_result",
      is_repo: true,
      branch: "main",
      files: [
        { path: "first.txt", status: "added", staged: true, unstaged: false, additions: 2, deletions: 0 },
      ],
    });

    const s2 = makeSender();
    await handleGitDiff(repo, s2, { type: "git_diff", id: "g4", path: "first.txt", staged: true });
    expect(s2.sent[0]).toMatchObject({
      type: "git_diff_result",
      in_reply_to: "g4",
      path: "first.txt",
      staged: true,
      additions: 2,
      deletions: 0,
    });
    expect((s2.sent[0] as Extract<ServerMessage, { type: "git_diff_result" }>).diff).toContain("+alpha");
  });

  test("tracks modified, staged+unstaged, renamed, deleted, untracked text/binary, and tracked binary files", async () => {
    const repo = initRepo("main");
    writeFileSync(join(repo, "mod.txt"), "line1\nline2\n");
    writeFileSync(join(repo, "rename-me.txt"), "stay\n");
    writeFileSync(join(repo, "delete-me.txt"), "gone\n");
    writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 4]));
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    // Staged + unstaged modification
    writeFileSync(join(repo, "mod.txt"), "line1\nline2 staged\n");
    git(repo, "add", "mod.txt");
    writeFileSync(join(repo, "mod.txt"), "line1\nline2 staged\nline3 unstaged\n");

    // Rename + modify
    git(repo, "mv", "rename-me.txt", "renamed.txt");
    writeFileSync(join(repo, "renamed.txt"), "stay\nmore\n");

    // Deleted
    rmSync(join(repo, "delete-me.txt"));

    // Untracked text & binary
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub/new.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "untracked.bin"), Buffer.from([10, 0, 20, 30]));

    // Tracked binary modification
    writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 9, 8, 7]));

    const statusSender = makeSender();
    // Run from nested subdirectory to verify repo-root-relative path resolution works!
    await handleGitStatus(join(repo, "sub"), statusSender, { type: "git_status", id: "st1" });
    const statusRes = statusSender.sent[0] as Extract<ServerMessage, { type: "git_status_result" }>;
    expect(statusRes.is_repo).toBe(true);

    const byPath = new Map(statusRes.files.map((f) => [f.path, f]));
    expect(byPath.get("mod.txt")).toMatchObject({
      status: "modified",
      staged: true,
      unstaged: true,
      additions: 2,
    });
    expect(byPath.get("renamed.txt")).toMatchObject({
      status: "renamed",
      old_path: "rename-me.txt",
      staged: true,
      unstaged: true,
    });
    expect(byPath.get("delete-me.txt")).toMatchObject({
      status: "deleted",
      staged: false,
      unstaged: true,
      deletions: 1,
    });
    expect(byPath.get("sub/new.txt")).toMatchObject({
      status: "untracked",
      staged: false,
      unstaged: true,
      additions: 2,
      deletions: 0,
    });
    expect(byPath.get("untracked.bin")).toMatchObject({
      status: "untracked",
      binary: true,
    });
    expect(byPath.get("bin.dat")).toMatchObject({
      status: "modified",
      binary: true,
    });

    // Unstaged diff from nested cwd
    const dUnstaged = makeSender();
    await handleGitDiff(join(repo, "sub"), dUnstaged, { type: "git_diff", id: "d1", path: "mod.txt", staged: false });
    expect((dUnstaged.sent[0] as Extract<ServerMessage, { type: "git_diff_result" }>).diff).toContain("+line3 unstaged");

    // Staged diff
    const dStaged = makeSender();
    await handleGitDiff(join(repo, "sub"), dStaged, { type: "git_diff", id: "d2", path: "mod.txt", staged: true });
    const stagedText = (dStaged.sent[0] as Extract<ServerMessage, { type: "git_diff_result" }>).diff;
    expect(stagedText).toContain("+line2 staged");
    expect(stagedText).not.toContain("+line3 unstaged");

    // Untracked text synthesized diff
    const dUntracked = makeSender();
    await handleGitDiff(repo, dUntracked, { type: "git_diff", id: "d3", path: "sub/new.txt" });
    expect((dUntracked.sent[0] as Extract<ServerMessage, { type: "git_diff_result" }>).diff).toContain("+++ b/sub/new.txt");

    // Binary untracked & tracked
    const dUntrackedBin = makeSender();
    await handleGitDiff(repo, dUntrackedBin, { type: "git_diff", id: "d4", path: "untracked.bin" });
    expect(dUntrackedBin.sent[0]).toMatchObject({ type: "git_diff_result", binary: true, diff: "" });

    const dTrackedBin = makeSender();
    await handleGitDiff(repo, dTrackedBin, { type: "git_diff", id: "d5", path: "bin.dat" });
    expect(dTrackedBin.sent[0]).toMatchObject({ type: "git_diff_result", binary: true, diff: "" });
  });

  test("rejects path traversal and absolute/NUL paths with invalid_message", async () => {
    const repo = initRepo("main");
    writeFileSync(join(repo, "a.txt"), "hi\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-m", "init");

    for (const bad of ["../outside.txt", "/etc/passwd", "a.txt\0b", "", ".."]) {
      const sender = makeSender();
      await handleGitDiff(repo, sender, { type: "git_diff", id: "bad", path: bad });
      expect(sender.sent[0]).toMatchObject({
        type: "error",
        in_reply_to: "bad",
        code: "invalid_message",
      });
    }
  });

  test("caps oversized diffs at MAX_DIFF_BYTES and sets truncated: true", async () => {
    const repo = initRepo("main");
    const big = Array.from({ length: 4000 }, (_, idx) => `line-${idx}-${"x".repeat(40)}`).join("\n") + "\n";
    writeFileSync(join(repo, "big.txt"), big);

    const sender = makeSender();
    await handleGitDiff(repo, sender, { type: "git_diff", id: "big1", path: "big.txt" });
    const res = sender.sent[0] as Extract<ServerMessage, { type: "git_diff_result" }>;
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.diff, "utf8")).toBeLessThanOrEqual(MAX_DIFF_BYTES);
  });
});

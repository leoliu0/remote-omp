import { execFile } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ActionReplySender } from "./handlers.js";
import type {
  ClientMessage,
  GitDiffResultMessage,
  GitFileStatus,
  GitStatusResultMessage,
  WireGitFileChange,
} from "../protocol/types.js";

const execFileAsync = promisify(execFile);

export const GIT_TIMEOUT_MS = 10_000;
export const MAX_STATUS_FILES = 200;
export const MAX_DIFF_BYTES = 128 * 1024;
export const MAX_UNTRACKED_STAT_FILES = 40;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

type GitStatusMsg = Extract<ClientMessage, { type: "git_status" }>;
type GitDiffMsg = Extract<ClientMessage, { type: "git_diff" }>;

export class InvalidGitPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGitPathError";
  }
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--no-optional-locks", ...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: "utf8",
  });
  return stdout;
}

/** Resolves the git toplevel directory for `cwd`, or `null` outside a repo. */
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = (await execGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Validates and normalizes a repo-relative path so untrusted client input
 * cannot escape `repoRoot` or pass NULs / absolute paths.
 */
export function assertSafeRepoRelativePath(repoRoot: string, rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new InvalidGitPathError("missing file path");
  }
  if (rawPath.includes("\0")) {
    throw new InvalidGitPathError("invalid NUL byte in path");
  }
  if (rawPath.startsWith("/") || rawPath.startsWith("\\") || /^[A-Za-z]:/.test(rawPath)) {
    throw new InvalidGitPathError("path must be relative to the repository root");
  }
  const slashNormalized = rawPath.replace(/\\/g, "/");
  const cleanPosix = posix.normalize(slashNormalized);
  if (
    !cleanPosix ||
    cleanPosix === "." ||
    cleanPosix === ".." ||
    cleanPosix.startsWith("../")
  ) {
    throw new InvalidGitPathError("path escapes repository root");
  }

  const absRoot = resolve(repoRoot);
  const absTarget = resolve(absRoot, cleanPosix);
  const rel = relative(absRoot, absTarget);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new InvalidGitPathError("path escapes repository root");
  }
  return cleanPosix;
}

function parseBranchHeader(header: string): string | undefined {
  let body = header.startsWith("## ") ? header.slice(3) : header;
  body = body.trim();
  if (!body) return undefined;
  if (body.startsWith("HEAD (no branch)")) return "detached";
  if (body.startsWith("No commits yet on ")) {
    body = body.slice("No commits yet on ".length);
  } else if (body.startsWith("Initial commit on ")) {
    body = body.slice("Initial commit on ".length);
  }
  const dotsIdx = body.indexOf("...");
  if (dotsIdx >= 0) {
    body = body.slice(0, dotsIdx);
  } else {
    body = body.replace(/\s+\[[^\]]*\]$/, "");
  }
  return body.trim() || undefined;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function classifyStatus(x: string, y: string): {
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
} {
  const xy = `${x}${y}`;
  if (x === "?" && y === "?") {
    return { status: "untracked", staged: false, unstaged: true };
  }
  const staged = x !== " " && x !== "?";
  const unstaged = y !== " " && y !== "?";
  if (CONFLICT_CODES.has(xy) || x === "U" || y === "U") {
    return { status: "conflicted", staged, unstaged };
  }
  if (x === "R" || y === "R") {
    return { status: "renamed", staged, unstaged };
  }
  if (x === "D" || y === "D") {
    return { status: "deleted", staged, unstaged };
  }
  if (x === "A" || y === "A" || x === "C" || y === "C") {
    return { status: "added", staged, unstaged };
  }
  return { status: "modified", staged, unstaged };
}

interface NumstatEntry {
  additions: number;
  deletions: number;
  binary: boolean;
}

function parseNumstatZ(stdout: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>();
  const tokens = stdout.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i++] ?? "";
    if (!token) continue;
    const firstTab = token.indexOf("\t");
    if (firstTab < 0) continue;
    const secondTab = token.indexOf("\t", firstTab + 1);
    if (secondTab < 0) continue;

    const addStr = token.slice(0, firstTab);
    const delStr = token.slice(firstTab + 1, secondTab);
    let filePath = token.slice(secondTab + 1);

    // `git diff --numstat -z` emits `add\tdel\t\0old_path\0new_path\0` for renames.
    if (filePath === "") {
      const _oldPath = tokens[i++] ?? "";
      filePath = tokens[i++] ?? _oldPath;
    }
    if (!filePath) continue;

    const binary = addStr === "-" || delStr === "-";
    const add = binary ? 0 : Number.parseInt(addStr, 10) || 0;
    const del = binary ? 0 : Number.parseInt(delStr, 10) || 0;
    const prev = map.get(filePath);
    if (prev) {
      prev.additions += add;
      prev.deletions += del;
      prev.binary = prev.binary || binary;
    } else {
      map.set(filePath, { additions: add, deletions: del, binary });
    }
  }
  return map;
}

async function inspectUntrackedFile(
  repoRoot: string,
  relPath: string,
): Promise<{ binary: boolean; additions?: number; text?: string; truncated?: boolean; emptyFile?: boolean }> {
  try {
    const safePath = assertSafeRepoRelativePath(repoRoot, relPath);
    const rootReal = await realpath(repoRoot);
    const absTarget = resolve(repoRoot, safePath);
    const fh = await open(absTarget, "r");
    try {
      const st = await fh.stat();
      if (!st.isFile()) return { binary: true };
      // Also guard symlink escaping repoRoot.
      const targetReal = await realpath(absTarget);
      const relReal = relative(rootReal, targetReal);
      if (relReal === ".." || relReal.startsWith(`..${sep}`) || isAbsolute(relReal)) {
        throw new InvalidGitPathError("symlink escapes repository root");
      }

      const toRead = Math.min(st.size, MAX_DIFF_BYTES + 1);
      const buf = Buffer.alloc(toRead);
      let offset = 0;
      while (offset < toRead) {
        const { bytesRead } = await fh.read(buf, offset, toRead - offset, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      const slice = buf.subarray(0, offset);
      const probeLen = Math.min(slice.length, 8192);
      if (slice.subarray(0, probeLen).includes(0)) {
        return { binary: true };
      }
      const truncated = st.size > MAX_DIFF_BYTES || offset > MAX_DIFF_BYTES;
      const usable = truncated ? slice.subarray(0, MAX_DIFF_BYTES) : slice;
      const text = usable.toString("utf8");
      if (st.size === 0) {
        return { binary: false, additions: 0, text: "", truncated: false, emptyFile: true };
      }
      const lines = text.endsWith("\n")
        ? text.slice(0, -1).split("\n")
        : text.split("\n");
      return { binary: false, additions: lines.length, text, truncated };
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err instanceof InvalidGitPathError) throw err;
    return { binary: false };
  }
}

function statusSortBucket(status: GitFileStatus): number {
  if (status === "conflicted") return 0;
  if (status === "untracked") return 2;
  return 1;
}

/** Reads branch, changed files, and line stats for `cwd`. */
export async function readGitChanges(
  cwd: string,
): Promise<Omit<GitStatusResultMessage, "type" | "in_reply_to">> {
  const repoRoot = await resolveRepoRoot(cwd);
  if (!repoRoot) {
    return { is_repo: false, files: [] };
  }

  const [statusOut, unstagedStatOut, stagedStatOut] = await Promise.all([
    execGit(repoRoot, ["status", "--porcelain=v1", "-z", "-b", "-uall"]),
    execGit(repoRoot, ["diff", "--numstat", "-z"]).catch(() => ""),
    execGit(repoRoot, ["diff", "--cached", "--numstat", "-z"]).catch(() => ""),
  ]);

  const unstagedStats = parseNumstatZ(unstagedStatOut);
  const stagedStats = parseNumstatZ(stagedStatOut);

  let branch: string | undefined;
  const parsed: WireGitFileChange[] = [];

  const tokens = statusOut.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i++] ?? "";
    if (!token) continue;
    if (token.startsWith("## ")) {
      branch = parseBranchHeader(token);
      continue;
    }
    if (token.length < 4) continue;
    const x = token[0]!;
    const y = token[1]!;
    const filePath = token.slice(3);
    if (!filePath) continue;

    let oldPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const nextTok = tokens[i++] ?? "";
      if (nextTok) oldPath = nextTok;
    }

    const { status, staged, unstaged } = classifyStatus(x, y);
    const uStat = unstagedStats.get(filePath);
    const sStat = stagedStats.get(filePath);
    const binary = Boolean(uStat?.binary || sStat?.binary);
    const hasStats = Boolean(uStat || sStat);
    const additions = binary
      ? undefined
      : hasStats
        ? (uStat?.additions ?? 0) + (sStat?.additions ?? 0)
        : undefined;
    const deletions = binary
      ? undefined
      : hasStats
        ? (uStat?.deletions ?? 0) + (sStat?.deletions ?? 0)
        : undefined;

    parsed.push({
      path: filePath,
      ...(oldPath ? { old_path: oldPath } : {}),
      status,
      staged,
      unstaged,
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
      ...(binary ? { binary: true } : {}),
    });
  }

  let untrackedInspected = 0;
  for (const item of parsed) {
    if (item.status !== "untracked") continue;
    if (untrackedInspected >= MAX_UNTRACKED_STAT_FILES) break;
    untrackedInspected += 1;
    try {
      const info = await inspectUntrackedFile(repoRoot, item.path);
      if (info.binary) {
        item.binary = true;
      } else if (info.additions !== undefined) {
        item.additions = info.additions;
        item.deletions = 0;
      }
    } catch {
      /* ignore unreadable/symlink untracked file in listing */
    }
  }

  parsed.sort((a, b) => {
    const ba = statusSortBucket(a.status);
    const bb = statusSortBucket(b.status);
    if (ba !== bb) return ba - bb;
    return a.path.localeCompare(b.path);
  });

  const truncated = parsed.length > MAX_STATUS_FILES;
  const files = truncated ? parsed.slice(0, MAX_STATUS_FILES) : parsed;

  return {
    is_repo: true,
    ...(branch ? { branch } : {}),
    repo_root: repoRoot,
    files,
    ...(truncated ? { truncated: true } : {}),
  };
}

function truncateUtf8OnLineBoundary(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= maxBytes) return { text: input, truncated: false };
  let sliced = buf.subarray(0, maxBytes).toString("utf8");
  // Drop possible incomplete trailing surrogate / replacement character.
  if (sliced.endsWith("\uFFFD")) {
    sliced = sliced.slice(0, -1);
  }
  const lastNl = sliced.lastIndexOf("\n");
  if (lastNl > 0) {
    sliced = sliced.slice(0, lastNl + 1);
  }
  return { text: sliced, truncated: true };
}

function countDiffChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("--- ")) deletions += 1;
  }
  return { additions, deletions };
}

/** Reads unified diff for one repo-relative path (`staged` toggles index vs worktree). */
export async function readGitFileDiff(
  cwd: string,
  filePath: string,
  staged: boolean,
): Promise<Omit<GitDiffResultMessage, "type" | "in_reply_to">> {
  const repoRoot = await resolveRepoRoot(cwd);
  if (!repoRoot) {
    throw new Error("not a git repository");
  }
  const safePath = assertSafeRepoRelativePath(repoRoot, filePath);

  if (!staged) {
    const singleStatus = await execGit(repoRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--",
      safePath,
    ]).catch(() => "");
    if (singleStatus.startsWith("?? ")) {
      const info = await inspectUntrackedFile(repoRoot, safePath);
      if (info.binary) {
        return { path: safePath, staged: false, diff: "", binary: true };
      }
      if (info.emptyFile) {
        const diff = `--- /dev/null\n+++ b/${safePath}\n@@ -0,0 +0,0 @@\n`;
        return { path: safePath, staged: false, diff, additions: 0, deletions: 0 };
      }
      const rawText = info.text ?? "";
      const bodyLines = (rawText.endsWith("\n") ? rawText.slice(0, -1) : rawText).split("\n");
      const header = `--- /dev/null\n+++ b/${safePath}\n@@ -0,0 +1,${bodyLines.length} @@\n`;
      const body = bodyLines.map((l) => `+${l}`).join("\n") + "\n";
      const combined = header + body;
      const capped = truncateUtf8OnLineBoundary(combined, MAX_DIFF_BYTES);
      return {
        path: safePath,
        staged: false,
        diff: capped.text,
        ...(info.truncated || capped.truncated ? { truncated: true } : {}),
        additions: bodyLines.length,
        deletions: 0,
      };
    }
  }

  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "-U3",
    ...(staged ? ["--cached"] : []),
    "--",
    safePath,
  ];
  const rawDiff = await execGit(repoRoot, args);
  const isBinary =
    /^Binary files .* differ$/m.test(rawDiff) ||
    /^GIT binary patch$/m.test(rawDiff);
  if (isBinary) {
    return { path: safePath, staged, diff: "", binary: true };
  }

  const capped = truncateUtf8OnLineBoundary(rawDiff, MAX_DIFF_BYTES);
  const { additions, deletions } = countDiffChanges(capped.text);
  return {
    path: safePath,
    staged,
    diff: capped.text,
    ...(capped.truncated ? { truncated: true } : {}),
    additions,
    deletions,
  };
}

export async function handleGitStatus(
  cwd: string,
  sender: ActionReplySender,
  msg: GitStatusMsg,
): Promise<void> {
  try {
    const res = await readGitChanges(cwd);
    sender.send({
      type: "git_status_result",
      in_reply_to: msg.id,
      ...res,
    });
  } catch (err) {
    sender.send({
      type: "error",
      in_reply_to: msg.id,
      code: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleGitDiff(
  cwd: string,
  sender: ActionReplySender,
  msg: GitDiffMsg,
): Promise<void> {
  try {
    const res = await readGitFileDiff(cwd, msg.path, Boolean(msg.staged));
    sender.send({
      type: "git_diff_result",
      in_reply_to: msg.id,
      ...res,
    });
  } catch (err) {
    sender.send({
      type: "error",
      in_reply_to: msg.id,
      code: err instanceof InvalidGitPathError ? "invalid_message" : "internal_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

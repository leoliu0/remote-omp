import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SupervisorOfflineError, SupervisorReplyError } from "../daemon/client.js";
import type { ControlRequest } from "../daemon/control_protocol.js";
import { addDaemon, listDaemons } from "../daemon/registry.js";
import type { ClientMessage, DirsListMessage, ServerMessage } from "../protocol/types.js";
import { acquireCwdLock } from "../session/cwd_lock.js";
import {
  defaultSessionRoots,
  handleListDirs,
  handleSpawnSession,
  MAX_LISTED_DIRS,
  MAX_RECENT_DIRS,
  resolveBrowsePath,
  type SessionsDeps,
} from "./sessions.js";

function makeSender() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send(msg: ServerMessage): void {
      sent.push(msg);
    },
  };
}

let base: string;
let home: string;
let ompRoot: string;
let customRoot: string;
let work: string;
let prevRemoteOmpHome: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "omp-sessions-")));
  home = join(base, "home");
  ompRoot = join(base, "omp-sessions");
  customRoot = join(base, "custom-sessions");
  work = join(home, "work");
  for (const d of [home, ompRoot, customRoot, work]) mkdirSync(d, { recursive: true });
  // Daemon registry and cwd locks live under REMOTE_OMP_HOME: keep them out of the real ~/.omp.
  prevRemoteOmpHome = process.env["REMOTE_OMP_HOME"];
  process.env["REMOTE_OMP_HOME"] = join(base, "remote-omp-home");
});

afterEach(() => {
  if (prevRemoteOmpHome === undefined) delete process.env["REMOTE_OMP_HOME"];
  else process.env["REMOTE_OMP_HOME"] = prevRemoteOmpHome;
  rmSync(base, { recursive: true, force: true });
});

const baseDeps = (): Partial<SessionsDeps> => ({
  home: () => home,
  sessionRoots: () => [ompRoot, customRoot],
});

async function listDirs(path?: string, overrides: Partial<SessionsDeps> = {}) {
  const sender = makeSender();
  await handleListDirs(sender, { type: "list_dirs", id: "L1", ...(path !== undefined ? { path } : {}) }, { ...baseDeps(), ...overrides });
  expect(sender.sent).toHaveLength(1);
  return sender.sent[0]!;
}

/** Narrows a reply to `dirs_list`, failing with the reply itself when it was something else. */
function dirsList(msg: ServerMessage): DirsListMessage {
  if (msg.type !== "dirs_list") throw new Error(`expected dirs_list, got ${JSON.stringify(msg)}`);
  return msg;
}

/** Writes `<root>/<dir>/<file>` shaped like an omp session log (a padded title line first). */
function writeSession(
  root: string,
  dir: string,
  file: string,
  cwd: string,
  opts: { at?: Date } = {},
): string {
  const folder = join(root, dir);
  mkdirSync(folder, { recursive: true });
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "t", source: "auto", updatedAt: "2026-11-20T00:00:00Z", pad: " ".repeat(300) }),
    JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-11-20T00:00:00.000Z", cwd }),
    JSON.stringify({ type: "model_change", id: "m", parentId: null }),
  ];
  const path = join(folder, file);
  writeFileSync(path, `${lines.join("\n")}\n`);
  if (opts.at) {
    utimesSync(path, opts.at, opts.at);
    utimesSync(folder, opts.at, opts.at);
  }
  return path;
}

const ago = (ms: number): Date => new Date(Date.now() - ms);
const HOUR = 3_600_000;

describe("list_dirs — browsing", () => {
  test("defaults to home: subfolders only, hidden skipped, sorted case-insensitively, git flagged", async () => {
    for (const d of ["Beta", "alpha", ".hidden", "proj", "wt"]) mkdirSync(join(home, d));
    mkdirSync(join(home, "proj", ".git"));
    writeFileSync(join(home, "wt", ".git"), "gitdir: /elsewhere\n"); // a worktree's .git is a file
    writeFileSync(join(home, "readme.txt"), "x");
    symlinkSync(work, join(home, "link-to-dir"));
    symlinkSync(join(home, "readme.txt"), join(home, "link-to-file"));

    const reply = await listDirs();
    expect(reply).toMatchObject({
      type: "dirs_list",
      in_reply_to: "L1",
      path: home,
      parent: dirname(home),
      home,
      truncated: false,
    });
    const { dirs } = dirsList(reply);
    expect(dirs).toEqual([
      { name: "alpha", path: join(home, "alpha"), is_git: false },
      { name: "Beta", path: join(home, "Beta"), is_git: false },
      { name: "link-to-dir", path: join(home, "link-to-dir"), is_git: false },
      { name: "proj", path: join(home, "proj"), is_git: true },
      { name: "work", path: work, is_git: false },
      { name: "wt", path: join(home, "wt"), is_git: true },
    ]);
  });

  test("resolves ~, ~/sub and relative paths against home", async () => {
    mkdirSync(join(work, "deep"));
    for (const raw of ["~/work", "work", `${work}/`, join(work, "..", "work")]) {
      expect(await listDirs(raw)).toMatchObject({ path: work, parent: home });
    }
    expect(await listDirs("~")).toMatchObject({ path: home });
    expect(await listDirs("   ")).toMatchObject({ path: home });
    const deep = dirsList(await listDirs("~/work"));
    expect(deep.dirs.map((d) => d.name)).toEqual(["deep"]);
  });

  test("the filesystem root has no parent", async () => {
    const root = parse(home).root;
    expect(await listDirs(root)).toMatchObject({ path: root, parent: null });
  });

  test("a missing folder, or a file, is not_found", async () => {
    writeFileSync(join(home, "file.txt"), "x");
    for (const raw of [join(home, "nope"), join(home, "file.txt"), join(home, "file.txt", "inside")]) {
      expect(await listDirs(raw)).toMatchObject({ type: "error", in_reply_to: "L1", code: "not_found" });
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable folder is permission_denied", async () => {
    const locked = join(home, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      expect(await listDirs(locked)).toMatchObject({ type: "error", code: "permission_denied" });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a huge folder is capped and flagged", async () => {
    const many = join(home, "many");
    mkdirSync(many);
    for (let i = 0; i < MAX_LISTED_DIRS + 5; i++) mkdirSync(join(many, `d${String(i).padStart(4, "0")}`));
    const reply = dirsList(await listDirs(many));
    expect(reply.dirs).toHaveLength(MAX_LISTED_DIRS);
    expect(reply.truncated).toBe(true);
    expect(reply.dirs[0]!.name).toBe("d0000");
    expect(reply.dirs.at(-1)!.name).toBe(`d${String(MAX_LISTED_DIRS - 1).padStart(4, "0")}`);
  });

  test("rejects a non-string path", async () => {
    const sender = makeSender();
    await handleListDirs(sender, { type: "list_dirs", id: "L2", path: 5 as never }, baseDeps());
    expect(sender.sent).toEqual([
      { type: "error", in_reply_to: "L2", code: "invalid_message", message: "path must be a string" },
    ]);
  });

  test("resolveBrowsePath is pure path math", () => {
    expect(resolveBrowsePath(undefined, "/h")).toBe("/h");
    expect(resolveBrowsePath("~/a/../b", "/h")).toBe("/h/b");
    expect(resolveBrowsePath("x", "/h")).toBe("/h/x");
    expect(resolveBrowsePath("/etc", "/h")).toBe("/etc");
  });
});

describe("list_dirs — recent folders", () => {
  const recentOf = async (overrides: Partial<SessionsDeps> = {}) =>
    dirsList(await listDirs(undefined, overrides)).recent;

  function project(name: string): string {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("reads the cwd from the session header (omp pads a title line first) and sorts newest first", async () => {
    const a = project("a");
    const b = project("b");
    const c = project("c");
    writeSession(ompRoot, "-work-a", "2026-11-18T10-00-00-000Z_aaa.jsonl", a, { at: ago(5 * HOUR) });
    writeSession(customRoot, "-work-b", "2026-11-19T10-00-00-000Z_bbb.jsonl", b, { at: ago(1 * HOUR) });
    writeSession(ompRoot, "-work-c", "2026-11-01T10-00-00-000Z_ccc.jsonl", c, { at: ago(48 * HOUR) });

    const recent = await recentOf();
    expect(recent.map((r) => r.path)).toEqual([b, a, c]);
    expect(recent.map((r) => r.name)).toEqual(["b", "a", "c"]);
    expect(Math.abs(recent[0]!.last_used! - (Date.now() - HOUR))).toBeLessThan(10_000);
  });

  test("only the newest session of a folder counts, falling back past an unreadable one", async () => {
    const newDir = project("new");
    const oldDir = project("old");
    const at = ago(HOUR);
    writeSession(ompRoot, "-work", "2026-11-01T10-00-00-000Z_old.jsonl", oldDir, { at });
    writeSession(ompRoot, "-work", "2026-11-19T10-00-00-000Z_new.jsonl", newDir, { at });
    expect((await recentOf()).map((r) => r.path)).toEqual([newDir]);

    // A newest file with no usable header is skipped for the one before it.
    writeFileSync(join(ompRoot, "-work", "2026-11-20T10-00-00-000Z_stub.jsonl"), "");
    expect((await recentOf()).map((r) => r.path)).toEqual([newDir]);
  });

  test("a folder that two session roots both name appears once, with the later time", async () => {
    const shared = project("shared");
    writeSession(ompRoot, "-work-shared", "2026-11-10T10-00-00-000Z_o.jsonl", shared, { at: ago(10 * HOUR) });
    writeSession(customRoot, "-work-shared", "2026-11-19T10-00-00-000Z_p.jsonl", shared, { at: ago(2 * HOUR) });
    const recent = await recentOf();
    expect(recent).toHaveLength(1);
    expect(Math.abs(recent[0]!.last_used! - (Date.now() - 2 * HOUR))).toBeLessThan(10_000);
  });

  test("drops folders that no longer exist, files, and logs without a header", async () => {
    const alive = project("alive");
    writeSession(ompRoot, "-gone", "2026-11-19T10-00-00-000Z_g.jsonl", join(work, "gone"), { at: ago(HOUR) });
    writeSession(ompRoot, "-alive", "2026-11-19T10-00-00-000Z_a.jsonl", alive, { at: ago(2 * HOUR) });
    writeFileSync(join(work, "plain.txt"), "x");
    writeSession(ompRoot, "-file", "2026-11-19T10-00-00-000Z_f.jsonl", join(work, "plain.txt"), { at: ago(3 * HOUR) });
    mkdirSync(join(ompRoot, "-garbage"));
    writeFileSync(join(ompRoot, "-garbage", "2026-11-19T10-00-00-000Z_x.jsonl"), "not json\n{broken\n");
    writeFileSync(join(ompRoot, "stray-file.txt"), "x");
    expect((await recentOf()).map((r) => r.path)).toEqual([alive]);
  });

  test("only the head of a log is read: a header past 16 KiB is not found", async () => {
    const far = project("far");
    const folder = join(ompRoot, "-far");
    mkdirSync(folder);
    const pad = JSON.stringify({ type: "title", pad: " ".repeat(20_000) });
    writeFileSync(
      join(folder, "2026-11-19T10-00-00-000Z_far.jsonl"),
      `${pad}\n${JSON.stringify({ type: "session", cwd: far })}\n`,
    );
    expect(await recentOf()).toEqual([]);
  });

  test("is capped, and missing session roots are fine", async () => {
    for (let i = 0; i < MAX_RECENT_DIRS + 5; i++) {
      const dir = project(`p${i}`);
      writeSession(ompRoot, `-work-p${i}`, "2026-11-19T10-00-00-000Z_s.jsonl", dir, { at: ago((i + 1) * HOUR) });
    }
    const recent = await recentOf();
    expect(recent).toHaveLength(MAX_RECENT_DIRS);
    expect(recent[0]!.name).toBe("p0");
    expect(await recentOf({ sessionRoots: () => [join(base, "never-existed")] })).toEqual([]);
  });

  test("registered always-on folders are included, without a time unless they have sessions", async () => {
    const door = project("door");
    const both = project("both");
    const plain = project("plain");
    addDaemon(door, "Door Agent");
    addDaemon(both, "Both Agent");
    writeSession(ompRoot, "-work-both", "2026-11-19T10-00-00-000Z_b.jsonl", both, { at: ago(HOUR) });
    writeSession(ompRoot, "-work-plain", "2026-11-19T10-00-00-000Z_p.jsonl", plain, { at: ago(2 * HOUR) });

    const recent = await recentOf();
    expect(recent.map((r) => r.path)).toEqual([both, plain, door]);
    expect(recent[0]).toMatchObject({ name: "Both Agent" });
    expect(recent[0]!.last_used).toBeGreaterThan(0);
    expect(recent[2]).toEqual({ path: door, name: "Door Agent" });
  });
});

describe("defaultSessionRoots", () => {
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
    delete process.env["PI_CODING_AGENT_DIR"];
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
  });

  test("is omp's session folder alone: the upstream Pi one is never read", () => {
    expect(defaultSessionRoots("/h")).toEqual([join("/h", ".omp", "agent", "sessions")]);
  });

  test("adds $PI_CODING_AGENT_DIR/sessions when omp's agent directory is relocated", () => {
    process.env["PI_CODING_AGENT_DIR"] = "/data/agent";
    expect(defaultSessionRoots("/h")).toEqual([
      join("/h", ".omp", "agent", "sessions"),
      join("/data/agent", "sessions"),
    ]);
  });
});

// ── spawn_session ────────────────────────────────────────────────────────────

type SupervisorHandler = (req: ControlRequest) => unknown;

/** A supervisor client double: answers each op through `handler`, records the calls. */
function fakeSupervisor(handler: SupervisorHandler) {
  const calls: ControlRequest[] = [];
  const callSupervisor = (async (req: ControlRequest) => {
    calls.push(req);
    return handler(req);
  }) as unknown as SessionsDeps["callSupervisor"];
  return { calls, callSupervisor };
}

const ephemeralOk: SupervisorHandler = (req) => {
  if (req.op !== "spawn_ephemeral") throw new Error(`unexpected op ${req.op}`);
  return { id: "eph00001", cwd: req.cwd, name: req.name, state: "running" };
};

async function spawn(
  msg: Partial<Extract<ClientMessage, { type: "spawn_session" }>>,
  overrides: Partial<SessionsDeps> = {},
) {
  const sender = makeSender();
  await handleSpawnSession(
    sender,
    { type: "spawn_session", id: "S1", cwd: work, ...msg },
    { ...baseDeps(), supervisorOnline: async () => true, ...overrides },
  );
  expect(sender.sent).toHaveLength(1);
  return sender.sent[0]!;
}

describe("spawn_session — ephemeral (the default)", () => {
  test("asks the supervisor for an omp session named after the folder", async () => {
    const sup = fakeSupervisor(ephemeralOk);
    const reply = await spawn({}, { callSupervisor: sup.callSupervisor });
    expect(sup.calls).toEqual([{ op: "spawn_ephemeral", cwd: work, name: "work" }]);
    expect(reply).toEqual({
      type: "spawn_result",
      in_reply_to: "S1",
      cwd: work,
      name: "work",
      persistent: false,
      daemon_id: "eph00001",
    });
    // Nothing was registered: the phone's session is not permanent.
    expect(listDaemons()).toEqual([]);
  });

  test("uses the given name (trimmed), the resolved real path, and ~", async () => {
    const link = join(base, "link");
    symlinkSync(work, link);
    const sup = fakeSupervisor(ephemeralOk);
    expect(await spawn({ cwd: link, name: "  my agent  " }, { callSupervisor: sup.callSupervisor })).toMatchObject({
      cwd: work,
      name: "my agent",
    });
    expect(await spawn({ cwd: "~/work" }, { callSupervisor: sup.callSupervisor })).toMatchObject({ cwd: work });
    expect(sup.calls.flatMap((c) => (c.op === "spawn_ephemeral" ? [c.cwd] : []))).toEqual([work, work]);
  });

  test("a blank name falls back to the folder name", async () => {
    const sup = fakeSupervisor(ephemeralOk);
    expect(await spawn({ name: "   " }, { callSupervisor: sup.callSupervisor })).toMatchObject({ name: basename(work) });
  });

  test("validates the request without touching the supervisor", async () => {
    const sup = fakeSupervisor(ephemeralOk);
    const deps = { callSupervisor: sup.callSupervisor };
    expect(await spawn({ cwd: "" }, deps)).toMatchObject({ type: "error", code: "invalid_message" });
    expect(await spawn({ cwd: "relative/dir" }, deps)).toMatchObject({ type: "error", code: "invalid_message" });
    expect(await spawn({ name: 7 as never }, deps)).toMatchObject({ type: "error", code: "invalid_message" });
    expect(await spawn({ persistent: "yes" as never }, deps)).toMatchObject({ type: "error", code: "invalid_message" });
    expect(await spawn({ cwd: join(work, "missing") }, deps)).toMatchObject({ type: "error", code: "not_found" });
    writeFileSync(join(work, "f.txt"), "x");
    expect(await spawn({ cwd: join(work, "f.txt") }, deps)).toMatchObject({ type: "error", code: "not_found" });
    expect(sup.calls).toEqual([]);
  });

  test("refuses a folder a live session holds the lock of, without taking the lock itself", async () => {
    const held = await acquireCwdLock(work);
    expect(held.ok).toBe(true);
    const sup = fakeSupervisor(ephemeralOk);
    try {
      expect(await spawn({}, { callSupervisor: sup.callSupervisor })).toMatchObject({
        type: "error",
        in_reply_to: "S1",
        code: "cwd_busy",
      });
      // Even under a custom name: the folder already has its session.
      expect(await spawn({ name: "other" }, { callSupervisor: sup.callSupervisor })).toMatchObject({ code: "cwd_busy" });
    } finally {
      if (held.ok) held.release();
    }
    expect(sup.calls).toEqual([]);

    // The probe only looked: once the holder is gone the folder is free, and
    // the probes left no lock of their own behind.
    expect(await spawn({}, { callSupervisor: sup.callSupervisor })).toMatchObject({ type: "spawn_result" });
    const free = await acquireCwdLock(work);
    expect(free.ok).toBe(true);
    if (free.ok) free.release();
  });

  test("refuses the exact named lock too", async () => {
    const held = await acquireCwdLock(work, "bob");
    expect(held.ok).toBe(true);
    try {
      const sup = fakeSupervisor(ephemeralOk);
      expect(await spawn({ name: "bob" }, { callSupervisor: sup.callSupervisor })).toMatchObject({ code: "cwd_busy" });
      expect(sup.calls).toEqual([]);
    } finally {
      if (held.ok) held.release();
    }
  });

  test("refuses a folder with a registered daemon", async () => {
    addDaemon(work, "door");
    const sup = fakeSupervisor(ephemeralOk);
    expect(await spawn({}, { callSupervisor: sup.callSupervisor })).toMatchObject({
      type: "error",
      code: "already_registered",
    });
    expect(sup.calls).toEqual([]);
  });

  test("a supervisor that is not running is supervisor_offline with the install hint", async () => {
    const sup = fakeSupervisor(() => {
      throw new SupervisorOfflineError("/x/supervisor.sock");
    });
    expect(await spawn({}, { callSupervisor: sup.callSupervisor })).toEqual({
      type: "error",
      in_reply_to: "S1",
      code: "supervisor_offline",
      message: "Run remote-omp install on the PC",
    });
  });

  test("a supervisor from before plan 68 is supervisor_outdated", async () => {
    const sup = fakeSupervisor(() => {
      throw new SupervisorReplyError("unknown op: spawn_ephemeral");
    });
    expect(await spawn({}, { callSupervisor: sup.callSupervisor })).toMatchObject({
      type: "error",
      code: "supervisor_outdated",
    });
  });

  test("the supervisor's own refusals pass through with their codes", async () => {
    for (const code of ["cwd_busy", "already_registered", "spawn_failed", "not_found"]) {
      const sup = fakeSupervisor(() => {
        throw new SupervisorReplyError(`refused: ${code}`, code);
      });
      expect(await spawn({}, { callSupervisor: sup.callSupervisor })).toEqual({
        type: "error",
        in_reply_to: "S1",
        code,
        message: `refused: ${code}`,
      });
    }
  });

  test("anything unexpected still answers, as internal_error", async () => {
    const sup = fakeSupervisor(() => {
      throw new Error("boom");
    });
    expect(await spawn({}, { callSupervisor: sup.callSupervisor })).toMatchObject({
      type: "error",
      code: "internal_error",
      message: "boom",
    });
  });
});

describe("spawn_session — persistent (Keep always on)", () => {
  test("registers an omp daemon and starts it fresh", async () => {
    const sup = fakeSupervisor((req) => {
      if (req.op !== "start") throw new Error(`unexpected op ${req.op}`);
      return { id: req.id, state: "starting", started: true };
    });
    const reply = await spawn({ persistent: true, name: "door" }, { callSupervisor: sup.callSupervisor });

    const [entry] = listDaemons();
    expect(entry).toEqual({ id: entry!.id, cwd: work, name: "door" });
    expect(sup.calls).toEqual([{ op: "start", id: entry!.id, fresh: true }]);
    expect(reply).toEqual({
      type: "spawn_result",
      in_reply_to: "S1",
      cwd: work,
      name: "door",
      persistent: true,
      daemon_id: entry!.id,
    });
  });

  test("with the supervisor offline nothing is registered", async () => {
    const sup = fakeSupervisor(ephemeralOk);
    const reply = await spawn(
      { persistent: true },
      { callSupervisor: sup.callSupervisor, supervisorOnline: async () => false },
    );
    expect(reply).toMatchObject({ type: "error", code: "supervisor_offline", message: "Run remote-omp install on the PC" });
    expect(listDaemons()).toEqual([]);
    expect(sup.calls).toEqual([]);
  });

  test("a failed start rolls the registration back through the supervisor", async () => {
    const sup = fakeSupervisor((req) => {
      if (req.op === "start") throw new SupervisorReplyError("omp vanished");
      if (req.op === "unregister") return { removed: true };
      throw new Error(`unexpected op ${req.op}`);
    });
    const reply = await spawn({ persistent: true }, { callSupervisor: sup.callSupervisor });
    expect(reply).toMatchObject({ type: "error", code: "internal_error", message: "omp vanished" });
    expect(sup.calls.map((c) => c.op)).toEqual(["start", "unregister"]);
  });

  test("...or straight from the registry when the supervisor went away meanwhile", async () => {
    const sup = fakeSupervisor(() => {
      throw new SupervisorOfflineError("/x/supervisor.sock");
    });
    const reply = await spawn({ persistent: true }, { callSupervisor: sup.callSupervisor });
    expect(reply).toMatchObject({ type: "error", code: "supervisor_offline" });
    expect(listDaemons()).toEqual([]);
  });
});

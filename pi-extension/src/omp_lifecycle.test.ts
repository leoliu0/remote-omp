/**
 * omp lifecycle compatibility (plan 69 step 4, gaps G2 G6 G7 G10 G11 G13 G14 G15).
 *
 * Drives the extension through a recording `pi` the way omp 19 does: the shapes
 * and event names below were read from `@oh-my-pi/pi-coding-agent` 19.0.1
 * (`agent-session.ts`, `lifecycle-mirror.ts`, `extensions/types.ts`), not from
 * the local `omp-api.ts` slice the repo compiles against.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as StorageModule from "./pairing/storage.js";
import type * as QrModule from "./pairing/qr.js";
import type * as HostExitModule from "./daemon/host_exit.js";
import type * as RpcChildModule from "./daemon/rpc_child.js";
import type * as IndexModule from "./index.js";

// The extension keeps its state under `<REMOTE_OMP_HOME>/.omp/remote`, read at call time:
// point it at a scratch dir before the module loads (`vi.hoisted` runs before the imports).
const home = vi.hoisted(() => {
  const dir = `${process.env["TMPDIR"] ?? "/tmp"}/omp-lifecycle-home-${process.pid}`;
  process.env["REMOTE_OMP_HOME"] = dir;
  return dir;
});

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

// ── Mock RelayClient ──────────────────────────────────────────────────────────

const relayRef: { current: MockRelay | null } = { current: null };

class MockRelay extends EventEmitter {
  static OPEN = 1;
  readyState = MockRelay.OPEN;
  connect = vi.fn().mockResolvedValue(undefined);
  send = vi.fn();
  sendControl = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  isOpen = vi.fn(() => this.readyState === MockRelay.OPEN);
  constructor() { super(); relayRef.current = this; }
}

class MockRoomAlreadyOpenError extends Error {}

vi.mock("./transport/relay_client.js", () => ({
  RelayClient: MockRelay,
  RoomAlreadyOpenError: MockRoomAlreadyOpenError,
}));

// ── Mock storage / qr / pi-coding-agent ──────────────────────────────────────

vi.mock("./pairing/storage.js", async (importOriginal) => {
  const orig = await importOriginal<typeof StorageModule>();
  return {
    ...orig,
    getOrCreateEd25519Keypair: vi.fn().mockResolvedValue({
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    }),
    listPeers: vi.fn().mockResolvedValue([]),
    listOwnerPubkeys: vi.fn().mockResolvedValue([]),
    addPeer: vi.fn().mockResolvedValue(undefined),
    snapshotOwnerPubkeys: vi.fn().mockRejectedValue(new Error("strict Owner snapshot unavailable")),
    conditionalRemovePeer: vi.fn().mockResolvedValue({ outcome: "not_found" }),
    removePeer: vi.fn().mockResolvedValue(false),
  };
});

vi.mock("./pairing/qr.js", async (importOriginal) => {
  const orig = await importOriginal<typeof QrModule>();
  return {
    ...orig,
    displayQR: vi.fn(),
    qrSession: {
      issueToken: vi.fn().mockReturnValue({ token: "test-token", expiresAt: Date.now() + 60_000 }),
      consumeToken: vi.fn().mockReturnValue("ok"),
      clear: vi.fn(),
      generateToken: vi.fn().mockReturnValue("test-token"),
    },
  };
});

const convertToPngMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("./omp-host.js", () => ({ convertToPng: convertToPngMock, hostTui: () => undefined }));

// Dynamic import: the mocks above must be registered before the extension module evaluates
// (it constructs `RelayClient` and reads the peer store at import time).
const index: typeof IndexModule = await import("./index.js");
const { _resetHostExitForTest, HOST_EXIT_STATUS_KEY }: typeof HostExitModule = await import("./daemon/host_exit.js");
const { EXIT_DAEMON_FRESH_SESSION, EXIT_DAEMON_RESTART }: typeof RpcChildModule = await import("./daemon/rpc_child.js");

const {
  default: extension,
  _startRelayForTest,
  _stopForTest,
  _resetMainSessionForTest,
  _setGitStatusReaderForTest,
  _getCurrentTurnIdForTest,
  _getMessageBufferForTest,
  _setMessageBufferForTest,
  _mapAgentMessagesToEvents,
  _hydrateMessageBufferFromSession,
  _loadMessagesFromJsonlFile,
  _isSubagentSession,
  _getPendingSteerIdsForTest,
  restartSession,
} = index;

// ── Harness ───────────────────────────────────────────────────────────────────

const PHONE = "phone__1234567890";
type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

interface Wire { peer: string; type: string; [key: string]: unknown }

function deferred<T = void>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

function makeCtx(extra: Record<string, unknown> = {}) {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    cwd: "/home/user/projects/omp-lifecycle",
    abort: vi.fn(),
    isIdle: () => true,
    shutdown: vi.fn(),
    agent: { kind: "main", id: "Main", name: "main", depth: 0 },
    ...extra,
  };
}

/** A recording `pi` shaped like omp's `ConcreteExtensionAPI` for what the extension touches. */
function makePi(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const pi = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => unknown }) => {
      commands.set(name, options.handler);
    },
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    ...overrides,
  };
  (extension as (pi: unknown) => void)(pi);
  return {
    pi,
    emit(event: string, payload: Record<string, unknown> = {}, ctx?: unknown): unknown {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler for ${event}`);
      return handler({ type: event, ...payload }, ctx);
    },
    has: (event: string) => handlers.has(event),
    command(name: string, args: string, ctx: unknown): unknown {
      const handler = commands.get(name);
      if (!handler) throw new Error(`no command ${name}`);
      return handler(args, ctx);
    },
  };
}

type Session = ReturnType<typeof makePi>;

function decode(raw: string): Wire {
  const outer = JSON.parse(raw) as { peer: string; ct: string };
  return { peer: outer.peer, ...(JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8")) as { type: string }) };
}

/** Everything sent to the phone since `from`. */
function wire(from = 0): Wire[] {
  return relayRef.current!.send.mock.calls.slice(from).map((call) => decode(call[0] as string));
}
const sentCount = (): number => relayRef.current!.send.mock.calls.length;

function phoneSends(inner: object): void {
  relayRef.current!.emit("message", JSON.stringify({
    peer: PHONE,
    ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
  }));
}

/** Factory + session_start + relay up + one paired phone, like a daemon after boot. */
async function boot(overrides: Record<string, unknown> = {}, ctxExtra: Record<string, unknown> = {}): Promise<Session & { ctx: ReturnType<typeof makeCtx> }> {
  const session = makePi(overrides);
  const ctx = makeCtx(ctxExtra);
  session.emit("session_start", {}, ctx);
  await _startRelayForTest(ctx);
  phoneSends({ type: "pair_request", id: "req-1", token: "test-token", device_name: "Phone" });
  await vi.waitFor(() => expect(index._getState()).toBe("paired"), { timeout: 2000 });
  return Object.assign(session, { ctx });
}

beforeEach(() => {
  _resetMainSessionForTest();
  _setGitStatusReaderForTest(async () => null);
  relayRef.current = null;
});

afterEach(async () => {
  vi.useRealTimers();
  _resetHostExitForTest();
  delete process.env["REMOTE_OMP_DAEMON"];
  await _stopForTest(makeCtx());
  _setMessageBufferForTest([]);
});

// ── G2: the echo must not wait for the run ────────────────────────────────────

describe("G2: phone prompt echo on omp", () => {
  const userStarted = (text: string): Record<string, unknown> => ({
    message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: Date.now() },
  });

  test("idle text prompt is echoed when omp starts it, not when the run ends", async () => {
    // omp: the promise of an idle `pi.sendUserMessage` settles at the END of the run.
    const run = deferred();
    const sendUserMessage = vi.fn(() => run.promise);
    const s = await boot({ sendUserMessage });
    const before = sentCount();

    phoneSends({ type: "user_message", id: "m1", text: "hello" });
    await flush();
    expect(sendUserMessage).toHaveBeenCalledWith("hello", undefined);

    s.emit("message_start", userStarted("hello"));
    await flush();
    // The run is still going (`run` pending) and the phone already has its bubble.
    expect(wire(before).filter((m) => m.type === "user_message").map((m) => m.id)).toEqual(["m1"]);
    run.resolve();
  });

  test("a user message with other text does not release the echo", async () => {
    const run = deferred();
    const s = await boot({ sendUserMessage: vi.fn(() => run.promise) });
    const before = sentCount();
    phoneSends({ type: "user_message", id: "m1", text: "hello" });
    await flush();
    s.emit("message_start", userStarted("typed on the PC meanwhile"));
    await flush();
    expect(wire(before).some((m) => m.type === "user_message")).toBe(false);
    run.resolve();
  });

  test("without a start event the echo follows at the admission ceiling", async () => {
    const run = deferred();
    await boot({ sendUserMessage: vi.fn(() => run.promise) });
    const before = sentCount();
    vi.useFakeTimers();
    phoneSends({ type: "user_message", id: "m1", text: "slow setup" });
    await vi.advanceTimersByTimeAsync(1_400);
    expect(wire(before).some((m) => m.type === "user_message")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(wire(before).filter((m) => m.type === "user_message").map((m) => m.id)).toEqual(["m1"]);
    run.resolve();
  });

  test("a rejection after the echo still reaches the phone and frees the turn id", async () => {
    const run = deferred();
    const s = await boot({ sendUserMessage: vi.fn(() => run.promise) });
    const before = sentCount();
    phoneSends({ type: "user_message", id: "m1", text: "doomed" });
    await flush();
    s.emit("message_start", userStarted("doomed"));
    await flush();
    expect(_getCurrentTurnIdForTest()).toBe("m1");

    run.reject(new Error("PromptDroppedError: aborted during setup"));
    await flush();
    const frames = wire(before);
    expect(frames.some((m) => m.type === "user_message")).toBe(true);
    const error = frames.find((m) => m.type === "error");
    expect(error).toMatchObject({ in_reply_to: "m1", code: "internal_error" });
    expect(String(error?.message)).toContain("aborted during setup");
    expect(_getCurrentTurnIdForTest()).toBeNull();
  });

  test("a rejection before the echo is reported once and nothing is echoed", async () => {
    await boot({ sendUserMessage: vi.fn(() => Promise.reject(new Error("No model selected"))) });
    const before = sentCount();
    phoneSends({ type: "user_message", id: "m1", text: "no model" });
    await flush();
    await flush();
    const frames = wire(before);
    expect(frames.some((m) => m.type === "user_message")).toBe(false);
    expect(frames.filter((m) => m.type === "error")).toHaveLength(1);
    expect(_getCurrentTurnIdForTest()).toBeNull();
  });

  test("a prompt sent while omp is busy still steers and echoes at once", async () => {
    const sendUserMessage = vi.fn(async () => undefined); // omp: a queued steer returns at once
    const s = await boot({ sendUserMessage }, { isIdle: () => false });
    s.emit("turn_start", { turnIndex: 0, timestamp: 0 }, makeCtx({ isIdle: () => false }));
    const before = sentCount();
    phoneSends({ type: "user_message", id: "steer-1", text: "change course", streaming_behavior: "steer" });
    await flush();
    expect(sendUserMessage).toHaveBeenCalledWith("change course", { deliverAs: "steer" });
    expect(wire(before).find((m) => m.type === "user_message")).toMatchObject({
      id: "steer-1",
      streaming_behavior: "steer",
    });
    expect(_getPendingSteerIdsForTest("change course")).toEqual(["steer-1"]);
  });

  test("image prompt is echoed when omp starts it", async () => {
    const run = deferred();
    const sendUserMessage = vi.fn(() => run.promise);
    const s = await boot({ sendUserMessage });
    const before = sentCount();
    phoneSends({ type: "user_message", id: "img-1", text: "what is this", images: [{ data: "QUJD", mime: "image/png" }] });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalled());
    s.emit("message_start", userStarted("what is this"));
    await flush();
    expect(wire(before).filter((m) => m.type === "user_message").map((m) => m.id)).toEqual(["img-1"]);
    run.resolve();
  });

  test("a queued message drained while idle is echoed when omp starts it", async () => {
    const run = deferred();
    const sendUserMessage = vi.fn(() => run.promise);
    const s = await boot({ sendUserMessage });
    const before = sentCount();
    phoneSends({ type: "queued_message_set", id: "q1", text: "run this next" });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledWith("run this next", undefined));
    s.emit("message_start", userStarted("run this next"));
    await flush();
    expect(wire(before).filter((m) => m.type === "user_message").map((m) => m.id)).toEqual(["q1"]);
    run.resolve();
  });
});

// ── G7: data-only custom messages must not steer into a live run ─────────────

describe("G7: data-only messages stay out of the model's context", () => {
  type Sent = { customType?: string; excludeFromContext?: boolean };
  const sentMessages = (s: Session): Sent[] =>
    (s.pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as Sent);
  const dataOnly = (s: Session): Sent[] =>
    sentMessages(s).filter((m) => m.customType?.startsWith("remote-omp:") === true && m.customType !== "remote-omp:mesh-message");

  test("relay state and pairing notices are transcript-only rows", async () => {
    const s = await boot();
    const sent = dataOnly(s);
    expect(sent.map((m) => m.customType)).toEqual(expect.arrayContaining(["remote-omp:relay-state", "remote-omp:paired"]));
    // omp steers a custom message into a LIVE run (an extra provider pass on unchanged context)
    // unless it is flagged `excludeFromContext`.
    expect(sent.filter((m) => m.excludeFromContext !== true).map((m) => m.customType)).toEqual([]);
  });

  test("the pairing code from /remote-omp pair is a transcript-only row", async () => {
    const s = await boot();
    await s.command("remote-omp pair", "", s.ctx);
    const code = dataOnly(s).filter((m) => m.customType === "remote-omp:pair-code");
    expect(code).toHaveLength(1);
    expect(code[0]?.excludeFromContext).toBe(true);
  });

  test("a mesh name assignment is a transcript-only row", async () => {
    const session = makePi();
    const ctx = makeCtx({ cwd: join(tmpdir(), `omp-lifecycle-name-${process.pid}-${Date.now()}`) });
    session.emit("session_start", {}, ctx);
    await index._connectForTest(ctx);
    const assigned = dataOnly(session).filter((m) => m.customType === "remote-omp:name-assigned");
    expect(assigned.length).toBeGreaterThan(0);
    expect(assigned.every((m) => m.excludeFromContext === true)).toBe(true);
  });

  test("the mesh delivery is the one message that still starts a turn", async () => {
    const s = await boot();
    index._deliverMeshMessageToAgentForTest({ id: "e1", from: "peer", re: null, body: "ping" });
    await flush(); // the delivery is queued on a microtask so it cannot collide with the run that just ended
    const call = (s.pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as Sent).customType === "remote-omp:mesh-message",
    );
    expect(call).toBeDefined();
    expect((call![0] as Sent).excludeFromContext).toBeUndefined();
    expect(call![1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });
});

// ── G6: agent_end is one stopped loop, not the end of the run ────────────────

describe("G6: a settle omp will resume does not end the turn", () => {
  /** One model loop: omp runs agent_start, a turn, then settles with `agent_end`. */
  function runLoop(s: Session, ctx: unknown, end: Record<string, unknown>): void {
    s.emit("agent_start", {}, ctx);
    s.emit("turn_start", { turnIndex: 0, timestamp: 0 }, ctx);
    s.emit("turn_end", { turnIndex: 0 }, ctx);
    s.emit("agent_end", { messages: [], ...end }, ctx);
  }
  const ofType = (from: number, type: string): Wire[] => wire(from).filter((m) => m.type === type);

  test.each([
    ["willContinue", { willContinue: true }],
    ["awaitingAsyncWork", { willContinue: true, awaitingAsyncWork: true }],
  ])("a %s settle keeps the turn open until the plain agent_end", async (_name, flags) => {
    const s = await boot();
    phoneSends({ type: "user_message", id: "m1", text: "work on it" });
    await flush();
    const before = sentCount();
    const controlsBefore = relayRef.current!.sendControl.mock.calls.length;

    vi.useFakeTimers();
    runLoop(s, s.ctx, flags);
    await vi.advanceTimersByTimeAsync(250); // past the 150 ms working-off delay
    vi.useRealTimers();
    expect(ofType(before, "agent_done")).toEqual([]);
    expect(_getCurrentTurnIdForTest()).toBe("m1");
    const workingOff = relayRef.current!.sendControl.mock.calls
      .slice(controlsBefore)
      .filter((call) => JSON.stringify(call[0]).includes('"working":false'));
    expect(workingOff).toEqual([]);

    // The continuation runs under the same turn and its plain agent_end closes it, once.
    runLoop(s, s.ctx, {});
    expect(ofType(before, "agent_done")).toMatchObject([{ in_reply_to: "m1" }]);
    expect(_getCurrentTurnIdForTest()).toBeNull();
  });

  test("a pending steer is announced consumed at the real end, not at a settle omp resumes", async () => {
    const s = await boot();
    phoneSends({ type: "user_message", id: "m1", text: "start" });
    await flush();
    s.emit("agent_start", {}, s.ctx);
    s.emit("turn_start", { turnIndex: 0, timestamp: 0 }, s.ctx);
    phoneSends({ type: "user_message", id: "steer-1", text: "also this", streaming_behavior: "steer" });
    await flush();
    expect(_getPendingSteerIdsForTest("also this")).toEqual(["steer-1"]);

    const before = sentCount();
    s.emit("turn_end", { turnIndex: 0 }, s.ctx);
    s.emit("agent_end", { messages: [], willContinue: true }, s.ctx);
    expect(ofType(before, "steer_consumed")).toEqual([]);
    s.emit("agent_end", { messages: [] }, s.ctx);
    expect(ofType(before, "steer_consumed")).toMatchObject([{ id: "steer-1" }]);
  });
});

// ── G10: omp replaces the session in place ───────────────────────────────────

describe("G10: session_switch and session_clear are mirrored to the phone", () => {
  const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp, attribution: "user" });
  const assistant = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
  const asEntry = (message: { timestamp: number }) => ({ type: "message", timestamp: message.timestamp, message });
  const historyOf = (from: number): Wire | undefined => wire(from).find((m) => m.type === "session_history");
  const eventTypes = (history: Wire | undefined): unknown[] =>
    Array.isArray(history?.events) ? history.events.map((e: { type: string }) => e.type) : [];

  test("session_switch drops the mirrored chat, steers and queue and tells every owner", async () => {
    const s = await boot();
    _setMessageBufferForTest([user("old question", 1), assistant("old answer", 2)]);
    phoneSends({ type: "user_message", id: "steer-1", text: "change course", streaming_behavior: "steer" });
    await flush();
    expect(_getPendingSteerIdsForTest("change course")).toEqual(["steer-1"]);

    const before = sentCount();
    s.emit("session_switch", { reason: "new" }, makeCtx({ sessionManager: { getBranch: () => [] } }));
    expect(historyOf(before)).toMatchObject({ events: [], eos: true, truncated: false });
    expect(wire(before).some((m) => m.type === "queued_message_state")).toBe(true);
    expect(_getMessageBufferForTest()).toEqual([]);
    expect(_getPendingSteerIdsForTest("change course")).toEqual([]);
  });

  test("session_switch to a resumed session sends that session's history", async () => {
    const s = await boot();
    _setMessageBufferForTest([user("old question", 1)]);
    const branch = [asEntry(user("resumed question", 10)), asEntry(assistant("resumed answer", 11))];
    const before = sentCount();
    s.emit("session_switch", { reason: "resume" }, makeCtx({ sessionManager: { getBranch: () => branch } }));
    expect(eventTypes(historyOf(before))).toEqual(["user_input", "agent_message"]);
    expect(_getMessageBufferForTest()).toHaveLength(2);
  });

  test("session_clear reads back only what follows the last reset_boundary", async () => {
    const s = await boot();
    _setMessageBufferForTest([user("secret", 1), assistant("answer", 2)]);
    const branch = [asEntry(user("secret", 1)), asEntry(assistant("answer", 2)), { type: "reset_boundary", timestamp: 3 }];
    const before = sentCount();
    s.emit("session_clear", {}, makeCtx({ sessionManager: { getBranch: () => branch } }));
    expect(historyOf(before)).toMatchObject({ events: [] });
    expect(_getMessageBufferForTest()).toEqual([]);
  });

  test("a subagent's session replacement is not the phone's session", async () => {
    const s = await boot();
    _setMessageBufferForTest([user("keep", 1)]);
    const before = sentCount();
    const subagent = makeCtx({ agent: { kind: "sub", id: "0-Explore", name: "explore", depth: 1 } });
    s.emit("session_switch", { reason: "new" }, subagent);
    s.emit("session_clear", {}, subagent);
    expect(wire(before)).toEqual([]);
    expect(_getMessageBufferForTest()).toHaveLength(1);
  });

  test("hydration starts after the last reset_boundary (session manager and session file)", () => {
    const branch = [
      asEntry(user("before", 1)),
      { type: "reset_boundary", timestamp: 2 },
      asEntry(user("after", 3)),
      asEntry(assistant("reply", 4)),
    ];
    _setMessageBufferForTest([]);
    _hydrateMessageBufferFromSession({ getBranch: () => branch });
    expect(_getMessageBufferForTest().map((m) => m.content)).toEqual(["after", [{ type: "text", text: "reply" }]]);

    const dir = mkdtempSync(join(tmpdir(), "omp-lifecycle-jsonl-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(file, `${branch.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      expect(_loadMessagesFromJsonlFile(file).map((m) => m.content)).toEqual(["after", [{ type: "text", text: "reply" }]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── G11: what omp wrote itself is not what the person said ───────────────────

describe("G11: harness-written messages are not user bubbles", () => {
  test("injected user messages are not replayed as user_input", () => {
    const events = _mapAgentMessagesToEvents([
      { role: "user", content: "real question", timestamp: 1 },
      { role: "user", content: "Plan approved. Execute it.", timestamp: 2, synthetic: true, attribution: "agent" },
      { role: "user", content: "continue", timestamp: 3, attribution: "agent" },
      { role: "user", content: "peer says hi", timestamp: 4, parentIrc: { from: "Main", body: "hi" } },
      { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 5 },
    ]);
    expect(events.filter((e) => e.type === "user_input")).toMatchObject([{ text: "real question", id: "sync_1" }]);
    expect(events.find((e) => e.type === "agent_message")).toMatchObject({ in_reply_to: "sync_1" });
  });

  test("a terminal !cmd or $code is replayed as the tool row it was", () => {
    const events = _mapAgentMessagesToEvents([
      { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0, timestamp: 7 },
      { role: "bashExecution", command: "false", output: "", exitCode: 1, timestamp: 8 },
      { role: "pythonExecution", code: "print(1)", output: "1", exitCode: 0, timestamp: 9 },
    ]);
    expect(events).toEqual([
      { ts: 7, type: "tool_request", tool_call_id: "user_bash_7", tool: "bash", args: { command: "ls" } },
      { ts: 7, type: "tool_result", tool_call_id: "user_bash_7", result: "a\nb" },
      { ts: 8, type: "tool_request", tool_call_id: "user_bash_8", tool: "bash", args: { command: "false" } },
      { ts: 8, type: "tool_result", tool_call_id: "user_bash_8", error: "exit code 1" },
      { ts: 9, type: "tool_request", tool_call_id: "user_python_9", tool: "python", args: { code: "print(1)" } },
      { ts: 9, type: "tool_result", tool_call_id: "user_python_9", result: "1" },
    ]);
  });

  test("developer messages (omp's own directives) have no row", () => {
    expect(_mapAgentMessagesToEvents([{ role: "developer", content: "reminder", timestamp: 1, synthetic: true }])).toEqual([]);
  });

  test("live: an injected user message never enters the replay buffer", async () => {
    const s = await boot();
    _setMessageBufferForTest([]);
    s.emit("message_end", { message: { role: "user", content: "Plan approved.", synthetic: true, attribution: "agent", timestamp: 1 } });
    s.emit("message_end", { message: { role: "user", content: "real", attribution: "user", timestamp: 2 } });
    expect(_getMessageBufferForTest().map((m) => m.content)).toEqual(["real"]);
  });
});

// ── G13: subagent detection follows ctx.agent.kind ───────────────────────────

describe("G13: subagent detection follows ctx.agent.kind", () => {
  const main = { kind: "main", id: "Main", name: "main", depth: 0 };
  const sub = { kind: "sub", id: "0-Explore", name: "explore", depth: 1 };

  test("omp's agent identity is authoritative", () => {
    expect(_isSubagentSession({ agent: sub })).toBe(true);
    expect(_isSubagentSession({ agent: main })).toBe(false);
  });

  test("a main session on a host without a UI (--no-ui) is still the main session", () => {
    expect(_isSubagentSession({ hasUI: false, agent: main })).toBe(false);
  });

  test("identity wins over the session-file heuristics, which only serve a context without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-lifecycle-sub-"));
    try {
      // `<dir>/parent.jsonl` exists, so a file inside `<dir>/parent/` looks like a subagent transcript.
      writeFileSync(join(dir, "parent.jsonl"), "");
      const sessionManager = { getSessionFile: () => join(dir, "parent", "child.jsonl") };
      expect(_isSubagentSession({ sessionManager })).toBe(true);
      expect(_isSubagentSession({ sessionManager, agent: main })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a context without an identity keeps the shape heuristics", () => {
    expect(_isSubagentSession({ hasUI: false })).toBe(true);
    expect(_isSubagentSession({ hasUI: true })).toBe(false);
  });
});

// ── G14: hydration reads the session files itself ────────────────────────────

describe("G14: hydration without a session manager reads the session files", () => {
  test("a folder with no session files leaves the buffer empty and throws nothing", () => {
    _setMessageBufferForTest([]);
    expect(() => _hydrateMessageBufferFromSession(undefined, join(tmpdir(), `omp-lifecycle-none-${process.pid}`))).not.toThrow();
    expect(_getMessageBufferForTest()).toEqual([]);
  });
});

// ── G15: a daemon ends through omp, not under it ─────────────────────────────

describe("G15: daemon exits go through the host", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  test("/restart asks omp to shut down and announces the code instead of exiting under it", async () => {
    const s = await boot();
    process.env["REMOTE_OMP_DAEMON"] = "1";
    expect(restartSession()).toBe(true);
    await vi.waitFor(() => expect(s.ctx.shutdown).toHaveBeenCalledTimes(1));
    expect(s.ctx.ui.setStatus).toHaveBeenCalledWith(HOST_EXIT_STATUS_KEY, String(EXIT_DAEMON_RESTART));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("a fresh session from the phone resets the mirror, then exits through omp with the fresh-session code", async () => {
    const s = await boot();
    process.env["REMOTE_OMP_DAEMON"] = "1";
    const before = sentCount();
    phoneSends({ type: "session_new", id: "n1" });
    await vi.waitFor(() => expect(s.ctx.shutdown).toHaveBeenCalledTimes(1));
    expect(wire(before).some((m) => m.type === "action_ok" && m.action === "session_new")).toBe(true);
    expect(s.ctx.ui.setStatus).toHaveBeenCalledWith(HOST_EXIT_STATUS_KEY, String(EXIT_DAEMON_FRESH_SESSION));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("a host that cannot shut down is still ended with the supervisor's code", async () => {
    await boot({}, { shutdown: undefined });
    process.env["REMOTE_OMP_DAEMON"] = "1";
    expect(restartSession()).toBe(true);
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(EXIT_DAEMON_RESTART));
  });
});

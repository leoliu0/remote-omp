import { afterEach, describe, expect, test, vi } from "vitest";
import type { ServerMessage } from "../protocol/types.js";
import {
  ompMainSession,
  RETRY_MESSAGES,
  RETRY_START_GRACE_MS,
  RetryTurn,
  type OmpRetrySession,
} from "./retry.js";

function makeSender() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send(msg: ServerMessage): void {
      sent.push(msg);
    },
  };
}

const REQ = { type: "retry_turn", id: "act_1" } as const;

function fakeSession(overrides: Partial<OmpRetrySession> & { retry?: () => Promise<boolean> } = {}) {
  const retry = vi.fn(overrides.retry ?? (async () => true));
  return { ...overrides, retry } as OmpRetrySession & { retry: ReturnType<typeof vi.fn> };
}

function makeRetry(opts: { session?: OmpRetrySession | null; idle?: boolean } = {}) {
  const state = { idle: opts.idle ?? true, session: opts.session === undefined ? fakeSession() : opts.session };
  const retry = new RetryTurn({
    session: () => state.session,
    isIdle: () => state.idle,
  });
  return { retry, state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("retry_turn (omp path)", () => {
  test("re-runs the failed turn through omp's retry() and acks", async () => {
    const session = fakeSession();
    const { retry } = makeRetry({ session });
    const sender = makeSender();

    expect(await retry.handle(sender, REQ)).toBe(true);

    expect(session.retry).toHaveBeenCalledTimes(1);
    expect(sender.sent).toEqual([{ type: "action_ok", in_reply_to: "act_1", action: "retry_turn" }]);
  });

  test("nothing to retry: omp's retry() resolves false → nothing_to_retry", async () => {
    const session = fakeSession({ retry: async () => false });
    const { retry } = makeRetry({ session });
    const sender = makeSender();

    expect(await retry.handle(sender, REQ)).toBe(false);

    expect(sender.sent).toEqual([
      { type: "error", in_reply_to: "act_1", code: "nothing_to_retry", message: RETRY_MESSAGES.nothing },
    ]);
  });

  test("refuses while a turn streams: busy, retry() never called", async () => {
    const session = fakeSession();
    const { retry } = makeRetry({ session, idle: false });
    const sender = makeSender();

    expect(await retry.handle(sender, REQ)).toBe(false);

    expect(session.retry).not.toHaveBeenCalled();
    expect(sender.sent).toEqual([
      { type: "error", in_reply_to: "act_1", code: "busy", message: RETRY_MESSAGES.working },
    ]);
  });

  test.each(["isStreaming", "isCompacting", "isRetrying"] as const)(
    "refuses while omp reports %s: busy, retry() never called",
    async (flag) => {
      const session = fakeSession({ [flag]: true });
      const { retry } = makeRetry({ session });
      const sender = makeSender();

      expect(await retry.handle(sender, REQ)).toBe(false);

      expect(session.retry).not.toHaveBeenCalled();
      expect(sender.sent).toEqual([
        { type: "error", in_reply_to: "act_1", code: "busy", message: RETRY_MESSAGES.working },
      ]);
    },
  );

  test("a throwing retry() → internal_error, and the claim is released", async () => {
    const session = fakeSession({
      retry: async () => {
        throw new Error("boom");
      },
    });
    const { retry, state } = makeRetry({ session });
    const sender = makeSender();

    expect(await retry.handle(sender, REQ)).toBe(false);
    expect(sender.sent).toEqual([
      { type: "error", in_reply_to: "act_1", code: "internal_error", message: "Retry failed: boom" },
    ]);

    // Not stuck: the next request reaches omp again.
    state.session = fakeSession();
    expect(await retry.handle(sender, { type: "retry_turn", id: "act_2" })).toBe(true);
  });
});

describe("retry_turn (host without omp's retry)", () => {
  test("no session handle → unsupported, never a re-sent prompt", async () => {
    const { retry } = makeRetry({ session: null });
    const sender = makeSender();

    expect(await retry.handle(sender, REQ)).toBe(false);

    expect(sender.sent).toEqual([
      { type: "error", in_reply_to: "act_1", code: "unsupported", message: RETRY_MESSAGES.unsupported },
    ]);
  });
});

describe("retry_turn (never two retries at once)", () => {
  test("two requests before the first settles: exactly one retry() call", async () => {
    let finish!: (retried: boolean) => void;
    const session = fakeSession({
      retry: () => new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    });
    const { retry } = makeRetry({ session });
    const sender = makeSender();

    const first = retry.handle(sender, REQ);
    const second = retry.handle(sender, { type: "retry_turn", id: "act_2" });
    expect(await second).toBe(false);
    finish(true);
    expect(await first).toBe(true);

    expect(session.retry).toHaveBeenCalledTimes(1);
    expect(sender.sent).toEqual([
      { type: "error", in_reply_to: "act_2", code: "busy", message: RETRY_MESSAGES.starting },
      { type: "action_ok", in_reply_to: "act_1", action: "retry_turn" },
    ]);
  });

  test("after a success the claim holds until the continuation starts", async () => {
    const session = fakeSession();
    const { retry } = makeRetry({ session });
    const sender = makeSender();

    expect(await retry.handle(sender, REQ)).toBe(true);
    // omp resolved retry() but its run has not begun (agent_start not seen yet).
    expect(await retry.handle(sender, { type: "retry_turn", id: "act_2" })).toBe(false);
    expect(session.retry).toHaveBeenCalledTimes(1);
    expect(sender.sent.at(-1)).toMatchObject({ code: "busy", message: RETRY_MESSAGES.starting });

    retry.onAgentStart();
    expect(await retry.handle(sender, { type: "retry_turn", id: "act_3" })).toBe(true);
    expect(session.retry).toHaveBeenCalledTimes(2);
  });

  test("the claim expires if the continuation never starts", async () => {
    vi.useFakeTimers();
    const session = fakeSession();
    const { retry } = makeRetry({ session });
    const sender = makeSender();

    expect(await retry.handle(sender, REQ)).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_START_GRACE_MS - 1);
    expect(await retry.handle(sender, { type: "retry_turn", id: "act_2" })).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await retry.handle(sender, { type: "retry_turn", id: "act_3" })).toBe(true);
    expect(session.retry).toHaveBeenCalledTimes(2);
  });

  test("a refused request leaves no claim behind", async () => {
    const session = fakeSession({ retry: async () => false });
    const { retry, state } = makeRetry({ session });
    const sender = makeSender();

    expect(await retry.handle(sender, REQ)).toBe(false);
    state.session = fakeSession();
    expect(await retry.handle(sender, { type: "retry_turn", id: "act_2" })).toBe(true);
  });
});

describe("ompMainSession", () => {
  const session = fakeSession();
  const api = (overrides: Record<string, unknown> = {}) => ({
    pi: {
      MAIN_AGENT_ID: "Main",
      AgentRegistry: {
        global: () => ({
          get: (id: string) => (id === "Main" ? { id, kind: "main", session } : undefined),
        }),
      },
      ...overrides,
    },
  });

  test("reads the live main session from the SDK omp injects as ExtensionAPI.pi", () => {
    expect(ompMainSession(api())).toBe(session);
  });

  test.each([
    ["no ExtensionAPI", null],
    ["upstream pi (no `pi` SDK)", {}],
    ["no AgentRegistry", { pi: { MAIN_AGENT_ID: "Main" } }],
    ["no main agent id", api({ MAIN_AGENT_ID: undefined })],
    ["main agent not registered", api({ MAIN_AGENT_ID: "Other" })],
    [
      "registered without a session",
      api({ AgentRegistry: { global: () => ({ get: () => ({ session: null }) }) } }),
    ],
    [
      "a session without retry()",
      api({ AgentRegistry: { global: () => ({ get: () => ({ session: {} }) }) } }),
    ],
  ])("null when %s", (_name, value) => {
    expect(ompMainSession(value)).toBeNull();
  });

  test("a stale API that throws reads as unavailable", () => {
    const stale = {
      get pi(): never {
        throw new Error("stale after session replacement");
      },
    };
    expect(ompMainSession(stale)).toBeNull();
  });
});

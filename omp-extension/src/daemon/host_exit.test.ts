import { afterEach, describe, expect, test, vi } from "vitest";
import {
  HOST_EXIT_STATUS_KEY,
  _resetHostExitForTest,
  parseHostExitFrame,
  pendingHostExit,
  requestHostExit,
} from "./host_exit.js";

afterEach(() => {
  vi.useRealTimers();
  _resetHostExitForTest();
});

describe("requestHostExit", () => {
  test("without ctx.shutdown it exits at once and remembers nothing", () => {
    const exit = vi.fn();
    requestHostExit({ ui: {} }, 43, exit);
    expect(exit).toHaveBeenCalledWith(43);
    expect(pendingHostExit()).toBeNull();
    requestHostExit(null, 42, exit);
    expect(exit).toHaveBeenLastCalledWith(42);
  });

  test("with ctx.shutdown it asks the host, announces the code and leaves the exit to omp", () => {
    const shutdown = vi.fn();
    const setStatus = vi.fn();
    const exit = vi.fn();
    requestHostExit({ shutdown, ui: { setStatus } }, 43, exit);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(HOST_EXIT_STATUS_KEY, "43");
    expect(exit).not.toHaveBeenCalled();
    expect(pendingHostExit()).toBe(43);
  });

  test("the first request wins", () => {
    const shutdown = vi.fn();
    requestHostExit({ shutdown }, 43, vi.fn());
    requestHostExit({ shutdown }, 42, vi.fn());
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(pendingHostExit()).toBe(43);
  });

  test("the watchdog ends the process when the host never does", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    requestHostExit({ shutdown: vi.fn() }, 42, exit, 1_000);
    vi.advanceTimersByTime(999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(42);
  });

  test("a host whose shutdown throws is exited directly", () => {
    const exit = vi.fn();
    requestHostExit({ shutdown: () => { throw new Error("stale"); } }, 43, exit);
    expect(exit).toHaveBeenCalledWith(43);
  });

  test("the code survives omp ending its own shutdown with process.exit(0)", () => {
    const previous = process.exitCode;
    try {
      requestHostExit({ shutdown: vi.fn() }, 43, vi.fn());
      // Ours is the last `exit` listener registered; omp's process.exit(0) runs it before the process ends.
      const listener = process.listeners("exit").at(-1);
      expect(listener).toBeDefined();
      listener?.(0);
      expect(process.exitCode).toBe(43);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe("parseHostExitFrame", () => {
  const frame = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: "extension_ui_request",
      id: "ui-1",
      method: "setStatus",
      statusKey: HOST_EXIT_STATUS_KEY,
      statusText: "43",
      ...overrides,
    });

  test("reads the announced code", () => {
    expect(parseHostExitFrame(frame())).toBe(43);
    expect(parseHostExitFrame(frame({ statusText: "0" }))).toBe(0);
  });

  test("ignores every other line", () => {
    expect(parseHostExitFrame(frame({ statusKey: "other" }))).toBeNull();
    expect(parseHostExitFrame(frame({ method: "notify" }))).toBeNull();
    expect(parseHostExitFrame(frame({ statusText: "soon" }))).toBeNull();
    expect(parseHostExitFrame('{"type":"message_start"}')).toBeNull();
    expect(parseHostExitFrame(`not json ${HOST_EXIT_STATUS_KEY}`)).toBeNull();
  });
});

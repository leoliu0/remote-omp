import { describe, expect, test } from "vitest";
import { DEFAULT_DAEMON_UI_TIMEOUT_MS, daemonUiTimeoutMs } from "./ui_timeout.js";

describe("daemonUiTimeoutMs", () => {
  test("defaults to 30 minutes", () => {
    expect(DEFAULT_DAEMON_UI_TIMEOUT_MS).toBe(1_800_000);
    expect(daemonUiTimeoutMs({})).toBe(1_800_000);
  });

  test("REMOTE_OMP_ASK_TIMEOUT_MS overrides with a positive integer", () => {
    expect(daemonUiTimeoutMs({ REMOTE_OMP_ASK_TIMEOUT_MS: "5000" })).toBe(5000);
  });

  test("the pre-rename REMOTE_PI_ASK_TIMEOUT_MS is not read", () => {
    expect(daemonUiTimeoutMs({ REMOTE_PI_ASK_TIMEOUT_MS: "5000" })).toBe(DEFAULT_DAEMON_UI_TIMEOUT_MS);
  });

  test.each(["", "  ", "0", "-5", "1.5", "abc", "Infinity"])("invalid %j falls back to the default", (raw) => {
    expect(daemonUiTimeoutMs({ REMOTE_OMP_ASK_TIMEOUT_MS: raw })).toBe(DEFAULT_DAEMON_UI_TIMEOUT_MS);
  });
});

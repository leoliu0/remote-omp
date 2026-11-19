import { describe, expect, test } from "vitest";
import { harnessFromArgv, resolveHarness } from "./harness.js";

describe("harnessFromArgv", () => {
  test("recognises omp by launcher name and by package path", () => {
    expect(harnessFromArgv("/home/x/.bun/bin/omp")).toBe("omp");
    expect(harnessFromArgv("/home/x/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")).toBe("omp");
    expect(harnessFromArgv("C:\\Users\\x\\AppData\\Roaming\\npm\\omp.cmd")).toBe("omp");
  });

  test("recognises pi by launcher name and by package path", () => {
    expect(harnessFromArgv("/home/x/.npm-global/bin/pi")).toBe("pi");
    expect(harnessFromArgv("/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js")).toBe("pi");
  });

  test("the standalone remote-pi CLI is neither", () => {
    expect(harnessFromArgv("/home/x/.local/bin/remote-pi")).toBeUndefined();
    expect(harnessFromArgv("/opt/remote-pi/dist/index.js")).toBeUndefined();
    expect(harnessFromArgv(undefined)).toBeUndefined();
  });
});

describe("resolveHarness", () => {
  test("flag beats environment beats the running harness beats pi", () => {
    expect(resolveHarness({ flag: "pi", env: "omp", argv1: "/bin/omp" })).toBe("pi");
    expect(resolveHarness({ env: "omp", argv1: "/bin/pi" })).toBe("omp");
    expect(resolveHarness({ argv1: "/bin/omp" })).toBe("omp");
    expect(resolveHarness({})).toBe("pi");
  });

  test("an unknown --harness is an error, not a silent fallback", () => {
    expect(() => resolveHarness({ flag: "claude", env: "omp" })).toThrow(/pi.*omp/);
  });

  test("a junk REMOTE_PI_HARNESS is ignored", () => {
    expect(resolveHarness({ env: "zsh", argv1: "/bin/omp" })).toBe("omp");
  });
});

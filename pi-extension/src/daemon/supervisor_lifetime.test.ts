import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Supervisor } from "./supervisor.js";
import { addDaemon } from "./registry.js";
import { callSupervisor } from "./client.js";

/**
 * Plan 67 — the supervisor is the only authority over a daemon's lifetime.
 *
 * The harness is a shell script that logs its argv and then behaves as the
 * `mode` file says, so each test drives real process exits through the real
 * supervisor. POSIX-only (shebang script + signals), like the other stubs.
 *
 * Real child processes exit on the platform clock, so these tests poll for the
 * observable outcome (`until`) instead of faking timers.
 */
const FAKE_HARNESS = `#!/bin/sh
echo "$*" >> "$RP_FAKE_LOG"
case "$(cat "$RP_FAKE_MODE" 2>/dev/null)" in
  exit0) exit 0 ;;
  exit1) exit 1 ;;
  flaky) sleep 0.3; exit 1 ;;
  *) exec sleep 30 ;;
esac
`;

let home: string;
let cwd: string;
let log: string;
let mode: string;
let harness: string;
let supervisor: Supervisor | null = null;

const spawns = (): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

async function until(what: string, pred: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}; spawns=${JSON.stringify(spawns())}`);
}

async function daemonState(): Promise<string | undefined> {
  return (await callSupervisor({ op: "list" })).daemons[0]?.state;
}

async function boot(opts: { backoffs: number[]; stableUptimeMs?: number; writeHarness?: boolean }): Promise<string> {
  if (opts.writeHarness !== false) {
    writeFileSync(harness, FAKE_HARNESS);
    chmodSync(harness, 0o755);
  }
  const { id } = addDaemon(cwd, "door");
  supervisor = new Supervisor({
    extensionPath: "/no/such/extension.js",
    piBin: harness,
    restartBackoffsMs: opts.backoffs,
    ...(opts.stableUptimeMs !== undefined ? { stableUptimeMs: opts.stableUptimeMs } : {}),
  });
  await supervisor.start();
  return id;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-life-"));
  cwd = mkdtempSync(join(tmpdir(), "pi-life-cwd-"));
  log = join(home, "spawns.log");
  mode = join(home, "mode");
  harness = join(home, "fake-harness.sh");
  process.env["REMOTE_PI_HOME"] = home;
  process.env["RP_FAKE_LOG"] = log;
  process.env["RP_FAKE_MODE"] = mode;
});

afterEach(async () => {
  if (supervisor) { await supervisor.stop(); supervisor = null; }
  delete process.env["REMOTE_PI_HOME"];
  delete process.env["RP_FAKE_LOG"];
  delete process.env["RP_FAKE_MODE"];
  for (const d of [home, cwd]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe.skipIf(process.platform === "win32")("Supervisor — lifetime authority (plan 67)", () => {
  test("a daemon that exits 0 on its own (the phone's quit) comes back with a fresh session", async () => {
    writeFileSync(mode, "exit0");
    await boot({ backoffs: [20] });
    await until("the respawn", () => spawns().length >= 2);
    writeFileSync(mode, "stay");

    const [first, second] = spawns();
    expect(first).toContain("--continue");
    expect(second).not.toContain("--continue");
    await until("a live daemon", async () => (await daemonState()) === "running");
  });

  test("a crash-looping daemon is still retried past the end of the backoff ladder", async () => {
    writeFileSync(mode, "exit1");
    await boot({ backoffs: [10, 20] });
    // Ladder has 2 rungs; the old supervisor stopped after rung count attempts.
    await until("retries beyond the ladder", () => spawns().length >= 6);
  });

  test("a run that lasted long enough resets the backoff", async () => {
    writeFileSync(mode, "flaky"); // lives 300 ms, then dies
    await boot({ backoffs: [10, 60_000], stableUptimeMs: 100 });
    // Without the reset the third spawn would wait a minute.
    await until("the third spawn", () => spawns().length >= 3, 4000);
  });

  test("a harness binary that is missing at first is picked up once it appears", async () => {
    writeFileSync(mode, "stay");
    await boot({ backoffs: [30], writeHarness: false });
    await sleep(150); // several failed spawn attempts
    writeFileSync(harness, FAKE_HARNESS);
    chmodSync(harness, 0o755);
    await until("the daemon to run", () => spawns().length >= 1);
    await until("running state", async () => (await daemonState()) === "running");
  });

  test("stop during a backoff keeps the daemon down", async () => {
    writeFileSync(mode, "exit1");
    const id = await boot({ backoffs: [300] });
    await until("the crash", async () => spawns().length >= 1 && (await daemonState()) === "crashed");
    await callSupervisor({ op: "stop", id });
    const seen = spawns().length;
    await sleep(700);
    expect(spawns().length).toBe(seen);
  });
});

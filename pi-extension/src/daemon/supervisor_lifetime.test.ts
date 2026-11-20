import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Supervisor } from "./supervisor.js";
import { addDaemon, registryPath } from "./registry.js";
import { daemonIdForCwd } from "./id.js";
import { callSupervisor } from "./client.js";

/**
 * Plan 67 — the supervisor is the only authority over a daemon's lifetime.
 *
 * The fake omp is a shell script that logs its argv (and optionally env) and
 * behaves as the `mode` file says, so each test drives real process exits
 * through the real supervisor. POSIX-only (shebang script + signals).
 */
const FAKE_OMP = `#!/bin/sh
echo "$*" >> "$RP_FAKE_LOG"
if [ -n "$RP_FAKE_ENV_LOG" ]; then
  printf '%s|%s|%s\n' "$REMOTE_OMP_DAEMON" "$(env | grep -c '_HARNESS=')" "$RP_CHILD_TEST_VAR" >> "$RP_FAKE_ENV_LOG"
fi
case "$(cat "$RP_FAKE_MODE" 2>/dev/null)" in
  exit0_once) echo "stay" > "$RP_FAKE_MODE"; exit 0 ;;
  exit0) exit 0 ;;
  exit1) exit 1 ;;
  exit42) exit 42 ;;
  exit43) exit 43 ;;
  exit42_once) echo "stay" > "$RP_FAKE_MODE"; exit 42 ;;
  exit43_once) echo "stay" > "$RP_FAKE_MODE"; exit 43 ;;
  flaky) "$RP_NODE_EXE" -e "setTimeout(()=>{}, 250)"; exit 1 ;;
  *) exec sleep 30 ;;
esac
`;

let home: string;
let cwd: string;
let log: string;
let envLog: string;
let mode: string;
let fakeOmp: string;
let supervisor: Supervisor | null = null;
let prevOmpHome: string | undefined;

const spawns = (): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

const envLines = (): string[] =>
  existsSync(envLog) ? readFileSync(envLog, "utf8").split("\n").filter(Boolean) : [];

async function until(what: string, pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}; spawns=${JSON.stringify(spawns())}`);
}

async function daemonInfo(id?: string) {
  const list = (await callSupervisor({ op: "list" })).daemons;
  return id ? list.find((d) => d.id === id) : list[0];
}

async function boot(opts: {
  backoffs: [number, ...number[]];
  stableUptimeMs?: number;
  writeOmp?: boolean;
  /** Register the folder through `addDaemon` (default); false when the test wrote the registry itself. */
  register?: boolean;
  loadChildEnv?: () => Promise<NodeJS.ProcessEnv | undefined>;
}): Promise<string> {
  if (opts.writeOmp !== false) {
    writeFileSync(fakeOmp, FAKE_OMP);
    chmodSync(fakeOmp, 0o755);
  }
  if (opts.register !== false) addDaemon(cwd, "door");
  const id = daemonIdForCwd(cwd);
  supervisor = new Supervisor({
    extensionPath: "/no/such/extension.js",
    ompBin: fakeOmp,
    restartBackoffsMs: opts.backoffs,
    ...(opts.stableUptimeMs !== undefined ? { stableUptimeMs: opts.stableUptimeMs } : {}),
    ...(opts.loadChildEnv ? { loadChildEnv: opts.loadChildEnv } : {}),
  });
  await supervisor.start();
  return id;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omp-life-"));
  cwd = mkdtempSync(join(tmpdir(), "omp-life-cwd-"));
  log = join(home, "spawns.log");
  envLog = join(home, "env.log");
  mode = join(home, "mode");
  fakeOmp = join(home, "fake-omp.sh");
  prevOmpHome = process.env["REMOTE_OMP_HOME"];
  process.env["REMOTE_OMP_HOME"] = home;
  process.env["RP_FAKE_LOG"] = log;
  process.env["RP_FAKE_MODE"] = mode;
  process.env["RP_NODE_EXE"] = process.execPath;
});

afterEach(async () => {
  if (supervisor) { await supervisor.stop(); supervisor = null; }
  if (prevOmpHome === undefined) delete process.env["REMOTE_OMP_HOME"];
  else process.env["REMOTE_OMP_HOME"] = prevOmpHome;
  delete process.env["RP_FAKE_LOG"];
  delete process.env["RP_FAKE_ENV_LOG"];
  delete process.env["RP_FAKE_MODE"];
  delete process.env["RP_NODE_EXE"];
  for (const d of [home, cwd]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe.skipIf(process.platform === "win32")("Supervisor — lifetime authority (plan 67)", () => {
  test("unrequested exit 0 (phone Quit) respawns fresh once, then restores --continue on later respawn", async () => {
    writeFileSync(mode, "exit0_once");
    await boot({ backoffs: [20] });
    await until("live respawn #2", async () => spawns().length === 2 && (await daemonInfo())?.state === "running");

    const info2 = await daemonInfo();
    expect(info2?.pid).toBeDefined();
    process.kill(info2!.pid!, "SIGKILL");
    await until("live respawn #3", async () => spawns().length === 3 && (await daemonInfo())?.state === "running");

    const [first, second, third] = spawns();
    expect(first).toContain("--continue");
    expect(second).not.toContain("--continue");
    expect(third).toContain("--continue");
  });

  test("EXIT_DAEMON_FRESH_SESSION (42) respawns immediately without --continue; EXIT_DAEMON_RESTART (43) keeps --continue", async () => {
    writeFileSync(mode, "exit42_once");
    await boot({ backoffs: [60_000] });
    await until("immediate 42 respawn", async () => spawns().length === 2 && (await daemonInfo())?.state === "running");
    expect(spawns()[1]).not.toContain("--continue");

    await supervisor!.stop();
    supervisor = null;
    writeFileSync(log, "");
    writeFileSync(mode, "exit43_once");
    supervisor = new Supervisor({
      extensionPath: "/no/such/extension.js",
      ompBin: fakeOmp,
      restartBackoffsMs: [60_000],
    });
    await supervisor.start();
    await until("immediate 43 respawn", async () => spawns().length === 2 && (await daemonInfo())?.state === "running");
    expect(spawns()[1]).toContain("--continue");
  });

  test("repeated sub-5s exit 42/43 loops fall back to backoff instead of spinning 100% CPU", async () => {
    writeFileSync(mode, "exit42");
    await boot({ backoffs: [400] });
    // Initial spawn + 2 immediate fast recycles = 3 quick spawns; 4th waits for 400ms backoff.
    await until("3 fast spawns", () => spawns().length >= 3);
    const t3 = Date.now();
    await until("4th spawn after backoff", () => spawns().length >= 4);
    expect(Date.now() - t3).toBeGreaterThanOrEqual(300);
  });

  test("a crash-looping daemon is still retried past the end of the backoff ladder", async () => {
    writeFileSync(mode, "exit1");
    await boot({ backoffs: [10, 20] });
    // Ladder has 2 rungs; the old supervisor stopped after rung count attempts.
    await until("retries beyond the ladder", () => spawns().length >= 6);
  });

  test("unstable runs escalate backoff while long-enough runs reset it", async () => {
    // Part A: fast crashes escalate from rung 0 (10ms) to rung 1 (350ms).
    writeFileSync(mode, "exit1");
    await boot({ backoffs: [10, 350], stableUptimeMs: 5000 });
    await until("2nd spawn", () => spawns().length >= 2);
    const t2 = Date.now();
    await until("3rd spawn at escalated rung", () => spawns().length >= 3);
    expect(Date.now() - t2).toBeGreaterThanOrEqual(250);

    // Part B: runs exceeding stableUptimeMs reset back to rung 0 instead of hitting rung 1 (60s).
    await supervisor!.stop();
    supervisor = null;
    writeFileSync(log, "");
    writeFileSync(mode, "flaky"); // lives 250 ms, then dies
    supervisor = new Supervisor({
      extensionPath: "/no/such/extension.js",
      ompBin: fakeOmp,
      restartBackoffsMs: [10, 60_000],
      stableUptimeMs: 100,
    });
    await supervisor.start();
    await until("the third spawn after reset", () => spawns().length >= 3, 4000);
  });

  test("an omp binary that is missing at first is picked up once it appears", async () => {
    writeFileSync(mode, "stay");
    const id = await boot({ backoffs: [30], writeOmp: false });
    await until("several failed spawn retries", async () => ((await daemonInfo(id))?.restart_count ?? 0) >= 2);
    writeFileSync(fakeOmp, FAKE_OMP);
    chmodSync(fakeOmp, 0o755);
    await until("the daemon to run", () => spawns().length >= 1);
    await until("running state", async () => (await daemonInfo(id))?.state === "running");
  });

  test("stop during a backoff keeps the daemon down", async () => {
    writeFileSync(mode, "exit1");
    const id = await boot({ backoffs: [600] });
    await until("the crash", async () => spawns().length === 1 && (await daemonInfo(id))?.state === "crashed");
    const reply = await callSupervisor({ op: "stop", id });
    expect(reply.stopped).toBe(false);
    expect(spawns().length).toBe(1);
    await sleep(750);
    expect(spawns().length).toBe(1);
  });

  test("stop_all during backoff keeps all daemons down", async () => {
    const cwd2 = mkdtempSync(join(tmpdir(), "omp-life-cwd2-"));
    try {
      writeFileSync(mode, "exit1");
      writeFileSync(fakeOmp, FAKE_OMP);
      chmodSync(fakeOmp, 0o755);
      const d1 = addDaemon(cwd, "d1");
      const d2 = addDaemon(cwd2, "d2");
      supervisor = new Supervisor({
        extensionPath: "/no/such/extension.js",
        ompBin: fakeOmp,
        restartBackoffsMs: [600],
      });
      await supervisor.start();
      await until("both crashed", async () => {
        const list = (await callSupervisor({ op: "list" })).daemons;
        return spawns().length === 2 && list.every((d) => d.state === "crashed");
      });
      const reply = await callSupervisor({ op: "stop_all" });
      expect(reply.stopped).toEqual([]);
      expect(reply.already_stopped.sort()).toEqual([d1.id, d2.id].sort());
      await sleep(750);
      expect(spawns().length).toBe(2);
    } finally {
      try { rmSync(cwd2, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test("restart during backoff cancels timer and spawns once", async () => {
    writeFileSync(mode, "exit1");
    const id = await boot({ backoffs: [400] });
    await until("initial crash", async () => spawns().length === 1 && (await daemonInfo(id))?.state === "crashed");
    writeFileSync(mode, "stay");
    const reply = await callSupervisor({ op: "restart", id });
    expect(reply.restarted).toBe(true);
    await until("running after restart", async () => spawns().length === 2 && (await daemonInfo(id))?.state === "running");
    await sleep(550);
    expect(spawns().length).toBe(2);
  });

  test("unregister during backoff leaves no orphan respawn", async () => {
    writeFileSync(mode, "exit1");
    const id = await boot({ backoffs: [300] });
    await until("initial crash", async () => spawns().length === 1 && (await daemonInfo(id))?.state === "crashed");
    writeFileSync(mode, "stay");
    const reply = await callSupervisor({ op: "unregister", id });
    expect(reply.removed).toBe(true);
    await sleep(500);
    expect(spawns().length).toBe(1);
    expect((await callSupervisor({ op: "list" })).daemons).toEqual([]);
  });

  test("runs omp with its flags and REMOTE_OMP_DAEMON=1, exports no agent-CLI selector, and adds loadChildEnv without mutating supervisor env", async () => {
    process.env["RP_FAKE_ENV_LOG"] = envLog;
    writeFileSync(mode, "stay");
    const id = await boot({
      backoffs: [50],
      // Both selector names are blanked in the inheritance, so one that shows up in the child's
      // environment was exported by the supervisor itself.
      loadChildEnv: async () => ({
        RP_CHILD_TEST_VAR: "from-login-shell",
        REMOTE_PI_HARNESS: undefined,
        REMOTE_OMP_HARNESS: undefined,
      }),
    });
    await until("omp child running", async () => spawns().length === 1 && (await daemonInfo(id))?.state === "running");

    expect(spawns()[0]).toContain("--allow-home");
    expect(spawns()[0]).not.toContain("--approve");
    expect(spawns()[0]).not.toContain("--name");
    await until("env logged", () => envLines().length >= 1);
    expect(envLines()[0]).toBe("1|0|from-login-shell");
    expect(process.env["RP_CHILD_TEST_VAR"]).toBeUndefined();
  });

  test("a registry entry an older version saved with a harness runs omp all the same", async () => {
    mkdirSync(dirname(registryPath()), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify({ daemons: [{ cwd: realpathSync(cwd), name: "door", harness: "pi" }] }));
    writeFileSync(mode, "stay");
    const id = await boot({ backoffs: [50], register: false });
    await until("the saved entry to run", async () => spawns().length === 1 && (await daemonInfo(id))?.state === "running");

    expect(spawns()[0]).toContain("--mode rpc");
    expect(spawns()[0]).toContain("--allow-home");
    expect(spawns()[0]).not.toContain("--approve");
    expect(spawns()[0]).not.toContain("--name");
  });
});

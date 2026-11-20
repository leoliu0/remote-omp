import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Supervisor, _idForCwdForTest } from "./supervisor.js";
import { addDaemon } from "./registry.js";
import { callSupervisor, SupervisorReplyError } from "./client.js";

/**
 * Plan 68 — sessions started from the phone are ephemeral: the supervisor runs
 * them without a registry entry and nothing brings them back once they end.
 *
 * The fake omp is a shell script that logs its argv and behaves as the `mode`
 * file says, so each test drives real process exits through the real
 * supervisor. POSIX-only (shebang script + signals).
 */
const FAKE_OMP = `#!/bin/sh
echo "$*" >> "$RP_FAKE_LOG"
case "$(cat "$RP_FAKE_MODE" 2>/dev/null)" in
  quit_soon) "$RP_NODE_EXE" -e "setTimeout(()=>{}, 300)"; exit 0 ;;
  crash_soon) "$RP_NODE_EXE" -e "setTimeout(()=>{}, 300)"; exit 1 ;;
  exit42_once) echo "stay" > "$RP_FAKE_MODE"; "$RP_NODE_EXE" -e "setTimeout(()=>{}, 300)"; exit 42 ;;
  exit43_once) echo "stay" > "$RP_FAKE_MODE"; "$RP_NODE_EXE" -e "setTimeout(()=>{}, 300)"; exit 43 ;;
  *) exec sleep 30 ;;
esac
`;

let home: string;
let cwd: string;
let log: string;
let mode: string;
let fakeOmp: string;
let supervisor: Supervisor | null = null;
let prevOmpHome: string | undefined;

const spawns = (): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

// Real wall-clock waits, deliberately: the children are real processes and the
// supervisor's respawn timer runs on the platform clock, so neither a fake
// clock nor an event can stand in for "nothing came back".
async function until(what: string, pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}; spawns=${JSON.stringify(spawns())}`);
}

/** Long enough for a registered daemon to have been respawned (backoff is 20 ms here). */
const quiet = (): Promise<void> => sleep(300);

/** The fake omp logs its argv after the supervisor already saw it spawn. */
const spawned = (n: number): Promise<void> => until(`${n} spawn(s) logged`, () => spawns().length >= n);

const listed = async () => (await callSupervisor({ op: "list" })).daemons;

async function boot(opts: { ompBin?: string } = {}): Promise<void> {
  writeFileSync(fakeOmp, FAKE_OMP);
  chmodSync(fakeOmp, 0o755);
  supervisor = new Supervisor({
    extensionPath: "/no/such/extension.js",
    ompBin: opts.ompBin ?? fakeOmp,
    // A registered daemon would be back within 20 ms of any exit: the ephemeral
    // tests below prove nothing is, by waiting well past that.
    restartBackoffsMs: [20],
  });
  await supervisor.start();
}

const spawnEphemeral = (dir = cwd, name = "phone") =>
  callSupervisor({ op: "spawn_ephemeral", cwd: dir, name });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omp-eph-"));
  cwd = mkdtempSync(join(tmpdir(), "omp-eph-cwd-"));
  log = join(home, "spawns.log");
  mode = join(home, "mode");
  fakeOmp = join(home, "fake-omp.sh");
  prevOmpHome = process.env["REMOTE_OMP_HOME"];
  process.env["REMOTE_OMP_HOME"] = home;
  process.env["RP_FAKE_LOG"] = log;
  process.env["RP_FAKE_MODE"] = mode;
  process.env["RP_NODE_EXE"] = process.execPath;
  writeFileSync(mode, "stay");
});

afterEach(async () => {
  if (supervisor) { await supervisor.stop(); supervisor = null; }
  if (prevOmpHome === undefined) delete process.env["REMOTE_OMP_HOME"];
  else process.env["REMOTE_OMP_HOME"] = prevOmpHome;
  delete process.env["RP_FAKE_LOG"];
  delete process.env["RP_FAKE_MODE"];
  delete process.env["RP_NODE_EXE"];
  for (const d of [home, cwd]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe.skipIf(process.platform === "win32")("Supervisor — ephemeral sessions (plan 68)", () => {
  test("starts a fresh omp session that is listed as ephemeral and is not in the registry", async () => {
    await boot();
    const reply = await spawnEphemeral(cwd, "phone");
    const real = realpathSync(cwd);
    expect(reply).toMatchObject({ id: _idForCwdForTest(real), cwd: real, name: "phone" });
    expect(Object.keys(reply).sort()).toEqual(["cwd", "id", "name", "state"]);
    await spawned(1);

    // A new conversation, not the folder's latest one, and omp's flags.
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]).toContain("--mode rpc");
    expect(spawns()[0]).toContain("--allow-home");
    expect(spawns()[0]).not.toContain("--continue");

    for (const op of ["list", "status"] as const) {
      const { daemons } = await callSupervisor({ op });
      expect(daemons).toHaveLength(1);
      expect(daemons[0]).toMatchObject({
        id: reply.id, cwd: real, name: "phone", state: "running", ephemeral: true,
      });
      expect(daemons[0]).not.toHaveProperty("harness");
      expect(daemons[0]!.pid).toBeGreaterThan(0);
    }
    expect(existsSync(join(home, ".omp", "remote", "daemons.json"))).toBe(false);
  });

  test("a clean exit (the app's Quit) ends the session for good", async () => {
    writeFileSync(mode, "quit_soon");
    await boot();
    await spawnEphemeral();
    await until("the session to end", async () => (await listed()).length === 0);
    await quiet();
    expect(spawns()).toHaveLength(1);
    expect(await listed()).toEqual([]);
  });

  test("a crash is not retried either", async () => {
    writeFileSync(mode, "crash_soon");
    await boot();
    await spawnEphemeral();
    await until("the session to end", async () => (await listed()).length === 0);
    await quiet();
    expect(spawns()).toHaveLength(1);
  });

  test("the folder is free again once the session ended", async () => {
    writeFileSync(mode, "quit_soon");
    await boot();
    await spawnEphemeral();
    await until("the session to end", async () => (await listed()).length === 0);
    writeFileSync(mode, "stay");
    await spawnEphemeral();
    expect((await listed())[0]).toMatchObject({ state: "running", ephemeral: true });
    await spawned(2);
    expect(spawns()).toHaveLength(2);
  });

  test("the app's New context (exit 42) and Restart (exit 43) recycle the live session", async () => {
    writeFileSync(mode, "exit42_once");
    await boot();
    await spawnEphemeral();
    await until("the recycled session", async () => spawns().length === 2 && (await listed())[0]?.state === "running");
    // 42 = fresh conversation, like a daemon.
    expect(spawns()[1]).not.toContain("--continue");
    expect((await listed())[0]).toMatchObject({ ephemeral: true, restart_count: 1 });

    await supervisor!.stop();
    supervisor = null;
    writeFileSync(log, "");
    writeFileSync(mode, "exit43_once");
    await boot();
    await spawnEphemeral();
    await until("the restarted session", async () => spawns().length === 2 && (await listed())[0]?.state === "running");
    // 43 = restart: the first run was fresh, the restart resumes it.
    expect(spawns()[0]).not.toContain("--continue");
    expect(spawns()[1]).toContain("--continue");
  });

  test("shutdown stops the session and the next supervisor does not bring it back", async () => {
    await boot();
    await spawnEphemeral();
    await spawned(1);
    const pid = (await listed())[0]!.pid!;
    expect(() => process.kill(pid, 0)).not.toThrow();

    await supervisor!.stop();
    supervisor = null;
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);

    await boot();
    await quiet();
    expect(await listed()).toEqual([]);
    expect(spawns()).toHaveLength(1);
  });

  test("refuses a folder an ephemeral session already runs in", async () => {
    await boot();
    await spawnEphemeral();
    await spawned(1);
    const err = await spawnEphemeral().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupervisorReplyError);
    expect((err as SupervisorReplyError).code).toBe("cwd_busy");
    expect(spawns()).toHaveLength(1);
    expect(await listed()).toHaveLength(1);
  });

  test("refuses a folder a registered daemon owns", async () => {
    await boot();
    addDaemon(cwd, "door");
    const err = await spawnEphemeral().catch((e: unknown) => e);
    expect((err as SupervisorReplyError).code).toBe("already_registered");
    expect(spawns()).toHaveLength(0);
  });

  test("reports an omp that cannot start instead of pretending it did", async () => {
    await boot({ ompBin: join(home, "no-such-omp") });
    const err = await spawnEphemeral().catch((e: unknown) => e);
    expect((err as SupervisorReplyError).code).toBe("spawn_failed");
    expect((err as SupervisorReplyError).message).toBe(
      `omp did not start in ${realpathSync(cwd)} (is it installed and on the supervisor's PATH?)`,
    );
    expect(await listed()).toEqual([]);
  });

  test("rejects bad requests", async () => {
    await boot();
    const missing = await spawnEphemeral(join(home, "gone")).catch((e: unknown) => e);
    expect((missing as SupervisorReplyError).code).toBe("not_found");
    const noName = await spawnEphemeral(cwd, "  ").catch((e: unknown) => e);
    expect((noName as SupervisorReplyError).code).toBe("bad_request");
    expect(spawns()).toHaveLength(0);
  });

  test("a `harness` an older extension still sends is ignored: omp runs either way", async () => {
    await boot();
    const reply = await callSupervisor<"spawn_ephemeral">({
      op: "spawn_ephemeral", cwd, name: "x", harness: "claude",
    } as never);
    expect(reply).toMatchObject({ cwd: realpathSync(cwd), name: "x" });
    expect(reply).not.toHaveProperty("harness");
    await spawned(1);
    expect(spawns()[0]).toContain("--mode rpc");
  });

  test("`stop <id>` ends an ephemeral session and nothing restarts it; `unregister` leaves it alone", async () => {
    await boot();
    const { id } = await spawnEphemeral();
    await spawned(1);

    expect(await callSupervisor({ op: "unregister", id })).toEqual({ removed: false });
    expect((await listed())[0]).toMatchObject({ id, state: "running" });

    const stopped = await callSupervisor({ op: "stop", id });
    expect(stopped).toMatchObject({ id, stopped: true });
    await quiet();
    expect(await listed()).toEqual([]);
    expect(spawns()).toHaveLength(1);
  });

  test("stop_all ends ephemeral sessions too, and a registered daemon is untouched by their lifecycle", async () => {
    await boot();
    const other = mkdtempSync(join(tmpdir(), "omp-eph-other-"));
    try {
      const daemon = addDaemon(other, "door");
      await callSupervisor({ op: "start", id: daemon.id });
      const { id } = await spawnEphemeral();
      expect((await listed()).map((d) => d.id).sort()).toEqual([daemon.id, id].sort());

      const reply = await callSupervisor({ op: "stop_all" });
      expect([...reply.stopped].sort()).toEqual([daemon.id, id].sort());
      // The registered daemon stays registered (and stopped); the ephemeral one is gone.
      expect(await listed()).toMatchObject([{ id: daemon.id, state: "stopped" }]);
    } finally {
      try { rmSync(other, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

describe.skipIf(process.platform === "win32")("Supervisor — `start` with fresh (plan 68 persistent sessions)", () => {
  test("a registered daemon started fresh skips --continue once; plain start still resumes", async () => {
    await boot();
    const daemon = addDaemon(cwd, "door");
    await callSupervisor({ op: "start", id: daemon.id, fresh: true });
    await until("the daemon to run", async () => spawns().length === 1);
    expect(spawns()[0]).not.toContain("--continue");

    await callSupervisor({ op: "restart", id: daemon.id });
    await until("the restarted daemon", async () => spawns().length === 2);
    expect(spawns()[1]).toContain("--continue");
  });
});

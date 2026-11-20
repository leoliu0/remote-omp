import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "./supervisor.js";
import { addDaemon } from "./registry.js";
import { daemonIdForCwd } from "./id.js";
import { callSupervisor, SupervisorReplyError } from "./client.js";

/**
 * `send` is how a phone-typed slash command reaches omp's own command pipeline in a daemon
 * (plan 69 step 4, G3): the extension names itself by the id the supervisor gave it
 * (`REMOTE_OMP_DAEMON_ID`) and the supervisor writes the line to the child's stdin as an RPC
 * `prompt` frame. The omp here is a stub that logs the frames it receives.
 * POSIX-only (shebang script).
 */
let home: string;
let cwd: string;
let stdinLog: string;
let supervisor: Supervisor | null = null;
let daemonId: string;
let prevOmpHome: string | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "omp-send-"));
  cwd = mkdtempSync(join(tmpdir(), "omp-send-cwd-"));
  stdinLog = join(home, "stdin.log");
  prevOmpHome = process.env["REMOTE_OMP_HOME"];
  process.env["REMOTE_OMP_HOME"] = home;

  const stub = join(home, "omp-stub.mjs");
  writeFileSync(
    stub,
    `#!/usr/bin/env node\n` +
    `import { appendFileSync } from "node:fs";\n` +
    `process.stdin.setEncoding("utf8");\n` +
    `process.stdin.on("data", (c) => appendFileSync(${JSON.stringify(stdinLog)}, c));\n` +
    `setInterval(() => {}, 1e6);\n`,
  );
  chmodSync(stub, 0o755);

  addDaemon(cwd, "send-test");
  daemonId = daemonIdForCwd(cwd);
  supervisor = new Supervisor({ extensionPath: "/no/such/extension.js", ompBin: stub });
  await supervisor.start();
  // The child is up once its event filter has arrived on stdin.
  await vi.waitFor(() => expect(readFileSync(stdinLog, "utf8")).toContain("set_event_filter"), { timeout: 5000 });
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = null;
  if (prevOmpHome === undefined) delete process.env["REMOTE_OMP_HOME"];
  else process.env["REMOTE_OMP_HOME"] = prevOmpHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const promptFrames = (): Array<Record<string, unknown>> =>
  readFileSync(stdinLog, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((f) => f["type"] === "prompt");

describe.skipIf(process.platform === "win32")("supervisor `send`", () => {
  test("writes a prompt frame carrying the requested streaming behavior", async () => {
    const reply = await callSupervisor({ op: "send", id: daemonId, text: "/compact", streaming_behavior: "steer" });
    expect(reply).toEqual({ id: daemonId, delivered: true });
    await vi.waitFor(() => expect(promptFrames()).toHaveLength(1), { timeout: 2000 });
    expect(promptFrames()[0]).toMatchObject({ type: "prompt", message: "/compact", streamingBehavior: "steer" });
  });

  test("without one the prompt waits for the run to end (followUp), as a CLI send or cron fire should", async () => {
    await callSupervisor({ op: "send", id: daemonId, text: "summarise the day" });
    await vi.waitFor(() => expect(promptFrames()).toHaveLength(1), { timeout: 2000 });
    expect(promptFrames()[0]).toMatchObject({ message: "summarise the day", streamingBehavior: "followUp" });
  });

  test("a behavior omp does not have is refused, nothing is written", async () => {
    const err = await callSupervisor({
      op: "send", id: daemonId, text: "x", streaming_behavior: "interrupt" as "steer",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupervisorReplyError);
    expect((err as SupervisorReplyError).code).toBe("bad_request");
    expect(promptFrames()).toHaveLength(0);
  });

  test("an unknown daemon is an error", async () => {
    await expect(callSupervisor({ op: "send", id: "ffffffff", text: "/compact" })).rejects.toThrow(/not running/);
  });
});

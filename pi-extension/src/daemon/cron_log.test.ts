import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCronLog, cronLogPath, firedFor, readCronLog } from "./cron_log.js";

let home: string;
let prevOmpHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omp-cronlog-"));
  prevOmpHome = process.env["REMOTE_OMP_HOME"];
  process.env["REMOTE_OMP_HOME"] = home;
});
afterEach(() => {
  if (prevOmpHome === undefined) delete process.env["REMOTE_OMP_HOME"];
  else process.env["REMOTE_OMP_HOME"] = prevOmpHome;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("cron_log", () => {
  test("lives under the Remote OMP data directory, resolved when called", () => {
    expect(cronLogPath()).toBe(join(home, ".omp", "remote", "cron.jsonl"));
    const other = mkdtempSync(join(tmpdir(), "omp-cronlog-other-"));
    process.env["REMOTE_OMP_HOME"] = other;
    try {
      expect(cronLogPath()).toBe(join(other, ".omp", "remote", "cron.jsonl"));
    } finally {
      process.env["REMOTE_OMP_HOME"] = home;
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("missing file → []", () => {
    expect(readCronLog()).toEqual([]);
  });

  test("append creates the file + records all fields", () => {
    appendCronLog({ job_id: "j_1", daemon_id: "d1", schedule: "0 9 * * *", result: "delivered", prompt: "hello world" });
    const out = readCronLog();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      job_id: "j_1", daemon_id: "d1", schedule: "0 9 * * *",
      fired: true, result: "delivered", prompt_preview: "hello world",
    });
    expect(typeof out[0]!.ts).toBe("number");
  });

  test("records skips too (fired:false)", () => {
    appendCronLog({ job_id: "j_1", daemon_id: "d1", schedule: "0 9 * * *", result: "skipped_busy", prompt: "x" });
    appendCronLog({ job_id: "j_1", daemon_id: "d1", schedule: "0 9 * * *", result: "skipped_down", prompt: "x" });
    const out = readCronLog();
    expect(out.map((e) => [e.result, e.fired])).toEqual([
      ["skipped_busy", false],
      ["skipped_down", false],
    ]);
  });

  test("tail returns the last N, in order", () => {
    for (let i = 0; i < 5; i++) {
      appendCronLog({ job_id: "j_1", daemon_id: "d", schedule: "s", result: "delivered", prompt: `p${i}` });
    }
    const out = readCronLog({ tail: 2 });
    expect(out.map((e) => e.prompt_preview)).toEqual(["p3", "p4"]);
  });

  test("filters by job_id", () => {
    appendCronLog({ job_id: "j_a", daemon_id: "d", schedule: "s", result: "delivered", prompt: "a" });
    appendCronLog({ job_id: "j_b", daemon_id: "d", schedule: "s", result: "delivered", prompt: "b" });
    appendCronLog({ job_id: "j_a", daemon_id: "d", schedule: "s", result: "skipped_busy", prompt: "a2" });
    const out = readCronLog({ jobId: "j_a" });
    expect(out.map((e) => e.prompt_preview)).toEqual(["a", "a2"]);
  });

  test("prompt_preview is truncated to 80 chars", () => {
    appendCronLog({ job_id: "j", daemon_id: "d", schedule: "s", result: "delivered", prompt: "x".repeat(200) });
    expect(readCronLog()[0]!.prompt_preview).toHaveLength(80);
  });

  test("firedFor maps results", () => {
    expect(firedFor("delivered")).toBe(true);
    expect(firedFor("woke_and_delivered")).toBe(true);
    expect(firedFor("deliver_failed")).toBe(false);
    expect(firedFor("skipped_busy")).toBe(false);
  });
});

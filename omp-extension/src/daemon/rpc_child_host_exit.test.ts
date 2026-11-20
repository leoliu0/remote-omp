import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HOST_EXIT_STATUS_KEY } from "./host_exit.js";
import { RpcChild } from "./rpc_child.js";

describe("RpcChild: a host exit announced by the extension", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // The stub prints the announcement the extension makes after `ctx.shutdown()` and logs
  // everything it receives on stdin, like omp's RPC loop. Real child process on purpose:
  // the pipe between supervisor and omp is what this covers.
  test.skipIf(process.platform === "win32")("answers it with a frame omp handles, so the requested shutdown runs now", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-hostexit-"));
    const log = join(dir, "stdin.log");
    const stub = join(dir, "omp-stub.js");
    const announcement = JSON.stringify({
      type: "extension_ui_request",
      id: "ui-1",
      method: "setStatus",
      statusKey: HOST_EXIT_STATUS_KEY,
      statusText: "43",
    });
    writeFileSync(
      stub,
      "#!/usr/bin/env node\n" +
        "const fs=require('fs');\n" +
        `process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(log)},d));\n` +
        `console.log(${JSON.stringify(announcement)});\n` +
        "setInterval(()=>{},1e9);\n",
    );
    chmodSync(stub, 0o755);

    const child = new RpcChild({ ompBin: stub, extensionPath: "/x", cwd: dir });
    const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.spawn();
    await spawned;
    try {
      await vi.waitFor(
        () => {
          const frames = readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(frames.filter((frame) => frame["type"] === "get_state")).toHaveLength(1);
        },
        { timeout: 5_000, interval: 25 },
      );
    } finally {
      await child.stop();
    }
  });
});

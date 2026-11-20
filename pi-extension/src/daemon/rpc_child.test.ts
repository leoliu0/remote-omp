import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcChild, busyTransition, resolvePiBin, resolvePiSpawn, _npmShimTarget, rpcSpawnArgs, type RpcChildExitEvent } from "./rpc_child.js";

function deferredExit(): { promise: Promise<RpcChildExitEvent>; resolve: (evt: RpcChildExitEvent) => void } {
  let resolve!: (evt: RpcChildExitEvent) => void;
  const promise = new Promise<RpcChildExitEvent>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("rpcSpawnArgs", () => {
  const ext = "/path/to/dist/index.js";

  test("pi: includes --continue so a restart resumes the latest session (not a new one)", () => {
    expect(rpcSpawnArgs({ harness: "pi", extensionPath: ext })).toEqual([
      "--mode", "rpc", "--approve", "--continue", "-e", ext,
    ]);
  });

  test("pi: pins the session display name via --name when one is given", () => {
    expect(rpcSpawnArgs({ harness: "pi", extensionPath: ext, sessionName: "PC" })).toEqual([
      "--mode", "rpc", "--approve", "--continue", "--name", "PC", "-e", ext,
    ]);
  });

  test("pi: can omit --continue for one daemon fresh-session restart", () => {
    expect(rpcSpawnArgs({ harness: "pi", extensionPath: ext, sessionName: "PC", useContinue: false })).toEqual([
      "--mode", "rpc", "--approve", "--name", "PC", "-e", ext,
    ]);
  });

  // omp rejects pi's --approve/--name, and leaves `~` for a temp dir unless
  // --allow-home is given: a daemon must run in the folder it was registered for.
  test("omp: no pi-only flags, stays in the registered folder", () => {
    expect(rpcSpawnArgs({ harness: "omp", extensionPath: ext, sessionName: "PC" })).toEqual([
      "--mode", "rpc", "--allow-home", "--continue", "-e", ext,
    ]);
    expect(rpcSpawnArgs({ harness: "omp", extensionPath: ext, useContinue: false })).toEqual([
      "--mode", "rpc", "--allow-home", "-e", ext,
    ]);
  });
});

describe("RpcChild — lifecycle & stdio safety", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (!dir) return;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    dir = undefined;
  });

  test.skipIf(process.platform === "win32")("stop() reports a requested exit though the child dies by signal", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-rpcchild-"));
    const bin = join(dir, "staysalive.sh");
    writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(bin, 0o755);

    const child = new RpcChild({ piBin: bin, extensionPath: "/no/such.js", cwd: dir });
    const exited = new Promise<RpcChildExitEvent>((resolve) => child.once("exit", resolve));
    const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.spawn();
    await spawned;
    await child.stop();

    const evt = await exited;
    expect(evt.requested).toBe(true);
    expect(child.state).toBe("stopped");
  });

  test("a failed spawn can be retried", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-rpcchild-"));
    const child = new RpcChild({ piBin: join(dir, "no-such-harness"), extensionPath: "/no/such.js", cwd: dir });
    for (let attempt = 0; attempt < 2; attempt++) {
      const { promise, resolve } = deferredExit();
      child.once("exit", resolve);
      child.spawn();
      const evt = await promise;
      expect(evt.requested).toBe(false);
      expect(child.state).toBe("crashed");
    }
  });

  test.skipIf(process.platform === "win32")("omp harness writes set_event_filter on spawn", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-rpc-omp-filter-"));
    const stdinLog = join(dir, "stdin.log");
    const stub = join(dir, "omp-stub.mjs");
    writeFileSync(
      stub,
      `#!/usr/bin/env node\n` +
      `import { appendFileSync } from "node:fs";\n` +
      `process.stdin.setEncoding("utf8");\n` +
      `process.stdin.on("data", (c) => appendFileSync(${JSON.stringify(stdinLog)}, c));\n` +
      `setInterval(() => {}, 1e6);\n`,
    );
    chmodSync(stub, 0o755);

    const child = new RpcChild({ harness: "omp", piBin: stub, extensionPath: "/x.js", cwd: dir });
    const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.spawn();
    await spawned;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const text = readFileSync(stdinLog, "utf8");
        if (text.includes("set_event_filter")) break;
      } catch { /* waiting for stub to write */ }
      await new Promise((r) => setTimeout(r, 20));
    }
    const received = readFileSync(stdinLog, "utf8");
    expect(received).toContain('"type":"set_event_filter"');
    expect(received).toContain('"message_start"');
    expect(received).toContain('"message_end"');
    await child.stop();
  });

  test("oversized stdout line is dropped cleanly without corrupting later events", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-rpc-oversize-"));
    const child = new RpcChild({ piBin: "/usr/bin/true", extensionPath: "/x", cwd: dir });
    // Emit a >256 KiB line without newline followed by its newline and a valid message_start.
    child._ingestStdoutForTest("x".repeat(300 * 1024));
    expect(child.isBusy).toBe(false);
    child._ingestStdoutForTest('still-oversized\n{"type":"message_start"}\n');
    expect(child.isBusy).toBe(true);
    child._ingestStdoutForTest('{"type":"message_end"}\n');
    expect(child.isBusy).toBe(false);
  });

  test("stderr forwards complete lines each prefixed with cwd", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-rpc-stderr-"));
    const child = new RpcChild({ piBin: "/usr/bin/true", extensionPath: "/x", cwd: dir });
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      child._ingestStderrForTest("first-half ");
      expect(chunks).toHaveLength(0);
      child._ingestStderrForTest("second-half\nline2\n");
      expect(chunks).toEqual([`[${dir}] first-half second-half\n`, `[${dir}] line2\n`]);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test.skipIf(process.platform === "win32")("writing to an exited child stdin (EPIPE) does not throw uncaught", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-rpc-epipe-"));
    const stub = join(dir, "quick-exit.sh");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);

    const child = new RpcChild({ piBin: stub, extensionPath: "/x", cwd: dir });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.spawn();
    await exited;
    expect(child.sendPrompt("late")).toBe(false);
    await child.stop();
  });
});

describe("resolvePiBin (plan/40 — Windows pi.cmd)", () => {
  test("POSIX → returns the bin name unchanged", () => {
    expect(resolvePiBin("pi", "darwin")).toBe("pi");
    expect(resolvePiBin("pi", "linux")).toBe("pi");
    expect(resolvePiBin("/opt/homebrew/bin/pi", "darwin")).toBe("/opt/homebrew/bin/pi");
  });
  test("Windows → an explicit path or suffixed name is used as-is (no lookup)", () => {
    expect(resolvePiBin("C:\\tools\\pi.cmd", "win32")).toBe("C:\\tools\\pi.cmd");
    expect(resolvePiBin("pi.cmd", "win32")).toBe("pi.cmd");
    expect(resolvePiBin("C:/tools/pi", "win32")).toBe("C:/tools/pi");
  });
});

describe("_npmShimTarget (plan/40 — parse the .cmd shim)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  test("recovers the cli.js the npm shim launches (relative to the shim dir)", () => {
    tmp = mkdtempSync(join(tmpdir(), "pi-shim-"));
    const rel = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    const target = join(tmp, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "// cli\n");
    const shim = join(tmp, "pi.cmd");
    writeFileSync(shim, `@ECHO off\r\n"%_prog%"  "%dp0%\\${rel}" %*\r\n`);
    expect(_npmShimTarget(shim)).toBe(target);
  });

  test("returns null when the shim doesn't match / target missing", () => {
    tmp = mkdtempSync(join(tmpdir(), "pi-shim-"));
    const shim = join(tmp, "weird.cmd");
    writeFileSync(shim, "@echo off\r\necho nope\r\n");
    expect(_npmShimTarget(shim)).toBeNull();
    const shim2 = join(tmp, "pi.cmd");
    writeFileSync(shim2, `"%_prog%" "%dp0%\\does-not-exist.js" %*\r\n`);
    expect(_npmShimTarget(shim2)).toBeNull();
  });
});

describe("resolvePiSpawn (plan/40 — directly-spawnable target)", () => {
  test("POSIX → command is pi, no prefix args", () => {
    expect(resolvePiSpawn("pi", "linux")).toEqual({ command: "pi", prefixArgs: [] });
    expect(resolvePiSpawn("/usr/bin/pi", "darwin")).toEqual({ command: "/usr/bin/pi", prefixArgs: [] });
  });

  test("Windows .cmd shim → spawn node + parsed cli.js (no cmd.exe layer)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-spawn-"));
    try {
      const rel = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
      const target = join(tmp, rel);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "// cli\n");
      const shim = join(tmp, "pi.cmd");
      writeFileSync(shim, `"%_prog%" "%dp0%\\${rel}" %*\r\n`);
      const r = resolvePiSpawn(shim, "win32", "C:\\node\\node.exe");
      expect(r.command).toBe("C:\\node\\node.exe");
      expect(r.prefixArgs).toEqual([target]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Windows explicit .exe → used as-is, no prefix args", () => {
    expect(resolvePiSpawn("C:\\tools\\pi.exe", "win32")).toEqual({
      command: "C:\\tools\\pi.exe",
      prefixArgs: [],
    });
  });
});

describe("busyTransition (stream markers)", () => {
  test("message_start → true, message_end → false", () => {
    expect(busyTransition('{"type":"message_start"}')).toBe(true);
    expect(busyTransition('{"type":"message_end"}')).toBe(false);
  });
  test("other events + garbage → null (no change)", () => {
    expect(busyTransition('{"type":"session_info_changed"}')).toBeNull();
    expect(busyTransition('{"type":"response","command":"prompt"}')).toBeNull();
    expect(busyTransition("not json")).toBeNull();
  });
});

describe("RpcChild — isBusy", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (!dir) return;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    dir = undefined;
  });

  test("passive flag opens/closes on stream markers", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-busy-"));
    const child = new RpcChild({ piBin: "/usr/bin/true", extensionPath: "/x", cwd: dir });
    expect(child.isBusy).toBe(false);
    child._ingestStdoutForTest('{"type":"message_start"}');
    expect(child.isBusy).toBe(true);
    child._ingestStdoutForTest('{"type":"message_end"}');
    expect(child.isBusy).toBe(false);
  });

  test.skipIf(process.platform === "win32")("refreshBusy syncs from get_state.isStreaming (authoritative)", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-busy-gs-"));
    const stub = join(dir, "stub.mjs");
    writeFileSync(
      stub,
      "#!/usr/bin/env node\n" +
      "process.stdin.setEncoding('utf8');let b='';" +
      "process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const l=b.slice(0,n);b=b.slice(n+1);" +
      "try{const m=JSON.parse(l);if(m.type==='get_state')process.stdout.write(JSON.stringify({type:'response',command:'get_state',id:m.id,success:true,data:{isStreaming:true}})+'\\n');}catch{}}});" +
      "setInterval(()=>{},1e9);\n",
    );
    chmodSync(stub, 0o755);

    const child = new RpcChild({ piBin: stub, extensionPath: "/x", cwd: dir });
    const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.spawn();
    await spawned;
    const busy = await child.refreshBusy(1500);
    expect(busy).toBe(true);
    expect(child.isBusy).toBe(true);
    await child.stop();
  });

  test("refreshBusy returns the passive flag when the child isn't running", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-busy-off-"));
    const child = new RpcChild({ piBin: "/usr/bin/true", extensionPath: "/x", cwd: dir });
    expect(await child.refreshBusy(200)).toBe(false);
  });
});

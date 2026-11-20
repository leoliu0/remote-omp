import { afterEach, describe, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { RpcChild, busyTransition, resolveOmpBin, resolveOmpSpawn, _npmShimTarget, rpcSpawnArgs, type RpcChildExitEvent } from "./rpc_child.js";
import { daemonIdForCwd } from "./id.js";

function deferredExit(): { promise: Promise<RpcChildExitEvent>; resolve: (evt: RpcChildExitEvent) => void } {
  let resolve!: (evt: RpcChildExitEvent) => void;
  const promise = new Promise<RpcChildExitEvent>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("rpcSpawnArgs", () => {
  const ext = "/path/to/dist/index.js";

  // omp leaves `~` for a temp dir unless --allow-home is given: a daemon must run in the
  // folder it was registered for.
  test("includes --continue so a restart resumes the latest session (not a new one), and stays in the registered folder", () => {
    expect(rpcSpawnArgs({ extensionPath: ext })).toEqual([
      "--mode", "rpc", "--allow-home", "--continue", "-e", ext,
    ]);
  });

  test("can omit --continue for one daemon fresh-session restart", () => {
    expect(rpcSpawnArgs({ extensionPath: ext, useContinue: false })).toEqual([
      "--mode", "rpc", "--allow-home", "-e", ext,
    ]);
  });

  test("passes no flag omp does not know", () => {
    const args = rpcSpawnArgs({ extensionPath: ext });
    expect(args).not.toContain("--approve");
    expect(args).not.toContain("--name");
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
    dir = mkdtempSync(join(tmpdir(), "omp-rpcchild-"));
    const bin = join(dir, "staysalive.sh");
    writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(bin, 0o755);

    const child = new RpcChild({ ompBin: bin, extensionPath: "/no/such.js", cwd: dir });
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
    dir = mkdtempSync(join(tmpdir(), "omp-rpcchild-"));
    const child = new RpcChild({ ompBin: join(dir, "no-such-omp"), extensionPath: "/no/such.js", cwd: dir });
    for (let attempt = 0; attempt < 2; attempt++) {
      const { promise, resolve } = deferredExit();
      child.once("exit", resolve);
      child.spawn();
      const evt = await promise;
      expect(evt.requested).toBe(false);
      expect(child.state).toBe("crashed");
    }
  });

  test.skipIf(process.platform === "win32")("writes set_event_filter on spawn", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-rpc-filter-"));
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

    const child = new RpcChild({ ompBin: stub, extensionPath: "/x.js", cwd: dir });
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

  test.skipIf(process.platform === "win32")("runs `omp --mode rpc -e <extension>` from the PATH when no binary is given", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-rpc-default-"));
    const argvLog = join(dir, "argv.log");
    const fakeBin = join(dir, "bin");
    mkdirSync(fakeBin);
    const omp = join(fakeBin, "omp");
    writeFileSync(omp, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nexec sleep 30\n`);
    chmodSync(omp, 0o755);

    const child = new RpcChild({
      extensionPath: "/x.js",
      cwd: dir,
      env: { PATH: `${fakeBin}${delimiter}${process.env["PATH"] ?? ""}` },
    });
    const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.spawn();
    await spawned;
    let argv: string[] = [];
    await vi.waitFor(() => {
      argv = readFileSync(argvLog, "utf8").split("\n").filter(Boolean);
      expect(argv.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
    await child.stop();
    expect(argv).toEqual(["--mode", "rpc", "--allow-home", "--continue", "-e", "/x.js"]);
  });

  // omp refuses a `prompt` frame while a run streams ("Agent is already processing. Use steer()
  // or followUp() to queue messages") unless it names a streamingBehavior — verified live on omp
  // 19.0.1. A cron fire or CLI send used to write the frame without one (plan 69 step 4, G16).
  test.skipIf(process.platform === "win32")("sendPrompt writes a streamingBehavior (default followUp) and a unique id per frame", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-rpc-prompt-"));
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

    const child = new RpcChild({ ompBin: stub, extensionPath: "/x.js", cwd: dir });
    const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.spawn();
    await spawned;
    expect(child.sendPrompt("/compact keep the schema work")).toBe(true);
    expect(child.sendPrompt("/model", { streamingBehavior: "steer" })).toBe(true);
    expect(child.sendPrompt("same millisecond")).toBe(true);
    expect(child.sendPrompt("explicit id", { requestId: "req-7" })).toBe(true);

    let frames: Array<Record<string, unknown>> = [];
    await vi.waitFor(() => {
      frames = readFileSync(stdinLog, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((f) => f["type"] === "prompt");
      expect(frames).toHaveLength(4);
    }, { timeout: 2000 });
    await child.stop();

    expect(frames.map((f) => [f["message"], f["streamingBehavior"]])).toEqual([
      ["/compact keep the schema work", "followUp"],
      ["/model", "steer"],
      ["same millisecond", "followUp"],
      ["explicit id", "followUp"],
    ]);
    expect(frames[3]!["id"]).toBe("req-7");
    const ids = frames.map((f) => f["id"] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The child names itself to the supervisor with this id: the extension of a daemon sends a
  // phone-typed slash command back through the control socket (`send`) to reach omp's own
  // command pipeline, which an extension cannot enter from inside omp.
  test.skipIf(process.platform === "win32")("the child gets the id the supervisor files it under, and no agent-CLI selector", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-rpc-id-"));
    const envLog = join(dir, "env.json");
    const stub = join(dir, "omp-stub.mjs");
    writeFileSync(
      stub,
      `#!/usr/bin/env node\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `const harness = Object.keys(process.env).filter((k) => k.endsWith("_HARNESS"));\n` +
      `writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({ id: process.env.REMOTE_OMP_DAEMON_ID, daemon: process.env.REMOTE_OMP_DAEMON, harness }));\n` +
      `setInterval(() => {}, 1e6);\n`,
    );
    chmodSync(stub, 0o755);

    // Both names are blanked in the parent's inheritance so the check holds on a machine that has
    // one of them exported: whatever shows up in the child was put there by RpcChild.
    const child = new RpcChild({
      ompBin: stub,
      extensionPath: "/x.js",
      cwd: dir,
      env: { REMOTE_PI_HARNESS: undefined, REMOTE_OMP_HARNESS: undefined },
    });
    const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.spawn();
    await spawned;
    let seen: { id?: string; daemon?: string; harness?: string[] } = {};
    await vi.waitFor(() => {
      seen = JSON.parse(readFileSync(envLog, "utf8")) as typeof seen;
    }, { timeout: 2000 });
    await child.stop();
    expect(seen).toEqual({ id: daemonIdForCwd(dir), daemon: "1", harness: [] });
  });

  test("oversized stdout line is dropped cleanly without corrupting later events", () => {
    dir = mkdtempSync(join(tmpdir(), "omp-rpc-oversize-"));
    const child = new RpcChild({ ompBin: "/usr/bin/true", extensionPath: "/x", cwd: dir });
    // Emit a >256 KiB line without newline followed by its newline and a valid message_start.
    child._ingestStdoutForTest("x".repeat(300 * 1024));
    expect(child.isBusy).toBe(false);
    child._ingestStdoutForTest('still-oversized\n{"type":"message_start"}\n');
    expect(child.isBusy).toBe(true);
    child._ingestStdoutForTest('{"type":"message_end"}\n');
    expect(child.isBusy).toBe(false);
  });

  test("stderr forwards complete lines each prefixed with cwd", () => {
    dir = mkdtempSync(join(tmpdir(), "omp-rpc-stderr-"));
    const child = new RpcChild({ ompBin: "/usr/bin/true", extensionPath: "/x", cwd: dir });
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
    dir = mkdtempSync(join(tmpdir(), "omp-rpc-epipe-"));
    const stub = join(dir, "quick-exit.sh");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);

    const child = new RpcChild({ ompBin: stub, extensionPath: "/x", cwd: dir });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.spawn();
    await exited;
    expect(child.sendPrompt("late")).toBe(false);
    await child.stop();
  });
});

describe("resolveOmpBin (plan/40 — Windows omp.cmd)", () => {
  test("POSIX → returns the bin name unchanged", () => {
    expect(resolveOmpBin("omp", "darwin")).toBe("omp");
    expect(resolveOmpBin("omp", "linux")).toBe("omp");
    expect(resolveOmpBin("/opt/homebrew/bin/omp", "darwin")).toBe("/opt/homebrew/bin/omp");
  });
  test("Windows → an explicit path or suffixed name is used as-is (no lookup)", () => {
    expect(resolveOmpBin("C:\\tools\\omp.cmd", "win32")).toBe("C:\\tools\\omp.cmd");
    expect(resolveOmpBin("omp.cmd", "win32")).toBe("omp.cmd");
    expect(resolveOmpBin("C:/tools/omp", "win32")).toBe("C:/tools/omp");
  });
});

describe("_npmShimTarget (plan/40 — parse the .cmd shim)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  test("recovers the cli.js the npm shim launches (relative to the shim dir)", () => {
    tmp = mkdtempSync(join(tmpdir(), "omp-shim-"));
    const rel = join("node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
    const target = join(tmp, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "// cli\n");
    const shim = join(tmp, "omp.cmd");
    writeFileSync(shim, `@ECHO off\r\n"%_prog%"  "%dp0%\\${rel}" %*\r\n`);
    expect(_npmShimTarget(shim)).toBe(target);
  });

  test("returns null when the shim doesn't match / target missing", () => {
    tmp = mkdtempSync(join(tmpdir(), "omp-shim-"));
    const shim = join(tmp, "weird.cmd");
    writeFileSync(shim, "@echo off\r\necho nope\r\n");
    expect(_npmShimTarget(shim)).toBeNull();
    const shim2 = join(tmp, "omp.cmd");
    writeFileSync(shim2, `"%_prog%" "%dp0%\\does-not-exist.js" %*\r\n`);
    expect(_npmShimTarget(shim2)).toBeNull();
  });
});

describe("resolveOmpSpawn (plan/40 — directly-spawnable target)", () => {
  test("POSIX → command is omp, no prefix args", () => {
    expect(resolveOmpSpawn("omp", "linux")).toEqual({ command: "omp", prefixArgs: [] });
    expect(resolveOmpSpawn("/usr/bin/omp", "darwin")).toEqual({ command: "/usr/bin/omp", prefixArgs: [] });
  });

  test("Windows .cmd shim → spawn node + parsed cli.js (no cmd.exe layer)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "omp-spawn-"));
    try {
      const rel = join("node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
      const target = join(tmp, rel);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "// cli\n");
      const shim = join(tmp, "omp.cmd");
      writeFileSync(shim, `"%_prog%" "%dp0%\\${rel}" %*\r\n`);
      const r = resolveOmpSpawn(shim, "win32", "C:\\node\\node.exe");
      expect(r.command).toBe("C:\\node\\node.exe");
      expect(r.prefixArgs).toEqual([target]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Windows explicit .exe → used as-is, no prefix args", () => {
    expect(resolveOmpSpawn("C:\\tools\\omp.exe", "win32")).toEqual({
      command: "C:\\tools\\omp.exe",
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
    dir = mkdtempSync(join(tmpdir(), "omp-busy-"));
    const child = new RpcChild({ ompBin: "/usr/bin/true", extensionPath: "/x", cwd: dir });
    expect(child.isBusy).toBe(false);
    child._ingestStdoutForTest('{"type":"message_start"}');
    expect(child.isBusy).toBe(true);
    child._ingestStdoutForTest('{"type":"message_end"}');
    expect(child.isBusy).toBe(false);
  });

  test.skipIf(process.platform === "win32")("refreshBusy syncs from get_state.isStreaming (authoritative)", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-busy-gs-"));
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

    const child = new RpcChild({ ompBin: stub, extensionPath: "/x", cwd: dir });
    const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.spawn();
    await spawned;
    const busy = await child.refreshBusy(1500);
    expect(busy).toBe(true);
    expect(child.isBusy).toBe(true);
    await child.stop();
  });

  test("refreshBusy returns the passive flag when the child isn't running", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-busy-off-"));
    const child = new RpcChild({ ompBin: "/usr/bin/true", extensionPath: "/x", cwd: dir });
    expect(await child.refreshBusy(200)).toBe(false);
  });
});

describe("RpcChild — unanswered extension dialogs (daemon has no UI)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (!dir) return;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    dir = undefined;
  });

  // The stub prints one omp-style `select` dialog request and logs everything
  // it receives on stdin, like omp's RPC loop would.
  test.skipIf(process.platform === "win32")("cancels another extension's dialog after the time box via the child's stdin", async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-uireq-"));
    const log = join(dir, "stdin.log");
    const stub = join(dir, "omp-stub.js");
    writeFileSync(
      stub,
      "#!/usr/bin/env node\n" +
        "const fs=require('fs');\n" +
        `process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(log)},d));\n` +
        "console.log(JSON.stringify({type:'extension_ui_request',id:'dlg-1',method:'select',title:'Run it?',options:['yes','no']}));\n" +
        "setInterval(()=>{},1e9);\n",
    );
    chmodSync(stub, 0o755);

    const child = new RpcChild({
      ompBin: stub,
      extensionPath: "/x",
      cwd: dir,
      env: { REMOTE_OMP_ASK_TIMEOUT_MS: "150" },
    });
    const spawned = new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    child.spawn();
    await spawned;

    const deadline = Date.now() + 5000;
    let frames: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      try {
        frames = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch { /* not written yet */ }
      if (frames.some((f) => f["type"] === "extension_ui_response")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await child.stop();

    expect(frames.filter((f) => f["type"] === "extension_ui_response")).toEqual([
      { type: "extension_ui_response", id: "dlg-1", cancelled: true, timedOut: true },
    ]);
  });
});

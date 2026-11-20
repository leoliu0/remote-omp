import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { DaemonState } from "./control_protocol.js";
import { defaultAgentName, loadLocalConfig, type LocalConfig } from "../session/local_config.js";
import type { Harness } from "./harness.js";

/**
 * Wrapper around a `<harness> --mode rpc -e <extension>` child process for the
 * supervisor.
 *
 * Lifecycle:
 *   - `spawn()` boots the child with the daemon's cwd + `REMOTE_PI_DAEMON=1`
 *     env so the extension runs in headless daemon mode.
 *   - `sendPrompt(text)` writes a Pi RPC `prompt` command to stdin.
 *   - The child's stdout (RPC events) updates the passive `_busy` hint on
 *     `message_start`/`message_end`, resolves pending `get_state` queries for
 *     `refreshBusy()`, and re-emits lines as `"stdout"` when listeners exist.
 *   - Every exit fires an `exit` event with `{code, signal, requested, uptimeMs}`;
 *     the supervisor respawns unless it requested the exit itself (plan 67).
 *
 * Each `RpcChild` instance maps 1:1 to a registry entry (single cwd).
 * The supervisor owns the map of these and addresses them by `id`.
 */

const MAX_STDOUT_LINE_BYTES = 256 * 1024;
const MAX_STDERR_BUF_BYTES = 64 * 1024;

export interface RpcChildOptions {
  /** Which CLI to run; decides the argv (see `rpcSpawnArgs`). Defaults to "pi". */
  harness?: Harness;
  /** Path to the harness binary. Defaults to the harness name (must be on PATH). */
  piBin?: string;
  /** Absolute path to the remote-pi `dist/index.js` to load as -e. */
  extensionPath: string;
  /** Working directory for the spawned process. Falls back here when no inline
   *  `config` (`REMOTE_PI_DIRECT_CONFIG`) is injected. */
  cwd: string;
  /** Additional env vars merged on top of `process.env` + the mandatory
   *  `REMOTE_PI_DAEMON=1`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Daemon config injected into the child via `REMOTE_PI_DIRECT_CONFIG`
   * (JSON inline) instead of a per-cwd `.pi/remote-pi/config.json` file. The
   * supervisor builds this from the registry. When set, the child reads it
   * env-first (see `loadLocalConfig`) and no config file is needed. Also the
   * source of the `--name` for `pi` sessions. Falls back to the on-disk config
   * when omitted.
   */
  config?: LocalConfig;
}

export interface RpcChildExitEvent {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** True when the exit was asked for through `stop()`. Anything else — a
   *  crash, or the harness quitting by itself — is not the supervisor's doing. */
  readonly requested: boolean;
  /** How long the process ran (monotonic ms); 0 when it never started. */
  readonly uptimeMs: number;
}

export const EXIT_DAEMON_FRESH_SESSION = 42;
export const EXIT_DAEMON_RESTART = 43;

/** Windows extensions `spawn` (without `shell`) can actually launch, in
 *  preference order: native `.exe` first, then the `.cmd`/`.bat` shims (run via
 *  cmd.exe). An extensionless `pi` is a Unix shell script Node CANNOT spawn on
 *  Windows — picking it yields `spawn … ENOENT` and the daemon shows "crashed". */
const WIN_EXECUTABLE_EXTS = [".exe", ".cmd", ".bat", ".com"];

/**
 * Resolve the `pi` executable for `spawn` (plan/40, decision C). On Windows a
 * bare `pi` is actually `pi.cmd`/`pi.ps1`, and `spawn` won't find it without an
 * extension → resolve the real path via `where` (rather than `shell:true`,
 * which risks shell injection). An explicit path or an already-suffixed name is
 * used as-is. POSIX returns the name unchanged. Best-effort: if `where` fails,
 * fall back to the bare name (spawn will surface ENOENT honestly).
 */
export function resolvePiBin(piBin: string, plat: NodeJS.Platform = process.platform): string {
  if (plat !== "win32") return piBin;
  if (piBin.includes("\\") || piBin.includes("/") || /\.[a-z0-9]+$/i.test(piBin)) return piBin;
  try {
    const out = execFileSync("where", [piBin], { encoding: "utf8" });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const runnable = lines.find((l) =>
      WIN_EXECUTABLE_EXTS.some((ext) => l.toLowerCase().endsWith(ext)),
    );
    const chosen = runnable ?? lines[0];
    if (chosen) return chosen;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== "ENOENT") {
      process.stderr.write(`[remote-pi-supervisord] where ${piBin} failed: ${String(err)}\n`);
    }
  }
  return piBin;
}

/** What to pass to `spawn`: the executable and any args to prepend before the
 *  caller's args. On POSIX (and for `.exe`) `prefixArgs` is empty. */
export interface PiSpawnTarget { command: string; prefixArgs: string[] }

/**
 * Resolve `pi` to a directly-spawnable target (plan/40). On Windows `pi` is an
 * npm `.cmd` shim, which modern Node refuses to `spawn` without `shell:true`
 * (EINVAL, post CVE-2024-27980). Instead we parse the shim to recover the
 * underlying `node <cli.js>` and spawn that directly.
 */
export function resolvePiSpawn(
  piBin: string,
  plat: NodeJS.Platform = process.platform,
  nodeExe: string = process.execPath,
): PiSpawnTarget {
  const resolved = resolvePiBin(piBin, plat);
  if (plat !== "win32") return { command: resolved, prefixArgs: [] };
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const target = _npmShimTarget(resolved);
    if (target) return { command: nodeExe, prefixArgs: [target] };
  }
  return { command: resolved, prefixArgs: [] };
}

/**
 * Extract the JS entry an npm `.cmd` shim launches. npm shims invoke
 * `"%_prog%"  "%dp0%\<relative>\entry.js" %*`; we recover `<dir>\<relative>\entry.js`
 * (dir = the shim's own folder, i.e. `%dp0%`). Returns null when the shim
 * doesn't match the expected shape or the target is missing.
 */
export function _npmShimTarget(cmdPath: string): string | null {
  let content: string;
  try {
    content = readFileSync(cmdPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `[remote-pi-supervisord] could not read Windows shim ${cmdPath}: ${String(err)}\n`,
    );
    return null;
  }
  const m = content.match(/"%dp0%\\([^"]+\.[cm]?js)"/i);
  if (!m) return null;
  const target = join(dirname(cmdPath), m[1]!);
  return existsSync(target) ? target : null;
}

/**
 * Maps an RPC stdout line to a busy-state transition: `message_start` → true
 * (a message is streaming), `message_end` → false. Other lines → null (no
 * change). Pure + exported for tests.
 */
export function busyTransition(line: string): boolean | null {
  let obj: unknown;
  try { obj = JSON.parse(line); } catch { return null; }
  const t = (obj as { type?: unknown } | null)?.type;
  if (t === "message_start") return true;
  if (t === "message_end") return false;
  return null;
}

/**
 * CLI args for the daemon's `--mode rpc` child. pi and omp share the RPC
 * protocol but not their flags.
 */
export function rpcSpawnArgs(o: {
  harness: Harness;
  extensionPath: string;
  sessionName?: string;
  useContinue?: boolean;
}): string[] {
  const resume = o.useContinue === false ? [] : ["--continue"];
  if (o.harness === "omp") {
    return ["--mode", "rpc", "--allow-home", ...resume, "-e", o.extensionPath];
  }
  return [
    "--mode", "rpc",
    "--approve",
    ...resume,
    ...(o.sessionName ? ["--name", o.sessionName] : []),
    "-e", o.extensionPath,
  ];
}

export class RpcChild extends EventEmitter {
  private child: ChildProcess | null = null;
  private _state: DaemonState = "stopped";
  private _startedAt: number | null = null;
  private _restartCount = 0;
  /** True while a deliberate `stop()` is in flight. Reported as `requested` on exit. */
  private _stopping = false;
  /** Next spawn should create a fresh session instead of --continue. */
  private forceFreshSessionOnNextSpawn = false;
  /** Accumulates partial stdout lines while waiting for `\n`. */
  private stdoutBuf = "";
  private droppingLongStdoutLine = false;
  /** Accumulates partial stderr lines for clean `[cwd]` prefixing. */
  private stderrBuf = "";
  /** Passive busy flag derived from the RPC stream (message_start/end). */
  private _busy = false;
  /** In-flight `get_state` requests, keyed by request id. */
  private readonly _statePending = new Map<string, { resolve: (b: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly opts: RpcChildOptions) {
    super();
  }

  get state(): DaemonState { return this._state; }
  get isActive(): boolean { return this._state === "running" || this._state === "starting"; }
  /** Passive busy hint from the stream. Prefer `refreshBusy()` for an
   *  authoritative check before acting on it (cron skip_if_busy). */
  get isBusy(): boolean { return this._busy; }
  get pid(): number | undefined { return this.child?.pid; }
  get restartCount(): number { return this._restartCount; }
  get uptimeMs(): number | undefined {
    return this._startedAt !== null ? Math.max(0, Math.round(performance.now() - this._startedAt)) : undefined;
  }

  /**
   * Spawn the child process. Idempotent for the same instance: a second
   * call while already running/starting is a no-op.
   */
  spawn(): void {
    if (this.child) return;
    this._stopping = false; // fresh start — a later exit is not ours
    this._busy = false;
    this.stdoutBuf = "";
    this.droppingLongStdoutLine = false;
    this.stderrBuf = "";
    this._state = "starting";

    const harness = this.opts.harness ?? "pi";
    const piTarget = resolvePiSpawn(this.opts.piBin ?? harness);
    const cfg = this.opts.config ?? loadLocalConfig(this.opts.cwd);
    const sessionName = cfg.agent_name ?? defaultAgentName(this.opts.cwd);
    const useContinue = !this.forceFreshSessionOnNextSpawn;
    this.forceFreshSessionOnNextSpawn = false;
    // On Windows `prefixArgs` carries pi's cli.js (we spawn node directly); on
    // POSIX it's empty and `command` is the resolved harness binary or `piBin`.
    const args = [
      ...piTarget.prefixArgs,
      ...rpcSpawnArgs({ harness, extensionPath: this.opts.extensionPath, sessionName, useContinue }),
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.opts.env,
      // Mandatory daemon marker — session_start / commands check this to run
      // headlessly and keep daemon lifetime under the supervisor.
      REMOTE_PI_DAEMON: "1",
      // A daemon that registers another daemon from its shell (`remote-pi
      // create`) defaults to its own harness.
      REMOTE_PI_HARNESS: harness,
      // Inject the daemon config inline so the child needs no config file.
      ...(this.opts.config ? { REMOTE_PI_DIRECT_CONFIG: JSON.stringify(this.opts.config) } : {}),
    };

    let child: ChildProcess;
    try {
      child = spawn(piTarget.command, args, {
        cwd: this.opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: process.platform === "win32",
      });
    } catch (err) {
      process.stderr.write(
        `[remote-pi-supervisord] spawn failed (harness=${harness}, cmd=${piTarget.command}, cwd=${this.opts.cwd}): ${String(err)}\n`,
      );
      this._startedAt = null;
      this._onExit(null, null);
      return;
    }

    this.child = child;
    this._startedAt = performance.now();

    child.stdin?.on("error", (err) => {
      process.stderr.write(
        `[remote-pi-supervisord] stdin error for ${this.opts.cwd} (pid=${child.pid ?? "none"}): ${String(err)}\n`,
      );
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this._onStdout(chunk));

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this._onStderr(chunk));

    child.once("spawn", () => {
      if (this.child !== child) return;
      this._state = "running";
      if (harness === "omp" && child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.write(
            JSON.stringify({ type: "set_event_filter", events: ["message_start", "message_end"] }) + "\n",
          );
        } catch (err) {
          process.stderr.write(
            `[remote-pi-supervisord] failed setting omp event filter for ${this.opts.cwd}: ${String(err)}\n`,
          );
        }
      }
      this.emit("spawn", { pid: child.pid });
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) this._onExit(code, signal);
    });

    child.on("error", (err) => {
      if (this.child !== child) {
        process.stderr.write(
          `[remote-pi-supervisord] late child error (harness=${harness}, cmd=${piTarget.command}, cwd=${this.opts.cwd}): ${String(err)}\n`,
        );
        return;
      }
      if (child.pid !== undefined) {
        process.stderr.write(
          `[remote-pi-supervisord] child error (pid=${child.pid}, harness=${harness}, cwd=${this.opts.cwd}): ${String(err)}\n`,
        );
        return;
      }
      process.stderr.write(
        `[remote-pi-supervisord] spawn failed (harness=${harness}, cmd=${piTarget.command}, cwd=${this.opts.cwd}): ${String(err)}\n`,
      );
      this._startedAt = null;
      this._onExit(null, null);
    });
  }

  /**
   * Sends a Pi RPC `prompt` command to the child's stdin. Fire-and-forget.
   * Returns false if the child isn't active or writing failed.
   */
  sendPrompt(text: string, requestId?: string): boolean {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed || !this.isActive) {
      return false;
    }
    const cmd = { id: requestId ?? `sv-${Date.now()}`, type: "prompt", message: text };
    try {
      this.child.stdin.write(JSON.stringify(cmd) + "\n");
      return true;
    } catch (err) {
      process.stderr.write(
        `[remote-pi-supervisord] sendPrompt write failed for ${this.opts.cwd}: ${String(err)}\n`,
      );
      return false;
    }
  }

  /**
   * Asks the child to exit gracefully. Sends SIGTERM; if the child doesn't
   * exit within `timeoutMs`, escalates to SIGKILL. Resolves when `exit` fires
   * or after a bounded post-SIGKILL safety deadline.
   */
  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.child) return;
    this._stopping = true; // deliberate — the upcoming signal-exit is NOT a crash
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      this._onExit(child.exitCode, child.signalCode);
      return;
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout>;
      let safetyTimer: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(safetyTimer);
        this.removeListener("exit", finish);
        resolve();
      };
      this.once("exit", finish);

      try {
        const sent = child.kill("SIGTERM");
        if (!sent && child.exitCode === null && child.signalCode === null) {
          process.stderr.write(
            `[remote-pi-supervisord] SIGTERM could not be delivered to ${this.opts.cwd} (pid=${child.pid ?? "?"})\n`,
          );
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          process.stderr.write(
            `[remote-pi-supervisord] SIGTERM failed for ${this.opts.cwd} (pid=${child.pid ?? "?"}): ${String(err)}\n`,
          );
        }
      }

      killTimer = setTimeout(() => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return;
        process.stderr.write(
          `[remote-pi-supervisord] ${this.opts.cwd} (pid=${child.pid ?? "?"}) did not exit after ${timeoutMs}ms; escalating to SIGKILL\n`,
        );
        try {
          child.kill("SIGKILL");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            process.stderr.write(
              `[remote-pi-supervisord] SIGKILL failed for ${this.opts.cwd} (pid=${child.pid ?? "?"}): ${String(err)}\n`,
            );
          }
        }
      }, timeoutMs);

      safetyTimer = setTimeout(() => {
        if (settled) return;
        process.stderr.write(
          `[remote-pi-supervisord] ${this.opts.cwd} (pid=${child.pid ?? "?"}) did not exit after SIGKILL; detaching handle\n`,
        );
        if (this.child === child) {
          this._onExit(child.exitCode, child.signalCode);
        }
        finish();
      }, timeoutMs + 2000);
    });
  }

  private _onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    if (this.stderrBuf.length > MAX_STDERR_BUF_BYTES) {
      const overflow = this.stderrBuf;
      this.stderrBuf = "";
      process.stderr.write(`[${this.opts.cwd}] ${overflow}\n`);
      return;
    }
    let start = 0;
    let nl: number;
    while ((nl = this.stderrBuf.indexOf("\n", start)) >= 0) {
      const line = this.stderrBuf.slice(start, nl);
      start = nl + 1;
      process.stderr.write(`[${this.opts.cwd}] ${line}\n`);
    }
    if (start > 0) this.stderrBuf = this.stderrBuf.slice(start);
  }

  private _flushStderr(): void {
    if (!this.stderrBuf) return;
    const rem = this.stderrBuf;
    this.stderrBuf = "";
    process.stderr.write(`[${this.opts.cwd}] ${rem}\n`);
  }

  private _onStdout(chunk: string): void {
    let data = chunk;
    if (this.droppingLongStdoutLine) {
      const nl = data.indexOf("\n");
      if (nl < 0) return;
      this.droppingLongStdoutLine = false;
      data = data.slice(nl + 1);
      if (!data) return;
    }

    this.stdoutBuf += data;
    let start = 0;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n", start)) >= 0) {
      const line = this.stdoutBuf.slice(start, nl);
      start = nl + 1;
      if (!line.trim()) continue;
      this._handleStdoutLine(line);
    }

    if (start > 0) {
      this.stdoutBuf = this.stdoutBuf.slice(start);
    }
    if (this.stdoutBuf.length > MAX_STDOUT_LINE_BYTES) {
      this.stdoutBuf = "";
      this.droppingLongStdoutLine = true;
    }
  }

  private _handleStdoutLine(line: string): void {
    const hasStdoutListeners = this.listenerCount("stdout") > 0;
    const maybeBusy = line.includes('"message_start"') || line.includes('"message_end"');
    const maybeState = this._statePending.size > 0 && line.includes('"get_state"');

    if (maybeBusy || maybeState) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        obj = undefined;
      }
      if (obj && typeof obj === "object") {
        const o = obj as {
          type?: unknown;
          command?: unknown;
          id?: unknown;
          data?: { isStreaming?: unknown };
        };
        if (o.type === "message_start") {
          this._busy = true;
        } else if (o.type === "message_end") {
          this._busy = false;
        } else if (
          this._statePending.size > 0 &&
          o.type === "response" &&
          o.command === "get_state" &&
          typeof o.id === "string"
        ) {
          const pending = this._statePending.get(o.id);
          if (pending) {
            clearTimeout(pending.timer);
            this._statePending.delete(o.id);
            if (typeof o.data?.isStreaming === "boolean") {
              this._busy = o.data.isStreaming;
            }
            pending.resolve(this._busy);
          }
        }
      }
    }

    if (hasStdoutListeners) {
      this.emit("stdout", line);
    }
  }

  /**
   * Authoritative busy check: queries the child's `get_state` and syncs
   * `_busy` to `isStreaming`. Resolves the passive flag on timeout (no
   * response) or when the child isn't active.
   */
  async refreshBusy(timeoutMs = 1500): Promise<boolean> {
    if (!this.isActive || !this.child?.stdin || this.child.stdin.destroyed) return this._busy;
    const id = `gs-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._statePending.delete(id);
        process.stderr.write(
          `[remote-pi-supervisord] get_state timed out after ${timeoutMs}ms for ${this.opts.cwd}\n`,
        );
        resolve(this._busy);
      }, timeoutMs);
      this._statePending.set(id, { resolve, timer });
      try {
        this.child!.stdin!.write(JSON.stringify({ id, type: "get_state" }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this._statePending.delete(id);
        process.stderr.write(
          `[remote-pi-supervisord] get_state write failed for ${this.opts.cwd}: ${String(err)}\n`,
        );
        resolve(this._busy);
      }
    });
  }

  /** Test-only: feed a raw stdout chunk or line through the parser. */
  _ingestStdoutForTest(line: string): void {
    if (line.includes("\n")) {
      this._onStdout(line);
      return;
    }
    this._handleStdoutLine(line);
  }

  /** Test-only: feed a raw stderr chunk through the line-buffered forwarder. */
  _ingestStderrForTest(chunk: string): void {
    this._onStderr(chunk);
  }

  private _onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const requested = this._stopping;
    this._flushStderr();
    this.stdoutBuf = "";
    this.droppingLongStdoutLine = false;
    // The session itself asked to end — the app's `/new` (private code) or its
    // "quit session" (`/exit`, a clean exit nobody here requested): the next
    // spawn omits --continue once to create a fresh session. Later restarts go
    // back to --continue.
    if (code === EXIT_DAEMON_FRESH_SESSION || (code === 0 && !requested)) {
      this.forceFreshSessionOnNextSpawn = true;
    }
    const uptimeMs = this._startedAt !== null ? Math.max(0, Math.round(performance.now() - this._startedAt)) : 0;
    this._state = requested || code === 0 ? "stopped" : "crashed";
    this.child = null;
    this._startedAt = null;
    this._busy = false;
    for (const p of this._statePending.values()) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this._statePending.clear();
    this.emit("exit", { code, signal, requested, uptimeMs } satisfies RpcChildExitEvent);
  }

  /** Bumps the restart counter — called by the supervisor when it
   *  decides to re-spawn after an exit. Exposed so tests can drive it. */
  noteRestart(): void {
    this._restartCount += 1;
  }
}

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * The environment a new terminal would have (plan 67).
 *
 * A service manager starts the supervisor with a bare environment: none of the
 * API keys, proxies or PATH entries the user's shell rc files export. Daemons
 * are meant to be the user's terminal agent minus the terminal, so the
 * supervisor asks the login shell for its environment once at start — the same
 * approach editors use to launch tools from a GUI. Nothing is stored: a restart
 * re-reads the rc files.
 */

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 4096;

/** Interactive-shell ephemera that must not leak into the supervisor or daemons. */
const EPHEMERAL_SHELL_VARS = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

/** Explicit service/caller overrides that take precedence over the login shell. */
const PRESERVED_BASE_VARS = [
  "REMOTE_PI_HOME",
  "REMOTE_PI_RELAY",
  "REMOTE_PI_ALLOW_FILE_IDENTITY",
  "REMOTE_PI_NOTIFY_URL",
  "REMOTE_PI_NOTIFY_TOKEN",
  "REMOTE_PI_NOTIFY_MODE",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

export type ShellEnvResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; reason: string; stderr?: string };

/**
 * Extracts a JSON `Record<string, string>` object printed between `startMarker`
 * and `endMarker`, ignoring whatever rc files wrote around it. Returns null
 * when either marker is missing, the payload is invalid/non-object, or empty.
 */
export function parseEnvJsonBlock(
  stdout: string,
  startMarker: string,
  endMarker: string = startMarker,
): Record<string, string> | null {
  const start = stdout.indexOf(startMarker);
  if (start < 0) return null;
  const end = stdout.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return null;
  const raw = stdout.slice(start + startMarker.length, end).trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k && typeof v === "string") env[k] = v;
  }
  return Object.keys(env).length > 0 ? env : null;
}

/**
 * Strips interactive-shell ephemera (`PWD`, `OLDPWD`, `SHLVL`, `_`) and preserves
 * explicit service-level overrides from `baseEnv`.
 */
export function filterLoginShellEnv(
  shellEnv: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(shellEnv)) {
    if (!EPHEMERAL_SHELL_VARS.has(k)) filtered[k] = v;
  }
  for (const k of PRESERVED_BASE_VARS) {
    const val = baseEnv[k];
    if (val !== undefined) filtered[k] = val;
  }
  return filtered;
}

function _killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* already exited */
  }
}

/**
 * Runs `<shell> -ilc '...'` (interactive + login, so both profile and rc files
 * apply) and asks the current Node binary to emit `JSON.stringify(process.env)`
 * between per-call nonce markers constructed with `printf`. Resolves immediately
 * once the end marker arrives so background helpers spawned by rc files cannot
 * stall startup. Never rejects.
 */
export function loginShellEnv(opts: {
  shell: string;
  timeoutMs?: number;
  nodePath?: string;
}): Promise<ShellEnvResult> {
  if (!opts.shell || !opts.shell.trim()) {
    return Promise.resolve({ ok: false, reason: "shell path is empty" });
  }
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const nonce = randomBytes(8).toString("hex");
    const startMarker = `__RP_ENV_S_${nonce}__`;
    const endMarker = `__RP_ENV_E_${nonce}__`;
    const nodeExe = opts.nodePath ?? process.execPath;
    // Construct markers via printf format args so the exact marker literal never
    // appears in the shell command string (avoids ZSH_EXECUTION_STRING collisions).
    const cmd =
      `printf '__RP_ENV_S_%s__' ${nonce} && ` +
      `${JSON.stringify(nodeExe)} -e 'process.stdout.write(JSON.stringify(process.env))' && ` +
      `printf '__RP_ENV_E_%s__' ${nonce}`;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        opts.shell,
        ["-ilc", cmd],
        // Own process group: an interactive shell without a terminal must not
        // fight the supervisor for one, and cleanup/timeout kills the whole group.
        { stdio: ["ignore", "pipe", "pipe"], detached: true },
      );
    } catch (err) {
      resolve({
        ok: false,
        reason: `spawn threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let out = "";
    let errBuf = "";
    let settled = false;
    const finish = (res: ShellEnvResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      _killGroup(child.pid, "SIGKILL");
      finish({
        ok: false,
        reason: `timed out after ${timeoutMs}ms`,
        ...(errBuf.trim() ? { stderr: errBuf.trim() } : {}),
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      if (out.length < MAX_STDOUT_BYTES) {
        out += chunk.slice(0, MAX_STDOUT_BYTES - out.length);
      }
      const startIdx = out.indexOf(startMarker);
      if (startIdx >= 0 && out.includes(endMarker, startIdx + startMarker.length)) {
        const parsed = parseEnvJsonBlock(out, startMarker, endMarker);
        if (parsed) {
          _killGroup(child.pid, "SIGTERM");
          finish({ ok: true, env: parsed });
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (errBuf.length < MAX_STDERR_BYTES) {
        errBuf += chunk.slice(0, MAX_STDERR_BYTES - errBuf.length);
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        reason: `spawn error: ${err.message}`,
        ...(errBuf.trim() ? { stderr: errBuf.trim() } : {}),
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      const stderr = errBuf.trim() || undefined;
      if (code === 0) {
        const env = parseEnvJsonBlock(out, startMarker, endMarker);
        if (env) {
          finish({ ok: true, env });
          return;
        }
        finish({ ok: false, reason: "env block missing or empty", ...(stderr ? { stderr } : {}) });
        return;
      }
      finish({
        ok: false,
        reason: `exited with code=${code} signal=${signal}`,
        ...(stderr ? { stderr } : {}),
      });
    });
  });
}

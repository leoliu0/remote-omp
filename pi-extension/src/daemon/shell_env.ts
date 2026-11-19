import { spawn } from "node:child_process";

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

const MARKER = "__REMOTE_PI_ENV__";

/** Extracts the `env -0` block printed between two markers, ignoring whatever
 *  the rc files wrote before or after it. Null when the block is incomplete. */
export function parseEnvBlock(stdout: string, marker: string): Record<string, string> | null {
  const start = stdout.indexOf(marker);
  if (start < 0) return null;
  const end = stdout.indexOf(marker, start + marker.length);
  if (end < 0) return null;
  const env: Record<string, string> = {};
  for (const entry of stdout.slice(start + marker.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * Runs `<shell> -ilc 'env -0'` (interactive + login, so both profile and rc
 * files apply) and returns the resulting environment. Resolves null — never
 * rejects — when the shell is missing, fails, prints no block, or exceeds the
 * timeout; the caller then keeps the environment it already has.
 */
export function loginShellEnv(opts: { shell: string; timeoutMs?: number }): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const child = spawn(
      opts.shell,
      ["-ilc", `printf %s ${MARKER}; command env -0; printf %s ${MARKER}`],
      // Own process group: an interactive shell without a terminal must not
      // fight the supervisor for one, and the timeout can kill the whole group.
      { stdio: ["ignore", "pipe", "ignore"], detached: true },
    );
    let out = "";
    let settled = false;
    const finish = (env: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(env);
    };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      finish(null);
    }, opts.timeoutMs ?? 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.on("error", () => finish(null));
    child.on("close", () => finish(parseEnvBlock(out, MARKER)));
  });
}

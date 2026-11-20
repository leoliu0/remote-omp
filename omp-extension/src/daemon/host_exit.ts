/**
 * A supervised daemon asking to end its own process (`/restart`, `/exit` and a
 * fresh session from the phone), through the host instead of under it.
 *
 * The exit CODE is the message to the supervisor (`rpc_child.ts`: 42 fresh
 * session, 43 restart, 0 the app's Quit). Calling `process.exit(code)` from an
 * event handler delivers it but skips everything the host owes a clean end:
 * `session_shutdown`, `session.dispose()` and the flush of queued session writes.
 * The host-owned way out is `ctx.shutdown()`.
 *
 * In `--mode rpc` that call only REQUESTS the shutdown: omp acts on it after the
 * next input frame it finishes (or at stdin EOF), and a daemon's stdin is the
 * supervisor's pipe, quiet between prompts. So this also announces the exit
 * over the one channel the supervisor reads, an `extension_ui_request`
 * `setStatus` frame on stdout, and `RpcChild` answers it with a harmless frame
 * that lets omp act. A client that does not (the Cockpit) still gets its exit: the
 * watchdog below ends the process after the grace period, as before.
 *
 * omp ends its shutdown with `process.exit(0)`, so the code is re-applied from
 * an `exit` listener (Bun, like Node, reads `process.exitCode` after the
 * listeners ran).
 */

/** `ctx.ui.setStatus` key of the announcement; the text is the exit code. */
export const HOST_EXIT_STATUS_KEY = "remote-omp:host-exit";

/** How long the host gets to shut down before the daemon exits by itself. */
export const HOST_EXIT_GRACE_MS = 5_000;

/** The parts of an omp `ExtensionContext` this needs. */
export interface HostExitContext {
  shutdown?: () => void;
  ui?: { setStatus?: (key: string, text: string | undefined) => void };
}

let requestedCode: number | null = null;
let exitListener: (() => void) | null = null;
let watchdog: NodeJS.Timeout | null = null;

/** The code of the exit already requested, if any. */
export function pendingHostExit(): number | null {
  return requestedCode;
}

/**
 * Ask the host to end the process with `code`. The first request wins: a second
 * `/restart` while the first is shutting down changes nothing.
 *
 * Without a host binding to shut down through (no `ctx.shutdown`, i.e. before
 * `session_start`) there is nothing to be graceful with: exit at once.
 */
export function requestHostExit(
  ctx: HostExitContext | null | undefined,
  code: number,
  exit: (code: number) => void = (c) => process.exit(c),
  graceMs: number = HOST_EXIT_GRACE_MS,
): void {
  if (requestedCode !== null) return;
  if (typeof ctx?.shutdown !== "function") {
    // Nothing to shut down through, and the process is gone after this: nothing to remember either.
    exit(code);
    return;
  }
  requestedCode = code;
  exitListener = () => { process.exitCode = code; };
  process.on("exit", exitListener);
  watchdog = setTimeout(() => exit(code), graceMs);
  watchdog.unref();
  try {
    ctx.shutdown();
  } catch (err) {
    process.stderr.write(`[remote-omp] host shutdown failed (${String(err)}); exiting directly\n`);
    exit(code);
    return;
  }
  try {
    ctx.ui?.setStatus?.(HOST_EXIT_STATUS_KEY, String(code));
  } catch {
    // The announcement only speeds the shutdown up; the watchdog covers it.
  }
}

/** Test-only: forget a request, drop its listener and watchdog. */
export function _resetHostExitForTest(): void {
  requestedCode = null;
  clearTimeout(watchdog ?? undefined);
  watchdog = null;
  if (exitListener) process.off("exit", exitListener);
  exitListener = null;
}

/**
 * The exit code announced by one stdout line, or null when the line is anything
 * else. A string pre-check keeps the per-line cost of the supervisor's stdout
 * reader at one `includes`.
 */
export function parseHostExitFrame(line: string): number | null {
  if (!line.includes(HOST_EXIT_STATUS_KEY)) return null;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object") return null;
  const { type, method, statusKey, statusText } = frame as Record<string, unknown>;
  if (type !== "extension_ui_request" || method !== "setStatus" || statusKey !== HOST_EXIT_STATUS_KEY) return null;
  const code = typeof statusText === "string" ? Number.parseInt(statusText, 10) : Number.NaN;
  return Number.isInteger(code) ? code : null;
}

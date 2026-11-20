/**
 * Time box for interactive prompts nobody can answer in a daemon.
 *
 * A supervised daemon (`REMOTE_OMP_DAEMON=1`) has no terminal. A question only
 * a phone can answer must not block the agent forever when no phone shows up:
 * the `ask` tool resolves with its "no interactive client" result after this
 * long, and the supervisor cancels any other extension's unanswered
 * `extension_ui_request` dialog after the same time.
 */

export const DEFAULT_DAEMON_UI_TIMEOUT_MS = 30 * 60 * 1000;

/** `REMOTE_OMP_ASK_TIMEOUT_MS` overrides the default; anything not a positive integer falls back. */
export function daemonUiTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["REMOTE_OMP_ASK_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAEMON_UI_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAEMON_UI_TIMEOUT_MS;
}

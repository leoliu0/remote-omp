import type { SessionHistoryEvent } from "./protocol/types.js";

/**
 * A `role:"user"` message the HARNESS wrote, not the person: an auto-continue or
 * plan prompt, a parent agent's steer, an extension's
 * `sendUserMessage(text, { attribution: "agent" })`. omp's own test for a user
 * turn is `!synthetic && attribution !== "agent"` (`AgentSession.#isUserTask`);
 * `parentIrc` marks the parent's steer, which omp draws as a card, never a bubble.
 *
 * The phone's chat shows what the person said, so these stay out of it.
 */
export function isInjectedUserMessage(message: object): boolean {
  const m = message as { synthetic?: unknown; attribution?: unknown; parentIrc?: unknown };
  return m.synthetic === true || m.attribution === "agent" || m.parentIrc !== undefined;
}

/** omp's records of a `!cmd` / `$code` the person ran in the terminal (`bashExecution`, `pythonExecution`). */
export interface UserShellMessage {
  role: "bashExecution" | "pythonExecution";
  command?: string;
  code?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  timestamp?: number;
}

/**
 * A terminal shell run as the tool row it is: the request, then its output.
 * The run is part of the conversation (the model sees it unless it was a `!!`),
 * but omp records it straight into the session with no message events, so it
 * can only appear when the history is rebuilt from the branch.
 */
export function userShellEvents(message: UserShellMessage, ts: number): SessionHistoryEvent[] {
  const bash = message.role === "bashExecution";
  const toolCallId = `user_${bash ? "bash" : "python"}_${ts}`;
  const output = typeof message.output === "string" ? message.output : "";
  const failed = message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0);
  const text = message.cancelled === true ? `${output}${output ? "\n" : ""}[cancelled]` : output;
  return [
    {
      ts,
      type: "tool_request",
      tool_call_id: toolCallId,
      tool: bash ? "bash" : "python",
      args: bash ? { command: message.command ?? "" } : { code: message.code ?? "" },
    },
    failed
      ? { ts, type: "tool_result", tool_call_id: toolCallId, error: text || `exit code ${message.exitCode}` }
      : { ts, type: "tool_result", tool_call_id: toolCallId, result: text },
  ];
}

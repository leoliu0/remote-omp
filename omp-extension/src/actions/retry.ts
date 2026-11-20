/**
 * Plan/68 — Retry the failed turn from the app (`retry_turn`).
 *
 * omp's `/retry` ("Retry the last failed agent turn") is `AgentSession.retry()`:
 * it drops the errored assistant message from the active context and schedules
 * a continuation, so the SAME prompt runs again — no second user message.
 *
 * Extensions get no command hook for it, and `_tryExecuteTerminalInput` cannot
 * type `/retry` in a headless `--mode rpc` daemon. omp does hand every
 * extension its SDK as `ExtensionAPI.pi`, and that SDK's `AgentRegistry` holds
 * the live main session in every mode (TUI, `--mode rpc`, print): its handle
 * exposes `retry()` itself. Proven live on omp 19.0.1 in `--mode rpc` with a
 * failing provider: `retry()` resolved true, the continuation sent the same
 * single user message again and the turn completed (the failed assistant
 * message was dropped from the context).
 *
 * Under upstream pi `ExtensionAPI.pi` does not exist, so the action answers
 * `unsupported` there — nothing re-sends the prompt on the app's behalf.
 *
 * One retry at a time: the claim is taken synchronously, and kept after a
 * successful `retry()` until the continuation actually starts (`agent_start`)
 * — omp resolves `retry()` before the run begins, and a second tap in that gap
 * would schedule another continuation.
 */

import type { ClientMessage } from "../protocol/types.js";
import type { ActionReplySender } from "./handlers.js";

type RetryTurnMessage = Extract<ClientMessage, { type: "retry_turn" }>;

/** Error `code`s of a refused `retry_turn` (the wire code is an open string). */
export type RetryErrorCode = "busy" | "nothing_to_retry" | "unsupported" | "internal_error";

/** How long a successful retry keeps refusing further ones while waiting for `agent_start`. */
export const RETRY_START_GRACE_MS = 5_000;

export const RETRY_MESSAGES = {
  working: "The agent is still working. Wait for it to finish or stop it first.",
  starting: "A retry is already starting.",
  nothing: "There is no failed turn to retry.",
  unsupported: "Retry needs omp. This session isn't running omp, or its omp is too old to retry.",
} as const;

/** The slice of omp's `AgentSession` (via its registry handle) that this action calls. */
export interface OmpRetrySession {
  /** True once a continuation is scheduled; false while busy or when no failed turn is left. */
  retry(): Promise<boolean>;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  /** omp's own auto-retry is waiting to re-attempt the turn. */
  readonly isRetrying?: boolean;
}

/** The slice of omp's SDK (`ExtensionAPI.pi`) used to reach the live main session. */
interface OmpSdkSlice {
  AgentRegistry?: {
    global?(): { get?(id: string): { session?: OmpRetrySession | null } | undefined } | undefined;
  };
  MAIN_AGENT_ID?: unknown;
}

/**
 * omp's live main session, read from the `ExtensionAPI` the extension was
 * given; null under upstream pi, on an omp without the registry, or when the
 * API went stale after a session replacement.
 */
export function ompMainSession(api: unknown): OmpRetrySession | null {
  try {
    const sdk = (api as { pi?: OmpSdkSlice } | null | undefined)?.pi;
    const registry = sdk?.AgentRegistry?.global?.();
    const mainId = sdk?.MAIN_AGENT_ID;
    if (!registry || typeof mainId !== "string") return null;
    const session = registry.get?.(mainId)?.session;
    return session && typeof session.retry === "function" ? session : null;
  } catch {
    return null;
  }
}

export interface RetryTurnDeps {
  /** omp's live main session, or null when this host cannot retry. */
  session(): OmpRetrySession | null;
  /** The extension context's `isIdle()`: false while a turn streams. */
  isIdle(): boolean;
}

export class RetryTurn {
  /** A request holds the claim: it is running, or it succeeded and its turn has not started. */
  private _claimed = false;
  private _graceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RetryTurnDeps) {}

  /**
   * Answers one `retry_turn`. Resolves true when a continuation was scheduled
   * (`action_ok` sent), false when the request was refused (an `error` with a
   * `code` was sent instead). Never rejects.
   */
  async handle(sender: ActionReplySender, msg: RetryTurnMessage): Promise<boolean> {
    const refuse = (code: RetryErrorCode, message: string): false => {
      sender.send({ type: "error", in_reply_to: msg.id, code, message });
      return false;
    };
    if (this._claimed) return refuse("busy", RETRY_MESSAGES.starting);
    this._claimed = true;
    let scheduled = false;
    try {
      if (!this.deps.isIdle()) return refuse("busy", RETRY_MESSAGES.working);
      const session = this.deps.session();
      if (!session) return refuse("unsupported", RETRY_MESSAGES.unsupported);
      if (session.isStreaming || session.isCompacting || session.isRetrying) {
        return refuse("busy", RETRY_MESSAGES.working);
      }
      if (!(await session.retry())) return refuse("nothing_to_retry", RETRY_MESSAGES.nothing);
      scheduled = true;
      sender.send({ type: "action_ok", in_reply_to: msg.id, action: "retry_turn" });
      return true;
    } catch (err) {
      return refuse("internal_error", `Retry failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (scheduled) this._holdUntilStart();
      else this._claimed = false;
    }
  }

  /** The continuation started (`agent_start`): later requests are judged by the live idle state. */
  onAgentStart(): void {
    this._release();
  }

  /** Session end: drop the claim and its timer. */
  dispose(): void {
    this._release();
  }

  private _holdUntilStart(): void {
    this._clearTimer();
    this._graceTimer = setTimeout(() => this._release(), RETRY_START_GRACE_MS);
    this._graceTimer.unref?.();
  }

  private _release(): void {
    this._clearTimer();
    this._claimed = false;
  }

  private _clearTimer(): void {
    clearTimeout(this._graceTimer ?? undefined);
    this._graceTimer = null;
  }
}

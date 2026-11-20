/**
 * Time box for dialogs other extensions open inside a daemon.
 *
 * In `--mode rpc` omp turns every `ctx.ui.select/confirm/input/editor` call
 * into an `extension_ui_request` frame on stdout and waits for an
 * `extension_ui_response` on stdin. The supervisor owns that pipe and nothing
 * else answers, so an unattended daemon would block on the dialog for ever.
 * This answers each one with a cancellation once the time box ends, exactly
 * like the `ask` tool resolves as unanswered (`ask_tool.ts`).
 *
 * Frame shapes: omp `modes/rpc/rpc-types.ts` (`RpcExtensionUIRequest`,
 * `RpcExtensionUIResponse`).
 */

/** Request methods that wait for a response. The rest (`notify`, `setStatus`, …) are fire-and-forget. */
const BLOCKING_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };

export interface UiCancelFrame {
  type: "extension_ui_response";
  id: string;
  cancelled: true;
  timedOut: true;
}

export class UiRequestTimeBox {
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly _respond: (frame: UiCancelFrame) => void,
    private readonly _timeoutMs: () => number,
  ) {}

  /** Number of dialogs currently waiting. */
  get pending(): number {
    return this._timers.size;
  }

  /** Feed one stdout line; non-UI lines are ignored without parsing. */
  ingest(line: string): void {
    if (!line.includes('"extension_ui_request"')) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const { type, method, id, targetId } = frame as Record<string, unknown>;
    if (type !== "extension_ui_request" || typeof method !== "string") return;

    // The extension (or omp's own per-dialog timeout) withdrew the dialog.
    if (method === "cancel") {
      if (typeof targetId === "string") this._clear(targetId);
      return;
    }
    if (BLOCKING_METHODS[method] !== true || typeof id !== "string" || this._timers.has(id)) return;

    const timer = setTimeout(() => {
      this._timers.delete(id);
      this._respond({ type: "extension_ui_response", id, cancelled: true, timedOut: true });
    }, this._timeoutMs());
    timer.unref?.();
    this._timers.set(id, timer);
  }

  /** Drop every pending timer (child exited: its dialogs died with it). */
  dispose(): void {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
  }

  private _clear(id: string): void {
    clearTimeout(this._timers.get(id));
    this._timers.delete(id);
  }
}

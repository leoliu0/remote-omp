import type { ExtensionAPI } from "../omp-api.js";
import { Type } from "typebox";
import type {
  AskAnswerWire,
  AskOptionWire,
  AskQuestionWire,
  ExtensionUiRequestWire,
  ExtensionUiResponseWire,
  ServerMessage,
} from "../protocol/types.js";

const OptionItemSchema = Type.Object({
  label: Type.String({ description: "display label" }),
  description: Type.Optional(Type.String({ description: "optional explanatory text displayed below the label" })),
  preview: Type.Optional(Type.String({ description: "optional rich preview content for interactive ask dialogs" })),
});

const QuestionItemSchema = Type.Object({
  id: Type.String({ description: "question id" }),
  question: Type.String({ description: "question text" }),
  header: Type.Optional(Type.String({ description: "optional short display chip for rich ask dialogs" })),
  options: Type.Array(OptionItemSchema, { description: "available options" }),
  multi: Type.Optional(Type.Boolean({ description: "allow multiple selections" })),
  recommended: Type.Optional(Type.Number({ description: "recommended option index" })),
});

export const AskParamsSchema = Type.Object({
  questions: Type.Array(QuestionItemSchema, { description: "questions to ask" }),
});

export interface AskParams {
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    options: Array<{
      label: string;
      description?: string;
      preview?: string;
    }>;
    multi?: boolean;
    recommended?: number;
  }>;
}

type AskResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
type InvokeNativeTool = (params: { html: string }, options: { signal?: AbortSignal }) => Promise<AskResult>;

interface PendingAsk {
  flowId: string;
  resolve: (res: AskResult) => void;
  reject: (err: Error) => void;
  questions: AskParams["questions"];
}

const activeAsks = new Map<string, PendingAsk>();
let _broadcastFn: ((msg: ServerMessage) => void) | null = null;

function broadcastDismiss(flowId: string): void {
  if (!_broadcastFn) return;
  _broadcastFn({
    type: "extension_ui_request",
    id: flowId,
    method: "notify",
    message: "Clarification resolved.",
  });
}

export function getPendingAskRequests(): ServerMessage[] {
  const reqs: ServerMessage[] = [];
  for (const ask of activeAsks.values()) {
    reqs.push(createAskRequestWire(ask.flowId, ask.questions));
  }
  return reqs;
}

export function handleAskResponse(msg: ExtensionUiResponseWire): boolean {
  const ask = activeAsks.get(msg.id);
  if (!ask) return false;

  activeAsks.delete(msg.id);

  if ("cancelled" in msg && msg.cancelled === true) {
    ask.resolve({
      content: [{ type: "text", text: "User cancelled the selection" }],
      details: { cancelled: true },
    });
    broadcastDismiss(msg.id);
    return true;
  }

  const askData = msg.ask;
  if (askData && askData.kind === "cancel") {
    ask.resolve({
      content: [{ type: "text", text: "User cancelled the selection" }],
      details: { cancelled: true },
    });
    broadcastDismiss(msg.id);
    return true;
  }

  if (askData && askData.kind === "answer") {
    const lines: string[] = [];
    for (const q of ask.questions) {
      const ans = askData.answers[q.id];
      if (!ans) continue;
      // omp's native `ask` keeps both for a multi-choice answer (`[...values, typed]`);
      // for single choice the typed "Other" text replaces the pick (`typed || values[0]`).
      const values = ans.values ?? [];
      const custom = ans.customText;
      if (values.length > 0 && !(custom && !q.multi)) {
        lines.push(`User selected: ${values.join(", ")}`);
      }
      if (custom) {
        lines.push(`User provided custom input: ${custom}`);
      }
      if (ans.note) {
        lines.push(`User added note: ${ans.note}`);
      }
    }
    const text = lines.length > 0 ? lines.join("\n") : "User answered via mobile app.";
    ask.resolve({
      content: [{ type: "text", text }],
      details: { answers: askData.answers },
    });
    broadcastDismiss(msg.id);
    return true;
  }

  if ("value" in msg && typeof msg.value === "string") {
    ask.resolve({
      content: [{ type: "text", text: `User selected: ${msg.value}` }],
      details: { selected: msg.value },
    });
    broadcastDismiss(msg.id);
    return true;
  }

  ask.resolve({
    content: [{ type: "text", text: "User confirmed" }],
    details: {},
  });
  broadcastDismiss(msg.id);
  return true;
}

function createAskRequestWire(flowId: string, questions: AskParams["questions"]): ExtensionUiRequestWire {
  const wireQuestions: AskQuestionWire[] = questions.map((q) => {
    const options: AskOptionWire[] = q.options.map((o) => ({
      value: o.label,
      label: o.label,
      description: o.description,
      preview: o.preview,
    }));
    return {
      id: q.id,
      label: q.header || q.question,
      prompt: q.question,
      type: q.multi ? "multi" : "single",
      required: true,
      options,
    };
  });

  const first = wireQuestions[0];
  const title = first?.prompt ?? "Question";
  const optionLabels = first?.options.map((o) => o.label) ?? [];

  return {
    type: "extension_ui_request",
    id: flowId,
    method: "select",
    title,
    options: optionLabels,
    ask: {
      flow_id: flowId,
      tool_call_id: flowId,
      source: "tool",
      title,
      questions: wireQuestions,
    },
  };
}

/**
 * Broadcasts the question to mobile peers (even zero: the broadcast also raises
 * the push notification and the entry is replayed to a phone that attaches
 * later); settles on their response, `signal` abort, or — when `timeoutMs` is
 * given — as an unanswered ask after that long.
 */
function askRemotely(
  flowId: string,
  questions: AskParams["questions"],
  broadcast: (msg: ServerMessage) => void,
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): Promise<AskResult> {
  // Executor form: `Promise.withResolvers` needs Node 22 / lib es2024; this package targets Node 20.
  return new Promise<AskResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopTimer = () => clearTimeout(timer);
    activeAsks.set(flowId, {
      flowId,
      questions,
      resolve: (res) => { stopTimer(); resolve(res); },
      reject: (err) => { stopTimer(); reject(err); },
    });
    broadcast(createAskRequestWire(flowId, questions));
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (activeAsks.delete(flowId)) {
          broadcastDismiss(flowId);
          resolve(noClientResult(questions, { timedOut: true }));
        }
      }, timeoutMs);
      timer.unref?.();
    }
    signal?.addEventListener(
      "abort",
      () => {
        if (activeAsks.delete(flowId)) {
          stopTimer();
          broadcastDismiss(flowId);
          reject(new Error("Ask tool aborted"));
        }
      },
      { once: true },
    );
  });
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** omp ≥18.20 native `ask` takes one HTML form (`{ html }`); translate the `questions[]` wire shape into it. */
export function toNativeParams(params: AskParams): { html: string } {
  const blocks = params.questions.map((q) => {
    const type = q.multi ? "checkbox" : "radio";
    const legend = q.header ? `${q.header}: ${q.question}` : q.question;
    const previews = q.options
      .filter((o) => o.preview)
      .map((o) => `  <p>${escapeHtml(o.label)}:</p>\n  <pre>${escapeHtml(o.preview!)}</pre>`);
    const labels = q.options.map((o, i) => {
      const text = o.description ? `${o.label}: ${o.description}` : o.label;
      const checked = q.recommended === i ? " checked" : "";
      return `    <label><input type="${type}" name="${escapeHtml(q.id)}" value="${escapeHtml(o.label)}"${checked}> ${escapeHtml(text)}</label>`;
    });
    return [...previews, `  <fieldset>\n    <legend>${escapeHtml(legend)}</legend>\n${labels.join("\n")}\n  </fieldset>`].join("\n");
  });
  return { html: `<form>\n${blocks.join("\n")}\n</form>` };
}

/** Host facts the wrapper cannot derive: whether this process is a supervised daemon, and its time box. */
export interface AskHost {
  /** True in a supervised daemon: no terminal answers the native dialog, so the phone path is always used. */
  isDaemon?: () => boolean;
  /** How long a daemon ask waits for an answer before it resolves as unanswered. */
  timeoutMs?: () => number;
}

function noClientResult(questions: AskParams["questions"], details: Record<string, unknown>): AskResult {
  const questionsSummary = questions.map((q) => q.question).join("; ");
  return {
    content: [{
      type: "text",
      text: `[No interactive client attached to answer: "${questionsSummary}". Using default / proceeding without user selection.]`,
    }],
    details: { unprompted: true, ...details },
  };
}

export function registerAskWrapperTool(
  pi: ExtensionAPI,
  broadcast: (msg: ServerMessage) => void,
  hasActivePeers: () => boolean,
  host: AskHost = {},
): void {
  _broadcastFn = broadcast;

  pi.registerTool<typeof AskParamsSchema, Record<string, unknown>>({
    name: "ask",
    label: "Ask",
    description: "Ask the user clarifying questions during execution.",
    parameters: AskParamsSchema,
    execute: async (toolCallId, params, signal, _onUpdate, context) => {
      const invokeTool: unknown = context && "invokeTool" in context ? context.invokeTool : undefined;
      // `ctx.invokeTool` runs the native built-in `ask` this tool shadows; read defensively, headless/test contexts don't provide it.
      const invokeNative = typeof invokeTool === "function" ? (invokeTool as InvokeNativeTool) : undefined;

      // Daemon: nobody can answer the native dialog (its `extension_ui_request`
      // frames go to the supervisor), so the phone is the only channel even
      // when none is attached right now. Broadcast (push notification), register
      // for replay to a phone that attaches later, and give up after the time
      // box instead of blocking the agent forever.
      if (host.isDaemon?.()) {
        const flowId = `ask_${toolCallId || Date.now().toString(36)}`;
        return askRemotely(flowId, params.questions, broadcast, signal, host.timeoutMs?.());
      }

      // Mobile peer active: offer the question on the phone, and keep the native
      // terminal dialog up too — a paired phone is not proof the user is looking
      // at it. First answer wins; the other side is dismissed.
      if (hasActivePeers()) {
        const flowId = `ask_${toolCallId || Date.now().toString(36)}`;
        const remote = askRemotely(flowId, params.questions, broadcast, signal);
        if (!invokeNative) return remote;

        const localAbort = new AbortController();
        const localSignal = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
        const local = invokeNative(toNativeParams(params), { signal: localSignal });
        // The losing side settles after the race (aborted local dialog throws,
        // dismissed mobile ask never resolves); nothing awaits it.
        local.catch(() => {});
        try {
          return await Promise.race([local, remote]);
        } finally {
          localAbort.abort();
          if (activeAsks.delete(flowId)) broadcastDismiss(flowId);
        }
      }

      // No mobile peer: native ask tool when available.
      if (invokeNative) return invokeNative(toNativeParams(params), { signal });
      // Fallback if headless / no peer
      return noClientResult(params.questions, {});
    },
  });
}

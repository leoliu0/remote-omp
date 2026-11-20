// omp plan mode on the paired clients (app + web), through omp 19's native
// extension API. Nothing here presses keys or types lines.
//
// omp finishes planning when the agent writes the plan's slug to
// `xd://propose`, aborts that turn and opens its "Plan Review" overlay. It
// tells extensions about the overlay — `plan_review_requested{reviewId,
// planContent, options}` when it opens, `plan_review_resolved{reviewId,
// choice, by}` when it closes — and takes answers through
// `ctx.resolvePlanReview(reviewId, choice, {feedback?})`.
// `ctx.getPendingPlanReview()` replays an open review to a client that
// connects later, `ctx.openPlanReview()` re-opens the newest plan, and plan
// mode itself is `ctx.sessionModes` (`set` to enter/exit, `mode_changed` to
// follow; see omp_modes.ts).
//
// Interactive (TUI) only: a headless `--mode rpc` session has no plan mode,
// no review and no `ctx.sessionModes`.
//
// The wire keeps the action names the apps already speak. Each maps to one
// omp choice id (`PlanReviewChoice`, omp extensions/types.ts):
//
//   approve_execute → execute   fresh session, runs the plan
//   approve_compact → compact   compacts this conversation, then runs it
//   approve_keep    → keep      runs it in the current context (omp disables
//                               it above 95 % context fill)
//   refine          → refine    + the feedback text, which omp submits as the
//                               next planning prompt (blank feedback refused)
//   save_quit       → save      writes the plan to the project folder; omp
//                               leaves the review open ("Save and quit" no
//                               longer exists in omp)
//
// omp has no dismissal for an extension: a client's "Keep planning" only
// closes that client's sheet. The overlay stays up on the PC until someone
// answers it there or a client answers/refines it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

import {
  modeChangedState,
  modeSetError,
  parseModeState,
  type OmpModeState,
  type OmpSessionModes,
} from "./omp_modes.js";
import type {
  ExtensionUiResponseWire,
  PlanReviewAction,
  PlanReviewOptionWire,
  PlanStatus,
  ServerMessage,
} from "./protocol/types.js";

export const PLAN_REVIEW_ID_PREFIX = "plan-review:";

/** omp's plan mode (`/plan`, the plan review, `ctx.sessionModes`) exists only
 *  in its interactive TUI: RPC mode, which remote-omp daemons run, has no
 *  `/plan` command and never opens a plan review. */
export const PLAN_MODE_NEEDS_TERMINAL =
  "omp's plan mode needs its interactive terminal (TUI). This agent runs headless (daemon / RPC mode), so /plan and the plan review are not available here.";

/** omp's stable plan review choice ids. */
export type OmpPlanReviewChoice = "execute" | "compact" | "keep" | "refine" | "save";

const ACTION_OF: Record<OmpPlanReviewChoice, PlanReviewAction> = {
  execute: "approve_execute",
  compact: "approve_compact",
  keep: "approve_keep",
  refine: "refine",
  save: "save_quit",
};

const CHOICE_OF: Record<PlanReviewAction, OmpPlanReviewChoice> = {
  approve_execute: "execute",
  approve_compact: "compact",
  approve_keep: "keep",
  refine: "refine",
  save_quit: "save",
};

/** Texts the clients show on a plan review's sheet (same-id `notify`). */
const TEXT = {
  approved: "Plan approved.",
  refining: "Refining the plan.",
  closedPlanning: "Plan review closed — still planning.",
  closed: "Plan review closed.",
  replaced: "A newer plan replaced this one.",
  gone: "This plan review is no longer open.",
  outOfDate: "This plan review is out of date.",
  dismissed:
    "Review closed here. It is still open on the PC: tap Review plan to reopen it here, or send a message to keep planning.",
  saved: "Plan saved to the project folder. The review is still open: pick an option to continue.",
  refineNeedsText: "Refine needs your feedback: write what should change in the field above.",
  notAccepted: "omp did not accept that choice. Try again, or answer on the PC.",
  unknownChoice: "Unknown plan review choice.",
} as const;

/** What this module reads of omp's `PlanReviewRequestedEvent`. */
const ReviewEvent = z.object({
  reviewId: z.string().min(1),
  title: z.string(),
  planFilePath: z.string(),
  planContent: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), disabled: z.boolean().optional() })),
});

/** What this module reads of omp's `PlanReviewResolvedEvent`. */
const ResolvedEvent = z.object({
  reviewId: z.string().min(1),
  choice: z.string().optional(),
});

interface ReviewData {
  reviewId: string;
  title: string;
  planFilePath: string;
  planContent: string;
  /** In omp's order, on the wire's action names. */
  options: PlanReviewOptionWire[];
}

function parseReview(raw: unknown): ReviewData | null {
  const parsed = ReviewEvent.safeParse(raw);
  if (!parsed.success) return null;
  const { reviewId, title, planFilePath, planContent } = parsed.data;
  const options: PlanReviewOptionWire[] = [];
  for (const o of parsed.data.options) {
    if (!Object.hasOwn(ACTION_OF, o.id)) continue; // a choice newer than this module
    const action = ACTION_OF[o.id as OmpPlanReviewChoice];
    options.push(o.disabled === true ? { action, label: o.label, disabled: true } : { action, label: o.label });
  }
  return { reviewId, title, planFilePath, planContent, options };
}

export interface PlanReviewHost {
  broadcast(msg: ServerMessage): void;
  /** `ctx.resolvePlanReview(reviewId, choice, input)`; false = omp refused. */
  resolve(reviewId: string, choice: OmpPlanReviewChoice, input?: { feedback: string }): boolean;
  /** `ctx.getPendingPlanReview()`: the open review as omp reported it. */
  pending(): unknown;
  /** `ctx.openPlanReview()`: true once a review is awaiting an answer. */
  open(): Promise<boolean>;
  /** `ctx.sessionModes`; undefined when the host has none (headless). */
  modes(): OmpSessionModes | undefined;
  /** `ctx.isIdle()`. */
  isIdle(): boolean;
  /** The newest local plan file with content (what omp's `/plan-review` opens). */
  latestPlanFile(): string | null;
  /** Show a prompt that omp submits itself (Refine's feedback) on every
   *  client, and make it the open turn. `id` is the phone's own message id. */
  echoPrompt(text: string, id?: string): void;
}

interface Review extends ReviewData {
  /** Wire id: `plan-review:<omp reviewId>`. */
  id: string;
  /** The request frame has gone to the clients. */
  announced: boolean;
  /** A client closed its sheet (Keep planning): omp's overlay is still up. */
  dismissed: boolean;
}

interface PlanRef {
  planFilePath: string;
  title: string;
}

type Pick = { kind: "pick"; action: PlanReviewAction; feedback: string };
type Choice = Pick | { kind: "cancel" };

export interface PlanReviewController {
  /** omp's `plan_review_requested`: the overlay opened. */
  onReviewRequested(event: unknown): void;
  /** omp's `plan_review_resolved`: the overlay closed (any way). */
  onReviewResolved(event: unknown): void;
  /** omp's `mode_changed`: plan mode entered, paused or left. */
  onModeChanged(event: unknown): void;
  /** Reconcile with omp (agent start/end, session start/switch/compact): the
   *  open review as omp holds it, and the plan mode state. */
  sync(): void;
  /** Routes a client answer; false when `msg` is not a plan review answer. */
  respond(msg: ExtensionUiResponseWire): boolean;
  /** Client `plan_mode` action; resolves to an error message or null. */
  planMode(action: "enter" | "exit" | "review"): Promise<string | null>;
  /** A message typed on a client while the review is open is the planning
   *  follow-up: answers the review with Refine. False when no review is open
   *  (or omp refused); the caller then handles the message itself. */
  refine(feedback: string, promptId?: string): boolean;
  /** Frames a (re)syncing client needs: state, then the open review. */
  syncFrames(): ServerMessage[];
  /** omp's plan review overlay is up (it has the terminal's focus, so a line
   *  typed into omp's editor now would land on it). */
  reviewOpen(): boolean;
  /** Forget everything (tests). */
  reset(): void;
}

const IDLE_STATE_KEY = JSON.stringify({ type: "plan_state", status: "idle" });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PlanAnswer = z.object({
  action: z.enum(["approve_execute", "approve_compact", "approve_keep", "refine", "save_quit"]),
  feedback: z.string().optional(),
});

/** A client's answer → the choice (rich `plan`, cancel, or a bare select
 *  label from a client that only knows the plain select). */
function choiceOf(msg: ExtensionUiResponseWire, options: readonly PlanReviewOptionWire[]): Choice | null {
  if ("cancelled" in msg && msg.cancelled === true) return { kind: "cancel" };
  if ("plan" in msg) {
    const parsed = PlanAnswer.safeParse(msg.plan);
    if (!parsed.success) return null;
    return { kind: "pick", action: parsed.data.action, feedback: parsed.data.feedback?.trim() ?? "" };
  }
  if ("value" in msg && typeof msg.value === "string") {
    // The keep label carries a context size that moves between renders.
    const keepPrefix = options.find((o) => o.action === "approve_keep")?.label.replace(/\s*\(.*\)$/, "");
    const match =
      options.find((o) => o.label === msg.value) ??
      (keepPrefix ? options.find((o) => o.action === "approve_keep" && msg.value.startsWith(keepPrefix)) : undefined);
    return match ? { kind: "pick", action: match.action, feedback: "" } : null;
  }
  return null;
}

export function createPlanReview(host: PlanReviewHost): PlanReviewController {
  let review: Review | null = null;
  /** The last reviewed plan, kept after its review closes (while still
   *  planning) so a client can offer "Review plan". */
  let lastPlan: PlanRef | null = null;
  /** The last mode state omp reported, for a `getState()` that throws. */
  let lastModes: OmpModeState | null = null;
  /** Last broadcast `plan_state`. Clients get the state with every
   *  session_sync, so an unchanged idle state is never broadcast. */
  let published: string | null = IDLE_STATE_KEY;

  function notify(id: string, message: string, warning = false): void {
    host.broadcast({
      type: "extension_ui_request",
      id,
      method: "notify",
      message,
      ...(warning ? { notify_type: "warning" as const } : {}),
    });
  }

  function requestFrame(r: Review): ServerMessage {
    return {
      type: "extension_ui_request",
      id: r.id,
      method: "select",
      title: `Plan ready for review: ${r.title}`,
      options: r.options.map((o) => o.label),
      plan: {
        plan_file_path: r.planFilePath,
        title: r.title,
        content: r.planContent,
        options: r.options,
      },
    };
  }

  function modes(): OmpModeState | null {
    const session = host.modes();
    if (!session) return null;
    try {
      const parsed = parseModeState(session.getState());
      if (parsed) lastModes = parsed;
    } catch {
      /* keep the last state omp reported */
    }
    return lastModes;
  }

  function planStatus(): "inactive" | "active" | "paused" {
    return modes()?.plan?.status ?? "inactive";
  }

  function stateFrame(): ServerMessage {
    const mode = planStatus();
    const status: PlanStatus = review
      ? "review"
      : mode === "active"
        ? "active"
        : mode === "paused"
          ? "paused"
          : "idle";
    // While planning, name the plan omp would review: the last proposal, else
    // the newest local plan file.
    let plan: PlanRef | null = review;
    if (!plan && status === "active") {
      const latest = lastPlan ? null : host.latestPlanFile();
      plan = lastPlan ?? (latest ? { planFilePath: latest, title: planTitle(latest) } : null);
    }
    return plan
      ? { type: "plan_state", status, plan_file_path: plan.planFilePath, title: plan.title }
      : { type: "plan_state", status };
  }

  function publish(): void {
    const frame = stateFrame();
    const key = JSON.stringify(frame);
    if (key === published) return;
    published = key;
    host.broadcast(frame);
  }

  function announce(r: Review): void {
    r.announced = true;
    host.broadcast(requestFrame(r));
  }

  function setReview(data: ReviewData, announceIt: boolean): void {
    if (review && review.reviewId !== data.reviewId) notify(review.id, TEXT.replaced);
    const same = review?.reviewId === data.reviewId ? review : null;
    review = {
      ...data,
      id: `${PLAN_REVIEW_ID_PREFIX}${data.reviewId}`,
      announced: same?.announced ?? false,
      dismissed: same?.dismissed ?? false,
    };
    lastPlan = { planFilePath: data.planFilePath, title: data.title };
    if (announceIt) announce(review);
    publish();
  }

  function closeReview(message: string): void {
    if (!review) return;
    const id = review.id;
    review = null;
    notify(id, message);
    if (planStatus() !== "active") lastPlan = null;
    publish();
  }

  /** The state omp holds is the truth: adopt a review it reports that we never
   *  heard of (extension loaded late, event missed), drop one it no longer
   *  has, keep the options current (the PC's tier slider re-measures them).
   *  A host that cannot be asked (`pending` throws) leaves the state alone. */
  function sync(): void {
    let native: ReviewData | null;
    try {
      native = parseReview(host.pending());
    } catch {
      publish();
      return;
    }
    if (native && review?.reviewId === native.reviewId) {
      review = { ...review, options: native.options, planContent: native.planContent };
    } else if (native) {
      setReview(native, false);
      return;
    } else if (review) {
      closeReview(planStatus() === "active" ? TEXT.closed : TEXT.approved);
      return;
    }
    if (!review && planStatus() !== "active") lastPlan = null;
    publish();
  }

  /** Plan mode left while a review is up: omp closed it with the mode. */
  function reconcileMode(): void {
    if (review && planStatus() !== "active") closeReview(TEXT.closed);
    else if (!review && planStatus() !== "active") lastPlan = null;
    publish();
  }

  function resolvedText(choice: string | undefined): string {
    if (choice === "refine") return TEXT.refining;
    if (choice === "execute" || choice === "compact" || choice === "keep") return TEXT.approved;
    return planStatus() === "active" ? TEXT.closedPlanning : TEXT.closed;
  }

  function answer(current: Review, pick: Pick): void {
    const choice = CHOICE_OF[pick.action];
    const option = current.options.find((o) => o.action === pick.action);
    if (!option) {
      notify(current.id, "omp's plan review does not offer that choice.", true);
      return;
    }
    if (option.disabled) {
      notify(
        current.id,
        choice === "keep"
          ? `"${option.label}" is disabled: the context is too full.`
          : `"${option.label}" is disabled by omp.`,
        true,
      );
      return;
    }
    if (choice === "refine" && !pick.feedback) {
      notify(current.id, TEXT.refineNeedsText, true);
      return;
    }
    let accepted: boolean;
    try {
      accepted = host.resolve(current.reviewId, choice, choice === "refine" ? { feedback: pick.feedback } : undefined);
    } catch (err) {
      notify(current.id, `Could not reach omp's plan review: ${errorMessage(err)}`, true);
      return;
    }
    if (!accepted) {
      // Refused: omp closed or replaced the review meanwhile, or rejected the choice.
      sync();
      if (review?.reviewId === current.reviewId) notify(current.id, TEXT.notAccepted, true);
      else notify(current.id, review ? TEXT.outOfDate : TEXT.gone);
      return;
    }
    // `save` writes the plan and leaves omp's review open; the sheet stays too.
    if (choice === "save") {
      notify(current.id, TEXT.saved, true);
      return;
    }
    if (choice === "refine") host.echoPrompt(pick.feedback);
    if (review?.reviewId === current.reviewId) closeReview(choice === "refine" ? TEXT.refining : TEXT.approved);
  }

  const controller: PlanReviewController = {
    onReviewRequested(event) {
      const data = parseReview(event);
      if (data) setReview(data, true);
    },

    onReviewResolved(event) {
      const parsed = ResolvedEvent.safeParse(event);
      if (!parsed.success) return;
      if (review?.reviewId === parsed.data.reviewId) closeReview(resolvedText(parsed.data.choice));
      else publish();
    },

    onModeChanged(event) {
      const state = modeChangedState(event);
      if (state) lastModes = state;
      reconcileMode();
    },

    sync,

    respond(msg) {
      if (!msg.id.startsWith(PLAN_REVIEW_ID_PREFIX)) return false;
      const reviewId = msg.id.slice(PLAN_REVIEW_ID_PREFIX.length);
      sync(); // omp's truth first: the answer may race a pick on the PC
      const current = review?.reviewId === reviewId ? review : null;
      if (!current) {
        notify(msg.id, review ? TEXT.outOfDate : TEXT.gone);
        return true;
      }
      const choice = choiceOf(msg, current.options);
      if (!choice) {
        notify(msg.id, TEXT.unknownChoice, true);
      } else if (choice.kind === "cancel") {
        current.dismissed = true;
        notify(current.id, TEXT.dismissed);
      } else {
        answer(current, choice);
      }
      return true;
    },

    async planMode(action) {
      const session = host.modes();
      if (!session) return PLAN_MODE_NEEDS_TERMINAL;
      sync();
      if (action === "review") {
        if (review) {
          review.dismissed = false;
          announce(review);
          return null;
        }
        let opened: boolean;
        try {
          opened = await host.open();
        } catch (err) {
          return `Could not open the plan review: ${errorMessage(err)}`;
        }
        sync(); // adopts the review omp just opened when its event has not arrived
        const adopted = review as Review | null; // `sync` reassigns it; TS keeps the earlier narrowing
        if (adopted && !adopted.announced) announce(adopted);
        if (adopted) return null;
        if (opened) return TEXT.gone;
        if (planStatus() !== "active") return "Plan mode is not active.";
        if (!host.isIdle()) return "The agent is working: open the review once it is idle.";
        return "No plan to review yet.";
      }
      let result: unknown;
      try {
        result = await session.set({ mode: "plan", action });
      } catch (err) {
        return `Could not ${action} plan mode: ${errorMessage(err)}`;
      }
      reconcileMode();
      return modeSetError(result);
    },

    refine(feedback, promptId) {
      sync();
      const current = review;
      const text = feedback.trim();
      if (!current || !text) return false;
      let accepted: boolean;
      try {
        accepted = host.resolve(current.reviewId, "refine", { feedback: text });
      } catch {
        return false;
      }
      if (!accepted) {
        sync();
        return false;
      }
      host.echoPrompt(feedback, promptId);
      if (review?.reviewId === current.reviewId) closeReview(TEXT.refining);
      return true;
    },

    syncFrames() {
      sync();
      const frames: ServerMessage[] = [stateFrame()];
      if (review && !review.dismissed) frames.push(requestFrame(review));
      return frames;
    },

    reviewOpen() {
      sync();
      return review !== null;
    },

    reset() {
      review = null;
      lastPlan = null;
      lastModes = null;
      published = IDLE_STATE_KEY;
    },
  };
  return controller;
}

function planTitle(planFilePath: string): string {
  const name = planFilePath.replace(/^local:\/\//, "").split(/[\\/]/).pop() ?? planFilePath;
  return name.replace(/-?plan\.md$/i, "") || name;
}

// ── omp session state readers (host side) ───────────────────────────────────

/** The slice of omp's SessionManager this module reads. */
interface SessionManagerLike {
  getArtifactsDir?: () => string | null | undefined;
  getSessionId?: () => string | null | undefined;
}

/** omp's `local://` root for the session (omp: `<artifacts dir>/local`, else
 *  `<tmp>/omp-local/<session id>`). */
export function ompLocalRoot(sessionManager: unknown): string | null {
  const sm = sessionManager as SessionManagerLike | null | undefined;
  try {
    const artifacts = sm?.getArtifactsDir?.();
    if (artifacts) return resolve(artifacts, "local");
    const id = (sm?.getSessionId?.() ?? "session").replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join(tmpdir(), "omp-local", id && id !== "." && id !== ".." ? id : "session");
  } catch {
    return null;
  }
}

/** Absolute path of an omp plan path (`local://x.md`, absolute, or cwd-relative). */
export function resolvePlanPath(planFilePath: string, sessionManager: unknown, cwd: string): string | null {
  if (planFilePath.startsWith("local://")) {
    const root = ompLocalRoot(sessionManager);
    if (!root) return null;
    const full = resolve(root, planFilePath.slice("local://".length));
    return full === root || full.startsWith(root + sep) ? full : null;
  }
  return isAbsolute(planFilePath) ? planFilePath : resolve(cwd, planFilePath);
}

export function readPlanFile(planFilePath: string, sessionManager: unknown, cwd: string): string | null {
  const full = resolvePlanPath(planFilePath, sessionManager, cwd);
  if (!full) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

/** Local `*plan.md` files, newest first (omp's `/plan-review` order). */
export function localPlanFiles(sessionManager: unknown): string[] {
  const root = ompLocalRoot(sessionManager);
  if (!root || !existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile() && /plan\.md$/i.test(d.name))
      .map((d) => ({ name: d.name, mtime: statSync(join(root, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => `local://${f.name}`);
  } catch {
    return [];
  }
}

/** The newest local plan with content: what omp's `/plan-review` would open. */
export function latestPlanFile(sessionManager: unknown, cwd: string): string | null {
  return (
    localPlanFiles(sessionManager).find(
      (path) => (readPlanFile(path, sessionManager, cwd)?.trim().length ?? 0) > 0,
    ) ?? null
  );
}

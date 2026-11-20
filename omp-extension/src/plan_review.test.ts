import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createPlanReview,
  latestPlanFile,
  localPlanFiles,
  PLAN_MODE_NEEDS_TERMINAL,
  readPlanFile,
  type OmpPlanReviewChoice,
  type PlanReviewController,
} from "./plan_review.js";
import type { PlanReviewAction, ServerMessage } from "./protocol/types.js";

// What omp 19's interactive mode reports (`plan_review_requested`, see
// handlePlanApproval's `choicesAt`): stable choice ids, labels, `disabled`.
const REVIEW_ID = "0b6e2d52-0c8e-4f43-9b5e-0a3f9d4b7a11";
const WIRE_ID = `plan-review:${REVIEW_ID}`;
const PLAN_MARKDOWN =
  "# Plan: create hello.txt\n\n- Create `/tmp/pm-e2e/proj/hello.txt` with the `write` tool.\n- Content: `hello plan`.\n- Verify with `cat`.\n";

interface OmpReview {
  type: "plan_review_requested";
  reviewId: string;
  sessionId: string;
  title: string;
  planFilePath: string;
  planContent: string;
  options: Array<{ id: OmpPlanReviewChoice; label: string; disabled: boolean }>;
}

function omp19Review(over: { reviewId?: string; keepDisabled?: boolean; keepLabel?: string } = {}): OmpReview {
  return {
    type: "plan_review_requested",
    reviewId: over.reviewId ?? REVIEW_ID,
    sessionId: "session-1",
    title: "hello-txt",
    planFilePath: "local://hello-txt-plan.md",
    planContent: PLAN_MARKDOWN,
    options: [
      { id: "execute", label: "Approve and execute", disabled: false },
      { id: "compact", label: "Approve and compact context", disabled: false },
      { id: "keep", label: over.keepLabel ?? "Approve and keep context (~19k / 1m)", disabled: over.keepDisabled === true },
      { id: "refine", label: "Refine plan", disabled: false },
      { id: "save", label: "Save", disabled: false },
    ],
  };
}

type PlanStatusOmp = "inactive" | "active" | "paused";

interface FakeOmpState {
  plan: PlanStatusOmp;
  pending: OmpReview | undefined;
  idle: boolean;
  planFile: boolean;
  setRefusal: { code: string; message: string } | null;
}

interface FakeOmpCalls {
  resolve: Array<{ reviewId: string; choice: OmpPlanReviewChoice; input?: { feedback: string } }>;
  set: unknown[];
  open: number;
  saved: number;
  echoed: Array<{ text: string; id?: string }>;
}

interface FakeOmp {
  c: PlanReviewController;
  /** Every frame the controller broadcast to the clients. */
  sent: ServerMessage[];
  state: FakeOmpState;
  calls: FakeOmpCalls;
  /** omp opens the overlay: `plan_review_requested` goes to the extension. */
  openOverlay(review?: OmpReview): void;
  notifies(id?: string): ServerMessage[];
  requests(): ServerMessage[];
  states(): ServerMessage[];
}

/** omp's side of the contract, as `interactive-mode.ts` implements it:
 *  `resolvePlanReview` answers false for a closed/other review, a disabled or
 *  unknown choice and a blank refine; `save` leaves the review open; every
 *  other pick settles it. `sessionModes.set` refuses with omp's own result. */
function fakeOmp(opts: { headless?: boolean; plan?: PlanStatusOmp; planFile?: boolean; unreachable?: boolean } = {}): FakeOmp {
  const sent: ServerMessage[] = [];
  const state: FakeOmpState = {
    plan: opts.plan ?? "active",
    pending: undefined,
    idle: true,
    planFile: opts.planFile ?? true,
    setRefusal: null,
  };
  const calls: FakeOmpCalls = { resolve: [], set: [], open: 0, saved: 0, echoed: [] };
  const c = createPlanReview({
    broadcast: (msg) => sent.push(msg),
    resolve: (reviewId, choice, input) => {
      calls.resolve.push({ reviewId, choice, ...(input ? { input } : {}) });
      const pending = state.pending;
      if (!pending || pending.reviewId !== reviewId) return false;
      const option = pending.options.find((o) => o.id === choice);
      if (!option || option.disabled) return false;
      if (choice === "refine" && !input?.feedback.trim()) return false;
      if (choice === "save") {
        calls.saved += 1;
        return true;
      }
      state.pending = undefined;
      return true;
    },
    pending: () => {
      if (opts.unreachable) throw new Error("no live omp context");
      return state.pending ? structuredClone(state.pending) : undefined;
    },
    open: async () => {
      calls.open += 1;
      if (state.pending) return true;
      if (state.plan !== "active" || !state.idle || !state.planFile) return false;
      state.pending = omp19Review();
      c.onReviewRequested(structuredClone(state.pending));
      return true;
    },
    modes: () =>
      opts.headless
        ? undefined
        : {
            getState: () => ({
              plan: { status: state.plan, ...(state.plan === "active" ? { planFilePath: "local://PLAN.md" } : {}) },
              vibe: { status: "inactive" },
              goal: { status: "inactive" },
              loop: { status: "inactive" },
            }),
            set: async (request) => {
              calls.set.push(request);
              if (state.setRefusal) return { ok: false, ...state.setRefusal, state: {} };
              const next: PlanStatusOmp = request.action === "enter" ? "active" : "inactive";
              if (request.action === "exit") state.pending = undefined; // omp hides the review with the mode
              const changed = next !== state.plan;
              state.plan = next;
              return { ok: true, changed, state: {} };
            },
          },
    isIdle: () => state.idle,
    latestPlanFile: () => (state.planFile ? "local://hello-txt-plan.md" : null),
    echoPrompt: (text, id) => calls.echoed.push({ text, ...(id ? { id } : {}) }),
  });
  const openOverlay = (review: OmpReview = omp19Review()): void => {
    state.pending = review;
    c.onReviewRequested(structuredClone(review));
  };
  const notifies = (id = WIRE_ID) =>
    sent.filter((m) => m.type === "extension_ui_request" && m.method === "notify" && m.id === id);
  const requests = () => sent.filter((m) => m.type === "extension_ui_request" && m.method === "select");
  const states = () => sent.filter((m) => m.type === "plan_state");
  return { c, sent, state, calls, openOverlay, notifies, requests, states };
}

function answer(omp: FakeOmp, action: PlanReviewAction, feedback?: string, id = WIRE_ID): boolean {
  return omp.c.respond({
    type: "extension_ui_response",
    id,
    plan: feedback === undefined ? { action } : { action, feedback },
  });
}

describe("plan_review_requested", () => {
  test("opens one review: omp's plan markdown and its five choices on the wire's action names", () => {
    const omp = fakeOmp();
    omp.openOverlay();

    expect(omp.sent).toEqual([
      {
        type: "extension_ui_request",
        id: WIRE_ID,
        method: "select",
        title: "Plan ready for review: hello-txt",
        options: [
          "Approve and execute",
          "Approve and compact context",
          "Approve and keep context (~19k / 1m)",
          "Refine plan",
          "Save",
        ],
        plan: {
          plan_file_path: "local://hello-txt-plan.md",
          title: "hello-txt",
          content: PLAN_MARKDOWN,
          options: [
            { action: "approve_execute", label: "Approve and execute" },
            { action: "approve_compact", label: "Approve and compact context" },
            { action: "approve_keep", label: "Approve and keep context (~19k / 1m)" },
            { action: "refine", label: "Refine plan" },
            { action: "save_quit", label: "Save" },
          ],
        },
      },
      { type: "plan_state", status: "review", plan_file_path: "local://hello-txt-plan.md", title: "hello-txt" },
    ]);
  });

  test("keep context disabled by omp reaches the wire as disabled and cannot be answered", () => {
    const omp = fakeOmp();
    omp.openOverlay(omp19Review({ keepDisabled: true }));
    const req = omp.requests()[0] as Extract<ServerMessage, { type: "extension_ui_request"; method: "select" }>;
    expect(req.plan?.options[2]).toEqual({
      action: "approve_keep",
      label: "Approve and keep context (~19k / 1m)",
      disabled: true,
    });

    answer(omp, "approve_keep");
    expect(omp.calls.resolve).toEqual([]);
    expect(omp.notifies().at(-1)).toMatchObject({
      message: expect.stringContaining("the context is too full"),
      notify_type: "warning",
    });
    expect(omp.c.reviewOpen()).toBe(true);
  });

  test("a malformed event or a choice omp adds later is not fatal", () => {
    const omp = fakeOmp();
    omp.c.onReviewRequested({ type: "plan_review_requested" });
    omp.c.onReviewRequested(null);
    expect(omp.sent).toEqual([]);

    const review = omp19Review();
    (review.options as Array<{ id: string; label: string; disabled: boolean }>).push({
      id: "schedule",
      label: "Approve and schedule",
      disabled: false,
    });
    omp.openOverlay(review);
    const req = omp.requests()[0] as Extract<ServerMessage, { type: "extension_ui_request"; method: "select" }>;
    expect(req.plan?.options.map((o) => o.action)).toEqual([
      "approve_execute",
      "approve_compact",
      "approve_keep",
      "refine",
      "save_quit",
    ]);
  });

  test("a newer review replaces the open one and closes its sheet", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    const next = omp19Review({ reviewId: "second-review" });
    omp.openOverlay(next);

    expect(omp.notifies()).toEqual([
      { type: "extension_ui_request", id: WIRE_ID, method: "notify", message: "A newer plan replaced this one." },
    ]);
    expect(omp.requests().map((m) => m.id)).toEqual([WIRE_ID, "plan-review:second-review"]);

    // omp reports the replaced review's close after the new request: it must
    // not close the new sheet.
    omp.c.onReviewResolved({ type: "plan_review_resolved", reviewId: REVIEW_ID, choice: undefined, by: "local" });
    expect(omp.notifies("plan-review:second-review")).toEqual([]);
    expect(omp.c.reviewOpen()).toBe(true);
  });
});

describe("a client answers: each wire action resolves the review with omp's own choice", () => {
  test.each<[PlanReviewAction, OmpPlanReviewChoice]>([
    ["approve_execute", "execute"],
    ["approve_compact", "compact"],
    ["approve_keep", "keep"],
  ])("%s → ctx.resolvePlanReview(id, %s) and the sheet closes", (action, choice) => {
    const omp = fakeOmp();
    omp.openOverlay();
    expect(answer(omp, action)).toBe(true);

    expect(omp.calls.resolve).toEqual([{ reviewId: REVIEW_ID, choice }]);
    expect(omp.notifies()).toEqual([
      { type: "extension_ui_request", id: WIRE_ID, method: "notify", message: "Plan approved." },
    ]);
    expect(omp.c.reviewOpen()).toBe(false);
    expect(omp.states().at(-1)).toEqual({
      type: "plan_state",
      status: "active",
      plan_file_path: "local://hello-txt-plan.md",
      title: "hello-txt",
    });
  });

  test("refine sends the trimmed feedback as omp's next planning prompt and shows it on the clients", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    answer(omp, "refine", "  add a fourth bullet: print it with cat  ");

    expect(omp.calls.resolve).toEqual([
      { reviewId: REVIEW_ID, choice: "refine", input: { feedback: "add a fourth bullet: print it with cat" } },
    ]);
    expect(omp.calls.echoed).toEqual([{ text: "add a fourth bullet: print it with cat" }]);
    expect(omp.notifies().at(-1)).toMatchObject({ message: "Refining the plan." });
    expect(omp.c.reviewOpen()).toBe(false);
  });

  test("refine without feedback is refused by omp: the sheet stays open and says what is missing", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    answer(omp, "refine");
    answer(omp, "refine", "   ");

    expect(omp.calls.resolve).toEqual([]);
    expect(omp.calls.echoed).toEqual([]);
    expect(omp.notifies()).toHaveLength(2);
    expect(omp.notifies().at(-1)).toMatchObject({
      message: expect.stringContaining("Refine needs your feedback"),
      notify_type: "warning",
    });
    expect(omp.c.reviewOpen()).toBe(true);
  });

  test("save_quit → save: omp writes the plan, its review and the sheet stay open", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    answer(omp, "save_quit");

    expect(omp.calls.resolve).toEqual([{ reviewId: REVIEW_ID, choice: "save" }]);
    expect(omp.calls.saved).toBe(1);
    expect(omp.notifies()).toEqual([
      expect.objectContaining({ notify_type: "warning", message: expect.stringContaining("still open") }),
    ]);
    expect(omp.c.reviewOpen()).toBe(true);

    // The review still takes an answer afterwards.
    answer(omp, "approve_execute");
    expect(omp.calls.resolve.at(-1)).toEqual({ reviewId: REVIEW_ID, choice: "execute" });
    expect(omp.c.reviewOpen()).toBe(false);
  });

  test("a client that only knows the plain select answers by label, whatever context size the label shows", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.c.respond({ type: "extension_ui_response", id: WIRE_ID, value: "Approve and keep context (~20k / 1m)" });
    expect(omp.calls.resolve).toEqual([{ reviewId: REVIEW_ID, choice: "keep" }]);

    const second = fakeOmp();
    second.openOverlay();
    second.c.respond({ type: "extension_ui_response", id: WIRE_ID, value: "Approve and compact context" });
    expect(second.calls.resolve).toEqual([{ reviewId: REVIEW_ID, choice: "compact" }]);

    const third = fakeOmp();
    third.openOverlay();
    third.c.respond({ type: "extension_ui_response", id: WIRE_ID, value: "Something else" });
    expect(third.calls.resolve).toEqual([]);
    expect(third.notifies().at(-1)).toMatchObject({ message: "Unknown plan review choice.", notify_type: "warning" });
  });

  test("omp refuses the choice: the sheet keeps its options and says so", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    // omp's own state moved (the tier slider re-measured keep) without us hearing of it.
    omp.state.pending = omp19Review({ keepDisabled: true });
    answer(omp, "approve_keep");

    expect(omp.calls.resolve).toEqual([]); // refreshed options already say disabled
    expect(omp.notifies().at(-1)).toMatchObject({ notify_type: "warning" });
  });

  test("an answer for a review omp has already settled closes the sheet", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.state.pending = undefined; // the PC picked an option; the resolved event is still in flight
    answer(omp, "approve_execute");

    expect(omp.calls.resolve).toEqual([]);
    expect(omp.notifies().at(-1)).toMatchObject({ id: WIRE_ID });
    expect(omp.notifies().at(-1)).not.toHaveProperty("notify_type");
    expect(omp.c.reviewOpen()).toBe(false);
  });

  test("an answer to an unknown id closes that sheet; one to a replaced review says it is out of date", () => {
    const omp = fakeOmp();
    expect(answer(omp, "approve_execute", undefined, "plan-review:toolu_old")).toBe(true);
    expect(omp.notifies("plan-review:toolu_old")).toEqual([
      expect.objectContaining({ message: "This plan review is no longer open." }),
    ]);

    omp.openOverlay();
    answer(omp, "approve_execute", undefined, "plan-review:toolu_old");
    expect(omp.notifies("plan-review:toolu_old").at(-1)).toMatchObject({ message: "This plan review is out of date." });
    expect(omp.calls.resolve).toEqual([]);
  });

  test("a response that is not for a plan review is not ours", () => {
    const omp = fakeOmp();
    expect(omp.c.respond({ type: "extension_ui_response", id: "ask-1", value: "x" })).toBe(false);
  });

  test("omp throwing on resolve is reported on the sheet", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    const c = createPlanReview({
      broadcast: (m) => omp.sent.push(m),
      resolve: () => {
        throw new Error("stale context");
      },
      pending: () => structuredClone(omp.state.pending),
      open: async () => false,
      modes: () => undefined,
      isIdle: () => true,
      latestPlanFile: () => null,
      echoPrompt: () => undefined,
    });
    c.onReviewRequested(omp19Review());
    c.respond({ type: "extension_ui_response", id: WIRE_ID, plan: { action: "approve_execute" } });
    expect(omp.notifies().at(-1)).toMatchObject({
      message: expect.stringContaining("stale context"),
      notify_type: "warning",
    });
  });
});

describe("Keep planning (cancelled)", () => {
  test("omp has no dismissal for an extension: the sheet closes here, the review stays open", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.c.respond({ type: "extension_ui_response", id: WIRE_ID, cancelled: true });

    expect(omp.calls.resolve).toEqual([]);
    expect(omp.notifies()).toEqual([
      expect.objectContaining({ message: expect.stringContaining("still open on the PC") }),
    ]);
    expect(omp.notifies().at(-1)).not.toHaveProperty("notify_type"); // an info notify closes the sheet
    expect(omp.c.reviewOpen()).toBe(true);
  });

  test("a dismissed review is not replayed on sync, but the Plan button re-opens it", async () => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.c.respond({ type: "extension_ui_response", id: WIRE_ID, cancelled: true });

    expect(omp.c.syncFrames().map((f) => f.type)).toEqual(["plan_state"]);
    expect(omp.c.syncFrames()[0]).toMatchObject({ status: "review" });

    const before = omp.requests().length;
    await expect(omp.c.planMode("review")).resolves.toBeNull();
    expect(omp.requests()).toHaveLength(before + 1);
    expect(omp.c.syncFrames().map((f) => f.type)).toEqual(["plan_state", "extension_ui_request"]);
  });

  test("a message typed on a client while the review is open is the planning follow-up: Refine", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.c.respond({ type: "extension_ui_response", id: WIRE_ID, cancelled: true });

    expect(omp.c.refine("also add error handling", "msg-7")).toBe(true);
    expect(omp.calls.resolve).toEqual([
      { reviewId: REVIEW_ID, choice: "refine", input: { feedback: "also add error handling" } },
    ]);
    expect(omp.calls.echoed).toEqual([{ text: "also add error handling", id: "msg-7" }]);
    expect(omp.c.reviewOpen()).toBe(false);
  });

  test("refine() declines when there is nothing to refine, so the caller handles the message", () => {
    const omp = fakeOmp();
    expect(omp.c.refine("hello")).toBe(false); // no review
    omp.openOverlay();
    expect(omp.c.refine("   ")).toBe(false); // blank
    expect(omp.calls.resolve).toEqual([]);
    omp.state.pending = undefined; // omp settled it already
    expect(omp.c.refine("late")).toBe(false);
    expect(omp.c.reviewOpen()).toBe(false);
  });
});

describe("plan_review_resolved: the PC (or omp) closed the overlay", () => {
  test.each<[string | undefined, string]>([
    ["execute", "Plan approved."],
    ["compact", "Plan approved."],
    ["keep", "Plan approved."],
    ["refine", "Refining the plan."],
    [undefined, "Plan review closed — still planning."],
  ])("choice %s closes the client sheet with %j", (choice, message) => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.state.pending = undefined;
    omp.c.onReviewResolved({ type: "plan_review_resolved", reviewId: REVIEW_ID, choice, by: "local" });

    expect(omp.notifies()).toEqual([{ type: "extension_ui_request", id: WIRE_ID, method: "notify", message }]);
    expect(omp.c.reviewOpen()).toBe(false);
  });

  test("a cancel after plan mode ended is just 'closed'", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.state.pending = undefined;
    omp.state.plan = "inactive";
    omp.c.onReviewResolved({ type: "plan_review_resolved", reviewId: REVIEW_ID, choice: undefined, by: "local" });
    expect(omp.notifies().at(-1)).toMatchObject({ message: "Plan review closed." });
    expect(omp.states().at(-1)).toEqual({ type: "plan_state", status: "idle" });
  });

  test("the resolved event for our own answer does not close anything twice", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    answer(omp, "approve_compact");
    const notified = omp.notifies().length;
    omp.c.onReviewResolved({ type: "plan_review_resolved", reviewId: REVIEW_ID, choice: "compact", by: "extension" });
    expect(omp.notifies()).toHaveLength(notified);
  });

  test("a review that vanished without an event (session replaced) is dropped on the next sync", () => {
    const omp = fakeOmp({ plan: "inactive" });
    omp.openOverlay();
    omp.state.pending = undefined; // new session: omp hid the overlay
    omp.c.sync();
    expect(omp.notifies().at(-1)).toMatchObject({ message: "Plan approved." });
    expect(omp.c.syncFrames()).toEqual([{ type: "plan_state", status: "idle" }]);
  });
});

describe("replay to a client that connects later", () => {
  test("syncFrames re-sends the open review from omp, even when its event was never seen", () => {
    const omp = fakeOmp();
    omp.state.pending = omp19Review(); // opened before this extension heard of it
    const frames = omp.c.syncFrames();

    expect(frames.map((f) => f.type)).toEqual(["plan_state", "extension_ui_request"]);
    expect(frames[0]).toEqual({
      type: "plan_state",
      status: "review",
      plan_file_path: "local://hello-txt-plan.md",
      title: "hello-txt",
    });
    expect(frames[1]).toMatchObject({ id: WIRE_ID, method: "select", plan: { content: PLAN_MARKDOWN } });
    // Adopting is silent: no push, no broadcast to the clients already attached.
    expect(omp.requests()).toEqual([]);

    // Every later sync repeats it until the review is settled.
    expect(omp.c.syncFrames().map((f) => f.type)).toEqual(["plan_state", "extension_ui_request"]);
    answer(omp, "approve_execute");
    expect(omp.c.syncFrames().map((f) => f.type)).toEqual(["plan_state"]);
  });

  test("the replay carries omp's current options, not the ones from when it opened", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.state.pending = omp19Review({ keepDisabled: true, keepLabel: "Approve and keep context (~960k / 1m)" });
    const req = omp.c.syncFrames()[1] as Extract<ServerMessage, { type: "extension_ui_request"; method: "select" }>;
    expect(req.plan?.options[2]).toEqual({
      action: "approve_keep",
      label: "Approve and keep context (~960k / 1m)",
      disabled: true,
    });
  });

  test("an unchanged idle state is never broadcast (non-plan sessions stay quiet)", () => {
    const omp = fakeOmp({ plan: "inactive" });
    omp.c.sync();
    omp.c.onModeChanged({ type: "mode_changed", state: { plan: { status: "inactive" }, loop: { status: "inactive" } } });
    expect(omp.sent).toEqual([]);
    expect(omp.c.syncFrames()).toEqual([{ type: "plan_state", status: "idle" }]);
  });

  test("when omp cannot be asked, what the extension knows stands", () => {
    const omp = fakeOmp({ unreachable: true });
    omp.c.onReviewRequested(omp19Review());
    omp.c.sync();
    expect(omp.c.reviewOpen()).toBe(true);
    expect(omp.c.syncFrames().map((f) => f.type)).toEqual(["plan_state", "extension_ui_request"]);
  });
});

describe("plan mode: ctx.sessionModes + mode_changed", () => {
  test("enter and exit are one sessionModes.set each, no /plan typing, no confirm", async () => {
    const omp = fakeOmp({ plan: "inactive" });
    await expect(omp.c.planMode("enter")).resolves.toBeNull();
    expect(omp.calls.set).toEqual([{ mode: "plan", action: "enter" }]);
    expect(omp.states().at(-1)).toMatchObject({ type: "plan_state", status: "active" });

    await expect(omp.c.planMode("exit")).resolves.toBeNull();
    expect(omp.calls.set).toEqual([
      { mode: "plan", action: "enter" },
      { mode: "plan", action: "exit" },
    ]);
    expect(omp.states().at(-1)).toEqual({ type: "plan_state", status: "idle" });
  });

  test("mode_changed drives plan_state: active, paused, idle, naming the newest local plan", () => {
    const omp = fakeOmp({ plan: "inactive" });
    omp.state.plan = "active";
    omp.c.onModeChanged({ type: "mode_changed", state: { plan: { status: "active" }, loop: { status: "inactive" } } });
    expect(omp.states().at(-1)).toEqual({
      type: "plan_state",
      status: "active",
      plan_file_path: "local://hello-txt-plan.md",
      title: "hello-txt",
    });

    omp.state.plan = "paused";
    omp.c.onModeChanged({ type: "mode_changed", state: { plan: { status: "paused" }, loop: { status: "inactive" } } });
    expect(omp.states().at(-1)).toEqual({ type: "plan_state", status: "paused" });

    omp.state.plan = "inactive";
    omp.c.onModeChanged({ type: "mode_changed", state: { plan: { status: "inactive" }, loop: { status: "inactive" } } });
    expect(omp.states().at(-1)).toEqual({ type: "plan_state", status: "idle" });
  });

  test("planning without a plan file yet names no plan", () => {
    const omp = fakeOmp({ plan: "active", planFile: false });
    omp.c.onModeChanged({ type: "mode_changed", state: { plan: { status: "active" } } });
    expect(omp.states().at(-1)).toEqual({ type: "plan_state", status: "active" });
  });

  test("leaving plan mode closes an open review's sheet", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.state.plan = "inactive";
    omp.state.pending = undefined;
    omp.c.onModeChanged({ type: "mode_changed", state: { plan: { status: "inactive" } } });
    expect(omp.notifies().at(-1)).toMatchObject({ message: "Plan review closed." });
    expect(omp.states().at(-1)).toEqual({ type: "plan_state", status: "idle" });
  });

  test("exit while the review is open: omp hides the review with the mode", async () => {
    const omp = fakeOmp();
    omp.openOverlay();
    await expect(omp.c.planMode("exit")).resolves.toBeNull();
    expect(omp.notifies().at(-1)).toMatchObject({ message: "Plan review closed." });
    expect(omp.c.reviewOpen()).toBe(false);
  });

  test("omp's refusals come back as the action error", async () => {
    const omp = fakeOmp({ plan: "inactive" });
    omp.state.setRefusal = { code: "busy", message: "The session is busy with a turn or compaction; retry once it is idle." };
    await expect(omp.c.planMode("enter")).resolves.toBe(
      "The session is busy with a turn or compaction; retry once it is idle.",
    );
    omp.state.setRefusal = { code: "conflict", message: "Exit goal mode first." };
    await expect(omp.c.planMode("enter")).resolves.toBe("Exit goal mode first.");
  });

  test("a throwing sessionModes.set is an action error, not a crash", async () => {
    const c = createPlanReview({
      broadcast: () => undefined,
      resolve: () => false,
      pending: () => undefined,
      open: async () => false,
      modes: () => ({
        getState: () => ({ plan: { status: "inactive" } }),
        set: async () => {
          throw new Error("no host");
        },
      }),
      isIdle: () => true,
      latestPlanFile: () => null,
      echoPrompt: () => undefined,
    });
    await expect(c.planMode("enter")).resolves.toBe("Could not enter plan mode: no host");
  });

  test("review re-sends the open review; with none it asks omp to open one on the newest plan", async () => {
    const omp = fakeOmp();
    omp.openOverlay();
    const before = omp.requests().length;
    await expect(omp.c.planMode("review")).resolves.toBeNull();
    expect(omp.requests()).toHaveLength(before + 1);
    expect(omp.calls.open).toBe(0);

    const fresh = fakeOmp();
    await expect(fresh.c.planMode("review")).resolves.toBeNull();
    expect(fresh.calls.open).toBe(1);
    // omp's `plan_review_requested` announced it; the action must not send it twice.
    expect(fresh.requests()).toHaveLength(1);
    expect(fresh.c.reviewOpen()).toBe(true);
  });

  test("a review omp opened without its event reaching us is adopted and sent once", async () => {
    const omp = fakeOmp();
    const c = createPlanReview({
      broadcast: (m) => omp.sent.push(m),
      resolve: () => false,
      pending: () => structuredClone(omp.state.pending),
      open: async () => {
        omp.state.pending = omp19Review(); // no `plan_review_requested` delivered
        return true;
      },
      modes: () => ({ getState: () => ({ plan: { status: "active" } }), set: async () => ({ ok: true }) }),
      isIdle: () => true,
      latestPlanFile: () => null,
      echoPrompt: () => undefined,
    });
    await expect(c.planMode("review")).resolves.toBeNull();
    expect(omp.requests()).toHaveLength(1);
  });

  test.each<[string, Partial<{ plan: PlanStatusOmp; idle: boolean; planFile: boolean }>, string]>([
    ["plan mode off", { plan: "inactive" }, "Plan mode is not active."],
    ["agent working", { idle: false }, "The agent is working: open the review once it is idle."],
    ["no plan yet", { planFile: false }, "No plan to review yet."],
  ])("review refused by omp (%s) says why", async (_name, patch, message) => {
    const omp = fakeOmp();
    Object.assign(omp.state, patch);
    await expect(omp.c.planMode("review")).resolves.toBe(message);
    expect(omp.sent.filter((m) => m.type === "extension_ui_request")).toEqual([]);
  });

  test("headless (omp RPC / daemon): no plan mode, no sessionModes — every action says so", async () => {
    const omp = fakeOmp({ headless: true });
    await expect(omp.c.planMode("enter")).resolves.toBe(PLAN_MODE_NEEDS_TERMINAL);
    await expect(omp.c.planMode("exit")).resolves.toBe(PLAN_MODE_NEEDS_TERMINAL);
    await expect(omp.c.planMode("review")).resolves.toBe(PLAN_MODE_NEEDS_TERMINAL);
    expect(omp.calls.set).toEqual([]);
    expect(omp.c.syncFrames()).toEqual([{ type: "plan_state", status: "idle" }]);
    expect(omp.c.reviewOpen()).toBe(false);
  });
});

describe("reviewOpen", () => {
  test("is true exactly while omp holds the review", () => {
    const omp = fakeOmp();
    expect(omp.c.reviewOpen()).toBe(false);
    omp.openOverlay();
    expect(omp.c.reviewOpen()).toBe(true);
    omp.state.pending = undefined; // closed on the PC
    expect(omp.c.reviewOpen()).toBe(false);
  });

  test("reset forgets the review (tests share one module)", () => {
    const omp = fakeOmp();
    omp.openOverlay();
    omp.c.reset();
    omp.state.pending = undefined;
    expect(omp.c.reviewOpen()).toBe(false);
  });
});

describe("omp session readers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-review-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("local:// plans resolve under the session's artifacts dir, newest first", () => {
    const local = join(dir, "local");
    mkdirSync(local);
    writeFileSync(join(local, "hello-txt-plan.md"), PLAN_MARKDOWN);
    writeFileSync(join(local, "bye-txt-plan.md"), "# bye");
    writeFileSync(join(local, "notes.md"), "not a plan");
    utimesSync(join(local, "hello-txt-plan.md"), 1, 1);
    const sm = { getArtifactsDir: () => dir, getSessionId: () => "s1" };

    expect(readPlanFile("local://hello-txt-plan.md", sm, "/nowhere")).toBe(PLAN_MARKDOWN);
    expect(readPlanFile("local://../escape-plan.md", sm, "/nowhere")).toBeNull();
    expect(localPlanFiles(sm)).toEqual(["local://bye-txt-plan.md", "local://hello-txt-plan.md"]);
  });

  test("latestPlanFile skips an empty draft, like omp's /plan-review", () => {
    const local = join(dir, "local");
    mkdirSync(local);
    writeFileSync(join(local, "hello-txt-plan.md"), PLAN_MARKDOWN);
    writeFileSync(join(local, "draft-plan.md"), "  \n");
    utimesSync(join(local, "hello-txt-plan.md"), 1, 1);
    const sm = { getArtifactsDir: () => dir, getSessionId: () => "s1" };

    expect(localPlanFiles(sm)[0]).toBe("local://draft-plan.md");
    expect(latestPlanFile(sm, "/nowhere")).toBe("local://hello-txt-plan.md");
    expect(latestPlanFile(null, "/nowhere")).toBeNull();
  });
});

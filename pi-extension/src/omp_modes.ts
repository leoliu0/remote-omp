// omp 19's built-in session modes: plan, vibe, goal and loop.
//
// omp reports them as one `SessionModeState` snapshot (`ctx.sessionModes
// .getState()`) and announces every change, whatever caused it (a slash
// command, a tool, `ctx.sessionModes.set()`, a session restore), with a
// `mode_changed{previous, state}` event (omp extensions/types.ts,
// `ModeChangedEvent`). Interactive (TUI) sessions only: `ctx.sessionModes` is
// undefined in `--mode rpc`, print and JSON runs and in subagents, so a
// headless daemon never has a plan or a loop.

import { z } from "zod";

const ModeStatus = z.enum(["inactive", "active", "paused"]);

/** The slice of omp's `SessionModeState` the clients mirror (plan and loop). */
const ModeState = z.object({
  plan: z.object({ status: ModeStatus, planFilePath: z.string().optional() }).optional(),
  loop: z.object({ status: ModeStatus }).optional(),
});

export type OmpModeState = z.infer<typeof ModeState>;

/** `ctx.sessionModes`: `getState()` is always allowed; `set()` can be refused
 *  by `extensionHandlers.modeControl`, an active turn or a conflicting mode. */
export interface OmpSessionModes {
  getState(): unknown;
  set(request: { mode: "plan"; action: "enter" | "exit" }): Promise<unknown>;
}

export function parseModeState(raw: unknown): OmpModeState | null {
  const parsed = ModeState.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const ModeChanged = z.object({ state: ModeState });

/** The new state a `mode_changed{previous, state}` event carries. */
export function modeChangedState(event: unknown): OmpModeState | null {
  const parsed = ModeChanged.safeParse(event);
  return parsed.success ? parsed.data.state : null;
}

/** Outcome of `ctx.sessionModes.set()`: ok, or omp's own refusal text. */
export function modeSetError(result: unknown): string | null {
  const parsed = z
    .union([
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ])
    .safeParse(result);
  if (!parsed.success) return "omp returned an unexpected answer for the mode change.";
  return parsed.data.ok ? null : parsed.data.message;
}

/** `room_meta.loop` as the app's Loop button reads it. omp's `inactive` is the
 *  app's `idle`. */
export type LoopBadge = "active" | "paused" | "idle";

export function loopBadge(state: OmpModeState | null | undefined): LoopBadge | undefined {
  const status = state?.loop?.status;
  if (!status) return undefined;
  return status === "inactive" ? "idle" : status;
}

/** Reads `ctx.sessionModes.getState()`; null when the host has no session
 *  modes (headless) or the read fails. */
export function readModeState(ctx: unknown): OmpModeState | null {
  try {
    if (typeof ctx !== "object" || ctx === null || !("sessionModes" in ctx)) return null;
    const modes = ctx.sessionModes;
    if (typeof modes !== "object" || modes === null || !("getState" in modes)) return null;
    return typeof modes.getState === "function" ? parseModeState(modes.getState()) : null;
  } catch {
    return null;
  }
}

/**
 * Phone model / thinking picks → omp's own settings.
 *
 * `pi.setModel` / `pi.setThinkingLevel` change the LIVE session only; a daemon
 * restart would read the saved defaults and revert the pick. omp persists
 * those through its own `Settings` + `AgentSession`, so this goes through the
 * same objects the TUI's model selector uses instead of touching any file:
 *
 *   - default model    → `modelRoles.default` via the live session's `settings`
 *                        (`setModelRole("default", …)`; `setProjectModelRole`
 *                        when the project layer owns the role, otherwise the
 *                        project value would shadow the write)
 *   - default thinking → `defaultThinkingLevel` via
 *                        `AgentSession.setThinkingLevel(level, persist = true)`
 *
 * The session comes from `ExtensionAPI.pi.AgentRegistry` (omp hands every
 * extension its SDK; see `retry.ts`). Importing omp's `config/settings` from
 * here is NOT an option: omp ships as one bundle, so an import resolves to a
 * second, never-initialized copy of the module (proven live on omp 19.0.1:
 * `isSettingsInitialized()` is false inside an extension).
 */

import type { ThinkingLevel } from "../protocol/types.js";
import type { ActionPi } from "./handlers.js";

/** The slice of omp's `Settings` the model default needs. */
export interface OmpDefaultsSettings {
  getModelRole(role: string): string | undefined;
  setModelRole(role: string, modelId: string | undefined): void;
  getModelRoleSource(role: string): string;
  /** Writes the project layer's role (omp ≥ 18.x). */
  setProjectModelRole?(role: string, modelId: string): void;
  /** Writes pending debounced saves to config.yml. */
  flush?(): Promise<void>;
}

/** The slice of omp's `AgentSession` used here. */
export interface OmpDefaultsSession {
  readonly settings?: OmpDefaultsSettings;
  /** `persist` also stores the level as `defaultThinkingLevel` (omp skips `off`). */
  setThinkingLevel?(level: ThinkingLevel | undefined, persist?: boolean): void;
}

interface OmpSdkSlice {
  AgentRegistry?: {
    global?(): { get?(id: string): { session?: OmpDefaultsSession | null } | undefined } | undefined;
  };
  MAIN_AGENT_ID?: unknown;
}

/** An explicit `:thinking` suffix on a role value (`provider/model:high`). */
const THINKING_SUFFIX = /:(auto|off|minimal|low|medium|high|xhigh|max)$/;

/** omp's live main session from the `ExtensionAPI` the extension was given; null when there is none (a stale API, a test host). */
export function ompDefaultsSession(api: unknown): OmpDefaultsSession | null {
  try {
    const sdk = (api as { pi?: OmpSdkSlice } | null | undefined)?.pi;
    const registry = sdk?.AgentRegistry?.global?.();
    const mainId = sdk?.MAIN_AGENT_ID;
    if (!registry || typeof mainId !== "string") return null;
    return registry.get?.(mainId)?.session ?? null;
  } catch {
    return null;
  }
}

/**
 * omp's configured default model (`modelRoles.default`) as `provider` + `modelId`,
 * a `:thinking` suffix dropped: the model a headless daemon uses at its first
 * turn, before any model is live. Null when no default is set or there is no
 * live session to ask. A value without a `provider/` part has no provider.
 */
export function configuredDefaultModel(api: unknown): { provider?: string; modelId: string } | null {
  try {
    const value = ompDefaultsSession(api)?.settings?.getModelRole("default");
    if (!value) return null;
    const bare = value.replace(THINKING_SUFFIX, "");
    const slash = bare.indexOf("/");
    return slash > 0 ? { provider: bare.slice(0, slash), modelId: bare.slice(slash + 1) } : { modelId: bare };
  } catch {
    return null;
  }
}

/**
 * Persists `provider/modelId` as omp's default model. Resolves true when
 * omp's settings took the write, false outside omp. Never throws: the live
 * model change already applied and a settings failure must not undo it.
 * An explicit thinking suffix on the existing role value stays, as in omp's
 * own selector (`formatRoleModelValue`).
 */
export async function persistDefaultModel(api: unknown, provider: string, modelId: string): Promise<boolean> {
  try {
    const settings = ompDefaultsSession(api)?.settings;
    if (!settings) return false;
    const suffix = settings.getModelRole("default")?.match(THINKING_SUFFIX)?.[0] ?? "";
    const value = `${provider}/${modelId}${suffix}`;
    if (settings.getModelRoleSource("default") === "project" && typeof settings.setProjectModelRole === "function") {
      settings.setProjectModelRole("default", value);
    } else {
      settings.setModelRole("default", value);
    }
    await settings.flush?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * The `ActionPi` the thinking handler calls. On omp, `setThinkingLevel`
 * applies the level to the live session AND stores it as the default in one
 * native call (`persist`; omp only writes when the level actually changes,
 * and never stores `off`). With no live session handle it is `pi` unchanged.
 */
export function persistingThinkingPi(pi: ActionPi, api: unknown): ActionPi {
  const session = ompDefaultsSession(api);
  const setThinkingLevel = session?.setThinkingLevel;
  if (typeof setThinkingLevel !== "function") return pi;
  return {
    setModel: (model) => pi.setModel(model),
    setThinkingLevel: (level) => setThinkingLevel.call(session, level, true),
  };
}

/**
 * Plan/66 — omp model roles from the app.
 *
 * omp keeps one model per role (`default`, `plan`, `task`, `smol`, custom…)
 * in config.yml `modelRoles`, as `provider/model[:thinking]`. The extension
 * reads and writes them through omp's OWN `settings` singleton and role
 * helpers, never the YAML file: omp's next save would overwrite a direct file
 * write, and its file watcher carries a settings save to every other running
 * omp process.
 *
 * How the live instance is reached: omp's extension loader maps imports of
 * `@oh-my-pi/pi-coding-agent/*` (and the `@earendil-works/…` / `@mariozechner/…`
 * aliases) to the modules bundled into the running omp binary, so
 * `config/settings` → `settings` is the same object the TUI's `/model` view
 * uses. Proven live on omp 18.12.2 (plan 66 step 1).
 * Under upstream pi the imports fail and `loadOmpRoleApi()` returns null.
 *
 * Handlers take the API as a parameter so tests pass a fake.
 */

import type {
  ClientMessage,
  ModelRoleSource,
  ServerMessage,
  ThinkingLevel,
  WireModelRole,
} from "../protocol/types.js";
import { wireFromModel, type ActionReplySender, type SdkModelLike } from "./handlers.js";

/** The slice of omp's `Settings` this feature calls. */
export interface OmpRoleSettings {
  getModelRoles(): Readonly<Record<string, string>>;
  getModelRole(role: string): string | undefined;
  /** `undefined` clears the role back to omp's default selection. */
  setModelRole(role: string, modelId: string | undefined): void;
  getModelRoleSource(role: string): ModelRoleSource;
  /** Writes pending debounced saves to config.yml. */
  flush?(): Promise<void>;
}

/** omp's `config/model-roles` helpers (+ the optional resolver). */
export interface OmpRoleApi {
  settings: OmpRoleSettings;
  getKnownRoleIds(settings: OmpRoleSettings): string[];
  getRoleInfo(role: string, settings: OmpRoleSettings): { name: string; hidden?: boolean };
  /** Authenticated models eligible for `role` (`registry.getAvailable("all")`
   *  filtered by the role's `accepts`). */
  roleCandidatePool(role: string, settings: OmpRoleSettings, registry: unknown): SdkModelLike[];
  /** `config/model-resolver`: resolves aliases (`@plan`), patterns and
   *  fallback lists the way omp does. Optional; a plain
   *  `provider/model[:thinking]` parse is the fallback. */
  resolveModelRoleValue?(
    value: string | undefined,
    models: SdkModelLike[],
    options?: { settings?: unknown },
  ): { model?: SdkModelLike; thinkingLevel?: string; explicitThinkingLevel?: boolean };
}

/** omp's `ModelRegistry` surface used here (`ctx.modelRegistry` inside omp). */
export interface RoleModelRegistry {
  getAvailable(kind?: string): SdkModelLike[];
  getAll?(kind?: string): SdkModelLike[];
}

/** One line per built-in omp role. omp itself has names but no descriptions. */
const ROLE_DESCRIPTIONS: Record<string, string> = {
  default: "Main model for new sessions",
  smol: "Fast model for light work",
  slow: "Model for deep reasoning",
  vision: "Model for reading images",
  plan: "Model for plan mode",
  commit: "Model for commit messages",
  tiny: "Smallest model for small internal calls",
  memory: "Model for memory notes",
  task: "Model for subagent tasks",
  advisor: "Model that reviews each turn",
  image: "Model for image generation",
  web: "Model for web search",
  speech: "Text-to-speech model",
  dictation: "Speech-to-text model",
  judge: "Model that grades results",
};

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

function asThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

let _loaded: Promise<OmpRoleApi | null> | null = null;

/**
 * Imports omp's live settings + role helpers. Resolves null outside omp (or if
 * an omp update moved them). Cached after the first success.
 */
export async function loadOmpRoleApi(): Promise<OmpRoleApi | null> {
  if (_loaded) return _loaded;
  const attempt = (async (): Promise<OmpRoleApi | null> => {
    try {
      const [s, r, resolver] = await Promise.all([
        import("@oh-my-pi/pi-coding-agent/config/settings"),
        import("@oh-my-pi/pi-coding-agent/config/model-roles"),
        import("@oh-my-pi/pi-coding-agent/config/model-resolver").catch(() => null),
      ]);
      const settings = s.settings as Partial<OmpRoleSettings> | undefined;
      // A separate copy of omp's package (not the host's bundled module) would
      // load uninitialized; only the live singleton has run `Settings.init()`.
      if (typeof s.isSettingsInitialized !== "function" || s.isSettingsInitialized() !== true) {
        return null;
      }
      if (
        !settings ||
        typeof settings.getModelRoles !== "function" ||
        typeof settings.getModelRole !== "function" ||
        typeof settings.setModelRole !== "function" ||
        typeof settings.getModelRoleSource !== "function" ||
        typeof r.getKnownRoleIds !== "function" ||
        typeof r.getRoleInfo !== "function" ||
        typeof r.roleCandidatePool !== "function"
      ) {
        return null;
      }
      const api: OmpRoleApi = {
        settings: settings as OmpRoleSettings,
        getKnownRoleIds: r.getKnownRoleIds as OmpRoleApi["getKnownRoleIds"],
        getRoleInfo: r.getRoleInfo as OmpRoleApi["getRoleInfo"],
        roleCandidatePool: r.roleCandidatePool as OmpRoleApi["roleCandidatePool"],
      };
      if (typeof resolver?.resolveModelRoleValue === "function") {
        api.resolveModelRoleValue =
          resolver.resolveModelRoleValue as NonNullable<OmpRoleApi["resolveModelRoleValue"]>;
      }
      return api;
    } catch {
      return null;
    }
  })();
  const api = await attempt;
  if (api) _loaded = attempt;
  return api;
}

/** Visible role ids, in omp's selector order. */
function visibleRoles(api: OmpRoleApi): string[] {
  const out: string[] = [];
  for (const role of api.getKnownRoleIds(api.settings)) {
    if (out.includes(role)) continue;
    let hidden = false;
    try {
      hidden = Boolean(api.getRoleInfo(role, api.settings).hidden);
    } catch {}
    if (!hidden) out.push(role);
  }
  return out;
}

function catalog(registry: RoleModelRegistry | null | undefined): SdkModelLike[] {
  if (!registry) return [];
  try {
    if (typeof registry.getAll === "function") return registry.getAll("all") ?? [];
    return registry.getAvailable("all") ?? [];
  } catch {
    return [];
  }
}

const modelKey = (m: SdkModelLike) => `${m.provider}/${m.id}`;

/** Keys of the list `models_list` sends (`getAvailable()`, omp's default
 *  "chat" kind); undefined when the registry can't say. */
function modelsListKeys(registry: RoleModelRegistry | null | undefined): Set<string> | undefined {
  if (!registry) return undefined;
  try {
    return new Set((registry.getAvailable() ?? []).map(modelKey));
  } catch {
    return undefined;
  }
}

function sameModels(pool: SdkModelLike[], full: Set<string>): boolean {
  const keys = new Set(pool.map(modelKey));
  if (keys.size !== full.size) return false;
  for (const k of keys) if (!full.has(k)) return false;
  return true;
}

/** `provider/model[:thinking]` → model + explicit thinking. */
function resolveRoleValue(
  api: OmpRoleApi,
  value: string,
  models: SdkModelLike[],
): { model?: SdkModelLike; thinking?: ThinkingLevel } {
  if (api.resolveModelRoleValue) {
    try {
      const r = api.resolveModelRoleValue(value, models, { settings: api.settings });
      if (r.model) {
        return {
          model: r.model,
          thinking: r.explicitThinkingLevel ? asThinkingLevel(r.thinkingLevel) : undefined,
        };
      }
    } catch {}
  }
  let selector = value.trim();
  let thinking: ThinkingLevel | undefined;
  const colon = selector.lastIndexOf(":");
  if (colon > 0) {
    const level = asThinkingLevel(selector.slice(colon + 1));
    if (level) {
      thinking = level;
      selector = selector.slice(0, colon);
    }
  }
  const slash = selector.indexOf("/");
  if (slash <= 0) return { thinking };
  const provider = selector.slice(0, slash);
  const id = selector.slice(slash + 1);
  const model = models.find((m) => m.provider === provider && m.id === id);
  return { model, thinking };
}

/**
 * `model_roles` entries. Without `onlyRole`: every visible role, no
 * `candidates` (the frame stays small). With `onlyRole`: just that role, plus
 * its `candidates` unless its pool equals the `models_list` list.
 */
export function buildModelRoles(
  api: OmpRoleApi,
  registry: RoleModelRegistry | null | undefined,
  onlyRole?: string,
): WireModelRole[] {
  const models = catalog(registry);
  const roles = onlyRole === undefined ? visibleRoles(api) : [onlyRole];
  return roles.map((role) => {
    let name = role;
    try {
      name = api.getRoleInfo(role, api.settings).name || role;
    } catch {}
    const entry: WireModelRole = {
      role,
      name,
      description: ROLE_DESCRIPTIONS[role] ?? "",
      source: api.settings.getModelRoleSource(role),
    };
    const value = api.settings.getModelRole(role);
    if (value) {
      const { model, thinking } = resolveRoleValue(api, value, models);
      if (model) entry.model = wireFromModel(model, true);
      if (thinking) entry.thinking = thinking;
    }
    // Key order on the wire: role, name, description, model, thinking, source.
    const { source, ...rest } = entry;
    const out: WireModelRole = { ...rest, source };
    if (onlyRole !== undefined && registry) {
      try {
        const full = modelsListKeys(registry);
        const pool = api.roleCandidatePool(role, api.settings, registry);
        // Same models as models_list → omit; the app shows its full list.
        if (!full || !sameModels(pool, full)) {
          out.candidates = pool.map((m) => ({ provider: m.provider, model_id: m.id }));
        }
      } catch {}
    }
    return out;
  });
}

const NOT_OMP = "model roles need omp (oh-my-pi); this host has none";

type ListModelRolesMsg = Extract<ClientMessage, { type: "list_model_roles" }>;
type ModelRoleSetMsg = Extract<ClientMessage, { type: "model_role_set" }>;

export function handleListModelRoles(
  api: OmpRoleApi | null,
  registry: RoleModelRegistry | null | undefined,
  sender: ActionReplySender,
  msg: ListModelRolesMsg,
): void {
  if (!api) {
    sender.send({ type: "error", in_reply_to: msg.id, code: "unsupported_type", message: NOT_OMP });
    return;
  }
  try {
    if (msg.role !== undefined && !visibleRoles(api).includes(msg.role)) {
      sender.send({
        type: "error",
        in_reply_to: msg.id,
        code: "invalid_message",
        message: `unknown role "${msg.role}"`,
      });
      return;
    }
    sender.send({
      type: "model_roles",
      in_reply_to: msg.id,
      roles: buildModelRoles(api, registry, msg.role),
    });
  } catch (e) {
    sender.send({
      type: "error",
      in_reply_to: msg.id,
      code: "internal_error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Validates and applies a role change through omp's settings, acks the
 * sender, then broadcasts a fresh `model_roles` (no `in_reply_to`) to every
 * active owner. Project-scoped roles are read-only from the app.
 */
export async function handleModelRoleSet(
  api: OmpRoleApi | null,
  registry: RoleModelRegistry | null | undefined,
  sender: ActionReplySender,
  msg: ModelRoleSetMsg,
  broadcast: (msg: ServerMessage) => void,
): Promise<void> {
  const fail = (error: string) =>
    sender.send({ type: "action_error", in_reply_to: msg.id, action: "model_role_set", error });
  try {
    if (!api) return fail(NOT_OMP);
    const { role } = msg;
    if (!visibleRoles(api).includes(role)) return fail(`unknown role "${role}"`);
    if (api.settings.getModelRoleSource(role) === "project") {
      return fail(`role "${role}" is set in the project config; change it there`);
    }
    const hasProvider = typeof msg.provider === "string" && msg.provider !== "";
    const hasModel = typeof msg.model_id === "string" && msg.model_id !== "";
    let value: string | undefined;
    if (hasProvider !== hasModel) return fail("provider and model_id go together");
    if (hasProvider && hasModel) {
      if (!registry) return fail("model registry not ready yet");
      const pool = api.roleCandidatePool(role, api.settings, registry);
      const model =
        pool.find((m) => m.provider === msg.provider && m.id === msg.model_id) ??
        pool.find(
          (m) =>
            m.provider.toLowerCase() === msg.provider!.toLowerCase() &&
            m.id.toLowerCase() === msg.model_id!.toLowerCase(),
        );
      if (!model) {
        return fail(`model "${msg.provider}/${msg.model_id}" is not available for role "${role}"`);
      }
      if (msg.thinking !== undefined) {
        const levels = wireFromModel(model, true).thinking_levels ?? [];
        if (!levels.includes(msg.thinking)) {
          return fail(`thinking "${msg.thinking}" is not supported by ${model.provider}/${model.id}`);
        }
      }
      // omp's TUI form (`formatModelSelectorValue`): provider/model[:thinking].
      value = `${model.provider}/${model.id}${msg.thinking ? `:${msg.thinking}` : ""}`;
    }
    api.settings.setModelRole(role, value);
    await api.settings.flush?.();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  sender.send({ type: "action_ok", in_reply_to: msg.id, action: "model_role_set" });
  try {
    broadcast({ type: "model_roles", roles: buildModelRoles(api, registry) });
  } catch {}
}

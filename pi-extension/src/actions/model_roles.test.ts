/**
 * Plan/66 — omp model roles: `list_model_roles` → `model_roles`, and
 * `model_role_set` → action_ok / action_error + a `model_roles` broadcast.
 *
 * The omp settings singleton and role helpers are faked through `OmpRoleApi`
 * (the live wiring imports omp's own `config/settings` + `config/model-roles`,
 * see README "Model roles").
 */

import { describe, expect, test } from "vitest";
import {
  handleListModelRoles,
  handleModelRoleSet,
  loadOmpRoleApi,
  type OmpRoleApi,
  type RoleModelRegistry,
} from "./model_roles.js";
import type { SdkModelLike } from "./handlers.js";
import type { ClientMessage, ServerMessage, WireModelRole } from "../protocol/types.js";

type Kinded = SdkModelLike & { kind: "chat" | "image" };

const opus: Kinded = {
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  provider: "anthropic",
  reasoning: true,
  contextWindow: 1_000_000,
  input: ["text", "image"],
  thinking: { efforts: ["low", "medium", "high", "xhigh", "max"] },
  kind: "chat",
};
const sonnet: Kinded = {
  id: "claude-sonnet-5-5",
  name: "Claude Sonnet 5.5",
  provider: "anthropic",
  reasoning: true,
  contextWindow: 1_000_000,
  thinking: { efforts: ["low", "medium", "high"] },
  kind: "chat",
};
const imageModel: Kinded = {
  id: "gpt-image-2",
  name: "GPT Image 2",
  provider: "openai",
  reasoning: false,
  contextWindow: 10_000,
  kind: "image",
};
/** Known to omp but without auth: in `getAll`, not in `getAvailable`. */
const noAuth: Kinded = {
  id: "grok-4.6",
  name: "Grok 4.6",
  provider: "xai",
  reasoning: true,
  contextWindow: 500_000,
  thinking: { efforts: ["high"] },
  kind: "chat",
};

/** omp's `ModelRegistry`: `kind` defaults to "chat" (what `models_list`
 *  lists); `"all"` adds the other kinds. */
function fakeRegistry(): RoleModelRegistry {
  const byKind = (models: Kinded[], kind = "chat") =>
    kind === "all" ? models : models.filter((m) => m.kind === kind);
  return {
    getAvailable: (kind?: string) => byKind([opus, sonnet, imageModel], kind),
    getAll: (kind?: string) => byKind([opus, sonnet, imageModel, noAuth], kind),
  };
}

const NAMES: Record<string, string> = {
  default: "Default",
  smol: "Fast",
  slow: "Thinking",
  plan: "Architect",
  task: "Subtask",
  image: "Image generation",
};
const BUILTINS = Object.keys(NAMES);

function fakeApi(initial: Record<string, string>, projectRoles: string[] = []) {
  const roles: Record<string, string> = { ...initial };
  const setCalls: Array<[string, string | undefined]> = [];
  let flushes = 0;
  const api: OmpRoleApi = {
    settings: {
      getModelRoles: () => ({ ...roles }),
      getModelRole: (role) => roles[role],
      setModelRole: (role, value) => {
        setCalls.push([role, value]);
        if (value === undefined) delete roles[role];
        else roles[role] = value;
      },
      getModelRoleSource: (role) =>
        projectRoles.includes(role) ? "project" : role in roles ? "global" : "default",
      flush: async () => {
        flushes += 1;
      },
    },
    // omp: built-ins first (hidden ones dropped by the caller), then roles
    // only present in config.
    getKnownRoleIds: () => [
      ...BUILTINS,
      ...Object.keys(roles).filter((r) => !BUILTINS.includes(r)),
      "secret",
    ],
    getRoleInfo: (role) =>
      role === "secret" ? { name: "Secret", hidden: true } : { name: NAMES[role] ?? role },
    roleCandidatePool: (role, _settings, registry) =>
      (registry as RoleModelRegistry)
        .getAvailable("all")
        .filter((m) => ((m as Kinded).kind === "image") === (role === "image")),
  };
  return { api, roles, setCalls, flushes: () => flushes };
}

function makeSender() {
  const sent: ServerMessage[] = [];
  return { sent, send: (msg: ServerMessage) => void sent.push(msg) };
}

type SetMsg = Extract<ClientMessage, { type: "model_role_set" }>;
const setMsg = (fields: Omit<SetMsg, "type" | "id">): SetMsg => ({
  type: "model_role_set",
  id: "set-1",
  ...fields,
});

function rolesOf(msg: ServerMessage | undefined): WireModelRole[] {
  expect(msg?.type).toBe("model_roles");
  return (msg as Extract<ServerMessage, { type: "model_roles" }>).roles;
}

const USER_ROLES = {
  default: "anthropic/claude-opus-5-5:xhigh",
  plan: "anthropic/claude-opus-5-5:max",
  task: "anthropic/claude-sonnet-5-5:auto",
  smol: "anthropic/claude-sonnet-5-5",
  designer: "xai/grok-4.6:high",
};

// ── list_model_roles ───────────────────────────────────────────────────────

describe("handleListModelRoles", () => {
  test("replies model_roles in omp's role order, with name, model, thinking and source", () => {
    const { api } = fakeApi(USER_ROLES);
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, { type: "list_model_roles", id: "L1" });

    expect(sender.sent).toHaveLength(1);
    const reply = sender.sent[0] as Extract<ServerMessage, { type: "model_roles" }>;
    expect(reply.in_reply_to).toBe("L1");
    const roles = rolesOf(reply);
    expect(roles.map((r) => r.role)).toEqual([
      "default", "smol", "slow", "plan", "task", "image", "designer",
    ]);

    const plan = roles.find((r) => r.role === "plan")!;
    expect(plan).toMatchObject({ name: "Architect", thinking: "max", source: "global" });
    expect(plan.description).not.toBe("");
    // Reuses the models_list WireModel builder (omp thinking rule).
    expect(plan.model).toEqual({
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      provider: "anthropic",
      reasoning: true,
      context_window: 1_000_000,
      vision: true,
      thinking_levels: ["off", "auto", "low", "medium", "high", "xhigh", "max"],
    });

    expect(roles.find((r) => r.role === "task")).toMatchObject({ thinking: "auto" });
    const smol = roles.find((r) => r.role === "smol")!;
    expect(smol.model?.id).toBe("claude-sonnet-5-5");
    expect(smol).not.toHaveProperty("thinking");
  });

  test("an unset role has no model or thinking and source default", () => {
    const { api } = fakeApi(USER_ROLES);
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, { type: "list_model_roles", id: "L2" });
    const slow = rolesOf(sender.sent[0]).find((r) => r.role === "slow")!;
    expect(slow).toMatchObject({ role: "slow", name: "Thinking", source: "default" });
    expect(slow).not.toHaveProperty("model");
    expect(slow).not.toHaveProperty("thinking");
  });

  test("a list without role carries no candidates, even for kind roles", () => {
    const { api } = fakeApi(USER_ROLES);
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, { type: "list_model_roles", id: "L7" });
    const roles = rolesOf(sender.sent[0]);
    expect(roles.length).toBeGreaterThan(1);
    for (const r of roles) expect(r).not.toHaveProperty("candidates");
  });

  test("a role request returns only that role, with its pool as bare pairs", () => {
    const { api } = fakeApi(USER_ROLES);
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, {
      type: "list_model_roles",
      id: "L8",
      role: "image",
    });
    expect(sender.sent).toHaveLength(1);
    const reply = sender.sent[0] as Extract<ServerMessage, { type: "model_roles" }>;
    expect(reply.in_reply_to).toBe("L8");
    expect(reply.roles.map((r) => r.role)).toEqual(["image"]);
    expect(reply.roles[0]).toMatchObject({ name: "Image generation", source: "default" });
    expect(reply.roles[0]!.candidates).toEqual([{ provider: "openai", model_id: "gpt-image-2" }]);
    expect(Object.keys(reply.roles[0]!.candidates![0]!)).toEqual(["provider", "model_id"]);
  });

  test("a role request sends a same-kind pool narrower than the full list", () => {
    const { api } = fakeApi(USER_ROLES);
    api.roleCandidatePool = (role, _s, registry) =>
      (registry as RoleModelRegistry)
        .getAvailable("all")
        .filter((m) => (role === "plan" ? m.id === "claude-opus-5-5" : (m as Kinded).kind === "chat"));
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, { type: "list_model_roles", id: "L9", role: "plan" });
    expect(rolesOf(sender.sent[0])).toEqual([
      expect.objectContaining({
        role: "plan",
        candidates: [{ provider: "anthropic", model_id: "claude-opus-5-5" }],
      }),
    ]);
  });

  test("a role request whose pool equals the full chat list sends no candidates", () => {
    const { api } = fakeApi(USER_ROLES);
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, { type: "list_model_roles", id: "L10", role: "task" });
    const roles = rolesOf(sender.sent[0]);
    expect(roles.map((r) => r.role)).toEqual(["task"]);
    expect(roles[0]).not.toHaveProperty("candidates");
    expect(roles[0]!.model?.id).toBe("claude-sonnet-5-5");
  });

  test("a role request without a model registry sends no candidates", () => {
    const { api } = fakeApi(USER_ROLES);
    const sender = makeSender();
    handleListModelRoles(api, null, sender, { type: "list_model_roles", id: "L11", role: "image" });
    const roles = rolesOf(sender.sent[0]);
    expect(roles.map((r) => r.role)).toEqual(["image"]);
    expect(roles[0]).not.toHaveProperty("candidates");
  });

  test("a request for an unknown role replies an error", () => {
    const { api } = fakeApi(USER_ROLES);
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, { type: "list_model_roles", id: "L12", role: "nope" });
    expect(sender.sent).toEqual([
      expect.objectContaining({ type: "error", in_reply_to: "L12", code: "invalid_message" }),
    ]);
  });

  test("a custom role keeps its id as name, has an empty description, resolves through getAll", () => {
    const { api } = fakeApi(USER_ROLES);
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, { type: "list_model_roles", id: "L3" });
    const designer = rolesOf(sender.sent[0]).find((r) => r.role === "designer")!;
    expect(designer).toMatchObject({ name: "designer", description: "", thinking: "high", source: "global" });
    expect(designer.model?.id).toBe("grok-4.6");
  });

  test("a project-scoped role reports source project", () => {
    const { api } = fakeApi(USER_ROLES, ["plan"]);
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, { type: "list_model_roles", id: "L4" });
    expect(rolesOf(sender.sent[0]).find((r) => r.role === "plan")?.source).toBe("project");
  });

  test("uses omp's resolveModelRoleValue when available (aliases, patterns)", () => {
    const { api } = fakeApi({ plan: "@default" });
    api.resolveModelRoleValue = (value) =>
      value === "@default"
        ? { model: opus, thinkingLevel: "high", explicitThinkingLevel: true }
        : { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false };
    const sender = makeSender();
    handleListModelRoles(api, fakeRegistry(), sender, { type: "list_model_roles", id: "L5" });
    const plan = rolesOf(sender.sent[0]).find((r) => r.role === "plan")!;
    expect(plan.model?.id).toBe("claude-opus-5-5");
    expect(plan.thinking).toBe("high");
  });

  test("without omp (upstream pi) replies an error, not a crash", () => {
    const sender = makeSender();
    handleListModelRoles(null, fakeRegistry(), sender, { type: "list_model_roles", id: "L6" });
    expect(sender.sent).toEqual([
      expect.objectContaining({ type: "error", in_reply_to: "L6", code: "unsupported_type" }),
    ]);
  });
});

// ── model_role_set ─────────────────────────────────────────────────────────

describe("handleModelRoleSet", () => {
  test("set: writes provider/model:thinking through settings, acks, then broadcasts", async () => {
    const { api, setCalls, flushes } = fakeApi(USER_ROLES);
    const sender = makeSender();
    const broadcast: ServerMessage[] = [];
    await handleModelRoleSet(
      api,
      fakeRegistry(),
      sender,
      setMsg({ role: "task", provider: "anthropic", model_id: "claude-opus-5-5", thinking: "high" }),
      (m) => broadcast.push(m),
    );
    expect(setCalls).toEqual([["task", "anthropic/claude-opus-5-5:high"]]);
    expect(flushes()).toBe(1);
    expect(sender.sent).toEqual([{ type: "action_ok", in_reply_to: "set-1", action: "model_role_set" }]);
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]).not.toHaveProperty("in_reply_to");
    for (const r of rolesOf(broadcast[0])) expect(r).not.toHaveProperty("candidates");
    const task = rolesOf(broadcast[0]).find((r) => r.role === "task")!;
    expect(task.model?.id).toBe("claude-opus-5-5");
    expect(task.thinking).toBe("high");
  });

  test("set without thinking writes the bare provider/model id", async () => {
    const { api, setCalls } = fakeApi(USER_ROLES);
    const sender = makeSender();
    await handleModelRoleSet(
      api,
      fakeRegistry(),
      sender,
      setMsg({ role: "slow", provider: "anthropic", model_id: "claude-sonnet-5-5" }),
      () => {},
    );
    expect(setCalls).toEqual([["slow", "anthropic/claude-sonnet-5-5"]]);
    expect(sender.sent[0]).toMatchObject({ type: "action_ok", action: "model_role_set" });
  });

  test("clear: omitting provider/model_id clears the role, acks and broadcasts", async () => {
    const { api, setCalls } = fakeApi(USER_ROLES);
    const sender = makeSender();
    const broadcast: ServerMessage[] = [];
    await handleModelRoleSet(api, fakeRegistry(), sender, setMsg({ role: "task" }), (m) =>
      broadcast.push(m),
    );
    expect(setCalls).toEqual([["task", undefined]]);
    expect(sender.sent[0]).toMatchObject({ type: "action_ok", action: "model_role_set" });
    const task = rolesOf(broadcast[0]).find((r) => r.role === "task")!;
    expect(task).not.toHaveProperty("model");
    expect(task.source).toBe("default");
  });

  test("a kind role takes a model from its own pool", async () => {
    const { api, setCalls } = fakeApi(USER_ROLES);
    const sender = makeSender();
    await handleModelRoleSet(
      api,
      fakeRegistry(),
      sender,
      setMsg({ role: "image", provider: "openai", model_id: "gpt-image-2" }),
      () => {},
    );
    expect(setCalls).toEqual([["image", "openai/gpt-image-2"]]);
  });

  const rejects: Array<[string, Omit<SetMsg, "type" | "id">, RegExp, string[]?]> = [
    ["unknown role", { role: "nope", provider: "anthropic", model_id: "claude-opus-5-5" }, /unknown role/],
    ["hidden role", { role: "secret", provider: "anthropic", model_id: "claude-opus-5-5" }, /unknown role/],
    [
      "model not in the role's candidate pool",
      { role: "plan", provider: "openai", model_id: "gpt-image-2" },
      /not available for role "plan"/,
    ],
    [
      "model without auth (not in getAvailable)",
      { role: "plan", provider: "xai", model_id: "grok-4.6" },
      /not available for role "plan"/,
    ],
    [
      "unsupported thinking level",
      { role: "plan", provider: "anthropic", model_id: "claude-sonnet-5-5", thinking: "max" },
      /thinking "max"/,
    ],
    ["provider without model_id", { role: "plan", provider: "anthropic" }, /provider and model_id/],
    [
      "project-scoped role",
      { role: "plan", provider: "anthropic", model_id: "claude-sonnet-5-5" },
      /project/,
      ["plan"],
    ],
  ];
  for (const [label, fields, error, projectRoles] of rejects) {
    test(`rejects ${label} with action_error, no write, no broadcast`, async () => {
      const { api, setCalls } = fakeApi(USER_ROLES, projectRoles);
      const sender = makeSender();
      const broadcast: ServerMessage[] = [];
      await handleModelRoleSet(api, fakeRegistry(), sender, setMsg(fields), (m) => broadcast.push(m));
      expect(setCalls).toEqual([]);
      expect(broadcast).toEqual([]);
      expect(sender.sent).toHaveLength(1);
      const reply = sender.sent[0] as Extract<ServerMessage, { type: "action_error" }>;
      expect(reply).toMatchObject({ type: "action_error", in_reply_to: "set-1", action: "model_role_set" });
      expect(reply.error).toMatch(error);
    });
  }

  test("rejects without omp (upstream pi)", async () => {
    const sender = makeSender();
    await handleModelRoleSet(null, fakeRegistry(), sender, setMsg({ role: "plan" }), () => {});
    expect(sender.sent[0]).toMatchObject({ type: "action_error", action: "model_role_set" });
  });

  test("rejects a set before a model registry exists", async () => {
    const { api, setCalls } = fakeApi(USER_ROLES);
    const sender = makeSender();
    await handleModelRoleSet(
      api,
      null,
      sender,
      setMsg({ role: "plan", provider: "anthropic", model_id: "claude-opus-5-5" }),
      () => {},
    );
    expect(setCalls).toEqual([]);
    expect(sender.sent[0]).toMatchObject({ type: "action_error", action: "model_role_set" });
  });
});

describe("loadOmpRoleApi", () => {
  test("outside omp the omp modules don't resolve, so it returns null", async () => {
    await expect(loadOmpRoleApi()).resolves.toBeNull();
  });
});

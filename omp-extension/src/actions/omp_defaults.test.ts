import { describe, expect, test, vi } from "vitest";
import {
  ompDefaultsSession,
  persistDefaultModel,
  persistingThinkingPi,
  type OmpDefaultsSession,
  type OmpDefaultsSettings,
} from "./omp_defaults.js";
import type { ActionPi } from "./handlers.js";

/** `ExtensionAPI.pi` as omp hands it out: the SDK whose registry holds the live main session. */
const ompApi = (session: OmpDefaultsSession | null) => ({
  pi: {
    MAIN_AGENT_ID: "main",
    AgentRegistry: { global: () => ({ get: (id: string) => (id === "main" ? { session } : undefined) }) },
  },
});

function makeSettings(opts: { source?: string; existing?: string; project?: boolean } = {}) {
  const calls: string[] = [];
  const settings: OmpDefaultsSettings = {
    getModelRole: () => opts.existing,
    setModelRole: (role, value) => calls.push(`global:${role}=${value}`),
    getModelRoleSource: () => opts.source ?? "global",
    flush: vi.fn(async () => { calls.push("flush"); }),
  };
  if (opts.project !== false) settings.setProjectModelRole = (role, value) => calls.push(`project:${role}=${value}`);
  return { settings, calls };
}

describe("persistDefaultModel", () => {
  test("writes modelRoles.default through the live session's settings and flushes", async () => {
    const { settings, calls } = makeSettings();
    expect(await persistDefaultModel(ompApi({ settings }), "anthropic", "claude-opus-4-7")).toBe(true);
    expect(calls).toEqual(["global:default=anthropic/claude-opus-4-7", "flush"]);
  });

  test("a project-owned default role is updated in the project layer (a global write would be shadowed)", async () => {
    const { settings, calls } = makeSettings({ source: "project" });
    await persistDefaultModel(ompApi({ settings }), "openai", "gpt-5");
    expect(calls).toEqual(["project:default=openai/gpt-5", "flush"]);
  });

  test("project source without a project setter falls back to the global write", async () => {
    const { settings, calls } = makeSettings({ source: "project", project: false });
    await persistDefaultModel(ompApi({ settings }), "openai", "gpt-5");
    expect(calls[0]).toBe("global:default=openai/gpt-5");
  });

  test("keeps an explicit thinking suffix on the existing role, like omp's own selector", async () => {
    const { settings, calls } = makeSettings({ existing: "anthropic/claude-opus-4-6:high" });
    await persistDefaultModel(ompApi({ settings }), "anthropic", "claude-opus-4-7");
    expect(calls[0]).toBe("global:default=anthropic/claude-opus-4-7:high");
  });

  test("a model id that merely contains a colon but no thinking level keeps no suffix", async () => {
    const { settings, calls } = makeSettings({ existing: "openrouter/foo:free" });
    await persistDefaultModel(ompApi({ settings }), "anthropic", "claude-opus-4-7");
    expect(calls[0]).toBe("global:default=anthropic/claude-opus-4-7");
  });

  test("outside omp (no SDK on the API) it resolves false and writes nothing", async () => {
    expect(await persistDefaultModel({}, "a", "b")).toBe(false);
    expect(await persistDefaultModel(null, "a", "b")).toBe(false);
    expect(await persistDefaultModel(ompApi(null), "a", "b")).toBe(false);
  });

  test("a failing settings write never throws (the live change already applied)", async () => {
    const { settings } = makeSettings();
    settings.setModelRole = () => { throw new Error("disk full"); };
    expect(await persistDefaultModel(ompApi({ settings }), "a", "b")).toBe(false);
  });
});

describe("persistingThinkingPi", () => {
  const basePi = (): ActionPi & { thinking: unknown[] } => {
    const thinking: unknown[] = [];
    return { thinking, setModel: vi.fn(async () => true), setThinkingLevel: (l) => { thinking.push(l); } };
  };

  test("omp: setThinkingLevel runs the session's native setter with persist = true; pi's own setter is not used", () => {
    const pi = basePi();
    const setThinkingLevel = vi.fn();
    persistingThinkingPi(pi, ompApi({ setThinkingLevel })).setThinkingLevel("high");
    expect(setThinkingLevel).toHaveBeenCalledWith("high", true);
    expect(pi.thinking).toEqual([]);
  });

  test("elsewhere it is pi unchanged", () => {
    const pi = basePi();
    expect(persistingThinkingPi(pi, {})).toBe(pi);
    expect(persistingThinkingPi(pi, ompApi({}))).toBe(pi);
  });

  test("setModel still goes to pi", async () => {
    const pi = basePi();
    const wrapped = persistingThinkingPi(pi, ompApi({ setThinkingLevel: vi.fn() }));
    await wrapped.setModel({ id: "m", provider: "p" } as never);
    expect(pi.setModel).toHaveBeenCalledTimes(1);
  });
});

describe("ompDefaultsSession", () => {
  test("null when the registry throws (stale API after a session replacement)", () => {
    const api = { pi: { MAIN_AGENT_ID: "main", AgentRegistry: { global: () => { throw new Error("stale"); } } } };
    expect(ompDefaultsSession(api)).toBeNull();
  });
});

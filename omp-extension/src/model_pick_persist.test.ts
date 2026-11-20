/**
 * A phone model/thinking pick is persisted through omp's own settings API and
 * nothing else: no `~/.pi/agent/settings.json`, no `<cwd>/.pi/settings.json`,
 * no regex patch of config.yml.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _routeClientMessageFrom, _setPiForTest, _resetMainSessionForTest } from "./index.js";
import { ensureModelRegistry } from "./actions/registry.js";

type Frame = Record<string, unknown>;

const model = {
  id: "claude-opus-4-7",
  name: "Claude Opus 4.7",
  provider: "anthropic",
  api: "anthropic-messages",
  reasoning: true,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8192,
  thinking: { defaultLevel: "high", levels: ["minimal", "low", "medium", "high"] },
};

/** omp's live main session as the registry hands it out: its Settings + the native thinking setter. */
function fakeOmp() {
  const roles: Record<string, string> = {};
  const thinking: Array<[string | undefined, boolean | undefined]> = [];
  const flush = vi.fn(async () => {});
  const session = {
    settings: {
      getModelRole: (r: string) => roles[r],
      setModelRole: (r: string, v: string | undefined) => {
        if (v === undefined) delete roles[r];
        else roles[r] = v;
      },
      getModelRoleSource: () => "global",
      flush,
    },
    setThinkingLevel: (level: string | undefined, persist?: boolean) => { thinking.push([level, persist]); },
  };
  const pi = {
    setModel: vi.fn(async () => true),
    setThinkingLevel: vi.fn(),
    pi: {
      MAIN_AGENT_ID: "main",
      AgentRegistry: { global: () => ({ get: (id: string) => (id === "main" ? { session } : undefined) }) },
    },
  };
  return { pi, roles, thinking, flush };
}

describe("phone model/thinking picks persist only through omp settings", () => {
  const prevHome = process.env["HOME"];
  let home: string;
  const projectSettings = join(process.cwd(), ".pi", "settings.json");
  const projectSettingsBefore = existsSync(projectSettings);

  const makeSender = () => {
    const sent: Frame[] = [];
    return { sent, send: (m: Frame) => { sent.push(m); } };
  };
  const route = (sender: ReturnType<typeof makeSender>, msg: Frame) =>
    _routeClientMessageFrom(
      sender as unknown as Parameters<typeof _routeClientMessageFrom>[0],
      msg as unknown as Parameters<typeof _routeClientMessageFrom>[1],
      { abort: vi.fn() } as unknown as Parameters<typeof _routeClientMessageFrom>[2],
    );

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-pick-home-"));
    process.env["HOME"] = home;
    // The handlers resolve the registry from the last ctx that carried one.
    ensureModelRegistry({
      modelRegistry: {
        refresh() {},
        find: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
        getAvailable: () => [model],
      },
    } as unknown as Parameters<typeof ensureModelRegistry>[0]);
  });

  afterEach(() => {
    _resetMainSessionForTest();
    _setPiForTest(null);
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  const expectNoStrayFiles = () => {
    expect(readdirSync(home)).toEqual([]);
    expect(existsSync(projectSettings)).toBe(projectSettingsBefore);
  };

  test("model_set → modelRoles.default via omp settings (flushed); HOME and <cwd>/.pi stay untouched", async () => {
    const omp = fakeOmp();
    _setPiForTest(omp.pi);

    const sender = makeSender();
    route(sender, { type: "model_set", id: "m1", provider: "anthropic", model_id: "claude-opus-4-7" });

    await vi.waitFor(() => expect(omp.flush).toHaveBeenCalledTimes(1));
    expect(sender.sent[0]).toMatchObject({ type: "action_ok", in_reply_to: "m1", action: "model_set" });
    expect(omp.pi.setModel).toHaveBeenCalledTimes(1);
    expect(omp.roles).toEqual({ default: "anthropic/claude-opus-4-7" });
    expectNoStrayFiles();
  });

  test("thinking_set → omp's native persisting setter, not pi's; HOME and <cwd>/.pi stay untouched", async () => {
    const omp = fakeOmp();
    _setPiForTest(omp.pi);

    const sender = makeSender();
    route(sender, { type: "thinking_set", id: "t1", level: "high" });
    route(sender, { type: "thinking_set", id: "t2", level: "off" });
    await vi.waitFor(() => expect(sender.sent.filter((f) => f["type"] === "action_ok")).toHaveLength(2));
    expect(omp.thinking).toEqual([["high", true], ["off", true]]);
    expect(omp.pi.setThinkingLevel).not.toHaveBeenCalled();
    expectNoStrayFiles();
  });

  test("outside omp (no SDK on the API) the live pick still applies and nothing is written anywhere", async () => {
    const setThinkingLevel = vi.fn();
    _setPiForTest({ setModel: vi.fn(async () => true), setThinkingLevel });

    const sender = makeSender();
    route(sender, { type: "model_set", id: "m2", provider: "anthropic", model_id: "claude-opus-4-7" });
    route(sender, { type: "thinking_set", id: "t3", level: "medium" });
    await vi.waitFor(() => expect(sender.sent.filter((f) => f["type"] === "action_ok")).toHaveLength(2));
    expect(setThinkingLevel).toHaveBeenCalledWith("medium");
    await new Promise((r) => setTimeout(r, 20));
    expectNoStrayFiles();
  });
});

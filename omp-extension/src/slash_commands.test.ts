import { afterEach, describe, expect, test } from "vitest";
import { SupervisorOfflineError, SupervisorReplyError } from "./daemon/client.js";
import type { ControlRequest } from "./daemon/control_protocol.js";
import {
  _setBuiltinCommandsForTest,
  _setSupervisorCallForTest,
  buildSlashCatalog,
  builtinCommands,
  ensureBuiltinCommands,
  ExpectedRpcInputs,
  isKnownSlashCommand,
  loadBuiltinCommands,
  looksLikeSlashCommand,
  parseSlashLine,
  planHeadlessSlash,
  sendThroughSupervisor,
  SlashDeliveryError,
  supervisedDaemonId,
  type BuiltinCommand,
  type HeadlessPlanInput,
} from "./slash_commands.js";

// A slice of omp 19.0.1's registry (`BUILTIN_SLASH_COMMANDS_INTERNAL`, flags read off the real
// thing): `handle` = a `prompt` frame runs it; without it the command is TUI-only.
const b = (name: string, headless: boolean, extra: Partial<BuiltinCommand> = {}): BuiltinCommand => ({
  name,
  aliases: [],
  description: `${name} (tui)`,
  headless,
  ...extra,
});
const REGISTRY: BuiltinCommand[] = [
  b("compact", true, { headlessDescription: "Compact the conversation", hint: "[focus]" }),
  b("model", true, { aliases: ["models"], headlessDescription: "Show current model selection" }),
  b("export", true),
  b("new", false),
  b("clear", false),
  b("goal", false),
  b("plan", false),
  b("plan-review", false),
  b("exit", false),
  b("quit", false, { aliases: ["q"] }),
  b("restart", false),
];

const PLAN_MESSAGE = "plan mode needs the terminal";
const planInput = (over: Partial<HeadlessPlanInput> = {}): HeadlessPlanInput => ({
  builtins: REGISTRY,
  commandNames: new Set(["skill:audit-paper", "prompt", "review"]),
  daemon: true,
  daemonId: "a1b2c3d4",
  planMessage: PLAN_MESSAGE,
  ...over,
});
const plan = (text: string, over: Partial<HeadlessPlanInput> = {}) => planHeadlessSlash(text, planInput(over));

describe("parseSlashLine / looksLikeSlashCommand", () => {
  test("splits like omp's parseSlashCommand: name ends at the first space or colon", () => {
    expect(parseSlashLine("/compact")).toEqual({ name: "compact", args: "", token: "compact" });
    expect(parseSlashLine("/compact keep the schema work")).toEqual({
      name: "compact", args: "keep the schema work", token: "compact",
    });
    expect(parseSlashLine("/skill:audit-paper check §2")).toEqual({
      name: "skill", args: "audit-paper check §2", token: "skill:audit-paper",
    });
    expect(parseSlashLine("  /model gpt-5  ")).toEqual({ name: "model", args: "gpt-5", token: "model" });
  });

  test("not a command: no slash, a bare slash", () => {
    expect(parseSlashLine("compact")).toBeNull();
    expect(parseSlashLine("/")).toBeNull();
    expect(parseSlashLine("")).toBeNull();
  });

  test("paths and prose that start with a slash are not commands", () => {
    expect(looksLikeSlashCommand("/etc/hosts is broken")).toBe(false);
    expect(looksLikeSlashCommand("//comment")).toBe(false);
    expect(looksLikeSlashCommand("/ spaced")).toBe(false);
    expect(looksLikeSlashCommand("/compact")).toBe(true);
    expect(looksLikeSlashCommand("/skill:x do it")).toBe(true);
    expect(looksLikeSlashCommand("/plan-review")).toBe(true);
  });
});

describe("planHeadlessSlash — a host with no omp TUI", () => {
  test("builtins with a text-mode handler, skills and extension commands are forwarded to omp", () => {
    expect(plan("/compact")).toEqual({ kind: "forward", known: true, daemonId: "a1b2c3d4" });
    expect(plan("/model gpt-5")).toEqual({ kind: "forward", known: true, daemonId: "a1b2c3d4" });
    expect(plan("/models")).toEqual({ kind: "forward", known: true, daemonId: "a1b2c3d4" });
    expect(plan("/skill:audit-paper check §2")).toEqual({ kind: "forward", known: true, daemonId: "a1b2c3d4" });
    expect(plan("/prompt ✦")).toEqual({ kind: "forward", known: true, daemonId: "a1b2c3d4" });
  });

  test("a name omp does not list is still forwarded (file commands exist), unmarked as known", () => {
    expect(plan("/team-standup monday")).toEqual({ kind: "forward", known: false, daemonId: "a1b2c3d4" });
  });

  test("prose that starts with a slash stays an ordinary prompt", () => {
    expect(plan("/etc/hosts is broken")).toEqual({ kind: "text" });
    expect(plan("just text")).toEqual({ kind: "text" });
  });

  test("/new is done here: omp's RPC prompt has no text-mode /new and would send it to the model", () => {
    expect(plan("/new")).toEqual({ kind: "local", action: "new" });
    // even where the supervisor is out of reach (the New session action has its own paths)
    expect(plan("/new", { daemonId: null, daemon: false })).toEqual({ kind: "local", action: "new" });
  });

  test("/exit, /quit, /q and /restart are done here, only in a supervised daemon", () => {
    expect(plan("/exit")).toEqual({ kind: "local", action: "exit" });
    expect(plan("/quit")).toEqual({ kind: "local", action: "exit" });
    expect(plan("/q")).toEqual({ kind: "local", action: "exit" });
    expect(plan("/restart")).toEqual({ kind: "local", action: "restart" });
    for (const line of ["/exit", "/quit", "/restart"]) {
      expect(plan(line, { daemon: false, daemonId: null })).toMatchObject({
        kind: "refuse", code: "command_unavailable",
      });
    }
  });

  test("TUI-only builtins are refused instead of reaching the model", () => {
    expect(plan("/goal ship it")).toMatchObject({ kind: "refuse", code: "command_unavailable" });
    expect(plan("/clear")).toMatchObject({ kind: "refuse", code: "command_unavailable" });
    const refusal = plan("/goal ship it");
    expect(refusal.kind === "refuse" && refusal.message).toContain("/goal");
  });

  test("plan mode keeps its own code and message", () => {
    expect(plan("/plan make hello.txt")).toEqual({
      kind: "refuse", code: "plan_mode_unavailable", message: PLAN_MESSAGE,
    });
    expect(plan("/plan-review")).toEqual({ kind: "refuse", code: "plan_mode_unavailable", message: PLAN_MESSAGE });
    // also when the registry could not be read
    expect(plan("/plan", { builtins: null })).toEqual({
      kind: "refuse", code: "plan_mode_unavailable", message: PLAN_MESSAGE,
    });
  });

  test("without a supervisor route: a command omp lists is refused (never model text), prose is a prompt", () => {
    const unsupervised = { daemonId: null, daemon: false };
    expect(plan("/compact", unsupervised)).toMatchObject({ kind: "refuse", code: "command_unavailable" });
    expect(plan("/skill:audit-paper", unsupervised)).toMatchObject({ kind: "refuse", code: "command_unavailable" });
    expect(plan("/team-standup monday", unsupervised)).toEqual({ kind: "text" });
  });

  test("when omp's registry cannot be read, only what the extension itself knows is intercepted", () => {
    expect(plan("/goal x", { builtins: null })).toEqual({ kind: "forward", known: false, daemonId: "a1b2c3d4" });
    expect(plan("/new", { builtins: null })).toEqual({ kind: "local", action: "new" });
  });

  test("names that collide with Object.prototype are plain names", () => {
    expect(plan("/constructor")).toEqual({ kind: "forward", known: false, daemonId: "a1b2c3d4" });
    expect(plan("/__proto__ x")).toEqual({ kind: "forward", known: false, daemonId: "a1b2c3d4" });
  });
});

describe("isKnownSlashCommand", () => {
  const lookup = { builtins: REGISTRY, commandNames: new Set(["skill:audit-paper", "review"]) };

  test("builtins (name and alias), extension/prompt/skill commands", () => {
    expect(isKnownSlashCommand("/compact", lookup)).toBe(true);
    expect(isKnownSlashCommand("/q", lookup)).toBe(true);
    expect(isKnownSlashCommand("/review the diff", lookup)).toBe(true);
    expect(isKnownSlashCommand("/skill:audit-paper x", lookup)).toBe(true);
  });

  test("the commands the extension acts on itself count without a registry", () => {
    const bare = { builtins: null, commandNames: new Set<string>() };
    for (const line of ["/new", "/exit", "/quit", "/restart", "/plan", "/plan-review"]) {
      expect(isKnownSlashCommand(line, bare)).toBe(true);
    }
    expect(isKnownSlashCommand("/compact", bare)).toBe(false);
  });

  test("prose and unknown names are not known", () => {
    expect(isKnownSlashCommand("/etc/hosts", lookup)).toBe(false);
    expect(isKnownSlashCommand("/nothing-like-it", lookup)).toBe(false);
    expect(isKnownSlashCommand("hello", lookup)).toBe(false);
  });
});

describe("buildSlashCatalog", () => {
  const hostCommands = [
    { name: "remote-omp", description: "Connect", source: "extension" },
    { name: "remote-omp status", description: "Show status", source: "extension" },
    { name: "review", description: "Review a diff", source: "prompt" },
    { name: "skill:audit-paper", description: "Audit manuscripts", source: "skill" },
    { name: "skill:slides", source: "skill" },
    { name: "compact", description: "shadowed by the builtin", source: "extension" },
  ];

  test("TUI: every builtin, with omp's TUI wording; skills ride in their own list as skill:<name>", () => {
    const catalog = buildSlashCatalog({ host: "tui", builtins: REGISTRY, hostCommands });
    expect(catalog.commands.filter((c) => c.source === "builtin").map((c) => c.name)).toEqual(
      REGISTRY.map((c) => c.name),
    );
    expect(catalog.commands.find((c) => c.name === "compact")).toEqual({
      name: "compact", description: "compact (tui)", source: "builtin", hint: "[focus]",
    });
    expect(catalog.skills).toEqual([
      { name: "skill:audit-paper", description: "Audit manuscripts" },
      { name: "skill:slides", description: "" },
    ]);
  });

  test("headless: only what a prompt frame runs plus what the extension does itself, with omp's text-mode wording", () => {
    const catalog = buildSlashCatalog({ host: "headless", builtins: REGISTRY, hostCommands });
    const builtins = catalog.commands.filter((c) => c.source === "builtin").map((c) => c.name);
    expect(builtins).toEqual(["compact", "model", "export", "new", "exit", "quit", "restart"]);
    expect(builtins).not.toContain("goal");
    expect(builtins).not.toContain("plan");
    expect(catalog.commands.find((c) => c.name === "compact")?.description).toBe("Compact the conversation");
    expect(catalog.commands.find((c) => c.name === "export")?.description).toBe("export (tui)");
  });

  test("extension and prompt commands follow; names with a space are autocomplete-only and dropped; a builtin shadows", () => {
    const catalog = buildSlashCatalog({ host: "headless", builtins: REGISTRY, hostCommands });
    expect(catalog.commands.filter((c) => c.source !== "builtin")).toEqual([
      { name: "remote-omp", description: "Connect", source: "extension" },
      { name: "review", description: "Review a diff", source: "prompt" },
    ]);
    expect(catalog.commands.filter((c) => c.name === "compact")).toHaveLength(1);
  });

  test("without a registry (outside omp, or a renamed omp module) no command list is claimed; skills still come through", () => {
    const catalog = buildSlashCatalog({ host: "headless", builtins: null, hostCommands });
    expect(catalog.commands).toBeUndefined();
    expect(catalog.skills).toHaveLength(2);
  });

  test("with a registry the list is the host's even when no builtin is runnable", () => {
    const catalog = buildSlashCatalog({ host: "headless", builtins: [], hostCommands });
    expect(catalog.commands?.map((c) => c.name)).toEqual(["remote-omp", "review", "compact"]);
  });
});

describe("omp's builtin registry", () => {
  afterEach(() => _setBuiltinCommandsForTest(null));

  test("outside omp the import fails and the registry stays unknown", async () => {
    expect(await loadBuiltinCommands()).toBeNull();
    _setBuiltinCommandsForTest(null);
    expect(await ensureBuiltinCommands()).toBeNull();
    expect(builtinCommands()).toBeNull();
  });

  test("a pinned registry is what ensureBuiltinCommands returns", async () => {
    _setBuiltinCommandsForTest(REGISTRY);
    expect(await ensureBuiltinCommands()).toBe(REGISTRY);
    expect(builtinCommands()).toBe(REGISTRY);
  });
});

describe("supervisedDaemonId", () => {
  test("the daemon marker and the id the supervisor spawned the child under", () => {
    expect(supervisedDaemonId({ REMOTE_OMP_DAEMON: "1", REMOTE_OMP_DAEMON_ID: "a1b2c3d4" })).toBe("a1b2c3d4");
    expect(supervisedDaemonId({ REMOTE_OMP_DAEMON: "1" })).toBeNull();
    expect(supervisedDaemonId({ REMOTE_OMP_DAEMON_ID: "a1b2c3d4" })).toBeNull();
    expect(supervisedDaemonId({ REMOTE_OMP_DAEMON: "1", REMOTE_OMP_DAEMON_ID: "" })).toBeNull();
  });
});

describe("sendThroughSupervisor", () => {
  afterEach(() => _setSupervisorCallForTest());

  test("writes the line as a steering `send` to the daemon", async () => {
    const calls: ControlRequest[] = [];
    _setSupervisorCallForTest((async (req: ControlRequest) => {
      calls.push(req);
      return { id: "a1b2c3d4", delivered: true };
    }) as never);
    await sendThroughSupervisor("a1b2c3d4", "/compact keep schema");
    expect(calls).toEqual([
      { op: "send", id: "a1b2c3d4", text: "/compact keep schema", streaming_behavior: "steer" },
    ]);
  });

  test("an unreachable supervisor, an unknown daemon and a child that is not accepting input fail with a message for the phone", async () => {
    _setSupervisorCallForTest((async () => {
      throw new SupervisorOfflineError("/tmp/x.sock");
    }) as never);
    await expect(sendThroughSupervisor("id", "/compact")).rejects.toThrow(/supervisor is not running/i);

    _setSupervisorCallForTest((async () => {
      throw new SupervisorReplyError("daemon id not running");
    }) as never);
    await expect(sendThroughSupervisor("id", "/compact")).rejects.toThrow("daemon id not running");

    _setSupervisorCallForTest((async () => ({ id: "id", delivered: false })) as never);
    const err = await sendThroughSupervisor("id", "/compact").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlashDeliveryError);
    expect((err as SlashDeliveryError).code).toBe("command_unavailable");
  });
});

describe("ExpectedRpcInputs", () => {
  test("a line comes back once, matched on trimmed text", () => {
    const expected = new ExpectedRpcInputs();
    expected.expect("/compact ");
    expect(expected.consume("/compact")).toBe(true);
    expect(expected.consume("/compact")).toBe(false);
    expect(expected.consume("/model")).toBe(false);
  });

  test("the same line twice is two entries", () => {
    const expected = new ExpectedRpcInputs();
    expected.expect("/jobs");
    expected.expect("/jobs");
    expect(expected.consume("/jobs")).toBe(true);
    expect(expected.consume("/jobs")).toBe(true);
    expect(expected.consume("/jobs")).toBe(false);
  });

  test("a withdrawn line (delivery failed) is not expected", () => {
    const expected = new ExpectedRpcInputs();
    const withdraw = expected.expect("/compact");
    withdraw();
    withdraw();
    expect(expected.consume("/compact")).toBe(false);
  });

  test("an entry that never came back expires", () => {
    let now = 1_000;
    const expected = new ExpectedRpcInputs(30_000, () => now);
    expected.expect("/compact");
    now += 30_001;
    expect(expected.consume("/compact")).toBe(false);
  });

  test("clear forgets everything", () => {
    const expected = new ExpectedRpcInputs();
    expected.expect("/compact");
    expected.clear();
    expect(expected.consume("/compact")).toBe(false);
  });
});


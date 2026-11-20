import { describe, expect, test, vi } from "vitest";

// What omp's `BUILTIN_SLASH_COMMANDS_INTERNAL` looks like (omp 19.0.1): `handle` is the text-mode
// handler a `prompt` frame runs, `handleTui` the editor one; descriptions can be getters.
vi.mock("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry", () => ({
  BUILTIN_SLASH_COMMANDS_INTERNAL: [
    {
      name: "compact",
      description: "Manually compact the session context",
      acpDescription: "Compact the conversation",
      acpInputHint: "[auto|full] [focus]",
      allowArgs: true,
      handle: () => undefined,
      handleTui: () => undefined,
    },
    {
      name: "model",
      aliases: ["models"],
      get description() {
        return "Switch model for this session";
      },
      inlineHint: "[model]",
      handle: () => undefined,
      handleTui: () => undefined,
    },
    { name: "new", description: "Start a new session", handleTui: () => undefined },
    { name: "", description: "nameless entries are skipped" },
    null,
  ],
}));

const { loadBuiltinCommands, ensureBuiltinCommands, builtinCommands } = await import("./slash_commands.js");

describe("loadBuiltinCommands against omp's registry shape", () => {
  test("reads names, aliases, wording, hints and whether a text-mode handler exists", async () => {
    expect(await loadBuiltinCommands()).toEqual([
      {
        name: "compact",
        aliases: [],
        description: "Manually compact the session context",
        headlessDescription: "Compact the conversation",
        hint: "[auto|full] [focus]",
        headless: true,
      },
      {
        name: "model",
        aliases: ["models"],
        description: "Switch model for this session",
        hint: "[model]",
        headless: true,
      },
      { name: "new", aliases: [], description: "Start a new session", headless: false },
    ]);
  });

  test("ensureBuiltinCommands loads once and caches", async () => {
    expect(builtinCommands()).toBeNull();
    const list = await ensureBuiltinCommands();
    expect(list?.map((c) => c.name)).toEqual(["compact", "model", "new"]);
    expect(builtinCommands()).toBe(list);
    expect(await ensureBuiltinCommands()).toBe(list);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerAskWrapperTool,
  handleAskResponse,
  getPendingAskRequests,
  toNativeParams,
  AskParamsSchema,
} from "./ask_tool.js";
import type { ExtensionAPI } from "../omp-api.js";
import type { ServerMessage, ExtensionUiRequestWire } from "../protocol/types.js";

describe("ask_tool", () => {
  let registeredTool: any = null;
  const mockPi: ExtensionAPI = {
    registerTool: vi.fn((tool: any) => {
      registeredTool = tool;
    }),
  } as unknown as ExtensionAPI;

  beforeEach(() => {
    registeredTool = null;
    vi.clearAllMocks();
  });

  it("registers ask tool with schema and description", () => {
    registerAskWrapperTool(mockPi, vi.fn(), () => false);
    expect(mockPi.registerTool).toHaveBeenCalled();
    expect(registeredTool.name).toBe("ask");
    expect(registeredTool.parameters).toBe(AskParamsSchema);
  });

  it("delegates to context.invokeTool when no active peers", async () => {
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "CLI answer" }],
      details: {},
    });
    registerAskWrapperTool(mockPi, vi.fn(), () => false);

    const result = await registeredTool.execute(
      "call_1",
      { questions: [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }] }] },
      undefined,
      undefined,
      { invokeTool },
    );

    expect(invokeTool).toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: "text", text: "CLI answer" }],
      details: {},
    });
  });

  it("broadcasts extension_ui_request and waits for mobile response when active peers exist", async () => {
    const broadcasts: ServerMessage[] = [];
    const broadcast = (msg: ServerMessage) => broadcasts.push(msg);

    registerAskWrapperTool(mockPi, broadcast, () => true);

    const executePromise = registeredTool.execute(
      "call_123",
      {
        questions: [
          {
            id: "auth",
            question: "Which auth?",
            header: "Auth Method",
            options: [
              { label: "JWT", description: "JSON Web Tokens" },
              { label: "OAuth", description: "OAuth 2.0" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      {},
    );

    expect(broadcasts).toHaveLength(1);
    const req = broadcasts[0] as ExtensionUiRequestWire;
    expect(req.type).toBe("extension_ui_request");
    expect(req.id).toBe("ask_call_123");
    expect(req.ask?.questions[0].id).toBe("auth");
    expect(req.ask?.questions[0].options).toHaveLength(2);

    // Pending requests should include it
    expect(getPendingAskRequests()).toHaveLength(1);

    // Simulate mobile answering
    const handled = handleAskResponse({
      type: "extension_ui_response",
      id: "ask_call_123",
      ask: {
        flow_id: "ask_call_123",
        kind: "answer",
        answers: {
          auth: { values: ["JWT"] },
        },
      },
    });

    expect(handled).toBe(true);
    const res = await executePromise;
    expect(res.content[0].text).toContain("User selected: JWT");
    expect(getPendingAskRequests()).toHaveLength(0);

    // Should have broadcasted dismiss notify to mobile
    const dismissNotify = broadcasts.find((m) => m.type === "extension_ui_request" && m.id === "ask_call_123" && m.method === "notify");
    expect(dismissNotify).toBeDefined();
  });

  it("handles cancel response correctly", async () => {
    const broadcasts: ServerMessage[] = [];
    registerAskWrapperTool(mockPi, (m) => broadcasts.push(m), () => true);

    const executePromise = registeredTool.execute(
      "call_cancel",
      { questions: [{ id: "q1", question: "Proceed?", options: [{ label: "Yes" }] }] },
      undefined,
      undefined,
      {},
    );

    handleAskResponse({
      type: "extension_ui_response",
      id: "ask_call_cancel",
      cancelled: true,
    });

    const res = await executePromise;
    expect(res.content[0].text).toContain("User cancelled");
    expect(res.details.cancelled).toBe(true);
  });

  it("shows the native dialog alongside the mobile ask; a local answer dismisses the phone", async () => {
    const broadcasts: ServerMessage[] = [];
    let localSignal: AbortSignal | undefined;
    const invokeTool = vi.fn((_params: unknown, opts: { signal?: AbortSignal }) => {
      localSignal = opts.signal;
      return Promise.resolve({ content: [{ type: "text", text: "User selected: Yes" }], details: {} });
    });
    registerAskWrapperTool(mockPi, (m) => broadcasts.push(m), () => true);

    const res = await registeredTool.execute(
      "call_local",
      { questions: [{ id: "q1", question: "Proceed?", options: [{ label: "Yes" }] }] },
      undefined,
      undefined,
      { invokeTool },
    );

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toBe("User selected: Yes");
    expect(localSignal?.aborted).toBe(true);
    expect(getPendingAskRequests()).toHaveLength(0);
    expect(broadcasts.map((m) => m.type === "extension_ui_request" && m.method)).toEqual(["select", "notify"]);
    // A late phone answer no longer matches a pending ask.
    expect(handleAskResponse({ type: "extension_ui_response", id: "ask_call_local", value: "Yes" })).toBe(false);
  });

  it("a mobile answer closes the native dialog", async () => {
    let localSignal: AbortSignal | undefined;
    const invokeTool = vi.fn(
      (_params: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          localSignal = opts.signal;
          opts.signal?.addEventListener("abort", () => reject(new Error("Ask input was cancelled")));
        }),
    );
    registerAskWrapperTool(mockPi, vi.fn(), () => true);

    const executePromise = registeredTool.execute(
      "call_remote",
      { questions: [{ id: "q1", question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] },
      undefined,
      undefined,
      { invokeTool },
    );
    expect(localSignal?.aborted).toBe(false);

    handleAskResponse({
      type: "extension_ui_response",
      id: "ask_call_remote",
      ask: { flow_id: "ask_call_remote", kind: "answer", answers: { q1: { values: ["No"] } } },
    });

    const res = await executePromise;
    expect(res.content[0].text).toBe("User selected: No");
    expect(localSignal?.aborted).toBe(true);
  });
});

describe("ask_tool — answer text", () => {
  let registeredTool: any = null;
  const mockPi = { registerTool: vi.fn((tool: any) => { registeredTool = tool; }) } as unknown as ExtensionAPI;

  const answerWith = async (id: string, question: Record<string, unknown>, answer: Record<string, unknown>) => {
    registerAskWrapperTool(mockPi, vi.fn(), () => true);
    const pending = registeredTool.execute(id, { questions: [question] }, undefined, undefined, {});
    handleAskResponse({
      type: "extension_ui_response",
      id: `ask_${id}`,
      ask: { flow_id: `ask_${id}`, kind: "answer", answers: { q1: answer } },
    } as never);
    return (await pending).content[0].text as string;
  };
  const opts = [{ label: "A" }, { label: "B" }];

  it("multi-choice with values AND custom text reaches the agent with both (omp native: [...values, typed])", async () => {
    const text = await answerWith("m1", { id: "q1", question: "Which?", multi: true, options: opts }, { values: ["A", "B"], customText: "and C" });
    expect(text).toBe("User selected: A, B\nUser provided custom input: and C");
  });

  it("multi-choice with only custom text keeps the custom line", async () => {
    const text = await answerWith("m2", { id: "q1", question: "Which?", multi: true, options: opts }, { customText: "just C" });
    expect(text).toBe("User provided custom input: just C");
  });

  it("single choice: typed text replaces the pick (omp native: typed || values[0])", async () => {
    const text = await answerWith("m3", { id: "q1", question: "Which?", options: opts }, { values: ["A"], customText: "mine" });
    expect(text).toBe("User provided custom input: mine");
  });

  it("single choice without custom text and notes are unchanged", async () => {
    const text = await answerWith("m4", { id: "q1", question: "Which?", options: opts }, { values: ["B"], note: "because" });
    expect(text).toBe("User selected: B\nUser added note: because");
  });
});

describe("ask_tool — daemon (no terminal, maybe no phone)", () => {
  let registeredTool: any = null;
  const mockPi = { registerTool: vi.fn((tool: any) => { registeredTool = tool; }) } as unknown as ExtensionAPI;
  const question = { id: "q1", question: "Deploy?", options: [{ label: "Yes" }, { label: "No" }] };

  beforeEach(() => {
    registeredTool = null;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("with zero peers it still broadcasts (push) and registers for replay, never calls the native dialog", async () => {
    const broadcasts: ServerMessage[] = [];
    const invokeTool = vi.fn();
    registerAskWrapperTool(mockPi, (m) => broadcasts.push(m), () => false, {
      isDaemon: () => true,
      timeoutMs: () => 60_000,
    });

    const pending = registeredTool.execute("d1", { questions: [question] }, undefined, undefined, { invokeTool });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(broadcasts).toHaveLength(1);
    expect((broadcasts[0] as ExtensionUiRequestWire).id).toBe("ask_d1");
    expect(getPendingAskRequests().map((r) => r.type === "extension_ui_request" && r.id)).toEqual(["ask_d1"]);

    // A phone that attaches later answers the replayed question.
    handleAskResponse({
      type: "extension_ui_response",
      id: "ask_d1",
      ask: { flow_id: "ask_d1", kind: "answer", answers: { q1: { values: ["Yes"] } } },
    });
    const res = await pending;
    expect(res.content[0].text).toBe("User selected: Yes");
    expect(getPendingAskRequests()).toHaveLength(0);
    // The answered ask's time box is gone: nothing left to fire.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves with the no-interactive-client result after the time box and drops the replay entry", async () => {
    const broadcasts: ServerMessage[] = [];
    registerAskWrapperTool(mockPi, (m) => broadcasts.push(m), () => false, {
      isDaemon: () => true,
      timeoutMs: () => 60_000,
    });

    const pending = registeredTool.execute("d2", { questions: [question] }, undefined, undefined, {});
    expect(getPendingAskRequests()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(getPendingAskRequests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    const res = await pending;
    expect(res.content[0].text).toContain("No interactive client attached");
    expect(res.content[0].text).toContain("Deploy?");
    expect(res.details).toMatchObject({ unprompted: true, timedOut: true });
    expect(getPendingAskRequests()).toHaveLength(0);
    // The phone sheet (if any) is dismissed.
    expect(broadcasts.map((m) => m.type === "extension_ui_request" && m.method)).toEqual(["select", "notify"]);
    // A very late answer matches nothing.
    expect(handleAskResponse({ type: "extension_ui_response", id: "ask_d2", value: "Yes" })).toBe(false);
  });

  it("an abort clears the time box and the replay entry", async () => {
    registerAskWrapperTool(mockPi, vi.fn(), () => false, { isDaemon: () => true, timeoutMs: () => 60_000 });
    const ac = new AbortController();
    const pending = registeredTool.execute("d3", { questions: [question] }, ac.signal, undefined, {});
    ac.abort();
    await expect(pending).rejects.toThrow("Ask tool aborted");
    expect(getPendingAskRequests()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("outside a daemon the native dialog is still used when no phone is attached", async () => {
    const invokeTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }], details: {} });
    registerAskWrapperTool(mockPi, vi.fn(), () => false, { isDaemon: () => false, timeoutMs: () => 60_000 });
    await registeredTool.execute("d4", { questions: [question] }, undefined, undefined, { invokeTool });
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });
});

describe("toNativeParams (omp ≥18.20 native `ask` takes one {html} form)", () => {
  const wrap = (inner: string) => `<form>\n${inner}\n</form>`;

  it("radio fieldset for a single-choice question, legend is `header: question`", () => {
    const { html } = toNativeParams({
      questions: [{ id: "auth", header: "Auth", question: "Which method?", options: [{ label: "JWT" }, { label: "OAuth" }] }],
    });
    expect(html).toBe(
      wrap(
        [
          "  <fieldset>",
          "    <legend>Auth: Which method?</legend>",
          '    <label><input type="radio" name="auth" value="JWT"> JWT</label>',
          '    <label><input type="radio" name="auth" value="OAuth"> OAuth</label>',
          "  </fieldset>",
        ].join("\n"),
      ),
    );
  });

  it("checkbox for multi, description appended to the label text, legend without header", () => {
    const { html } = toNativeParams({
      questions: [{ id: "feat", question: "Which features?", multi: true, options: [{ label: "A", description: "first" }, { label: "B" }] }],
    });
    expect(html).toContain("<legend>Which features?</legend>");
    expect(html).toContain('<input type="checkbox" name="feat" value="A"> A: first</label>');
    expect(html).toContain('<input type="checkbox" name="feat" value="B"> B</label>');
    expect(html).not.toContain('type="radio"');
  });

  it("`recommended` pre-checks exactly that option index", () => {
    const { html } = toNativeParams({
      questions: [{ id: "q", question: "Pick", recommended: 1, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }],
    });
    expect(html).toContain('value="A">');
    expect(html).toContain('value="B" checked>');
    expect(html).toContain('value="C">');
    expect(html.match(/ checked/g)).toHaveLength(1);
  });

  it("recommended index 0 is honoured (not treated as absent)", () => {
    const { html } = toNativeParams({
      questions: [{ id: "q", question: "Pick", recommended: 0, options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(html).toContain('value="A" checked>');
  });

  it("previews render as <pre> blocks before the fieldset, escaped", () => {
    const { html } = toNativeParams({
      questions: [{ id: "q", question: "Pick", options: [{ label: "A", preview: "if (a < b && c) {}" }, { label: "B" }] }],
    });
    expect(html).toContain("<p>A:</p>\n  <pre>if (a &lt; b &amp;&amp; c) {}</pre>");
    expect(html).not.toContain("<p>B:</p>");
    expect(html.indexOf("<pre>")).toBeLessThan(html.indexOf("<fieldset>"));
  });

  it("escapes HTML in id, header, question, label and description", () => {
    const { html } = toNativeParams({
      questions: [
        {
          id: 'a"b',
          header: "<H>",
          question: "x & y?",
          options: [{ label: `it's <b>`, description: '"d"' }],
        },
      ],
    });
    expect(html).toContain('name="a&quot;b"');
    expect(html).toContain("<legend>&lt;H&gt;: x &amp; y?</legend>");
    expect(html).toContain('value="it&#39;s &lt;b&gt;"');
    expect(html).toContain("it&#39;s &lt;b&gt;: &quot;d&quot;</label>");
    expect(html).not.toContain("<b>");
  });

  it("multiple questions become one form with one fieldset each", () => {
    const { html } = toNativeParams({
      questions: [
        { id: "a", question: "First?", options: [{ label: "1" }] },
        { id: "b", question: "Second?", multi: true, options: [{ label: "2" }] },
      ],
    });
    expect(html.startsWith("<form>\n")).toBe(true);
    expect(html.endsWith("\n</form>")).toBe(true);
    expect(html.match(/<fieldset>/g)).toHaveLength(2);
  });

  it("the wrapper passes the translated form (not questions[]) to the native tool", async () => {
    let registered: any = null;
    const pi = { registerTool: vi.fn((t: any) => { registered = t; }) } as unknown as ExtensionAPI;
    registerAskWrapperTool(pi, vi.fn(), () => false);
    const invokeTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }], details: {} });
    await registered.execute("n1", { questions: [{ id: "q", question: "Go?", options: [{ label: "Yes" }] }] }, undefined, undefined, { invokeTool });
    expect(invokeTool.mock.calls[0]![0]).toEqual({ html: expect.stringContaining("<legend>Go?</legend>") });
    expect(invokeTool.mock.calls[0]![0]).not.toHaveProperty("questions");
  });
});

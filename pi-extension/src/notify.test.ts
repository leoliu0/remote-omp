import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  isValidNotifyMode,
  isValidNotifyUrl,
  resolveNotifyConfig,
  type NotifyConfigResolution,
} from "./config.js";
import {
  buildWebhookRequest,
  cleanNotifySnippet,
  PushNotifier,
  sanitizeHeaderValue,
} from "./notify.js";

const BASE_EVENT = {
  id: "ev-1",
  title: "remote_omp: Done",
  body: "Finished tests",
  session: "remote_omp",
  cwd: "/home/leo/Documents/remote_omp",
};

describe("notify config validation & resolution", () => {
  const prevUrl = process.env["REMOTE_OMP_NOTIFY_URL"];
  const prevToken = process.env["REMOTE_OMP_NOTIFY_TOKEN"];
  const prevMode = process.env["REMOTE_OMP_NOTIFY_MODE"];

  afterEach(() => {
    if (prevUrl === undefined) delete process.env["REMOTE_OMP_NOTIFY_URL"];
    else process.env["REMOTE_OMP_NOTIFY_URL"] = prevUrl;
    if (prevToken === undefined) delete process.env["REMOTE_OMP_NOTIFY_TOKEN"];
    else process.env["REMOTE_OMP_NOTIFY_TOKEN"] = prevToken;
    if (prevMode === undefined) delete process.env["REMOTE_OMP_NOTIFY_MODE"];
    else process.env["REMOTE_OMP_NOTIFY_MODE"] = prevMode;
  });

  test("isValidNotifyUrl & isValidNotifyMode", () => {
    expect(isValidNotifyUrl("https://ntfy.sh/topic")).toBe(true);
    expect(isValidNotifyUrl("http://127.0.0.1:8080/hook")).toBe(true);
    expect(isValidNotifyUrl("ws://foo.test")).toBe(false);
    expect(isValidNotifyUrl("ftp://foo.test")).toBe(false);
    expect(isValidNotifyUrl("not a url")).toBe(false);
    expect(isValidNotifyUrl("")).toBe(false);

    expect(isValidNotifyMode("offline")).toBe(true);
    expect(isValidNotifyMode("always")).toBe(true);
    expect(isValidNotifyMode("off")).toBe(true);
    expect(isValidNotifyMode("never")).toBe(false);
  });

  test("resolveNotifyConfig prefers env over config and defaults mode to offline", () => {
    delete process.env["REMOTE_OMP_NOTIFY_URL"];
    delete process.env["REMOTE_OMP_NOTIFY_TOKEN"];
    delete process.env["REMOTE_OMP_NOTIFY_MODE"];

    expect(resolveNotifyConfig({})).toEqual({
      url: null,
      token: null,
      mode: "offline",
      source: "none",
    });

    expect(
      resolveNotifyConfig({
        notify_url: "https://ntfy.sh/from-cfg",
        notify_token: "cfg-tok",
        notify_mode: "always",
      }),
    ).toEqual({
      url: "https://ntfy.sh/from-cfg",
      token: "cfg-tok",
      mode: "always",
      source: "config",
    });

    process.env["REMOTE_OMP_NOTIFY_URL"] = "https://ntfy.sh/from-env";
    process.env["REMOTE_OMP_NOTIFY_TOKEN"] = "env-tok";
    process.env["REMOTE_OMP_NOTIFY_MODE"] = "off";
    expect(
      resolveNotifyConfig({
        notify_url: "https://ntfy.sh/from-cfg",
        notify_token: "cfg-tok",
        notify_mode: "always",
      }),
    ).toEqual({
      url: "https://ntfy.sh/from-env",
      token: "env-tok",
      mode: "off",
      source: "env",
    });
  });

  test("invalid env URL or mode falls back safely", () => {
    process.env["REMOTE_OMP_NOTIFY_URL"] = "not-a-url";
    process.env["REMOTE_OMP_NOTIFY_MODE"] = "bogus";
    expect(
      resolveNotifyConfig({
        notify_url: "https://ntfy.sh/valid",
        notify_mode: "always",
      }),
    ).toEqual({
      url: "https://ntfy.sh/valid",
      token: null,
      mode: "always",
      source: "config",
    });
  });
});

describe("snippet & header sanitization", () => {
  test("cleanNotifySnippet strips think tags, collapses whitespace, and truncates", () => {
    const raw = "<think>secret\nreasoning</think>\n  Hello   world \n next line ";
    expect(cleanNotifySnippet(raw, 240)).toBe("Hello world next line");
    expect(cleanNotifySnippet("<think>unclosed", 240)).toBe("");
    expect(cleanNotifySnippet("abcdefghij", 6)).toBe("abcde…");
  });

  test("sanitizeHeaderValue converts dashes/ellipsis and strips newlines/non-ASCII", () => {
    expect(sanitizeHeaderValue("omp — Done…\r\n🚀")).toBe("omp - Done...");
    for (let i = 0; i < sanitizeHeaderValue("✓ Café\t\n— ok").length; i++) {
      const code = sanitizeHeaderValue("✓ Café\t\n— ok").charCodeAt(i);
      expect(code).toBeGreaterThanOrEqual(32);
      expect(code).toBeLessThanOrEqual(126);
    }
  });
});

describe("buildWebhookRequest payloads", () => {
  test("default ntfy / plain webhook includes headers + bearer token", () => {
    const req = buildWebhookRequest(
      "https://ntfy.sh/my-topic",
      { ...BASE_EVENT, kind: "needs_input", title: "omp — Review…", hostname: "x3d" },
      "secret-token",
    );
    expect(req.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(req.headers["Title"]).toBe("omp - Review...");
    expect(req.headers["Priority"]).toBe("high");
    expect(req.headers["Tags"]).toBe("question");
    expect(req.headers["Authorization"]).toBe("Bearer secret-token");
    expect(req.headers["X-Remote-Omp-Event"]).toBe("needs_input");
    expect(req.headers["X-Remote-Omp-Session"]).toBe("remote_omp");
    expect(req.headers["X-Remote-Omp-Host"]).toBe("x3d");
    expect(req.body).toBe("Finished tests");
  });

  test("Discord webhook formats markdown content JSON", () => {
    const req = buildWebhookRequest(
      "https://discord.com/api/webhooks/123/abc",
      { ...BASE_EVENT, kind: "turn_done" },
    );
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({
      content: "**remote_omp: Done**\nFinished tests",
    });
  });

  test("Slack webhook formats text JSON", () => {
    const req = buildWebhookRequest(
      "https://hooks.slack.com/services/T0/B0/XX",
      { ...BASE_EVENT, kind: "error", body: "Boom" },
    );
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({
      text: "*remote_omp: Done*\nBoom",
    });
  });

  test("Generic JSON webhook triggers on .json or ?format=json", () => {
    const req = buildWebhookRequest(
      "https://example.test/hook?format=json",
      { ...BASE_EVENT, kind: "error", hostname: "x3d", ts: 12345 },
      "tok",
    );
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.headers["Authorization"]).toBe("Bearer tok");
    expect(JSON.parse(req.body)).toEqual({
      event: "error",
      title: "remote_omp: Done",
      body: "Finished tests",
      session: "remote_omp",
      cwd: "/home/leo/Documents/remote_omp",
      hostname: "x3d",
      priority: "high",
      ts: 12345,
    });
  });
});

describe("PushNotifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeNotifier(opts: {
    config?: Partial<NotifyConfigResolution>;
    online?: boolean;
    fetchImpl?: typeof fetch;
    debounceTurnMs?: number;
  }) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch =
      opts.fetchImpl ??
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response("ok", { status: 200 });
      });
    const cfg: NotifyConfigResolution = {
      url: "https://ntfy.sh/test",
      token: null,
      mode: "offline",
      source: "config",
      ...opts.config,
    };
    const notifier = new PushNotifier({
      getConfig: () => cfg,
      isPhoneOnline: () => opts.online ?? false,
      fetchImpl,
      hostname: () => "x3d",
      debounceTurnMs: opts.debounceTurnMs ?? 500,
    });
    return { notifier, calls };
  }

  test("offline mode suppresses when phone is online and sends when offline", async () => {
    const on = makeNotifier({ online: true, config: { mode: "offline" } });
    on.notifier.notifyTurnDone({ ...BASE_EVENT, id: "t1" });
    on.notifier.notifyNeedsInput({ ...BASE_EVENT, id: "a1" });
    await vi.advanceTimersByTimeAsync(600);
    expect(on.calls).toHaveLength(0);

    const off = makeNotifier({ online: false, config: { mode: "offline" } });
    off.notifier.notifyTurnDone({ ...BASE_EVENT, id: "t1" });
    await vi.advanceTimersByTimeAsync(600);
    expect(off.calls).toHaveLength(1);
  });

  test("always mode notifies even when phone is online; off mode never notifies", async () => {
    const always = makeNotifier({ online: true, config: { mode: "always" } });
    always.notifier.notifyNeedsInput({ ...BASE_EVENT, id: "a1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(always.calls).toHaveLength(1);

    const disabled = makeNotifier({ online: false, config: { mode: "off" } });
    disabled.notifier.notifyNeedsInput({ ...BASE_EVENT, id: "a2" });
    const res = await disabled.notifier.sendTest("remote_omp", "/cwd");
    expect(res.ok).toBe(false);
    expect(disabled.calls).toHaveLength(0);
  });

  test("turn_done followed closely by needs_input cancels turn_done (plan-review coalescing)", async () => {
    const { notifier, calls } = makeNotifier({ online: false });
    notifier.notifyTurnDone({ ...BASE_EVENT, id: "t1" });
    await vi.advanceTimersByTimeAsync(200);
    notifier.notifyNeedsInput({ ...BASE_EVENT, id: "ask1", title: "remote_omp: Plan review ready" });
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init?.headers as Record<string, string>)["X-Remote-Omp-Event"]).toBe("needs_input");
  });

  test("deduplicates repeated events with the same kind and id", async () => {
    const { notifier, calls } = makeNotifier({ online: false, debounceTurnMs: 50 });
    notifier.notifyNeedsInput({ ...BASE_EVENT, id: "same" });
    notifier.notifyNeedsInput({ ...BASE_EVENT, id: "same" });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
  });

  test("sendTest bypasses phone-online gate and returns HTTP status", async () => {
    const { notifier, calls } = makeNotifier({ online: true, config: { mode: "offline" } });
    const res = await notifier.sendTest("remote_omp", "/repo");
    expect(res).toEqual({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init?.headers as Record<string, string>)["Tags"]).toBe("bell");
  });

  test("non-2xx HTTP and rejected fetch do not throw and warn on stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const httpErr = makeNotifier({
      fetchImpl: async () => new Response("fail", { status: 500 }),
    });
    httpErr.notifier.notifyError({ ...BASE_EVENT, id: "e1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));

    const netErr = makeNotifier({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    netErr.notifier.notifyError({ ...BASE_EVENT, id: "e2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });
});

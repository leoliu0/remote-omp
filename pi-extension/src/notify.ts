import { hostname as osHostname } from "node:os";
import type { NotifyConfigResolution } from "./config.js";

export type NotifyKind = "turn_done" | "needs_input" | "error" | "test";

export interface NotifyPayloadInput {
  id: string;
  title: string;
  body: string;
  session: string;
  cwd: string;
}

export interface NotifyEvent extends NotifyPayloadInput {
  kind: NotifyKind;
  hostname?: string;
  ts?: number;
}

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface PushNotifierOptions {
  getConfig: () => NotifyConfigResolution;
  isPhoneOnline: () => boolean;
  fetchImpl?: typeof fetch;
  hostname?: () => string;
  debounceTurnMs?: number;
  timeoutMs?: number;
}

export interface NotifyTestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const DEFAULT_DEBOUNCE_TURN_MS = 500;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_SEEN_KEYS = 200;

/**
 * Strips model `<think>…</think>` blocks, collapses whitespace, and caps length
 * for concise mobile notification previews.
 */
export function cleanNotifySnippet(raw: string, maxChars = 240): string {
  const withoutThink = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think>[\s\S]*$/gi, " ");
  const collapsed = withoutThink.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (maxChars <= 0) return "";
  if (collapsed.length <= maxChars) return collapsed;
  if (maxChars === 1) return "…";
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Converts arbitrary title/metadata strings to printable single-line ASCII so
 * Fetch `Headers` validation never rejects Unicode dashes, emojis, or CR/LF.
 */
export function sanitizeHeaderValue(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagForKind(kind: NotifyKind): string {
  switch (kind) {
    case "needs_input":
      return "question";
    case "error":
      return "rotating_light";
    case "turn_done":
      return "white_check_mark";
    case "test":
      return "bell";
  }
}

function priorityForKind(kind: NotifyKind): "high" | "default" {
  return kind === "needs_input" || kind === "error" ? "high" : "default";
}

/**
 * Formats a webhook / ntfy POST request for Discord, Slack, JSON webhooks, or
 * ntfy-compatible plain-text endpoints.
 */
export function buildWebhookRequest(
  url: string,
  event: NotifyEvent,
  token?: string | null,
): WebhookRequest {
  const priority = priorityForKind(event.kind);
  const host = event.hostname ?? "";
  const ts = event.ts ?? Date.now();
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  const hostLower = parsed?.hostname.toLowerCase() ?? "";
  const pathLower = parsed?.pathname.toLowerCase() ?? "";

  if (
    (hostLower.endsWith("discord.com") || hostLower.endsWith("discordapp.com")) &&
    pathLower.includes("/api/webhooks/")
  ) {
    headers["Content-Type"] = "application/json";
    return {
      url,
      headers,
      body: JSON.stringify({ content: `**${event.title}**\n${event.body}`.trim() }),
    };
  }

  if (hostLower.endsWith("hooks.slack.com") && pathLower.includes("/services/")) {
    headers["Content-Type"] = "application/json";
    return {
      url,
      headers,
      body: JSON.stringify({ text: `*${event.title}*\n${event.body}`.trim() }),
    };
  }

  if (pathLower.endsWith(".json") || parsed?.searchParams.get("format") === "json") {
    headers["Content-Type"] = "application/json";
    return {
      url,
      headers,
      body: JSON.stringify({
        event: event.kind,
        title: event.title,
        body: event.body,
        session: event.session,
        cwd: event.cwd,
        hostname: host,
        priority,
        ts,
      }),
    };
  }

  headers["Content-Type"] = "text/plain; charset=utf-8";
  const safeTitle = sanitizeHeaderValue(event.title);
  if (safeTitle) headers["Title"] = safeTitle;
  headers["Priority"] = priority;
  headers["Tags"] = tagForKind(event.kind);
  headers["X-Remote-Pi-Event"] = event.kind;
  const safeSession = sanitizeHeaderValue(event.session);
  if (safeSession) headers["X-Remote-Pi-Session"] = safeSession;
  const safeHost = sanitizeHeaderValue(host);
  if (safeHost) headers["X-Remote-Pi-Host"] = safeHost;

  return {
    url,
    headers,
    body: event.body,
  };
}

/**
 * Dispatches offline-aware webhook / ntfy push notifications when the agent
 * finishes a turn, asks for interactive input/plan review, or hits an error.
 */
export class PushNotifier {
  private readonly getConfig: () => NotifyConfigResolution;
  private readonly isPhoneOnline: () => boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly getHostname: () => string;
  private readonly debounceTurnMs: number;
  private readonly timeoutMs: number;

  private readonly seen = new Set<string>();
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTurn: NotifyPayloadInput | null = null;

  constructor(opts: PushNotifierOptions) {
    this.getConfig = opts.getConfig;
    this.isPhoneOnline = opts.isPhoneOnline;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.getHostname = opts.hostname ?? osHostname;
    this.debounceTurnMs = opts.debounceTurnMs ?? DEFAULT_DEBOUNCE_TURN_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Queues a `turn_done` notification after a brief debounce so turns that
   * immediately open a plan review / confirmation dialog coalesce into a
   * single `needs_input` alert.
   */
  notifyTurnDone(input: NotifyPayloadInput): void {
    const key = `turn_done:${input.id}`;
    if (this.seen.has(key)) return;
    if (!this.shouldDeliver(false)) return;

    this.clearTurnTimer();
    this.pendingTurn = input;
    if (this.debounceTurnMs <= 0) {
      const next = this.pendingTurn;
      this.pendingTurn = null;
      if (next) void this.dispatch("turn_done", next, false);
      return;
    }

    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      const next = this.pendingTurn;
      this.pendingTurn = null;
      if (next) void this.dispatch("turn_done", next, false);
    }, this.debounceTurnMs);
  }

  /** Immediately dispatches an interactive-input alert, cancelling any pending `turn_done`. */
  notifyNeedsInput(input: NotifyPayloadInput): void {
    this.clearTurnTimer();
    this.pendingTurn = null;
    void this.dispatch("needs_input", input, false);
  }

  /** Immediately dispatches a non-fatal error alert. */
  notifyError(input: NotifyPayloadInput): void {
    this.clearTurnTimer();
    this.pendingTurn = null;
    void this.dispatch("error", input, false);
  }

  /** Sends a test webhook bypassing the phone-offline gate and reports status. */
  async sendTest(session: string, cwd: string): Promise<NotifyTestResult> {
    const cfg = this.getConfig();
    if (!cfg.url) {
      return { ok: false, error: "no notify_url configured" };
    }
    if (cfg.mode === "off") {
      return { ok: false, error: "notifications disabled (mode=off)" };
    }
    return this.postWebhook(cfg, {
      kind: "test",
      id: `test:${Date.now()}`,
      title: `${session || "remote-pi"}: Test notification`,
      body: `Remote Pi push test from ${this.safeHostname()} (${cwd || process.cwd()})`,
      session,
      cwd,
      hostname: this.safeHostname(),
      ts: Date.now(),
    });
  }

  dispose(): void {
    this.clearTurnTimer();
    this.pendingTurn = null;
  }

  private clearTurnTimer(): void {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  private safeHostname(): string {
    try {
      return this.getHostname() || "";
    } catch {
      return "";
    }
  }

  private shouldDeliver(bypassOfflineGate: boolean): NotifyConfigResolution | null {
    const cfg = this.getConfig();
    if (!cfg.url || cfg.mode === "off") return null;
    if (!bypassOfflineGate && cfg.mode === "offline" && this.isPhoneOnline()) return null;
    return cfg;
  }

  private markSeen(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    while (this.seen.size > MAX_SEEN_KEYS) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  private async dispatch(
    kind: NotifyKind,
    input: NotifyPayloadInput,
    bypassOfflineGate: boolean,
  ): Promise<void> {
    const cfg = this.shouldDeliver(bypassOfflineGate);
    if (!cfg) return;
    const key = `${kind}:${input.id}`;
    if (!this.markSeen(key)) return;

    const result = await this.postWebhook(cfg, {
      ...input,
      kind,
      hostname: this.safeHostname(),
      ts: Date.now(),
    });
    if (!result.ok) {
      process.stderr.write(`[remote-pi] notify failed: ${result.error ?? `HTTP ${result.status}`}\n`);
    }
  }

  private async postWebhook(
    cfg: NotifyConfigResolution,
    event: NotifyEvent,
  ): Promise<NotifyTestResult> {
    if (!cfg.url) return { ok: false, error: "no notify_url configured" };
    const req = buildWebhookRequest(cfg.url, event, cfg.token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
      return { ok: true, status: res.status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

import fs from "node:fs";
import path from "node:path";
import { remoteOmpHome } from "./paths.js";

// The data dir is resolved at call time (`remoteOmpHome()`), never at import
// time, so `REMOTE_OMP_HOME` can redirect the whole tree (tests, sandboxes) and
// the one-time legacy data-dir migration (`legacy_migration.ts`) can run before
// anything is created here.
const CONFIG_FILENAME = "config.json";

/**
 * Default community relay. Stored in canonical http(s):// form — conversion
 * to ws(s):// happens at the transport layer (see `toWebSocketUrl`). The
 * community relay's reverse proxy maps `:443 → :3000` (the WS port), so the
 * URL has no explicit port and the WebSocket upgrade rides on the same TLS
 * connection as the HTTPS endpoints used by the mesh client.
 */
export const kDefaultRelayUrl = "https://relay-rp1.jacobmoura.work";

export type NotifyMode = "offline" | "always" | "off";

export type RemoteOmpConfig = {
  relay?: string;
  notify_url?: string;
  notify_token?: string;
  notify_mode?: NotifyMode;
};

export type NotifyConfigResolution = {
  url: string | null;
  token: string | null;
  mode: NotifyMode;
  source: "env" | "config" | "none";
};

export function loadConfig(): RemoteOmpConfig {
  try {
    const raw = fs.readFileSync(path.join(remoteOmpHome(), CONFIG_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as RemoteOmpConfig;
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<RemoteOmpConfig>): void {
  const dir = remoteOmpHome();
  fs.mkdirSync(dir, { recursive: true });
  const current = loadConfig();
  const next: RemoteOmpConfig = { ...current };
  for (const key of Object.keys(patch) as Array<keyof RemoteOmpConfig>) {
    const value = patch[key];
    if (value === undefined) {
      delete next[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(next, null, 2));
}

export type RelayResolution = { url: string; source: "env" | "config" | "default" };

/**
 * Resolves the effective relay URL in **canonical http(s):// form**.
 *
 * Precedence:
 *   1. `REMOTE_OMP_RELAY` env var (ops/CI escape hatch)
 *   2. `~/.omp/remote/config.json` `relay` field (set via /remote-omp set-relay)
 *   3. `kDefaultRelayUrl` (community default)
 *
 * Any ws(s):// values found (legacy configs or env overrides) are coerced
 * to http(s):// defensively — the canonical form across the codebase is
 * http(s)://, and the transport layer converts to ws(s):// at WS-open time.
 */
export function resolveRelayUrl(): RelayResolution {
  const env = process.env["REMOTE_OMP_RELAY"];
  if (env && env.length > 0) return { url: toHttpUrl(env), source: "env" };
  const cfg = loadConfig();
  if (cfg.relay && cfg.relay.length > 0) return { url: toHttpUrl(cfg.relay), source: "config" };
  return { url: toHttpUrl(kDefaultRelayUrl), source: "default" };
}

/**
 * Strict validator for **user-provided** relay URLs (via `/remote-omp
 * set-relay` or `/remote-omp relay url`).
 *
 * Only accepts `http://` and `https://`. `ws://`/`wss://` are deliberately
 * **rejected** — the canonical form stored in config is http(s):// and the
 * extension converts to ws(s):// internally when opening the WebSocket.
 * Forcing a single scheme at the user boundary avoids two-form drift.
 */
export function isValidRelayUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false;
  try { new URL(url); return true; } catch { return false; }
}

/**
 * Returns true if the URL uses ws:// or wss:// scheme — for emitting a
 * targeted error message when the user pastes a WebSocket URL by mistake.
 */
export function isWebSocketScheme(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("ws://") || lower.startsWith("wss://");
}

/**
 * Converts an http(s):// URL to the corresponding ws(s):// form. Used by
 * the transport layer right before opening the WebSocket — config storage
 * and the mesh HTTP client both stay on http(s)://.
 *
 *   https://host  → wss://host
 *   http://host   → ws://host
 *   ws(s)://host  → pass-through (defensive — env overrides or legacy
 *                   configs may still carry ws(s)://)
 */
export function toWebSocketUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (lower.startsWith("http://"))  return "ws://"  + url.slice("http://".length);
  return url;
}

/**
 * Inverse of `toWebSocketUrl`. Used by `resolveRelayUrl` to coerce any
 * ws(s):// values back to canonical http(s):// before returning them to
 * the rest of the codebase.
 */
export function toHttpUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith("wss://")) return "https://" + url.slice("wss://".length);
  if (lower.startsWith("ws://"))  return "http://"  + url.slice("ws://".length);
  return url;
}

/**
 * Strict validator for webhook / ntfy notification URLs: accepts only
 * parseable `http://` or `https://` URLs.
 */
export function isValidNotifyUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Type guard for supported push notification modes. */
export function isValidNotifyMode(v: string): v is NotifyMode {
  return v === "offline" || v === "always" || v === "off";
}

/**
 * Resolves webhook/ntfy notification configuration.
 *
 * Precedence:
 *   - URL: `REMOTE_OMP_NOTIFY_URL` (env) > `~/.omp/remote/config.json` `notify_url`
 *   - Token: `REMOTE_OMP_NOTIFY_TOKEN` (env) > `config.json` `notify_token`
 *   - Mode: `REMOTE_OMP_NOTIFY_MODE` (env) > `config.json` `notify_mode` > `"offline"`
 */
export function resolveNotifyConfig(cfgOverride?: RemoteOmpConfig): NotifyConfigResolution {
  const cfg = cfgOverride ?? loadConfig();

  const envUrlRaw = process.env["REMOTE_OMP_NOTIFY_URL"]?.trim() ?? "";
  const cfgUrlRaw = typeof cfg.notify_url === "string" ? cfg.notify_url.trim() : "";

  let url: string | null = null;
  let source: "env" | "config" | "none" = "none";
  if (envUrlRaw && isValidNotifyUrl(envUrlRaw)) {
    url = envUrlRaw;
    source = "env";
  } else if (cfgUrlRaw && isValidNotifyUrl(cfgUrlRaw)) {
    url = cfgUrlRaw;
    source = "config";
  }

  const envToken = process.env["REMOTE_OMP_NOTIFY_TOKEN"]?.trim() ?? "";
  const cfgToken = typeof cfg.notify_token === "string" ? cfg.notify_token.trim() : "";
  const token = envToken || cfgToken || null;

  const envModeRaw = process.env["REMOTE_OMP_NOTIFY_MODE"]?.trim().toLowerCase() ?? "";
  const cfgModeRaw = typeof cfg.notify_mode === "string" ? cfg.notify_mode.trim().toLowerCase() : "";
  const mode: NotifyMode = isValidNotifyMode(envModeRaw)
    ? envModeRaw
    : isValidNotifyMode(cfgModeRaw)
      ? cfgModeRaw
      : "offline";

  return { url, token, mode, source };
}

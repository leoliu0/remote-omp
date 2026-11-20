import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidRelayUrl,
  isWebSocketScheme,
  loadConfig,
  resolveRelayUrl,
  saveConfig,
  toWebSocketUrl,
  toHttpUrl,
  kDefaultRelayUrl,
} from "./config.js";

describe("isValidRelayUrl (strict http(s):// only)", () => {
  test("accepts http://", () => {
    expect(isValidRelayUrl("http://foo.test")).toBe(true);
    expect(isValidRelayUrl("http://foo.test:3000")).toBe(true);
    expect(isValidRelayUrl("http://192.168.1.10:3000")).toBe(true);
  });

  test("accepts https://", () => {
    expect(isValidRelayUrl("https://relay.example.tld")).toBe(true);
    expect(isValidRelayUrl("https://relay-rp1.jacobmoura.work")).toBe(true);
  });

  test("rejects ws:// (user must use http:// + auto-convert)", () => {
    expect(isValidRelayUrl("ws://foo.test")).toBe(false);
    expect(isValidRelayUrl("ws://192.168.1.10:3000")).toBe(false);
  });

  test("rejects wss:// (user must use https:// + auto-convert)", () => {
    expect(isValidRelayUrl("wss://relay.example.tld")).toBe(false);
  });

  test("rejects empty / non-URL / non-http scheme", () => {
    expect(isValidRelayUrl("")).toBe(false);
    expect(isValidRelayUrl("not a url")).toBe(false);
    expect(isValidRelayUrl("ftp://example.tld")).toBe(false);
    expect(isValidRelayUrl("file:///etc/passwd")).toBe(false);
  });
});

describe("isWebSocketScheme", () => {
  test("true for ws:// and wss://", () => {
    expect(isWebSocketScheme("ws://foo")).toBe(true);
    expect(isWebSocketScheme("wss://foo")).toBe(true);
    expect(isWebSocketScheme("WSS://Foo")).toBe(true); // case-insensitive
  });

  test("false for http://, https://, and others", () => {
    expect(isWebSocketScheme("http://foo")).toBe(false);
    expect(isWebSocketScheme("https://foo")).toBe(false);
    expect(isWebSocketScheme("ftp://foo")).toBe(false);
    expect(isWebSocketScheme("")).toBe(false);
  });
});

describe("toWebSocketUrl (http(s):// → ws(s)://)", () => {
  test("https:// → wss://", () => {
    expect(toWebSocketUrl("https://relay.example.tld")).toBe("wss://relay.example.tld");
    expect(toWebSocketUrl("https://foo:3000/path")).toBe("wss://foo:3000/path");
  });

  test("http:// → ws://", () => {
    expect(toWebSocketUrl("http://relay.example.tld")).toBe("ws://relay.example.tld");
    expect(toWebSocketUrl("http://192.168.1.10:3000")).toBe("ws://192.168.1.10:3000");
  });

  test("ws(s):// pass through (defensive — env override may bypass validation)", () => {
    expect(toWebSocketUrl("ws://foo")).toBe("ws://foo");
    expect(toWebSocketUrl("wss://foo")).toBe("wss://foo");
  });

  test("case-insensitive scheme match", () => {
    expect(toWebSocketUrl("HTTPS://Foo")).toBe("wss://Foo");
    expect(toWebSocketUrl("HTTP://Foo")).toBe("ws://Foo");
  });
});

describe("toHttpUrl (ws(s):// → http(s)://)", () => {
  test("wss:// → https://", () => {
    expect(toHttpUrl("wss://relay.example.tld")).toBe("https://relay.example.tld");
  });

  test("ws:// → http://", () => {
    expect(toHttpUrl("ws://192.168.1.10:3000")).toBe("http://192.168.1.10:3000");
  });

  test("http(s):// pass through", () => {
    expect(toHttpUrl("https://foo")).toBe("https://foo");
    expect(toHttpUrl("http://foo:3000")).toBe("http://foo:3000");
  });
});

describe("kDefaultRelayUrl", () => {
  test("is canonical https:// form (no scheme conversion needed at resolve time)", () => {
    expect(kDefaultRelayUrl).toMatch(/^https:\/\//);
    expect(kDefaultRelayUrl).toBe("https://relay-rp1.jacobmoura.work");
  });
});

describe("config.json location + env names (plan/69)", () => {
  // `REMOTE_OMP_HOME` replaces the OS home as the root of the data tree and is
  // read on every call, never captured at import.
  const prev = {
    home: process.env["REMOTE_OMP_HOME"],
    relay: process.env["REMOTE_OMP_RELAY"],
  };
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omp-config-"));
    process.env["REMOTE_OMP_HOME"] = home;
    delete process.env["REMOTE_OMP_RELAY"];
  });
  afterEach(() => {
    if (prev.home === undefined) delete process.env["REMOTE_OMP_HOME"];
    else process.env["REMOTE_OMP_HOME"] = prev.home;
    if (prev.relay === undefined) delete process.env["REMOTE_OMP_RELAY"];
    else process.env["REMOTE_OMP_RELAY"] = prev.relay;
    rmSync(home, { recursive: true, force: true });
  });

  test("saveConfig / loadConfig round-trip through <REMOTE_OMP_HOME>/.omp/remote/config.json", () => {
    expect(loadConfig()).toEqual({});

    saveConfig({ relay: "https://relay.example.tld", notify_mode: "always" });
    const file = join(home, ".omp", "remote", "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      relay: "https://relay.example.tld",
      notify_mode: "always",
    });
    expect(loadConfig()).toEqual({ relay: "https://relay.example.tld", notify_mode: "always" });

    // An explicit `undefined` removes the key.
    saveConfig({ notify_mode: undefined });
    expect(loadConfig()).toEqual({ relay: "https://relay.example.tld" });
  });

  test("the data dir is resolved on every call: re-pointing REMOTE_OMP_HOME switches files", () => {
    saveConfig({ relay: "https://one.test" });
    const other = mkdtempSync(join(tmpdir(), "omp-config-other-"));
    try {
      process.env["REMOTE_OMP_HOME"] = other;
      expect(loadConfig()).toEqual({});
      saveConfig({ relay: "https://two.test" });
      expect(existsSync(join(other, ".omp", "remote", "config.json"))).toBe(true);

      process.env["REMOTE_OMP_HOME"] = home;
      expect(loadConfig()).toEqual({ relay: "https://one.test" });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("resolveRelayUrl: REMOTE_OMP_RELAY beats config.json beats the default", () => {
    expect(resolveRelayUrl()).toEqual({ url: kDefaultRelayUrl, source: "default" });

    saveConfig({ relay: "wss://cfg.test" });
    expect(resolveRelayUrl()).toEqual({ url: "https://cfg.test", source: "config" });

    process.env["REMOTE_OMP_RELAY"] = "http://env.test:3000";
    expect(resolveRelayUrl()).toEqual({ url: "http://env.test:3000", source: "env" });
  });
});

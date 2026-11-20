import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "./storage.js";
import type { KeyStoreBackend } from "./storage.js";

const {
  getOrCreateEd25519Keypair,
  KeyringUnavailableError,
  _setKeyStoreBackendForTest,
  _setKeyringExpectedForTest,
  _setKeyringRetryForTest,
  _unlinkIdentityFileForTest,
  _identityFileForTest,
  _setNativeBindingErrorForTest,
} = storage;

// The data dir follows REMOTE_OMP_HOME (resolved at call time), so pointing it
// at a temp dir keeps every file this suite writes out of the dev's real
// ~/.omp/remote — and out of a running daemon's live copy of it.
const _tmpHome = mkdtempSync(join(tmpdir(), "omp-storage-"));
const _dataDir = join(_tmpHome, ".omp", "remote");
const _prevHome = process.env["REMOTE_OMP_HOME"];
process.env["REMOTE_OMP_HOME"] = _tmpHome;

afterAll(() => {
  if (_prevHome === undefined) delete process.env["REMOTE_OMP_HOME"];
  else process.env["REMOTE_OMP_HOME"] = _prevHome;
  rmSync(_tmpHome, { recursive: true, force: true });
});

// ── In-memory backend for migration / round-trip tests ──────────────────────

class InMemoryBackend implements KeyStoreBackend {
  readonly store = new Map<string, string>();
  readonly reads: { service: string; account: string }[] = [];
  readonly writes: { service: string; account: string; value: string }[] = [];
  readonly deletes: { service: string; account: string }[] = [];
  private _failOn?: "read" | "write" | "delete";
  private _failAllOn?: "read" | "write" | "delete";
  private _failReadsOf?: { service: string; once: boolean };

  failNext(op: "read" | "write" | "delete" | undefined) {
    this._failOn = op;
  }

  /** Persistent failure — every op of this kind throws (simulates a keyring
   *  that's locked/unavailable for the whole call, surviving retries). */
  failAll(op: "read" | "write" | "delete" | undefined) {
    this._failAllOn = op;
  }

  /** Make reads of ONE keyring service throw — every time, or only the next
   *  one. Reads of the other services keep working. `undefined` clears it. */
  failReadsOf(service: string | undefined, opts: { once?: boolean } = {}) {
    this._failReadsOf = service === undefined ? undefined : { service, once: opts.once === true };
  }

  async read(service: string, account: string) {
    this.reads.push({ service, account });
    if (this._failAllOn === "read") throw new Error("simulated keyring locked");
    if (this._failReadsOf?.service === service) {
      if (this._failReadsOf.once) this._failReadsOf = undefined;
      throw new Error("simulated keyring locked");
    }
    if (this._failOn === "read") {
      this._failOn = undefined;
      throw new Error("simulated keyring unavailable");
    }
    return this.store.get(`${service}|${account}`);
  }
  async write(service: string, account: string, value: string) {
    this.writes.push({ service, account, value });
    if (this._failOn === "write") {
      this._failOn = undefined;
      throw new Error("simulated keyring write failure");
    }
    this.store.set(`${service}|${account}`, value);
  }
  async delete(service: string, account: string) {
    this.deletes.push({ service, account });
    const key = `${service}|${account}`;
    const had = this.store.has(key);
    this.store.delete(key);
    return had;
  }
}

const NEW_SERVICE = "dev.remoteomp.omp";
const LEGACY_PI_SERVICE = "dev.remotepi.pi";   // Remote Pi's keyring service
const LEGACY_MAC_SERVICE = "dev.remotepi.mac"; // keytar-era service (pre-2026-05-25)
const ACCOUNT = "longterm-ed25519";

beforeEach(async () => {
  // Silence the migration / fallback console output during tests so the
  // vitest output isn't polluted.
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Zero retry delay so persistent-failure tests don't sleep.
  _setKeyringRetryForTest(3, 0);
  await _unlinkIdentityFileForTest();
  // peers.json now gates identity minting (issues #95/#69), so a container left
  // by a previous test would make an unrelated "fresh install" case throw.
  rmSync(join(_dataDir, "peers.json"), { force: true });
});

afterEach(() => {
  _setKeyStoreBackendForTest(null);
  _setKeyringExpectedForTest(null);
  _setKeyringRetryForTest(null);
  _setNativeBindingErrorForTest(null);
  delete process.env.REMOTE_OMP_ALLOW_FILE_IDENTITY;
  vi.restoreAllMocks();
});

// ── Keyring path ────────────────────────────────────────────────────────────

describe("getOrCreateEd25519Keypair — keyring path", () => {
  test("returns existing entry from new service without writing", async () => {
    const backend = new InMemoryBackend();
    const original = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(2)).toString("base64"),
    });
    backend.store.set(`${NEW_SERVICE}|${ACCOUNT}`, original);
    _setKeyStoreBackendForTest(backend);

    const kp = await getOrCreateEd25519Keypair();
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
    );
    expect(backend.writes.length).toBe(0);
    expect(backend.deletes.length).toBe(0);
  });

  test("generates + saves a fresh keypair when neither service has an entry", async () => {
    const backend = new InMemoryBackend();
    _setKeyStoreBackendForTest(backend);

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(backend.writes.length).toBe(1);
    expect(backend.writes[0]!.service).toBe(NEW_SERVICE);
    expect(backend.writes[0]!.account).toBe(ACCOUNT);
    expect(backend.deletes.length).toBe(0);
    // Every legacy service is consulted before a first run mints anything.
    expect(backend.reads.map((r) => r.service)).toEqual([NEW_SERVICE, LEGACY_PI_SERVICE, LEGACY_MAC_SERVICE]);
  });

  test("idempotent across two calls — second call returns same key without write", async () => {
    const backend = new InMemoryBackend();
    _setKeyStoreBackendForTest(backend);

    const first = await getOrCreateEd25519Keypair();
    const second = await getOrCreateEd25519Keypair();

    expect(Buffer.from(first.publicKey).toString("base64")).toBe(
      Buffer.from(second.publicKey).toString("base64"),
    );
    expect(backend.writes.length).toBe(1);  // only the first call wrote
  });
});

// Linux `@napi-rs/keyring` without a Secret Service falls back to kernel
// keyutils (session/_persistent keyrings) — RAM only, gone after reboot. The
// next boot then found an empty keyring, minted a fresh identity, and
// SelfRevoke wiped peers.json because the new key wasn't in any Owner blob.
describe("getOrCreateEd25519Keypair — non-durable keyring (Linux)", () => {
  test("keyring identity survives a reboot that empties the keyring", async () => {
    const beforeReboot = new InMemoryBackend();
    _setKeyStoreBackendForTest(beforeReboot);
    _setKeyringExpectedForTest(false);
    const paired = await getOrCreateEd25519Keypair();

    // Reboot: kernel keyrings are wiped, the file system is not.
    _setKeyStoreBackendForTest(new InMemoryBackend());
    const afterReboot = await getOrCreateEd25519Keypair();

    expect(Buffer.from(afterReboot.publicKey).toString("base64"))
      .toBe(Buffer.from(paired.publicKey).toString("base64"));
  });

  test("pre-existing keyring entry is pinned to identity.json before a reboot", async () => {
    const existing = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(8)).toString("base64"),
    });
    const beforeReboot = new InMemoryBackend();
    beforeReboot.store.set(`${NEW_SERVICE}|${ACCOUNT}`, existing);
    _setKeyStoreBackendForTest(beforeReboot);
    _setKeyringExpectedForTest(false);
    await getOrCreateEd25519Keypair();

    _setKeyStoreBackendForTest(new InMemoryBackend());
    const afterReboot = await getOrCreateEd25519Keypair();

    expect(Buffer.from(afterReboot.publicKey).toString("base64"))
      .toBe(Buffer.from(new Uint8Array(32).fill(9)).toString("base64"));
  });
});

// ── Legacy keyring migration (plan/69: Remote Pi → Remote OMP) ──────────────

describe("getOrCreateEd25519Keypair — legacy keyring services (plan/69)", () => {
  const entry = (fill: number): string => JSON.stringify({
    pk: Buffer.from(new Uint8Array(32).fill(fill)).toString("base64"),
    sk: Buffer.from(new Uint8Array(64).fill(fill + 1)).toString("base64"),
  });
  const pkOf = (fill: number): string => Buffer.from(new Uint8Array(32).fill(fill)).toString("base64");
  const readServices = (backend: InMemoryBackend): string[] => backend.reads.map((r) => r.service);

  test("`dev.remotepi.pi` entry → copied to the new service, legacy entry kept", async () => {
    const backend = new InMemoryBackend();
    backend.store.set(`${LEGACY_PI_SERVICE}|${ACCOUNT}`, entry(7));
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);

    const kp = await getOrCreateEd25519Keypair();

    // Preserved identity, written under the new service.
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(pkOf(7));
    expect(backend.store.get(`${NEW_SERVICE}|${ACCOUNT}`)).toBe(entry(7));
    // A rename never deletes the user's secret: the legacy entry stays put.
    expect(backend.store.get(`${LEGACY_PI_SERVICE}|${ACCOUNT}`)).toBe(entry(7));
    expect(backend.deletes).toEqual([]);
  });

  test("`dev.remotepi.mac` (keytar era) entry → copied to the new service, legacy entry kept", async () => {
    const backend = new InMemoryBackend();
    backend.store.set(`${LEGACY_MAC_SERVICE}|${ACCOUNT}`, entry(5));
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);

    const kp = await getOrCreateEd25519Keypair();

    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(pkOf(5));
    expect(backend.store.get(`${NEW_SERVICE}|${ACCOUNT}`)).toBe(entry(5));
    expect(backend.store.get(`${LEGACY_MAC_SERVICE}|${ACCOUNT}`)).toBe(entry(5));
    expect(backend.deletes).toEqual([]);
    // Looked at the Remote Pi service first, then fell through to the keytar-era one.
    expect(readServices(backend)).toEqual([NEW_SERVICE, LEGACY_PI_SERVICE, LEGACY_MAC_SERVICE]);
  });

  test("both legacy entries present → `dev.remotepi.pi` wins and the keytar-era entry is not even read", async () => {
    const backend = new InMemoryBackend();
    backend.store.set(`${LEGACY_PI_SERVICE}|${ACCOUNT}`, entry(7));
    backend.store.set(`${LEGACY_MAC_SERVICE}|${ACCOUNT}`, entry(9));
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);

    const kp = await getOrCreateEd25519Keypair();

    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(pkOf(7));
    expect(backend.store.get(`${NEW_SERVICE}|${ACCOUNT}`)).toBe(entry(7));
    expect(readServices(backend)).toEqual([NEW_SERVICE, LEGACY_PI_SERVICE]);
    expect(backend.deletes).toEqual([]);
  });

  test("new entry already present → it wins and the legacy entries are never read, written or deleted", async () => {
    const backend = new InMemoryBackend();
    backend.store.set(`${NEW_SERVICE}|${ACCOUNT}`, entry(3));
    backend.store.set(`${LEGACY_PI_SERVICE}|${ACCOUNT}`, entry(9));
    backend.store.set(`${LEGACY_MAC_SERVICE}|${ACCOUNT}`, entry(5));
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);

    const kp = await getOrCreateEd25519Keypair();

    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(pkOf(3));
    expect(readServices(backend)).toEqual([NEW_SERVICE]);
    expect(backend.writes).toEqual([]);
    expect(backend.deletes).toEqual([]);
    expect(backend.store.get(`${LEGACY_PI_SERVICE}|${ACCOUNT}`)).toBe(entry(9));
    expect(backend.store.get(`${LEGACY_MAC_SERVICE}|${ACCOUNT}`)).toBe(entry(5));
  });

  test("the copy is one-shot: a second call is served by the new service alone", async () => {
    const backend = new InMemoryBackend();
    backend.store.set(`${LEGACY_PI_SERVICE}|${ACCOUNT}`, entry(7));
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);
    await getOrCreateEd25519Keypair();
    backend.reads.length = 0;
    backend.writes.length = 0;

    const again = await getOrCreateEd25519Keypair();

    expect(Buffer.from(again.publicKey).toString("base64")).toBe(pkOf(7));
    expect(readServices(backend)).toEqual([NEW_SERVICE]);
    expect(backend.writes).toEqual([]);
  });

  test("a migrated identity is pinned to identity.json on a non-durable keyring", async () => {
    const beforeReboot = new InMemoryBackend();
    beforeReboot.store.set(`${LEGACY_PI_SERVICE}|${ACCOUNT}`, entry(7));
    _setKeyStoreBackendForTest(beforeReboot);
    _setKeyringExpectedForTest(false);  // Linux without a Secret Service

    await getOrCreateEd25519Keypair();
    expect(existsSync(_identityFileForTest())).toBe(true);

    // Reboot: kernel keyrings are wiped (legacy entry included), the file system is not.
    _setKeyStoreBackendForTest(new InMemoryBackend());
    const afterReboot = await getOrCreateEd25519Keypair();
    expect(Buffer.from(afterReboot.publicKey).toString("base64")).toBe(pkOf(7));
  });

  test("a transient write failure while copying is retried and still migrates (nothing deleted)", async () => {
    const backend = new InMemoryBackend();
    backend.store.set(`${LEGACY_PI_SERVICE}|${ACCOUNT}`, entry(7));
    backend.failNext("write");  // the copy into the new service throws once
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);

    const kp = await getOrCreateEd25519Keypair();

    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(pkOf(7));
    expect(backend.store.get(`${NEW_SERVICE}|${ACCOUNT}`)).toBe(entry(7));
    expect(backend.store.get(`${LEGACY_PI_SERVICE}|${ACCOUNT}`)).toBe(entry(7));
    expect(backend.deletes).toEqual([]);
  });

  test("a transiently unreadable legacy service is retried, then migrates", async () => {
    const backend = new InMemoryBackend();
    backend.store.set(`${LEGACY_PI_SERVICE}|${ACCOUNT}`, entry(7));
    backend.failReadsOf(LEGACY_PI_SERVICE, { once: true });  // e.g. a Keychain that is still locked
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);

    const kp = await getOrCreateEd25519Keypair();

    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(pkOf(7));
    expect(backend.store.get(`${NEW_SERVICE}|${ACCOUNT}`)).toBe(entry(7));
    expect(backend.deletes).toEqual([]);
  });

  test("a persistently unreadable legacy service on a core-keyring platform refuses to mint a new identity", async () => {
    const backend = new InMemoryBackend();
    backend.failReadsOf(LEGACY_PI_SERVICE);
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);  // macOS/Windows

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(KeyringUnavailableError);
    // The legacy entry may still hold the paired key, so nothing was minted or written.
    expect(backend.writes).toEqual([]);
    expect(existsSync(_identityFileForTest())).toBe(false);
  });
});

// ── Headless fallback ───────────────────────────────────────────────────────

describe("getOrCreateEd25519Keypair — headless Linux fallback", () => {
  test("keyring read throws persistently (no keyring expected) → falls back to identity.json (chmod 0o600)", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);  // simulate headless Linux (no core keyring)

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey.length).toBe(32);

    // File exists at the expected path with restrictive perms.
    expect(existsSync(_identityFileForTest())).toBe(true);
    // POSIX-only: `chmod 0o600` is a no-op on Windows (NTFS perms aren't the
    // POSIX bits + Node reports a fixed mode), so only assert the perm bits
    // off Windows. The file-creation + fallback behavior is checked above.
    if (process.platform !== "win32") {
      const stat = statSync(_identityFileForTest());
      const perms = stat.mode & 0o777;
      expect(perms & 0o077).toBe(0);  // group + other bits zero
    }

    // Round-trip: parse and check it deserializes to the same key.
    const parsed = JSON.parse(readFileSync(_identityFileForTest(), "utf8")) as { pk: string; sk: string };
    expect(Buffer.from(parsed.pk, "base64").length).toBe(32);
  });

  test("fallback second call returns the file-stored key (no regen)", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);
    const first = await getOrCreateEd25519Keypair();

    // Reset the backend so it would throw again on a fresh read.
    const backend2 = new InMemoryBackend();
    backend2.failAll("read");
    _setKeyStoreBackendForTest(backend2);
    const second = await getOrCreateEd25519Keypair();

    expect(Buffer.from(first.publicKey).toString("base64")).toBe(
      Buffer.from(second.publicKey).toString("base64"),
    );
  });

});

// ── Locked-keychain protection (the "lost pairing after a week idle" bug) ────

// ── Native binding cannot load (issue #113 — Bun-built omp) ─────────────────

describe("getOrCreateEd25519Keypair — @napi-rs/keyring binding unavailable", () => {
  test("a binding that never loads falls back to the file identity even on a core-keyring platform", async () => {
    // A load failure is deterministic: no unlock or retry will fix it, so the
    // "keyring is locked, refuse to regenerate" guard must not fire — that
    // would leave the user with no working path at all (issue #113).
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(null);  // real platform check (darwin/win32 on CI hosts)
    _setNativeBindingErrorForTest(new Error("Cannot find native binding."));

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey).toHaveLength(32);
    expect(existsSync(_identityFileForTest())).toBe(true);

    // Second call is stable — same identity, read straight off the file.
    const again = await getOrCreateEd25519Keypair();
    expect(Buffer.from(again.publicKey).toString("base64"))
      .toBe(Buffer.from(kp.publicKey).toString("base64"));
  });

  test("with the binding loadable, a locked core keyring still refuses to regenerate", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(null);
    _setNativeBindingErrorForTest(null);
    // Only meaningful on a platform whose keyring is a core OS service.
    if (process.platform !== "darwin" && process.platform !== "win32") return;

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(KeyringUnavailableError);
    expect(existsSync(_identityFileForTest())).toBe(false);
  });
});

describe("getOrCreateEd25519Keypair — locked keyring does NOT regenerate", () => {
  test("transient read failure recovers via retry → uses keyring entry, no file written", async () => {
    const backend = new InMemoryBackend();
    const original = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(6)).toString("base64"),
    });
    backend.store.set(`${NEW_SERVICE}|${ACCOUNT}`, original);
    backend.failNext("read");  // first read throws, retry succeeds
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);  // macOS/Windows: keyring is core

    const kp = await getOrCreateEd25519Keypair();
    // Recovered the ORIGINAL paired key — not a freshly minted one.
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
    );
    expect(backend.reads.length).toBeGreaterThanOrEqual(2);  // retried
    expect(existsSync(_identityFileForTest())).toBe(false);  // no file regen
  });

  test("persistent failure on a core-keyring platform with no file → throws (refuses to regen)", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);  // macOS/Windows

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(KeyringUnavailableError);
    // Critically: no new identity file was written (pairing not silently broken).
    expect(existsSync(_identityFileForTest())).toBe(false);
  });

  test("persistent failure but identity.json already exists → returns the FILE key (never throws, never regen)", async () => {
    // First, create a file identity via the headless path.
    const seed = new InMemoryBackend();
    seed.failAll("read");
    _setKeyStoreBackendForTest(seed);
    _setKeyringExpectedForTest(false);
    const fileKp = await getOrCreateEd25519Keypair();

    // Now the keyring is "core" but locked; the existing file must win.
    const locked = new InMemoryBackend();
    locked.failAll("read");
    _setKeyStoreBackendForTest(locked);
    _setKeyringExpectedForTest(true);
    const kp = await getOrCreateEd25519Keypair();

    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(fileKp.publicKey).toString("base64"),
    );
  });

  test("REMOTE_OMP_ALLOW_FILE_IDENTITY=1 opts into file identity even on a core-keyring platform", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);
    process.env.REMOTE_OMP_ALLOW_FILE_IDENTITY = "1";

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey.length).toBe(32);
    expect(existsSync(_identityFileForTest())).toBe(true);
  });
});

// ── Never mint a new identity over existing pairings (issues #95 / #69) ──────

describe("getOrCreateEd25519Keypair — paired devices block identity minting", () => {
  function seedPairedDevice(): void {
    mkdirSync(_dataDir, { recursive: true });
    writeFileSync(join(_dataDir, "peers.json"), JSON.stringify({
      peers: [{ name: "Phone", remote_epk: "AAAA", paired_at: new Date(0).toISOString() }],
    }));
  }

  test("unreadable keyring + existing pairings → throws instead of minting (daemon case)", async () => {
    // systemd --user resolves a different secret-service store than the desktop
    // session that paired; minting here makes SelfRevoke wipe peers.json.
    seedPairedDevice();
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);  // headless Linux — used to mint silently

    await expect(getOrCreateEd25519Keypair())
      .rejects.toBeInstanceOf(storage.PairedIdentityMissingError);
    expect(existsSync(_identityFileForTest())).toBe(false);
  });

  test("REMOTE_OMP_ALLOW_FILE_IDENTITY=1 still opts out of the guard", async () => {
    seedPairedDevice();
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);
    process.env.REMOTE_OMP_ALLOW_FILE_IDENTITY = "1";

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey).toHaveLength(32);
    expect(existsSync(_identityFileForTest())).toBe(true);
  });

  test("no pairings yet → a genuine first run still mints normally", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey).toHaveLength(32);
    expect(existsSync(_identityFileForTest())).toBe(true);
  });
});

// ── Corrupt peer record isolation ────────────────────────────────────────────

describe("peer record corruption isolation", () => {
  const peersPath = join(_dataDir, "peers.json");

  function writePeers(peers: unknown): void {
    mkdirSync(_dataDir, { recursive: true });
    writeFileSync(peersPath, JSON.stringify({ peers }, null, 2));
  }

  test.each([null, 42, "not-an-array", { remote_epk: "not-an-array" }])(
    "treats a non-array peers value as empty: %j",
    async (peers) => {
      writePeers(peers);

      await expect(storage.listPeers()).resolves.toEqual([]);
      await expect(storage.listOwnerPubkeys()).resolves.toEqual([]);
    },
  );

  test("a false commit guard preserves the exact raw peer record", async () => {
    const rawHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE";
    const peers = [
      { name: "Re-paired Owner", remote_epk: rawHandle, paired_at: "replacement" },
    ];
    writePeers(peers);

    await expect(storage.removePeer(rawHandle, () => false)).resolves.toBe(false);
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({ peers });
  });

  test("removes only the exact raw handle while preserving corrupt entries", async () => {
    const urlSafeHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE";
    const standardHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE=";
    const originalPeers = [
      null,
      42,
      { name: "missing handle" },
      { name: "null handle", remote_epk: null, paired_at: "first" },
      { name: "URL-safe", remote_epk: urlSafeHandle, paired_at: "second" },
      { name: "standard", remote_epk: standardHandle, paired_at: "third" },
    ];
    writePeers(originalPeers);

    await expect(storage.listPeers()).resolves.toEqual(originalPeers);
    await expect(storage.listOwnerPubkeys()).resolves.toEqual([
      null,
      42,
      undefined,
      urlSafeHandle,
      standardHandle,
    ]);
    await expect(storage.removePeer(urlSafeHandle)).resolves.toBe(true);

    const expectedPeers = originalPeers.filter((peer) =>
      !peer ||
      typeof peer !== "object" ||
      (peer as { remote_epk?: unknown }).remote_epk !== urlSafeHandle,
    );
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({
      peers: expectedPeers,
    });
    await expect(storage.removePeer(urlSafeHandle)).resolves.toBe(false);
    await expect(storage.removePeer(standardHandle)).resolves.toBe(true);
  });
});

// ── File identity wins over a READABLE keyring (masking bug) ─────────────────
//
// A file-backed/headless install pairs the mobile against the key in
// `~/.omp/remote/identity.json`. If the platform keyring later becomes readable
// (D-Bus/libsecret installed, a desktop session, a stale entry from another
// install), consulting it FIRST would mask the file identity — returning a
// different key, or minting a fresh one over an empty keyring — and break the
// existing pairing. The file must win. (These cases differ from the
// "locked keyring" ones above: here the keyring READS FINE, it just isn't the
// paired identity.)

describe("getOrCreateEd25519Keypair — file identity wins over a readable keyring", () => {
  /** Seed a file-backed identity via the headless path and return its key. */
  async function seedFileIdentity() {
    const seed = new InMemoryBackend();
    seed.failAll("read");
    _setKeyStoreBackendForTest(seed);
    _setKeyringExpectedForTest(false);  // headless Linux → writes identity.json
    const fileKp = await getOrCreateEd25519Keypair();
    expect(existsSync(_identityFileForTest())).toBe(true);
    return fileKp;
  }

  test("readable keyring holding a DIFFERENT entry → file identity still wins", async () => {
    const fileKp = await seedFileIdentity();

    // A fully-readable keyring now holds a DIFFERENT identity.
    const keyring = new InMemoryBackend();
    const otherPk = Buffer.from(new Uint8Array(32).fill(42)).toString("base64");
    keyring.store.set(`${NEW_SERVICE}|${ACCOUNT}`, JSON.stringify({
      pk: otherPk,
      sk: Buffer.from(new Uint8Array(64).fill(43)).toString("base64"),
    }));
    _setKeyStoreBackendForTest(keyring);
    _setKeyringExpectedForTest(true);  // even on a core-keyring platform

    const kp = await getOrCreateEd25519Keypair();
    // File identity wins — the mobile is paired against it.
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(fileKp.publicKey).toString("base64"),
    );
    expect(Buffer.from(kp.publicKey).toString("base64")).not.toBe(otherPk);
    // The keyring is never consulted — the file short-circuits ahead of it.
    expect(keyring.reads.length).toBe(0);
    expect(keyring.writes.length).toBe(0);
    expect(keyring.deletes.length).toBe(0);
  });

  test("readable but EMPTY keyring → does NOT mint a fresh key over identity.json", async () => {
    const fileKp = await seedFileIdentity();

    // A readable but EMPTY keyring appears (e.g. libsecret installed later).
    const keyring = new InMemoryBackend();
    _setKeyStoreBackendForTest(keyring);
    _setKeyringExpectedForTest(true);

    const kp = await getOrCreateEd25519Keypair();
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(fileKp.publicKey).toString("base64"),
    );
    // Critically: no fresh keypair was generated + written into the keyring
    // (that write is exactly what masked the file identity and broke pairing).
    expect(keyring.reads.length).toBe(0);
    expect(keyring.writes.length).toBe(0);
  });
});


describe("owner snapshot mutation tokens", () => {
  const peersPath = join(_dataDir, "peers.json");
  const snapshotStorage = storage as typeof storage & {
    snapshotOwnerPubkeys(): Promise<readonly { rawOwnerPubkey: unknown; token: unknown }[]>;
    conditionalRemovePeer(remoteEpk: string, expectedToken: unknown): Promise<{ outcome: string }>;
  };

  function writePeers(peers: unknown): void {
    mkdirSync(_dataDir, { recursive: true });
    writeFileSync(peersPath, JSON.stringify({ peers }, null, 2));
  }

  test("stale re-pair token preserves the replacement record", async () => {
    const rawHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE=";
    const original = { name: "first", remote_epk: rawHandle, paired_at: "first" };
    const replacement = { name: "replacement", remote_epk: rawHandle, paired_at: "replacement" };
    writePeers([original]);

    const [snapshot] = await snapshotStorage.snapshotOwnerPubkeys();
    await storage.addPeer(replacement);
    await expect(snapshotStorage.conditionalRemovePeer(rawHandle, snapshot!.token))
      .resolves.toMatchObject({ outcome: "stale" });
    expect(readFileSync(peersPath, "utf8")).toBe(JSON.stringify({ peers: [replacement] }, null, 2));
  });

  test("current token removes only its exact raw representation", async () => {
    const urlSafeHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE";
    const standardHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE=";
    writePeers([
      { name: "url", remote_epk: urlSafeHandle, paired_at: "first" },
      { name: "standard", remote_epk: standardHandle, paired_at: "second" },
    ]);

    const snapshot = await snapshotStorage.snapshotOwnerPubkeys();
    const token = snapshot.find((entry) => entry.rawOwnerPubkey === urlSafeHandle)!.token;
    await expect(snapshotStorage.conditionalRemovePeer(urlSafeHandle, token))
      .resolves.toMatchObject({ outcome: "removed" });
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({
      peers: [{ name: "standard", remote_epk: standardHandle, paired_at: "second" }],
    });
  });
});

// ── The data dir follows REMOTE_OMP_HOME at call time ────────────────────────

describe("data dir is resolved at call time, not import time", () => {
  test("peers.json and identity.json follow REMOTE_OMP_HOME as it changes", async () => {
    const other = mkdtempSync(join(tmpdir(), "omp-storage-other-"));
    try {
      process.env["REMOTE_OMP_HOME"] = other;
      const otherDir = join(other, ".omp", "remote");

      await storage.addPeer({ name: "Phone", remote_epk: "AAAA", paired_at: new Date(0).toISOString() });

      expect(existsSync(join(otherDir, "peers.json"))).toBe(true);
      expect(existsSync(join(_dataDir, "peers.json"))).toBe(false);
      expect(_identityFileForTest()).toBe(join(otherDir, "identity.json"));
      await expect(storage.listPeers()).resolves.toHaveLength(1);

      // Back on the suite's own home: the first one's peer list is not visible here.
      process.env["REMOTE_OMP_HOME"] = _tmpHome;
      await expect(storage.listPeers()).resolves.toEqual([]);
      expect(_identityFileForTest()).toBe(join(_dataDir, "identity.json"));
    } finally {
      process.env["REMOTE_OMP_HOME"] = _tmpHome;
      rmSync(other, { recursive: true, force: true });
    }
  });
});

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PeerChannel } from "../transport/peer_channel.js";
import type { ClientMessage, ServerMessage } from "../protocol/types.js";
import {
  FILE_CHUNK_BYTES,
  FileSender,
  SendFileError,
  chooseTargetPhone,
  guessMime,
  maxSendBytes,
  registerSendToPhoneTool,
  type PhonePresence,
  type PhoneRegistry,
} from "./send_file.js";

const MiB = 1024 * 1024;

type Frame = Extract<ServerMessage, { type: `file_${string}` }>;

/**
 * Fake phone: records every frame, reassembles chunks, and (when `autoAck`)
 * answers each chunk with a cumulative `file_ack` and `file_end` with
 * `file_done` once the SHA matches — the receiver contract from plan/65.
 */
class FakePhone implements PeerChannel {
  frames: Frame[] = [];
  received = new Map<number, Buffer>();
  offline = false;  // frames sent while offline are lost (relay drops them)
  dropOnce = new Set<number>();  // chunk seqs lost in transit, once each
  autoAck = true;
  sender: FileSender | null = null;
  maxUnacked = 0;
  /** Set by a delivered file_offer: like the app, chunks of an unknown file are ignored. */
  knowsOffer = false;
  private nextSeq = 0;
  private sha = "";

  constructor(readonly id: string) {}

  send(msg: ServerMessage): void {
    if (!msg.type.startsWith("file_")) return;
    const frame = msg as Frame;
    this.frames.push(frame);
    if (this.offline) return;
    switch (frame.type) {
      case "file_offer":
        // The app acks every offer (a repeat too) with its current next_seq.
        this.sha = frame.sha256;
        this.knowsOffer = true;
        if (this.autoAck) this.reply({ type: "file_ack", file_id: frame.file_id, next_seq: this.nextSeq });
        break;
      case "file_chunk": {
        if (!this.knowsOffer) return;
        if (this.dropOnce.delete(frame.seq)) return;
        this.maxUnacked = Math.max(this.maxUnacked, frame.seq + 1 - this.nextSeq);
        this.received.set(frame.seq, Buffer.from(frame.data, "base64"));
        this.nextSeq = 0;
        while (this.received.has(this.nextSeq)) this.nextSeq += 1;
        if (this.autoAck) this.reply({ type: "file_ack", file_id: frame.file_id, next_seq: this.nextSeq });
        break;
      }
      case "file_end":
        if (this.autoAck && this.nextSeq === frame.chunks) {
          const ok = createHash("sha256").update(this.assembled()).digest("hex") === this.sha;
          this.reply(ok
            ? { type: "file_done", file_id: frame.file_id }
            : { type: "file_error", file_id: frame.file_id, reason: "sha_mismatch" });
        }
        break;
      default:
        break;
    }
  }

  /** Phone → ext frame, delivered async like the relay would. */
  reply(msg: ClientMessage): void {
    queueMicrotask(() => this.sender?.handleMessage(this.id, msg));
  }

  /** Cumulative ack as tracked by the fake receiver. */
  get next(): number {
    return this.nextSeq;
  }

  assembled(): Buffer {
    const parts: Buffer[] = [];
    for (let i = 0; this.received.has(i); i += 1) parts.push(this.received.get(i)!);
    return Buffer.concat(parts);
  }

  chunks(): Extract<Frame, { type: "file_chunk" }>[] {
    return this.frames.filter((f): f is Extract<Frame, { type: "file_chunk" }> => f.type === "file_chunk");
  }
}

function registry(phones: FakePhone[], latest: string | null = null): PhoneRegistry & {
  phones: Map<string, FakePhone>;
  latest: string | null;
  states: Map<string, PhonePresence>;
} {
  const map = new Map(phones.map((p) => [p.id, p]));
  return {
    phones: map,
    latest,
    states: new Map(),
    online() { return this.phones; },
    latestInputDevice() { return this.latest; },
    deviceName(id: string) { return `Device ${id}`; },
    presence(id: string) { return this.states.get(id) ?? "unknown"; },
  };
}

/** Relay presence change as index.ts reports it: registry first, then the sender. */
function setPresence(reg: ReturnType<typeof registry>, sender: FileSender, id: string, online: boolean): void {
  reg.states.set(id, online ? "online" : "offline");
  sender.onPresence(id, online);
}

function fileIdOf(phone: FakePhone): string {
  return (phone.frames[0] as { file_id: string }).file_id;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "send-file-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["REMOTE_PI_MAX_SEND_MIB"];
});

function writeFile(name: string, bytes: Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("FileSender — chunking and integrity", () => {
  test("a 5 MiB file arrives as 5 chunks of 1 MiB with the right SHA", async () => {
    const bytes = randomBytes(5 * MiB);
    const path = writeFile("build.apk", bytes);
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;

    const result = await sender.send({ path, caption: "fresh build", turnId: "t-1" });

    expect(FILE_CHUNK_BYTES).toBe(MiB);
    const offer = phone.frames[0]!;
    expect(offer).toMatchObject({
      type: "file_offer",
      name: "build.apk",
      mime: "application/vnd.android.package-archive",
      size: 5 * MiB,
      sha256: sha(bytes),
      caption: "fresh build",
      turn_id: "t-1",
    });
    const chunks = phone.chunks();
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4]);
    for (const c of chunks) {
      expect(c.file_id).toBe((offer as { file_id: string }).file_id);
      expect(Buffer.from(c.data, "base64").length).toBe(MiB);
    }
    expect(phone.frames.filter((f) => f.type === "file_end")).toEqual([
      { type: "file_end", file_id: (offer as { file_id: string }).file_id, chunks: 5 },
    ]);
    expect(sha(phone.assembled())).toBe(sha(bytes));
    expect(result).toMatchObject({ name: "build.apk", size: 5 * MiB, device: "Device p1" });
  });

  test("a partial last chunk and an empty file are sent correctly", async () => {
    const bytes = randomBytes(2 * MiB + 17);
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    await sender.send({ path: writeFile("a.bin", bytes) });
    expect(phone.chunks().map((c) => Buffer.from(c.data, "base64").length)).toEqual([MiB, MiB, 17]);
    expect(sha(phone.assembled())).toBe(sha(bytes));

    const empty = new FakePhone("p2");
    const sender2 = new FileSender(registry([empty], "p2"));
    empty.sender = sender2;
    const res = await sender2.send({ path: writeFile("empty.txt", Buffer.alloc(0)) });
    expect(empty.chunks()).toHaveLength(0);
    expect(empty.frames.map((f) => f.type)).toEqual(["file_offer", "file_end"]);
    expect(res.size).toBe(0);
  });

  test("file_error sha_mismatch from the phone fails the transfer with that reason", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("x.pdf", randomBytes(100)) });
    await vi.waitFor(() => expect(phone.frames.some((f) => f.type === "file_end")).toBe(true));
    const fileId = (phone.frames[0] as { file_id: string }).file_id;
    phone.reply({ type: "file_error", file_id: fileId, reason: "sha_mismatch" });
    await expect(pending).rejects.toMatchObject({ code: "sha_mismatch" });
    expect(sender.activeCount()).toBe(0);
  });

  test("file_cancel from the phone fails the transfer as cancelled", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("x.zip", randomBytes(3 * MiB)) });
    await vi.waitFor(() => expect(phone.chunks().length).toBeGreaterThan(0));
    phone.reply({ type: "file_cancel", file_id: (phone.frames[0] as { file_id: string }).file_id });
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  test("frames from another phone or for an unknown file_id are ignored", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("x.txt", Buffer.from("hello")) });
    await vi.waitFor(() => expect(phone.frames.some((f) => f.type === "file_end")).toBe(true));
    const fileId = (phone.frames[0] as { file_id: string }).file_id;
    expect(sender.handleMessage("intruder", { type: "file_done", file_id: fileId })).toBe(true);
    expect(sender.handleMessage("p1", { type: "file_done", file_id: "nope" })).toBe(true);
    expect(sender.activeCount()).toBe(1);
    // Non-file frames are not the sender's business.
    expect(sender.handleMessage("p1", { type: "ping", id: "x" })).toBe(false);
    sender.handleMessage("p1", { type: "file_done", file_id: fileId });
    await expect(pending).resolves.toMatchObject({ name: "x.txt", size: 5 });
  });
});

describe("FileSender — flow control", () => {
  test("never more than 4 chunks are unacked", async () => {
    const bytes = randomBytes(12 * MiB);
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("big.bin", bytes) });

    // Ack lazily, one chunk at a time, checking the window before every ack.
    let acked = 0;
    while (acked < 12) {
      await vi.waitFor(() => expect(phone.chunks().length).toBeGreaterThan(acked));
      // Let the pump run as far as the window allows.
      await new Promise((r) => setTimeout(r, 5));
      const sent = phone.chunks().length;
      expect(sent - acked).toBeLessThanOrEqual(4);
      acked += 1;
      sender.handleMessage("p1", { type: "file_ack", file_id: phone.chunks()[0]!.file_id, next_seq: acked });
    }
    await vi.waitFor(() => expect(phone.frames.some((f) => f.type === "file_end")).toBe(true));
    sender.handleMessage("p1", { type: "file_done", file_id: phone.chunks()[0]!.file_id });
    await pending;
    expect(phone.chunks()).toHaveLength(12);
    expect(sha(phone.assembled())).toBe(sha(bytes));
  });

  test("with no acks at all, exactly 4 chunks go out and the sender waits", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    const ac = new AbortController();
    const pending = sender.send({ path: writeFile("big.bin", randomBytes(9 * MiB)), signal: ac.signal });
    await vi.waitFor(() => expect(phone.chunks().length).toBe(4));
    await new Promise((r) => setTimeout(r, 30));
    expect(phone.chunks().length).toBe(4);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  test("auto-acking phone sees at most 4 unacked chunks on a 10 MiB file", async () => {
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    await sender.send({ path: writeFile("big.bin", randomBytes(10 * MiB)) });
    expect(phone.maxUnacked).toBeLessThanOrEqual(4);
    expect(phone.chunks()).toHaveLength(10);
  });
});

describe("FileSender — resume", () => {
  test("a reconnect with next_seq=3 resumes at 3", async () => {
    const bytes = randomBytes(5 * MiB);
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    phone.dropOnce.add(3);  // phone stores 0..2, then the link dies
    const reg = registry([phone], "p1");
    const sender = new FileSender(reg);
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("r.apk", bytes) });

    await vi.waitFor(() => expect(phone.chunks().length).toBe(4));
    const fileId = phone.chunks()[0]!.file_id;
    // The phone's channel is re-attached on reconnect: the sender probes the
    // first chunk it has no ack for, then waits for the phone's file_ack.
    sender.onPhoneAttached("p1");
    await vi.waitFor(() => expect(phone.chunks().length).toBe(5));
    expect(phone.chunks()[4]!.seq).toBe(0);
    const before = phone.chunks().length;
    phone.autoAck = true;
    sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 3 });
    await pending;

    expect(phone.chunks().slice(before).map((c) => c.seq)).toEqual([3, 4]);
    expect(sha(phone.assembled())).toBe(sha(bytes));
  });

  test("silent drop: retransmit probe, then the phone's next_seq=3 resumes at 3", async () => {
    const bytes = randomBytes(6 * MiB);
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    phone.dropOnce.add(3);
    const sender = new FileSender(registry([phone], "p1"), { retransmitMs: 20 });
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("r.bin", bytes) });

    // No ack → after the retransmit timeout the sender probes seq 0 only
    // (one chunk per timeout, never the whole window again).
    await vi.waitFor(() => expect(phone.chunks().length).toBeGreaterThan(4));
    const fileId = phone.chunks()[0]!.file_id;
    expect(phone.chunks().slice(0, 4).map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    expect(new Set(phone.chunks().slice(4).map((c) => c.seq))).toEqual(new Set([0]));
    const before = phone.chunks().length;
    phone.autoAck = true;
    sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 3 });
    await pending;

    const resumed = phone.chunks().slice(before).map((c) => c.seq);
    expect(resumed.slice(0, 3)).toEqual([3, 4, 5]);
    expect(sha(phone.assembled())).toBe(sha(bytes));
  });

  test("a phone that missed the file_offer can start: every probe re-sends the offer first", async () => {
    // The incident of 2026-10-22: the relay dropped the offer and every chunk.
    const bytes = randomBytes(3 * MiB);
    const phone = new FakePhone("p1");
    phone.offline = true;
    const sender = new FileSender(registry([phone], "p1"), { retransmitMs: 20, offerAckMs: 5_000 });
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("lost.pdf", bytes) });
    await vi.waitFor(() => expect(phone.chunks().length).toBeGreaterThan(4));
    expect(phone.knowsOffer).toBe(false);
    phone.offline = false;  // back, but it never saw the first offer
    await pending;
    expect(sha(phone.assembled())).toBe(sha(bytes));
    // Each probe chunk follows a fresh file_offer.
    const types = phone.frames.map((f) => f.type);
    for (let i = 4; i < types.length; i += 1) {
      if (types[i] === "file_chunk" && types[i - 1] !== "file_chunk" && types[i - 1] !== "file_offer") {
        throw new Error(`probe chunk at ${i} without an offer before it: ${types.slice(0, i + 1).join(",")}`);
      }
    }
    expect(types.filter((t) => t === "file_offer").length).toBeGreaterThan(1);
  });

  test("the attach probe sends file_offer before the first unacked chunk", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    const ac = new AbortController();
    const pending = sender.send({ path: writeFile("a.bin", randomBytes(5 * MiB)), signal: ac.signal });
    await vi.waitFor(() => expect(phone.chunks().length).toBe(4));
    const before = phone.frames.length;
    sender.onPhoneAttached("p1");
    await vi.waitFor(() => expect(phone.frames.length).toBe(before + 2));
    expect(phone.frames.slice(before).map((f) => f.type)).toEqual(["file_offer", "file_chunk"]);
    expect(phone.frames.at(-1)).toMatchObject({ type: "file_chunk", seq: 0 });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("FileSender — timeouts", () => {
  test("defaults: offer ack 30 s, stall 60 s, offline grace 60 s, offline wait 20 s", () => {
    const sender = new FileSender(registry([]));
    expect(sender.offerAckMs).toBe(30_000);
    expect(sender.stallMs).toBe(60_000);
    expect(sender.offlineGraceMs).toBe(60_000);
    expect(sender.offlineWaitMs).toBe(20_000);
    expect(sender.retransmitMaxMs).toBeLessThan(sender.stallMs);
    expect((sender as unknown as Record<string, unknown>)["resumeWindowMs"]).toBeUndefined();
  });

  test("no ack for the file_offer → phone_unreachable and file_cancel", async () => {
    const phone = new FakePhone("p1");
    phone.offline = true;  // relay drops everything, sender cannot tell
    const sender = new FileSender(registry([phone], "p1"), { offerAckMs: 60, retransmitMs: 20 });
    phone.sender = sender;
    const started = Date.now();
    const err = await sender.send({ path: writeFile("t.bin", randomBytes(2 * MiB)) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "phone_unreachable" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(phone.frames.at(-1)).toMatchObject({ type: "file_cancel" });
    expect(sender.activeCount()).toBe(0);
  });

  test("an offer ack with next_seq 0 counts: the offer timer stops", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const sender = new FileSender(registry([phone], "p1"), { offerAckMs: 150, stallMs: 5_000 });
    phone.sender = sender;
    const ac = new AbortController();
    const pending = sender.send({ path: writeFile("t.bin", randomBytes(2 * MiB)), signal: ac.signal });
    await vi.waitFor(() => expect(phone.frames.length).toBeGreaterThan(0), { interval: 1 });
    sender.handleMessage("p1", { type: "file_ack", file_id: fileIdOf(phone), next_seq: 0 });
    await new Promise((r) => setTimeout(r, 250));
    expect(sender.activeCount()).toBe(1);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  test("acks stop mid-transfer → stalled after the stall window, with file_cancel", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const sender = new FileSender(registry([phone], "p1"), { stallMs: 60, retransmitMs: 20 });
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("s.bin", randomBytes(4 * MiB)) });
    await vi.waitFor(() => expect(phone.chunks().length).toBeGreaterThanOrEqual(4), { interval: 1 });
    const fileId = fileIdOf(phone);
    sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 0 });
    sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 1 });
    // Probe answers that repeat the same position are not progress.
    const timer = setInterval(() => sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 1 }), 10);
    try {
      const err = await pending.catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "stalled" });
      expect(String((err as Error).message)).toMatch(/25%/);
    } finally {
      clearInterval(timer);
    }
    expect(phone.frames.at(-1)).toMatchObject({ type: "file_cancel" });
  });

  test("no 10-minute wait: with steady acks a transfer is not cut by the stall window", async () => {
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"), { stallMs: 200 });
    phone.sender = sender;
    await expect(sender.send({ path: writeFile("ok.bin", randomBytes(6 * MiB)) })).resolves.toMatchObject({ chunks: 6 });
  });
});

describe("FileSender — relay presence", () => {
  test("target offline per presence → waits, then phone_offline with a clear message; nothing sent", async () => {
    const phone = new FakePhone("p1");
    const reg = registry([phone], "p1");
    reg.states.set("p1", "offline");
    const sender = new FileSender(reg, { offlineWaitMs: 60 });
    phone.sender = sender;
    const started = Date.now();
    const err = await sender.send({ path: writeFile("a.pdf", randomBytes(100)) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendFileError);
    expect(err).toMatchObject({ code: "phone_offline" });
    expect((err as Error).message).toBe(
      "phone_offline: Remote Pi is not connected on the phone. Ask the user to open the app, then try again.",
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(phone.frames).toHaveLength(0);
    expect(sender.activeCount()).toBe(0);
  });

  test("target offline, then peer_online within the wait → the file is sent", async () => {
    const phone = new FakePhone("p1");
    const reg = registry([phone], "p1");
    reg.states.set("p1", "offline");
    const sender = new FileSender(reg, { offlineWaitMs: 5_000 });
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("a.pdf", randomBytes(100)) });
    await new Promise((r) => setTimeout(r, 30));
    expect(phone.frames).toHaveLength(0);
    setPresence(reg, sender, "p1", true);
    await expect(pending).resolves.toMatchObject({ name: "a.pdf" });
  });

  test("abort during the offline wait rejects with aborted", async () => {
    const phone = new FakePhone("p1");
    const reg = registry([phone], "p1");
    reg.states.set("p1", "offline");
    const sender = new FileSender(reg, { offlineWaitMs: 5_000 });
    const ac = new AbortController();
    const pending = sender.send({ path: writeFile("a.pdf", randomBytes(100)), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  test("the latest phone offline per presence, another one online → the online one", async () => {
    const a = new FakePhone("a");
    const b = new FakePhone("b");
    const reg = registry([a, b], "a");
    reg.states.set("a", "offline");
    reg.states.set("b", "online");
    const sender = new FileSender(reg, { offlineWaitMs: 5_000 });
    b.sender = sender;
    await sender.send({ path: writeFile("t.txt", Buffer.from("hi")) });
    expect(a.frames).toHaveLength(0);
    expect(b.frames.length).toBeGreaterThan(0);
  });

  test("presence unknown → the attached channel is used, as before", async () => {
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"), { offlineWaitMs: 5_000 });
    phone.sender = sender;
    await expect(sender.send({ path: writeFile("t.txt", Buffer.from("hi")) })).resolves.toMatchObject({ size: 2 });
  });

  test("peer_offline mid-transfer pauses; peer_online resumes with file_offer, then the first unacked chunk", async () => {
    const bytes = randomBytes(8 * MiB);
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const reg = registry([phone], "p1");
    reg.states.set("p1", "online");
    const sender = new FileSender(reg, { offlineGraceMs: 5_000, stallMs: 5_000 });
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("big.pdf", bytes) });
    await vi.waitFor(() => expect(phone.chunks().length).toBe(4));
    const fileId = fileIdOf(phone);
    sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 0 });
    sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 2 });
    await vi.waitFor(() => expect(phone.chunks().length).toBe(6));

    // The phone drops: the relay discards what is still in flight.
    phone.offline = true;
    setPresence(reg, sender, "p1", false);
    const pausedAt = phone.frames.length;
    sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 3 });  // a late ack
    await new Promise((r) => setTimeout(r, 40));
    expect(phone.frames.length).toBe(pausedAt);  // paused: nothing sent while offline

    phone.offline = false;
    phone.autoAck = true;
    setPresence(reg, sender, "p1", true);
    await pending;
    const resumed = phone.frames.slice(pausedAt);
    expect(resumed[0]).toMatchObject({ type: "file_offer", file_id: fileId });
    expect(resumed[1]).toMatchObject({ type: "file_chunk", seq: 3 });
    expect(sha(phone.assembled())).toBe(sha(bytes));
  });

  test("offline longer than the grace → phone_offline with the percentage received", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const reg = registry([phone], "p1");
    reg.states.set("p1", "online");
    const sender = new FileSender(reg, { offlineGraceMs: 60, stallMs: 5_000 });
    phone.sender = sender;
    const pending = sender.send({ path: writeFile("big.pdf", randomBytes(4 * MiB)) });
    await vi.waitFor(() => expect(phone.chunks().length).toBe(4));
    const fileId = fileIdOf(phone);
    sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 0 });
    sender.handleMessage("p1", { type: "file_ack", file_id: fileId, next_seq: 2 });
    setPresence(reg, sender, "p1", false);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "phone_offline" });
    expect((err as Error).message).toMatch(/50%/);
    expect(phone.frames.at(-1)).toMatchObject({ type: "file_cancel" });
    expect(sender.activeCount()).toBe(0);
  });

  test("the offer and stall timers do not run while paused", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const reg = registry([phone], "p1");
    reg.states.set("p1", "online");
    const sender = new FileSender(reg, { offerAckMs: 100, stallMs: 100, offlineGraceMs: 5_000 });
    phone.sender = sender;
    const ac = new AbortController();
    const pending = sender.send({ path: writeFile("p.bin", randomBytes(2 * MiB)), signal: ac.signal });
    await vi.waitFor(() => expect(phone.frames.length).toBeGreaterThan(0), { interval: 1 });
    setPresence(reg, sender, "p1", false);
    await new Promise((r) => setTimeout(r, 200));
    expect(sender.activeCount()).toBe(1);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("FileSender — abort", () => {
  test("abort sends file_cancel and rejects with aborted", async () => {
    const phone = new FakePhone("p1");
    phone.autoAck = false;
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    const ac = new AbortController();
    const pending = sender.send({ path: writeFile("a.bin", randomBytes(3 * MiB)), signal: ac.signal });
    await vi.waitFor(() => expect(phone.chunks().length).toBeGreaterThan(0));
    const fileId = phone.chunks()[0]!.file_id;
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(phone.frames.at(-1)).toEqual({ type: "file_cancel", file_id: fileId });
    expect(sender.activeCount()).toBe(0);
  });

  test("an already-aborted signal sends nothing", async () => {
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"));
    const ac = new AbortController();
    ac.abort();
    await expect(sender.send({ path: writeFile("a.txt", Buffer.from("x")), signal: ac.signal }))
      .rejects.toMatchObject({ code: "aborted" });
    expect(phone.frames).toHaveLength(0);
  });
});

describe("FileSender — rejected before any frame", () => {
  test("missing path → not_found", async () => {
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"));
    await expect(sender.send({ path: join(dir, "nope.apk") })).rejects.toMatchObject({ code: "not_found" });
    expect(phone.frames).toHaveLength(0);
  });

  test("directory → not_a_file", async () => {
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"));
    mkdirSync(join(dir, "sub"));
    await expect(sender.send({ path: join(dir, "sub") })).rejects.toMatchObject({ code: "not_a_file" });
    expect(phone.frames).toHaveLength(0);
  });

  test("file over the cap → too_large (cap from REMOTE_PI_MAX_SEND_MIB)", async () => {
    process.env["REMOTE_PI_MAX_SEND_MIB"] = "1";
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"));
    const err = await sender.send({ path: writeFile("big.bin", randomBytes(MiB + 1)) }).catch((e) => e);
    expect(err).toBeInstanceOf(SendFileError);
    expect(err.code).toBe("too_large");
    expect(phone.frames).toHaveLength(0);
  });

  test("relative paths resolve against cwd", async () => {
    writeFile("rel.txt", Buffer.from("rel"));
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    await expect(sender.send({ path: "rel.txt", cwd: dir })).resolves.toMatchObject({ name: "rel.txt", size: 3 });
  });

  test("no online phone → phone_offline, nothing queued", async () => {
    const sender = new FileSender(registry([], "gone"));
    await expect(sender.send({ path: writeFile("a.txt", Buffer.from("x")) }))
      .rejects.toMatchObject({ code: "phone_offline" });
    expect(sender.activeCount()).toBe(0);
  });
});

describe("cap and helpers", () => {
  test("maxSendBytes defaults to 256 MiB and honours REMOTE_PI_MAX_SEND_MIB", () => {
    expect(maxSendBytes({})).toBe(256 * MiB);
    expect(maxSendBytes({ REMOTE_PI_MAX_SEND_MIB: "64" })).toBe(64 * MiB);
    expect(maxSendBytes({ REMOTE_PI_MAX_SEND_MIB: "junk" })).toBe(256 * MiB);
    expect(maxSendBytes({ REMOTE_PI_MAX_SEND_MIB: "0" })).toBe(256 * MiB);
  });

  test("guessMime covers the common cases", () => {
    expect(guessMime("a.apk")).toBe("application/vnd.android.package-archive");
    expect(guessMime("A.PDF")).toBe("application/pdf");
    expect(guessMime("README.md")).toBe("text/markdown");
    expect(guessMime("noext")).toBe("application/octet-stream");
  });
});

describe("chooseTargetPhone", () => {
  const ch: PeerChannel = { send: () => undefined };
  test("the phone that sent the latest input wins when online", () => {
    expect(chooseTargetPhone(new Map([["a", ch], ["b", ch]]), "a")).toBe("a");
  });
  test("latest phone offline → the only other online phone", () => {
    expect(chooseTargetPhone(new Map([["b", ch]]), "a")).toBe("b");
    expect(chooseTargetPhone(new Map([["b", ch]]), null)).toBe("b");
  });
  test("no phone online → null", () => {
    expect(chooseTargetPhone(new Map(), "a")).toBeNull();
  });
  test("several online, latest unknown → the most recently attached", () => {
    expect(chooseTargetPhone(new Map([["a", ch], ["b", ch]]), "z")).toBe("b");
  });
  test("the target is the latest-input phone, not another online one", async () => {
    const a = new FakePhone("a");
    const b = new FakePhone("b");
    const sender = new FileSender(registry([a, b], "a"));
    a.sender = sender;
    await sender.send({ path: writeFile("t.txt", Buffer.from("hi")) });
    expect(a.frames.length).toBeGreaterThan(0);
    expect(b.frames).toHaveLength(0);
  });
});

describe("send_to_phone tool", () => {
  type Tool = {
    name: string;
    description: string;
    parameters: unknown;
    execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    }>;
  };
  function capture(sender: FileSender, turnId: () => string | null = () => null): Tool {
    let tool: Tool | undefined;
    const pi = { registerTool: (t: Tool) => { tool = t; } } as unknown as ExtensionAPI;
    registerSendToPhoneTool(pi, sender, turnId);
    return tool!;
  }

  test("registers with a description that steers the agent to finished files", () => {
    const tool = capture(new FileSender(registry([])));
    expect(tool.name).toBe("send_to_phone");
    expect(tool.description).toMatch(/finished/i);
    expect(tool.description).toMatch(/phone/i);
  });

  test("returns {name, size, device} on file_done and passes turn_id + ctx.cwd", async () => {
    writeFile("out.pdf", Buffer.from("%PDF-1.4"));
    const phone = new FakePhone("p1");
    const sender = new FileSender(registry([phone], "p1"));
    phone.sender = sender;
    const tool = capture(sender, () => "turn-7");
    const res = await tool.execute("call-1", { path: "out.pdf", caption: "report" }, undefined, undefined, { cwd: dir });
    expect(res.details).toMatchObject({ name: "out.pdf", size: 8, device: "Device p1" });
    expect(res.content[0]!.text).toMatch(/out\.pdf/);
    expect(phone.frames[0]).toMatchObject({ type: "file_offer", caption: "report", turn_id: "turn-7" });
  });

  test("phone_offline surfaces as a tool error naming the code", async () => {
    const tool = capture(new FileSender(registry([])));
    await expect(tool.execute("c", { path: writeFile("a.txt", Buffer.from("x")) }))
      .rejects.toThrow(/phone_offline/);
  });
});

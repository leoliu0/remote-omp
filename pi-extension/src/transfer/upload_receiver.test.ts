import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "../protocol/types.js";
import type { PeerChannel } from "../transport/peer_channel.js";
import {
  FINISHED_TTL_MS,
  MAX_ACTIVE_UPLOADS,
  STALE_PART_MS,
  UPLOAD_IDLE_MS,
  UploadReceiver,
  maxUploadBytes,
  sanitizeUploadName,
  uploadsRoot,
  uploadReserveBytes,
  withCollisionSuffix,
  type UploadReceiverOptions,
} from "./upload_receiver.js";

const MiB = 1024 * 1024;
const DAY = "2026-11-20";

/** The echo of the request id has its own tests; the rest compare ack facts. */
function withoutEcho<M extends ServerMessage>(frame: M): M {
  if (frame.type !== "upload_ack") return frame;
  const { in_reply_to: _echo, ...facts } = frame;
  return facts as M;
}

class FakePhone implements PeerChannel {
  frames: ServerMessage[] = [];

  send(msg: ServerMessage): void {
    this.frames.push(msg);
  }

  /** Frames of one type; acks without their `in_reply_to` echo. */
  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.ofRaw(type).map(withoutEcho);
  }

  /** Frames of one type exactly as sent. */
  ofRaw<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.frames.filter((f): f is Extract<ServerMessage, { type: T }> => f.type === type);
  }

  get last(): ServerMessage {
    return this.frames[this.frames.length - 1]!;
  }
}

let tmp: string;
let root: string;
let nextId = 0;
const receivers: UploadReceiver[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "upload-test-"));
  root = join(tmp, "uploads");
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(receivers.splice(0).map((r) => r.abortAll()));
  rmSync(tmp, { recursive: true, force: true });
  delete process.env["REMOTE_OMP_MAX_UPLOAD_MIB"];
});

function receiver(opts: UploadReceiverOptions = {}): UploadReceiver {
  const rx = new UploadReceiver({ root: () => root, now: () => new Date(2026, 10, 20, 9, 30), reserveBytes: () => 0, ...opts });
  receivers.push(rx);
  return rx;
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const rid = (): string => `req-${(nextId += 1)}`;

function start(uploadId: string, name: string, bytes: Buffer, extra: Record<string, unknown> = {}): ClientMessage {
  return {
    type: "upload_start",
    id: rid(),
    upload_id: uploadId,
    name,
    size: bytes.length,
    sha256: sha(bytes),
    ...extra,
  } as ClientMessage;
}

function chunk(uploadId: string, seq: number, bytes: Buffer): ClientMessage {
  return { type: "upload_chunk", id: rid(), upload_id: uploadId, seq, data: bytes.toString("base64") };
}

const end = (uploadId: string): ClientMessage => ({ type: "upload_end", id: rid(), upload_id: uploadId });
const cancel = (uploadId: string): ClientMessage => ({ type: "upload_cancel", id: rid(), upload_id: uploadId });

/** Delivers one frame and waits for the receiver to finish with it. */
async function deliver(rx: UploadReceiver, phone: FakePhone, msg: ClientMessage, device = "dev-1"): Promise<void> {
  expect(rx.handleMessage(device, phone, msg)).toBe(true);
  await rx.idle();
}

/** The whole happy path: start, every chunk, end. */
async function upload(
  rx: UploadReceiver,
  phone: FakePhone,
  uploadId: string,
  name: string,
  bytes: Buffer,
  chunkBytes = MiB,
): Promise<void> {
  await deliver(rx, phone, start(uploadId, name, bytes));
  for (let off = 0, seq = 0; off < bytes.length; off += chunkBytes, seq += 1) {
    await deliver(rx, phone, chunk(uploadId, seq, bytes.subarray(off, off + chunkBytes)));
  }
  await deliver(rx, phone, end(uploadId));
}

function dayDir(): string {
  return join(root, DAY);
}

function dayListing(): string[] {
  return existsSync(dayDir()) ? readdirSync(dayDir()).sort() : [];
}

function incomingDir(): string {
  return join(root, ".incoming");
}

/** The temp files of the uploads being received. */
function incomingListing(): string[] {
  return existsSync(incomingDir()) ? readdirSync(incomingDir()).sort() : [];
}

describe("UploadReceiver — storing a file", () => {
  test("a chunked upload lands in uploads/<date>/<name> with the right bytes and sha256", async () => {
    const bytes = randomBytes(2 * MiB + 123);
    const phone = new FakePhone();
    const rx = receiver();

    await deliver(rx, phone, start("u1", "report.pdf", bytes, { mime: "application/pdf" }));
    expect(phone.of("upload_ack")).toEqual([{ type: "upload_ack", upload_id: "u1", seq: 0, received: 0 }]);
    expect(dayListing()).toEqual([]);
    expect(incomingListing()).toHaveLength(1);

    await deliver(rx, phone, chunk("u1", 0, bytes.subarray(0, MiB)));
    await deliver(rx, phone, chunk("u1", 1, bytes.subarray(MiB, 2 * MiB)));
    await deliver(rx, phone, chunk("u1", 2, bytes.subarray(2 * MiB)));
    expect(phone.of("upload_ack").slice(1)).toEqual([
      { type: "upload_ack", upload_id: "u1", seq: 1, received: MiB },
      { type: "upload_ack", upload_id: "u1", seq: 2, received: 2 * MiB },
      { type: "upload_ack", upload_id: "u1", seq: 3, received: bytes.length },
    ]);
    expect(rx.activeCount()).toBe(1);

    await deliver(rx, phone, end("u1"));

    const path = join(dayDir(), "report.pdf");
    expect(phone.of("upload_done")).toEqual([{ type: "upload_done", upload_id: "u1", path, size: bytes.length }]);
    expect(phone.of("upload_error")).toEqual([]);
    expect(sha(readFileSync(path))).toBe(sha(bytes));
    expect(dayListing()).toEqual(["report.pdf"]);
    expect(rx.activeCount()).toBe(0);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("an upload without sha256 is stored as is, and an empty file works", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("plain text");
    await deliver(rx, phone, { ...start("u1", "a.txt", bytes), sha256: undefined } as ClientMessage);
    await deliver(rx, phone, chunk("u1", 0, bytes));
    await deliver(rx, phone, end("u1"));
    expect(readFileSync(join(dayDir(), "a.txt"), "utf8")).toBe("plain text");

    await upload(rx, phone, "u2", "empty.bin", Buffer.alloc(0));
    expect(statSync(join(dayDir(), "empty.bin")).size).toBe(0);
    expect(phone.of("upload_done").map((d) => d.size)).toEqual([10, 0]);
  });

  test("the date directory follows the clock", async () => {
    const phone = new FakePhone();
    const rx = receiver({ now: () => new Date(2027, 0, 5, 23, 59) });
    await upload(rx, phone, "u1", "a.txt", Buffer.from("x"));
    expect(phone.of("upload_done")[0]!.path).toBe(join(root, "2027-01-05", "a.txt"));
  });

  test("the uploads root honors REMOTE_OMP_HOME", () => {
    expect(uploadsRoot({ REMOTE_OMP_HOME: "/srv/omp" })).toBe(join("/srv/omp", ".omp", "remote", "uploads"));
  });

  test("a finished upload is answered again for a repeated end or start", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("hello");
    await upload(rx, phone, "u1", "a.txt", bytes);
    const done = phone.of("upload_done")[0]!;

    await deliver(rx, phone, end("u1"));
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes));
    expect(phone.of("upload_done")).toEqual([done, done, done, done]);
    expect(dayListing()).toEqual(["a.txt"]);
  });

  test("a finished upload is forgotten after ten minutes", async () => {
    vi.useFakeTimers();
    const phone = new FakePhone();
    const rx = receiver();
    await upload(rx, phone, "u1", "a.txt", Buffer.from("hello"));
    await vi.advanceTimersByTimeAsync(FINISHED_TTL_MS + 1);
    await deliver(rx, phone, end("u1"));
    expect(phone.last).toMatchObject({ type: "upload_error", code: "unknown_upload" });
  });
});

describe("UploadReceiver — names", () => {
  test("an existing name gets (1), (2) and an existing file is never replaced", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    mkdirSync(dayDir(), { recursive: true });
    writeFileSync(join(dayDir(), "report.pdf"), "mine");

    await upload(rx, phone, "u1", "report.pdf", Buffer.from("one"));
    await upload(rx, phone, "u2", "report.pdf", Buffer.from("two"));
    await upload(rx, phone, "u3", "archive.tar.gz", Buffer.from("t1"));
    await upload(rx, phone, "u4", "archive.tar.gz", Buffer.from("t2"));

    expect(dayListing()).toEqual([
      "archive (1).tar.gz",
      "archive.tar.gz",
      "report (1).pdf",
      "report (2).pdf",
      "report.pdf",
    ]);
    expect(readFileSync(join(dayDir(), "report.pdf"), "utf8")).toBe("mine");
    expect(readFileSync(join(dayDir(), "report (1).pdf"), "utf8")).toBe("one");
    expect(readFileSync(join(dayDir(), "report (2).pdf"), "utf8")).toBe("two");
    expect(phone.of("upload_done").map((d) => d.path)).toEqual([
      join(dayDir(), "report (1).pdf"),
      join(dayDir(), "report (2).pdf"),
      join(dayDir(), "archive.tar.gz"),
      join(dayDir(), "archive (1).tar.gz"),
    ]);
  });

  test("two uploads of the same name in flight at once keep apart", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const a = Buffer.from("AAAA");
    const b = Buffer.from("BBBBBB");
    await deliver(rx, phone, start("ua", "same.bin", a));
    await deliver(rx, phone, start("ub", "same.bin", b));
    expect(incomingListing()).toHaveLength(2);
    expect(dayListing()).toEqual([]);
    await deliver(rx, phone, chunk("ub", 0, b));
    await deliver(rx, phone, chunk("ua", 0, a));
    await deliver(rx, phone, end("ub"));
    await deliver(rx, phone, end("ua"));

    // The name is settled when a file is complete: the first to finish keeps it.
    expect(readFileSync(join(dayDir(), "same.bin"), "utf8")).toBe("BBBBBB");
    expect(readFileSync(join(dayDir(), "same (1).bin"), "utf8")).toBe("AAAA");
    expect(dayListing()).toEqual(["same (1).bin", "same.bin"]);
    expect(incomingListing()).toEqual([]);
  });

  test("a file that appears under the reserved name before the end is not overwritten", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("data");
    await deliver(rx, phone, start("u1", "race.txt", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes));
    writeFileSync(join(dayDir(), "race.txt"), "someone else");
    await deliver(rx, phone, end("u1"));

    expect(readFileSync(join(dayDir(), "race.txt"), "utf8")).toBe("someone else");
    expect(readFileSync(join(dayDir(), "race (1).txt"), "utf8")).toBe("data");
    expect(phone.of("upload_done")[0]!.path).toBe(join(dayDir(), "race (1).txt"));
  });

  test.each([
    ["../../../evil.sh", "evil.sh"],
    ["..\\..\\Windows\\evil.dll", "evil.dll"],
    ["/etc/cron.d/evil", "evil"],
    ["C:\\Users\\me\\Documents\\cv.pdf", "cv.pdf"],
    ["nested/dir/", "dir"],
  ])("path traversal name %j is stored as %j inside the date directory", async (raw, stored) => {
    const phone = new FakePhone();
    const rx = receiver();
    await upload(rx, phone, "u1", raw, Buffer.from("x"));
    expect(phone.of("upload_done")[0]!.path).toBe(join(dayDir(), stored));
    expect(dayListing()).toEqual([stored]);
    // Nothing escaped the uploads root.
    expect(readdirSync(tmp)).toEqual(["uploads"]);
    expect(readdirSync(root).sort()).toEqual([".incoming", DAY]);
  });
});

describe("sanitizeUploadName", () => {
  test.each([
    ["report.pdf", "report.pdf"],
    ["My Report (final).PDF", "My Report (final).PDF"],
    ["../../etc/passwd", "passwd"],
    ["..\\..\\boot.ini", "boot.ini"],
    ["/abs/path/file.txt", "file.txt"],
    [".bashrc", "bashrc"],
    ["...hidden.txt", "hidden.txt"],
    ["..", "upload"],
    [".", "upload"],
    ["", "upload"],
    ["   ", "upload"],
    ["a\u0000b\nc\u007f.txt", "abc.txt"],
    ["evil\u202Egnp.exe", "evilgnp.exe"],
    ['we<ir>d:na"me|?*.txt', "we_ir_d_na_me___.txt"],
    ["trailing dots...", "trailing dots"],
    ["CON", "_CON"],
    ["nul.txt", "_nul.txt"],
    ["COM1.log", "_COM1.log"],
    ["console.txt", "console.txt"],
    ["résumé.pdf", "résumé.pdf"],
  ])("%j → %j", (raw, expected) => {
    expect(sanitizeUploadName(raw)).toBe(expected);
  });

  test("anything that is not a string becomes 'upload'", () => {
    expect(sanitizeUploadName(undefined)).toBe("upload");
    expect(sanitizeUploadName(42)).toBe("upload");
    expect(sanitizeUploadName({ name: "x" })).toBe("upload");
  });

  test("a long name is cut to 200 UTF-8 bytes keeping the extension and whole characters", () => {
    const ascii = sanitizeUploadName(`${"a".repeat(300)}.pdf`);
    expect(Buffer.byteLength(ascii)).toBe(200);
    expect(ascii.endsWith(".pdf")).toBe(true);

    const wide = sanitizeUploadName(`${"é".repeat(150)}.txt`);
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(200);
    expect(wide.endsWith(".txt")).toBe(true);
    expect(wide).toBe(`${"é".repeat(98)}.txt`);
  });

  test("collision suffixes go before the extension", () => {
    expect(withCollisionSuffix("report.pdf", 0)).toBe("report.pdf");
    expect(withCollisionSuffix("report.pdf", 1)).toBe("report (1).pdf");
    expect(withCollisionSuffix("archive.tar.gz", 2)).toBe("archive (2).tar.gz");
    expect(withCollisionSuffix("README", 3)).toBe("README (3)");
  });
});

describe("UploadReceiver — limits", () => {
  test("the cap comes from REMOTE_OMP_MAX_UPLOAD_MIB, 256 MiB by default", () => {
    expect(maxUploadBytes({})).toBe(256 * MiB);
    expect(maxUploadBytes({ REMOTE_OMP_MAX_UPLOAD_MIB: "1" })).toBe(MiB);
    expect(maxUploadBytes({ REMOTE_OMP_MAX_UPLOAD_MIB: "0.5" })).toBe(MiB / 2);
    for (const bad of ["", "abc", "0", "-3"]) {
      expect(maxUploadBytes({ REMOTE_OMP_MAX_UPLOAD_MIB: bad })).toBe(256 * MiB);
    }
  });

  test("an upload above the cap is refused at the start, before anything is written", async () => {
    process.env["REMOTE_OMP_MAX_UPLOAD_MIB"] = "1";
    const phone = new FakePhone();
    const rx = new UploadReceiver({ root: () => root, reserveBytes: () => 0 });
    receivers.push(rx);
    const big = Buffer.alloc(MiB + 1);
    await deliver(rx, phone, start("u1", "big.bin", big));

    expect(phone.frames).toEqual([
      {
        type: "upload_error",
        upload_id: "u1",
        code: "too_large",
        message: "The file is 1 MiB; the PC accepts uploads up to 1 MiB (REMOTE_OMP_MAX_UPLOAD_MIB).",
      },
    ]);
    expect(existsSync(root)).toBe(false);
    expect(rx.activeCount()).toBe(0);

    // At the cap exactly is fine.
    await upload(rx, phone, "u2", "ok.bin", Buffer.alloc(MiB, 7));
    expect(phone.of("upload_done")).toHaveLength(1);
  });

  test("more bytes than announced fail the upload and delete the .part", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    await deliver(rx, phone, start("u1", "liar.bin", Buffer.alloc(4)));
    await deliver(rx, phone, chunk("u1", 0, Buffer.alloc(3)));
    await deliver(rx, phone, chunk("u1", 1, Buffer.alloc(3)));

    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "size_mismatch" });
    expect(dayListing()).toEqual([]);
    expect(rx.activeCount()).toBe(0);
  });

  test("an end before all the bytes arrived is answered with the position, not an error", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("abcdefgh");
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes.subarray(0, 4)));
    await deliver(rx, phone, end("u1"));
    expect(withoutEcho(phone.last)).toEqual({ type: "upload_ack", upload_id: "u1", seq: 1, received: 4 });
    expect(phone.of("upload_error")).toEqual([]);

    await deliver(rx, phone, chunk("u1", 1, bytes.subarray(4)));
    await deliver(rx, phone, end("u1"));
    expect(readFileSync(join(dayDir(), "a.txt"), "utf8")).toBe("abcdefgh");
  });

  test("a wrong sha256 deletes the file and reports sha_mismatch", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("the real bytes");
    await deliver(rx, phone, start("u1", "a.txt", bytes, { sha256: sha(Buffer.from("something else")) }));
    await deliver(rx, phone, chunk("u1", 0, bytes));
    await deliver(rx, phone, end("u1"));

    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "sha_mismatch" });
    expect(phone.of("upload_done")).toEqual([]);
    expect(dayListing()).toEqual([]);
  });

  test("the sha256 is accepted in any case", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("shout");
    await deliver(rx, phone, start("u1", "a.txt", bytes, { sha256: sha(bytes).toUpperCase() }));
    await deliver(rx, phone, chunk("u1", 0, bytes));
    await deliver(rx, phone, end("u1"));
    expect(phone.of("upload_done")).toHaveLength(1);
  });

  test("a full disk is refused at the start", async () => {
    const phone = new FakePhone();
    const rx = receiver({ freeBytes: () => Promise.resolve(10) });
    await deliver(rx, phone, start("u1", "a.bin", Buffer.alloc(11)));
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "no_space" });
    expect(dayListing()).toEqual([]);

    // Unknown free space is not a reason to refuse.
    const rx2 = receiver({ freeBytes: () => Promise.resolve(null) });
    await upload(rx2, phone, "u2", "b.bin", Buffer.alloc(11));
    expect(phone.of("upload_done")).toHaveLength(1);
  });

  test(`at most ${MAX_ACTIVE_UPLOADS} uploads at once`, async () => {
    const phone = new FakePhone();
    const rx = receiver();
    for (let i = 0; i < MAX_ACTIVE_UPLOADS; i += 1) {
      await deliver(rx, phone, start(`u${i}`, `f${i}.bin`, Buffer.alloc(1)));
    }
    expect(rx.activeCount()).toBe(MAX_ACTIVE_UPLOADS);
    await deliver(rx, phone, start("one-too-many", "x.bin", Buffer.alloc(1)));
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "one-too-many", code: "too_many_uploads" });

    await deliver(rx, phone, cancel("u0"));
    await deliver(rx, phone, start("one-too-many", "x.bin", Buffer.alloc(1)));
    expect(phone.last).toMatchObject({ type: "upload_ack", upload_id: "one-too-many" });
  });
});

describe("UploadReceiver — cancel and idle timeout", () => {
  test("cancel deletes the .part and forgets the upload", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("abcdefgh");
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes.subarray(0, 4)));
    expect(incomingListing()).toHaveLength(1);

    await deliver(rx, phone, cancel("u1"));
    expect(incomingListing()).toEqual([]);
    expect(rx.activeCount()).toBe(0);
    expect(phone.of("upload_error")).toEqual([]);

    // A frame still in flight finds nothing.
    await deliver(rx, phone, chunk("u1", 1, bytes.subarray(4)));
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "unknown_upload" });
    expect(incomingListing()).toEqual([]);

    // Cancelling something unknown is not an error.
    const before = phone.frames.length;
    await deliver(rx, phone, cancel("nope"));
    expect(phone.frames).toHaveLength(before);
  });

  test("a cancel queued behind chunks still removes every byte", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = randomBytes(3 * MiB);
    await deliver(rx, phone, start("u1", "big.bin", bytes));
    // No awaiting between frames: the receiver is busy writing when the cancel arrives.
    rx.handleMessage("dev-1", phone, chunk("u1", 0, bytes.subarray(0, MiB)));
    rx.handleMessage("dev-1", phone, chunk("u1", 1, bytes.subarray(MiB, 2 * MiB)));
    rx.handleMessage("dev-1", phone, cancel("u1"));
    rx.handleMessage("dev-1", phone, chunk("u1", 2, bytes.subarray(2 * MiB)));
    await rx.idle();

    expect(incomingListing()).toEqual([]);
    expect(rx.activeCount()).toBe(0);
  });

  test("60 s without a frame drops the upload, deletes the .part and tells the phone", async () => {
    vi.useFakeTimers();
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("abcdefgh");
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes.subarray(0, 4)));
    expect(incomingListing()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1);
    expect(incomingListing()).toHaveLength(1);
    expect(phone.of("upload_error")).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await rx.idle();
    expect(incomingListing()).toEqual([]);
    expect(rx.activeCount()).toBe(0);
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "timeout" });

    // The phone's late frames find nothing.
    await deliver(rx, phone, chunk("u1", 1, bytes.subarray(4)));
    expect(phone.last).toMatchObject({ code: "unknown_upload" });
  });

  test("every frame, even a repeated start, restarts the 60 s", async () => {
    vi.useFakeTimers();
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("abcdefgh");
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await vi.advanceTimersByTimeAsync(50_000);
    await deliver(rx, phone, chunk("u1", 0, bytes.subarray(0, 4)));
    await vi.advanceTimersByTimeAsync(50_000);
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(rx.activeCount()).toBe(1);

    await deliver(rx, phone, chunk("u1", 1, bytes.subarray(4)));
    await deliver(rx, phone, end("u1"));
    expect(readFileSync(join(dayDir(), "a.txt"), "utf8")).toBe("abcdefgh");
    await vi.advanceTimersByTimeAsync(2 * UPLOAD_IDLE_MS);
    expect(phone.of("upload_error")).toEqual([]);
  });

  test("abortAll deletes every .part", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    await deliver(rx, phone, start("u1", "a.bin", Buffer.alloc(8)));
    await deliver(rx, phone, start("u2", "b.bin", Buffer.alloc(8)));
    await deliver(rx, phone, chunk("u1", 0, Buffer.alloc(4)));
    expect(incomingListing()).toHaveLength(2);

    await rx.abortAll();
    expect(incomingListing()).toEqual([]);
    expect(rx.activeCount()).toBe(0);
  });

  test("a .part left by a crash is swept on the first upload, a recent one is kept", async () => {
    mkdirSync(incomingDir(), { recursive: true });
    const stale = join(incomingDir(), "crashed.part");
    const recent = join(incomingDir(), "live.part");
    writeFileSync(stale, "x");
    writeFileSync(recent, "y");
    const old = new Date(Date.now() - STALE_PART_MS - 60_000);
    utimesSync(stale, old, old);

    const phone = new FakePhone();
    const rx = receiver();
    await deliver(rx, phone, start("u1", "a.txt", Buffer.from("x")));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});

describe("UploadReceiver — gaps, duplicates and resumption", () => {
  test("out-of-order and duplicate chunks end up in the right order with cumulative acks", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("AAAABBBBCCCCDD");
    const parts = [bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8, 12), bytes.subarray(12)];
    await deliver(rx, phone, start("u1", "a.txt", bytes));

    await deliver(rx, phone, chunk("u1", 2, parts[2]!));  // far ahead: held back
    await deliver(rx, phone, chunk("u1", 1, parts[1]!));  // still a gap
    expect(phone.of("upload_ack").slice(1)).toEqual([
      { type: "upload_ack", upload_id: "u1", seq: 0, received: 0 },
      { type: "upload_ack", upload_id: "u1", seq: 0, received: 0 },
    ]);
    expect(statSync(join(incomingDir(), incomingListing()[0]!)).size).toBe(0);

    await deliver(rx, phone, chunk("u1", 0, parts[0]!));  // fills the gap: 0, 1 and 2 are written
    await deliver(rx, phone, chunk("u1", 1, parts[1]!));  // duplicate
    await deliver(rx, phone, chunk("u1", 3, parts[3]!));
    expect(phone.of("upload_ack").slice(3)).toEqual([
      { type: "upload_ack", upload_id: "u1", seq: 3, received: 12 },
      { type: "upload_ack", upload_id: "u1", seq: 3, received: 12 },
      { type: "upload_ack", upload_id: "u1", seq: 4, received: 14 },
    ]);

    await deliver(rx, phone, end("u1"));
    expect(readFileSync(join(dayDir(), "a.txt"), "utf8")).toBe("AAAABBBBCCCCDD");
  });

  test("a repeated start for a live upload answers with the current position and keeps the bytes", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("AAAABBBB");
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes.subarray(0, 4)));
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    expect(withoutEcho(phone.last)).toEqual({ type: "upload_ack", upload_id: "u1", seq: 1, received: 4 });

    await deliver(rx, phone, chunk("u1", 1, bytes.subarray(4)));
    await deliver(rx, phone, end("u1"));
    expect(readFileSync(join(dayDir(), "a.txt"), "utf8")).toBe("AAAABBBB");
    expect(dayListing()).toEqual(["a.txt"]);
  });

  test("an upload id reused for a different file is refused and the original is untouched", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    await deliver(rx, phone, start("u1", "a.txt", Buffer.from("AAAA")));
    await deliver(rx, phone, start("u1", "a.txt", Buffer.from("BBBBBB")));
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "invalid_upload" });
    expect(rx.activeCount()).toBe(1);
  });

  test("a chunk or end for an upload this PC never saw gets unknown_upload", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    await deliver(rx, phone, chunk("ghost", 0, Buffer.from("x")));
    expect(phone.last).toEqual({
      type: "upload_error",
      upload_id: "ghost",
      code: "unknown_upload",
      message: "The PC has no such upload (it timed out, was cancelled, or Remote OMP restarted).",
    });
    await deliver(rx, phone, end("ghost"));
    expect(phone.of("upload_error")).toHaveLength(2);
    expect(existsSync(root)).toBe(false);
  });

  test("several uploads interleave by upload_id", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const a = randomBytes(2 * MiB);
    const b = randomBytes(MiB + 5);
    await deliver(rx, phone, start("ua", "a.bin", a));
    await deliver(rx, phone, start("ub", "b.bin", b));
    await deliver(rx, phone, chunk("ua", 0, a.subarray(0, MiB)));
    await deliver(rx, phone, chunk("ub", 0, b.subarray(0, MiB)));
    await deliver(rx, phone, chunk("ub", 1, b.subarray(MiB)));
    await deliver(rx, phone, chunk("ua", 1, a.subarray(MiB)));
    await deliver(rx, phone, end("ub"));
    await deliver(rx, phone, end("ua"));

    expect(sha(readFileSync(join(dayDir(), "a.bin")))).toBe(sha(a));
    expect(sha(readFileSync(join(dayDir(), "b.bin")))).toBe(sha(b));
    expect(phone.of("upload_done").map((d) => d.upload_id)).toEqual(["ub", "ua"]);
  });

  test("an upload belongs to the phone that started it", async () => {
    const owner = new FakePhone();
    const other = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("AAAA");
    await deliver(rx, owner, start("u1", "a.txt", bytes), "phone-A");

    // Another phone cannot add to it, finish it or cancel it.
    await deliver(rx, other, chunk("u1", 0, Buffer.from("EVIL")), "phone-B");
    await deliver(rx, other, end("u1"), "phone-B");
    await deliver(rx, other, cancel("u1"), "phone-B");
    expect(other.frames.map((f) => f.type)).toEqual(["upload_error", "upload_error"]);
    expect(rx.activeCount()).toBe(1);

    await deliver(rx, owner, chunk("u1", 0, bytes), "phone-A");
    await deliver(rx, owner, end("u1"), "phone-A");
    expect(readFileSync(join(dayDir(), "a.txt"), "utf8")).toBe("AAAA");

    // The same id is free for another phone.
    await deliver(rx, other, start("u1", "b.txt", Buffer.from("B")), "phone-B");
    expect(other.last).toMatchObject({ type: "upload_ack", upload_id: "u1" });
  });

  test("replies follow the phone's latest channel after a reconnect", async () => {
    const before = new FakePhone();
    const after = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("AAAABBBB");
    await deliver(rx, before, start("u1", "a.txt", bytes));
    await deliver(rx, before, chunk("u1", 0, bytes.subarray(0, 4)));
    await deliver(rx, after, start("u1", "a.txt", bytes));
    await deliver(rx, after, chunk("u1", 1, bytes.subarray(4)));
    await deliver(rx, after, end("u1"));

    expect(after.of("upload_ack").map((a) => a.seq)).toEqual([1, 2]);
    expect(after.of("upload_done")).toHaveLength(1);
    expect(before.of("upload_done")).toEqual([]);
  });
});

describe("UploadReceiver — malformed frames", () => {
  test.each([
    ["no size", { size: undefined }],
    ["negative size", { size: -1 }],
    ["fractional size", { size: 1.5 }],
    ["string size", { size: "10" }],
    ["no name", { name: undefined }],
    ["short sha256", { sha256: "abc" }],
    ["non-hex sha256", { sha256: "z".repeat(64) }],
  ])("a start with %s is refused", async (_label, patch) => {
    const phone = new FakePhone();
    const rx = receiver();
    await deliver(rx, phone, { ...start("u1", "a.txt", Buffer.from("x")), ...patch } as ClientMessage);
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "invalid_upload" });
    expect(rx.activeCount()).toBe(0);
    expect(existsSync(root)).toBe(false);
  });

  test("a bad upload id is answered with a plain error correlated to the request id", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    for (const bad of ["", "../x", "a b", "x".repeat(129), undefined, 7]) {
      const msg = { type: "upload_chunk", id: "req-9", upload_id: bad, seq: 0, data: "" } as unknown as ClientMessage;
      expect(rx.handleMessage("dev-1", phone, msg)).toBe(true);
    }
    expect(phone.frames).toHaveLength(6);
    expect(phone.frames.every((f) => f.type === "error" && f.in_reply_to === "req-9" && f.code === "invalid_message")).toBe(true);
  });

  test("a chunk with a bad seq or data fails the upload", async () => {
    for (const patch of [{ seq: -1 }, { seq: 1.5 }, { seq: "0" }, { data: 5 }]) {
      const phone = new FakePhone();
      const rx = receiver();
      await deliver(rx, phone, start("u1", "a.txt", Buffer.from("x")));
      await deliver(rx, phone, { ...chunk("u1", 0, Buffer.from("x")), ...patch } as ClientMessage);
      expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "invalid_upload" });
      expect(dayListing()).toEqual([]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a chunk above 2 MiB fails the upload", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const big = Buffer.alloc(2 * MiB + 1);
    await deliver(rx, phone, start("u1", "a.bin", big));
    await deliver(rx, phone, chunk("u1", 0, big));
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "invalid_upload" });
    expect(dayListing()).toEqual([]);
  });

  test("frames of other types are not handled", () => {
    const rx = receiver();
    const phone = new FakePhone();
    expect(rx.handleMessage("dev-1", phone, { type: "ping", id: "p" })).toBe(false);
    expect(rx.handleMessage("dev-1", phone, { type: "file_cancel", file_id: "f" })).toBe(false);
    expect(phone.frames).toEqual([]);
  });
});

describe("UploadReceiver — temp files never collide with finished uploads", () => {
  test("bytes are written under uploads/.incoming, never in the date directory", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("abcdefgh");
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes.subarray(0, 4)));
    expect(dayListing()).toEqual([]);
    expect(incomingListing()).toHaveLength(1);
    expect(incomingListing()[0]).toMatch(/\.part$/);

    await deliver(rx, phone, chunk("u1", 1, bytes.subarray(4)));
    await deliver(rx, phone, end("u1"));
    expect(dayListing()).toEqual(["a.txt"]);
    expect(incomingListing()).toEqual([]);
  });

  test("a finished upload whose name ends in .part survives the stale sweep", async () => {
    const phone = new FakePhone();
    await upload(receiver(), phone, "u1", "video.mkv.part", Buffer.from("movie"));
    const finalPath = join(dayDir(), "video.mkv.part");
    expect(readFileSync(finalPath, "utf8")).toBe("movie");
    const old = new Date(Date.now() - STALE_PART_MS - 60_000);
    utimesSync(finalPath, old, old);

    // A later process: its first upload runs the once-per-process sweep.
    await deliver(receiver(), phone, start("u2", "b.txt", Buffer.from("x")));
    expect(readFileSync(finalPath, "utf8")).toBe("movie");
  });

  test("an old *.part inside a date directory is not a leftover", async () => {
    mkdirSync(join(root, "2026-11-01"), { recursive: true });
    const kept = join(root, "2026-11-01", "old.bin.part");
    writeFileSync(kept, "x");
    const old = new Date(Date.now() - STALE_PART_MS - 60_000);
    utimesSync(kept, old, old);

    await deliver(receiver(), new FakePhone(), start("u1", "a.txt", Buffer.from("x")));
    expect(existsSync(kept)).toBe(true);
  });

  test("the temp name of an upload cannot be a name the phone chose", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("data");
    // Names are one safe segment without a leading dot; temp names live in .incoming.
    await deliver(rx, phone, start("u1", ".incoming/../x.part", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes));
    await deliver(rx, phone, end("u1"));
    expect(phone.of("upload_done")[0]!.path).toBe(join(dayDir(), "x.part"));
    expect(readdirSync(dayDir())).toEqual(["x.part"]);
  });
});

describe("sanitizeUploadName — dots and spaces of every kind", () => {
  const spaces = Array.from({ length: 0x10000 }, (_, i) => String.fromCharCode(i)).filter((c) => /\s/u.test(c));

  test("the Unicode spaces that String.trim removes are among the ones tested", () => {
    expect(spaces).toContain("\u00a0");
    expect(spaces).toContain("\u3000");
    expect(spaces).toContain("\u2028");
    expect(spaces.length).toBeGreaterThan(20);
  });

  test.each([
    [".\u00a0..\u00a0.", "upload"],
    [".\u00a0.\u00a0.", "upload"],
    [".\u00a0.bashrc", "bashrc"],
    ["\u3000..\u2003.hidden", "hidden"],
    ["name.\u00a0", "name"],
    ["name \u00a0. .", "name"],
    ["\u2028.", "upload"],
  ])("%j → %j", (raw, expected) => {
    expect(sanitizeUploadName(raw)).toBe(expected);
  });

  test("any space around dots is stripped: never hidden, never . or ..", () => {
    for (const space of spaces) {
      for (const raw of [
        `.${space}.`,
        `.${space}..${space}.`,
        `${space}.${space}x`,
        `x${space}.${space}`,
        `..${space}`,
        `${space}..`,
        `.${space}.bashrc`,
      ]) {
        const name = sanitizeUploadName(raw);
        const why = JSON.stringify(raw);
        expect(name.startsWith("."), why).toBe(false);
        expect(name, why).not.toBe(".");
        expect(name, why).not.toBe("..");
        expect(name, why).toBe(name.trim());
      }
    }
  });

  test("random mixes of dots, separators, spaces, control and invisible characters keep the invariants", () => {
    let seed = 0x9e3779b9;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pool = [".", ".", ".", "/", "\\", "a", "b", "é", "x", "_", "-", "0", "<", ":", "?", "\u0000", "\u001f", "\u007f", "\u200b", "\u202e", "\ufeff", ...spaces];
    for (let i = 0; i < 5000; i += 1) {
      let raw = "";
      for (let j = 1 + Math.floor(next() * 12); j > 0; j -= 1) raw += pool[Math.floor(next() * pool.length)];
      const name = sanitizeUploadName(raw);
      const why = JSON.stringify(raw);
      expect(name.length, why).toBeGreaterThan(0);
      expect(name.startsWith("."), why).toBe(false);
      expect(name.endsWith("."), why).toBe(false);
      expect(name === "." || name === "..", why).toBe(false);
      expect(/[/\\]/.test(name), why).toBe(false);
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(name), why).toBe(false);
      expect(name, why).toBe(name.trim());
      expect(Buffer.byteLength(name), why).toBeLessThanOrEqual(200);
      expect(sanitizeUploadName(name), why).toBe(name);
    }
  });
});

describe("UploadReceiver — disk reserve", () => {
  test("the reserve is 1 GiB unless REMOTE_OMP_UPLOAD_RESERVE_MIB says otherwise", () => {
    expect(uploadReserveBytes({})).toBe(1024 * MiB);
    expect(uploadReserveBytes({ REMOTE_OMP_UPLOAD_RESERVE_MIB: "64" })).toBe(64 * MiB);
    expect(uploadReserveBytes({ REMOTE_OMP_UPLOAD_RESERVE_MIB: "0" })).toBe(0);
    expect(uploadReserveBytes({ REMOTE_OMP_UPLOAD_RESERVE_MIB: "-5" })).toBe(1024 * MiB);
    expect(uploadReserveBytes({ REMOTE_OMP_UPLOAD_RESERVE_MIB: "junk" })).toBe(1024 * MiB);
  });

  test("an upload that would eat into the reserve is refused at the start", async () => {
    const phone = new FakePhone();
    const rx = receiver({ freeBytes: () => Promise.resolve(1000), reserveBytes: () => 600 });
    await deliver(rx, phone, start("big", "a.bin", Buffer.alloc(401)));
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "big", code: "no_space" });
    expect((phone.last as { message: string }).message).toMatch(/reserve/i);
    expect(rx.activeCount()).toBe(0);

    await deliver(rx, phone, start("ok", "b.bin", Buffer.alloc(400)));
    expect(phone.last).toMatchObject({ type: "upload_ack", upload_id: "ok" });
  });

  test("bytes promised to uploads still in flight count against the free space", async () => {
    const phone = new FakePhone();
    const rx = receiver({ freeBytes: () => Promise.resolve(1000), reserveBytes: () => 0 });
    await deliver(rx, phone, start("a", "a.bin", Buffer.alloc(600)));
    await deliver(rx, phone, start("b", "b.bin", Buffer.alloc(500)));
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "b", code: "no_space" });

    // Only what is still to come is promised: 300 of the 600 are written.
    await deliver(rx, phone, chunk("a", 0, Buffer.alloc(300)));
    await deliver(rx, phone, start("c", "c.bin", Buffer.alloc(700)));
    expect(phone.last).toMatchObject({ type: "upload_ack", upload_id: "c" });

    // Once an upload is gone its promise is released.
    await deliver(rx, phone, cancel("a"));
    await deliver(rx, phone, cancel("c"));
    await deliver(rx, phone, start("d", "d.bin", Buffer.alloc(1000)));
    expect(phone.last).toMatchObject({ type: "upload_ack", upload_id: "d" });
  });

  test("uploads started together cannot each claim the same free space", async () => {
    const phone = new FakePhone();
    const rx = receiver({ freeBytes: () => Promise.resolve(1000), reserveBytes: () => 0 });
    for (let i = 0; i < 6; i += 1) {
      rx.handleMessage("dev-1", phone, start(`u${i}`, `f${i}.bin`, Buffer.alloc(200)));
    }
    await rx.idle();
    // The acks may come in any order; who is admitted does not: the first five.
    expect(phone.of("upload_ack").map((a) => a.upload_id).sort()).toEqual(["u0", "u1", "u2", "u3", "u4"]);
    expect(phone.of("upload_error").map((e) => [e.upload_id, e.code])).toEqual([["u5", "no_space"]]);
  });

  test("an unknown amount of free space is still no reason to refuse", async () => {
    const phone = new FakePhone();
    const rx = receiver({ freeBytes: () => Promise.resolve(null), reserveBytes: () => 1 << 30 });
    await upload(rx, phone, "u1", "a.bin", Buffer.alloc(11));
    expect(phone.of("upload_done")).toHaveLength(1);
  });
});

const idOf = (m: ClientMessage): string => (m as { id: string }).id;

describe("UploadReceiver — ack echo and the digest on upload_end", () => {
  test("every ack echoes the id of the frame it answers", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("AAAABBBB");
    const frames = [
      start("u1", "a.txt", bytes),
      chunk("u1", 0, bytes.subarray(0, 4)),
      chunk("u1", 0, bytes.subarray(0, 4)), // duplicate
      chunk("u1", 5, bytes.subarray(4)), // far ahead
      start("u1", "a.txt", bytes), // a probe
      end("u1"), // too early
    ];
    for (const f of frames) await deliver(rx, phone, f);
    expect(phone.ofRaw("upload_ack").map((a) => a.in_reply_to)).toEqual(frames.map(idOf));
  });

  test("a frame without a request id is answered without in_reply_to", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const { id: _id, ...noId } = start("u1", "a.txt", Buffer.from("x")) as ClientMessage & { id: string };
    await deliver(rx, phone, noId as ClientMessage);
    expect(phone.ofRaw("upload_ack")).toEqual([{ type: "upload_ack", upload_id: "u1", seq: 0, received: 0 }]);
  });

  test("the digest can arrive with upload_end instead of upload_start", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("a late digest");
    await deliver(rx, phone, { ...start("u1", "a.txt", bytes), sha256: undefined } as ClientMessage);
    await deliver(rx, phone, chunk("u1", 0, bytes));
    await deliver(rx, phone, { ...end("u1"), sha256: sha(bytes) } as ClientMessage);
    expect(phone.of("upload_done")).toHaveLength(1);
    expect(readFileSync(join(dayDir(), "a.txt"), "utf8")).toBe("a late digest");
  });

  test("a wrong digest on upload_end deletes the file and reports sha_mismatch", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("damaged");
    await deliver(rx, phone, { ...start("u1", "a.txt", bytes), sha256: undefined } as ClientMessage);
    await deliver(rx, phone, chunk("u1", 0, bytes));
    await deliver(rx, phone, { ...end("u1"), sha256: sha(Buffer.from("other")) } as ClientMessage);
    expect(phone.last).toMatchObject({ type: "upload_error", upload_id: "u1", code: "sha_mismatch" });
    expect(dayListing()).toEqual([]);
    expect(incomingListing()).toEqual([]);
  });

  test("the digest on upload_end is checked as well as the one on upload_start", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("both digests");
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes));
    await deliver(rx, phone, { ...end("u1"), sha256: sha(Buffer.from("nope")) } as ClientMessage);
    expect(phone.last).toMatchObject({ code: "sha_mismatch" });
  });

  test("a malformed digest on upload_end fails the upload", async () => {
    const phone = new FakePhone();
    const rx = receiver();
    const bytes = Buffer.from("x");
    await deliver(rx, phone, start("u1", "a.txt", bytes));
    await deliver(rx, phone, chunk("u1", 0, bytes));
    await deliver(rx, phone, { ...end("u1"), sha256: "not-hex" } as ClientMessage);
    expect(phone.last).toMatchObject({ type: "upload_error", code: "invalid_upload" });
    expect(dayListing()).toEqual([]);
    expect(incomingListing()).toEqual([]);
  });
});

/**
 * Plan/68 — receive a file the phone uploads to the PC this session runs on.
 *
 * The reverse of plan/65's `send_to_phone`, over the same peer channel (no
 * relay change):
 *
 *   app → ext  upload_start  { id, upload_id, name, size, mime?, sha256? }
 *   app → ext  upload_chunk  { id, upload_id, seq, data }   data = base64(256 KiB)
 *   app → ext  upload_end    { id, upload_id, sha256? }
 *   app → ext  upload_cancel { id, upload_id }
 *   ext → app  upload_ack    { upload_id, seq, received, in_reply_to? }   cumulative
 *   ext → app  upload_done   { upload_id, path, size }
 *   ext → app  upload_error  { upload_id, code, message }
 *
 * Flow control is the phone's: it keeps at most 4 chunks in flight beyond the
 * last `upload_ack` (the relay has no backpressure). `seq` in an ack is the
 * first chunk still needed, so one ack format covers progress, duplicates,
 * gaps and resumption. `in_reply_to` echoes the `id` of the frame the ack
 * answers: when the phone is unsure it sends `upload_start` again as a probe,
 * and since frames are processed in order the ack to the probe is the
 * position after everything that reached the PC before it, so the phone can
 * tell lost chunks from a slow link and resend only the former.
 *
 * Storage: `<home>/.omp/remote/uploads/YYYY-MM-DD/<name>` where `<home>` is
 * `$REMOTE_OMP_HOME` or the user's home. The name is the phone's file name
 * reduced to a safe basename; an existing name gets ` (1)`, ` (2)`… Bytes go
 * to `<uploads>/.incoming/<random>.part` (created exclusively, mode 0600: a
 * folder of its own and a name no stored file can have) and are hard-linked
 * to the final name once the size and the sha256 (from `upload_start` and/or
 * `upload_end`) check out, so a finished file never appears half-written,
 * never replaces another file, and the leftover sweep never looks at one.
 *
 * Limits: `REMOTE_OMP_MAX_UPLOAD_MIB` (default 256) per file, 8 uploads at
 * once, a disk reserve (`REMOTE_OMP_UPLOAD_RESERVE_MIB`, default 1024) that
 * uploads never eat into, counting the bytes promised to uploads in flight;
 * 60 s without a frame from the phone drops the upload and its `.part`. A
 * finished upload is remembered for ten minutes so a repeated `upload_end` (the
 * `upload_done` may have been lost) is answered again.
 */
import { createHash, randomUUID, type Hash } from "node:crypto";
import { link, lstat, mkdir, open, readdir, rename, rm, statfs, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ClientMessage,
  ServerMessage,
  UploadChunkMessage,
  UploadEndMessage,
  UploadErrorCode,
  UploadStartMessage,
} from "../protocol/types.js";
import type { PeerChannel } from "../transport/peer_channel.js";
import { remoteOmpHome } from "../paths.js";

/** No frame from the phone for this long drops the upload. */
export const UPLOAD_IDLE_MS = 60_000;
export const DEFAULT_MAX_UPLOAD_MIB = 256;
/** Uploads in progress at once, across phones. */
export const MAX_ACTIVE_UPLOADS = 8;
/** Largest chunk accepted (raw bytes). The phone sends 256 KiB; the relay caps a frame at 4 MiB. */
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
/** Out-of-order chunks held in memory while a gap is open. */
export const MAX_AHEAD_CHUNKS = 8;
/** A finished upload answers repeated frames for this long. */
export const FINISHED_TTL_MS = 10 * 60_000;
const MAX_FINISHED = 64;
/** Temp files in `<uploads>/.incoming` older than this are leftovers of a crash. */
export const STALE_PART_MS = 24 * 60 * 60_000;
/** Where bytes wait until the file is complete. A stored name never starts with a dot. */
const INCOMING_DIR = ".incoming";
/** Disk space uploads leave alone unless `REMOTE_OMP_UPLOAD_RESERVE_MIB` says otherwise. */
export const DEFAULT_UPLOAD_RESERVE_MIB = 1024;
/** UTF-8 bytes of the stored name, leaving room for ` (n)` under the usual 255. */
const MAX_NAME_BYTES = 200;
const MAX_NAME_ATTEMPTS = 1000;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Per-file cap in bytes: `REMOTE_OMP_MAX_UPLOAD_MIB` (positive number), else 256 MiB. */
export function maxUploadBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env["REMOTE_OMP_MAX_UPLOAD_MIB"];
  const mib = raw === undefined ? NaN : Number(raw);
  const effective = Number.isFinite(mib) && mib > 0 ? mib : DEFAULT_MAX_UPLOAD_MIB;
  return Math.floor(effective * 1024 * 1024);
}

/** Disk space uploads never eat into: `REMOTE_OMP_UPLOAD_RESERVE_MIB` (0 or more), else 1 GiB. */
export function uploadReserveBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env["REMOTE_OMP_UPLOAD_RESERVE_MIB"];
  const mib = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const effective = Number.isFinite(mib) && mib >= 0 ? mib : DEFAULT_UPLOAD_RESERVE_MIB;
  return Math.floor(effective * 1024 * 1024);
}

/** `<home>/.omp/remote/uploads`, resolved at call time so tests can redirect it with `REMOTE_OMP_HOME`. */
export function uploadsRoot(env: Record<string, string | undefined> = process.env): string {
  return resolve(join(remoteOmpHome(env), "uploads"));
}

const INVISIBLE = /[\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Dots and white space of every kind at either end of a name, however they alternate. */
const DOTS_AND_SPACES = /^[\s.]+|[\s.]+$/gu;
/** Windows device names, with or without an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * The phone's file name reduced to one safe path segment: the last segment
 * (either separator), no control or bidi characters, no `<>:"|?*`, no dots or
 * white space (of any Unicode kind) at either end (so never hidden, never `.`
 * or `..`), never a Windows device name, at most 200 UTF-8 bytes with the
 * extension kept. Never empty.
 */
export function sanitizeUploadName(raw: unknown): string {
  const segments = (typeof raw === "string" ? raw : "").split(/[\\/]+/).filter((s) => s.length > 0);
  let name = (segments[segments.length - 1] ?? "")
    .normalize("NFC")
    .replace(CONTROL, "")
    .replace(INVISIBLE, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(DOTS_AND_SPACES, "");
  if (name === "" || name === "." || name === "..") name = "upload";
  if (WINDOWS_DEVICE.test(name)) name = `_${name}`;
  return truncateName(name, MAX_NAME_BYTES);
}

function splitExtension(name: string): { stem: string; ext: string } {
  const tar = /\.tar\.[A-Za-z0-9]{1,8}$/i.exec(name);
  if (tar && tar.index > 0) return { stem: name.slice(0, tar.index), ext: tar[0] };
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 16) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

function truncateName(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) return name;
  const { stem, ext } = splitExtension(name);
  const budget = maxBytes - Buffer.byteLength(ext);
  let out = "";
  let bytes = 0;
  for (const ch of stem) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > budget) break;
    out += ch;
    bytes += b;
  }
  out = out.replace(/[\s.]+$/u, "");
  return `${out === "" ? "upload" : out}${ext}`;
}

/** `report.pdf` → `report (2).pdf`; `n` 0 is the name itself. */
export function withCollisionSuffix(name: string, n: number): string {
  if (n === 0) return name;
  const { stem, ext } = splitExtension(name);
  return `${stem} (${n})${ext}`;
}

function dateStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 10 ? `${Math.round(mib)} MiB` : `${Math.round(mib * 10) / 10} MiB`;
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return false;
    throw err;
  }
}

/** Free bytes for an unprivileged user on the filesystem of `dir`; null when unknown. */
async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** An outcome the phone is told about, as opposed to an unexpected exception. */
class UploadFailure extends Error {
  constructor(
    readonly uploadCode: UploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UploadFailure";
  }
}

function failureFromError(err: unknown): UploadFailure {
  if (err instanceof UploadFailure) return err;
  const code = errnoOf(err);
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new UploadFailure("no_space", "The PC ran out of disk space while storing the file.");
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new UploadFailure("write_failed", `The PC could not store the file: ${detail}`);
}

export interface UploadReceiverOptions {
  /** Uploads directory. Default: {@link uploadsRoot}. */
  root?: () => string;
  /** Clock for the date directory. */
  now?: () => Date;
  idleMs?: number;
  /** Per-file cap in bytes. Default: {@link maxUploadBytes}. */
  maxBytes?: () => number;
  maxActive?: number;
  /** Free bytes where the file will be stored; null = unknown (no check). */
  freeBytes?: (dir: string) => Promise<number | null>;
  /** Bytes of free space uploads must leave alone. Default: {@link uploadReserveBytes}. */
  reserveBytes?: () => number;
}

interface Upload {
  readonly key: string;
  readonly uploadId: string;
  /** Order of admission: an upload only counts the bytes promised to earlier ones. */
  readonly admission: number;
  /** The channel of the latest frame: replies follow the phone across reconnects. */
  channel: PeerChannel;
  /** Sanitized name the phone asked for. */
  readonly name: string;
  readonly size: number;
  /** The digest `upload_start` announced, if any; `upload_end` may bring another. */
  readonly sha256: string | null;
  readonly hash: Hash;
  readonly ahead: Map<number, Buffer>;
  fh: FileHandle | null;
  /** The temp file, under `<uploads>/.incoming`. */
  partPath: string | null;
  /** The date directory (as of the start) the finished file is stored in. */
  dir: string | null;
  /** Collision index of the final name; a commit race only moves it up. */
  nameIndex: number;
  /** First chunk still needed; every chunk below it is on disk. */
  nextSeq: number;
  /** Bytes of the chunks below `nextSeq`. */
  received: number;
  idle: NodeJS.Timeout | undefined;
  /** Serializes the frames of one upload. */
  chain: Promise<void>;
  /** Over (failed, cancelled or stored): queued frames do nothing. */
  closed: boolean;
  /** `upload_end` is being verified; the idle timer no longer applies. */
  finishing: boolean;
}

interface Finished {
  path: string;
  size: number;
  at: number;
}

type ParsedStart =
  | { ok: true; name: string; size: number; sha256: string | null }
  | { ok: false; reason: string };

/** A lowercase sha256 digest; null when absent, undefined when malformed. */
function parseDigest(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) return undefined;
  return value.toLowerCase();
}

/** The request id of a client frame: the ack that answers it echoes it. */
function requestId(msg: { id?: unknown }): string | undefined {
  return typeof msg.id === "string" ? msg.id : undefined;
}

function parseStart(msg: UploadStartMessage): ParsedStart {
  if (typeof msg.name !== "string") return { ok: false, reason: "name is required" };
  const size: unknown = msg.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    return { ok: false, reason: "size must be a non-negative integer" };
  }
  const sha256 = parseDigest(msg.sha256);
  if (sha256 === undefined) return { ok: false, reason: "sha256 must be 64 hex characters" };
  return { ok: true, name: sanitizeUploadName(msg.name), size, sha256 };
}

export class UploadReceiver {
  private readonly root: () => string;
  private readonly now: () => Date;
  private readonly idleMs: number;
  private readonly maxBytes: () => number;
  private readonly maxActive: number;
  private readonly freeBytes: (dir: string) => Promise<number | null>;
  private readonly reserveBytes: () => number;
  private readonly uploads = new Map<string, Upload>();
  private readonly finished = new Map<string, Finished>();
  private readonly pending = new Set<Promise<unknown>>();
  private admissions = 0;
  private swept = false;

  constructor(opts: UploadReceiverOptions = {}) {
    this.root = opts.root ?? uploadsRoot;
    this.now = opts.now ?? ((): Date => new Date());
    this.idleMs = opts.idleMs ?? UPLOAD_IDLE_MS;
    this.maxBytes = opts.maxBytes ?? maxUploadBytes;
    this.maxActive = opts.maxActive ?? MAX_ACTIVE_UPLOADS;
    this.freeBytes = opts.freeBytes ?? defaultFreeBytes;
    this.reserveBytes = opts.reserveBytes ?? uploadReserveBytes;
  }

  /** Uploads in progress. */
  activeCount(): number {
    return this.uploads.size;
  }

  /** Resolves once every frame accepted so far has been processed. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Drops every upload and deletes its `.part` (the relay stopped, the session ended). */
  async abortAll(): Promise<void> {
    for (const upload of [...this.uploads.values()]) this.cancel(upload);
    this.finished.clear();
    await this.idle();
  }

  /**
   * Routes a phone → PC frame. Returns true for every `upload_*` frame
   * (handled, answered with an error, or ignored), false for anything else.
   * Frames are scoped to the phone that started the upload.
   */
  handleMessage(deviceId: string | null, sender: PeerChannel, msg: ClientMessage): boolean {
    switch (msg.type) {
      case "upload_start":
      case "upload_chunk":
      case "upload_end":
      case "upload_cancel":
        break;
      default:
        return false;
    }
    const uploadId: unknown = msg.upload_id;
    if (typeof uploadId !== "string" || !UPLOAD_ID_PATTERN.test(uploadId)) {
      const id: unknown = msg.id;
      this.send(sender, {
        type: "error",
        ...(typeof id === "string" ? { in_reply_to: id } : {}),
        code: "invalid_message",
        message: "upload_id must be 1-128 characters of A-Z a-z 0-9 . _ -",
      });
      return true;
    }
    const key = `${deviceId ?? "-"}\u0000${uploadId}`;
    switch (msg.type) {
      case "upload_start":
        this.onStart(key, uploadId, sender, msg);
        break;
      case "upload_chunk":
        this.onChunk(key, uploadId, sender, msg);
        break;
      case "upload_end":
        this.onEnd(key, uploadId, sender, msg);
        break;
      case "upload_cancel": {
        const upload = this.uploads.get(key);
        if (upload) this.cancel(upload);
        break;
      }
    }
    return true;
  }

  // ── Frames ────────────────────────────────────────────────────────────────

  private onStart(key: string, uploadId: string, sender: PeerChannel, msg: UploadStartMessage): void {
    const replyTo = requestId(msg);
    const parsed = parseStart(msg);
    if (!parsed.ok) {
      this.sendError(sender, uploadId, "invalid_upload", `Invalid upload request: ${parsed.reason}.`);
      return;
    }
    const existing = this.uploads.get(key);
    if (existing) {
      // The phone probes with a repeated start: answer with where the PC is.
      if (existing.size !== parsed.size || existing.sha256 !== parsed.sha256 || existing.name !== parsed.name) {
        this.sendError(sender, uploadId, "invalid_upload", "This upload id is already in use for a different file.");
        return;
      }
      this.enqueue(existing, sender, () => this.ack(existing, replyTo));
      return;
    }
    const done = this.finishedFor(key);
    if (done) {
      this.sendDone(sender, uploadId, done);
      return;
    }
    const cap = this.maxBytes();
    if (parsed.size > cap) {
      this.sendError(
        sender,
        uploadId,
        "too_large",
        `The file is ${formatMiB(parsed.size)}; the PC accepts uploads up to ${formatMiB(cap)} (REMOTE_OMP_MAX_UPLOAD_MIB).`,
      );
      return;
    }
    if (this.uploads.size >= this.maxActive) {
      this.sendError(
        sender,
        uploadId,
        "too_many_uploads",
        `${this.maxActive} uploads are already in progress on the PC. Wait for one to finish.`,
      );
      return;
    }
    this.admissions += 1;
    const upload: Upload = {
      key,
      uploadId,
      admission: this.admissions,
      channel: sender,
      name: parsed.name,
      size: parsed.size,
      sha256: parsed.sha256,
      hash: createHash("sha256"),
      ahead: new Map(),
      fh: null,
      partPath: null,
      dir: null,
      nameIndex: 0,
      nextSeq: 0,
      received: 0,
      idle: undefined,
      chain: Promise.resolve(),
      closed: false,
      finishing: false,
    };
    this.uploads.set(key, upload);
    this.enqueue(upload, sender, async () => {
      await this.reserve(upload);
      this.ack(upload, replyTo);
    });
  }

  private onChunk(key: string, uploadId: string, sender: PeerChannel, msg: UploadChunkMessage): void {
    const upload = this.uploads.get(key);
    if (!upload) {
      this.replyUnknown(key, uploadId, sender);
      return;
    }
    const replyTo = requestId(msg);
    const seq: unknown = msg.seq;
    const data: unknown = msg.data;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || typeof data !== "string") {
      this.enqueue(upload, sender, () =>
        this.fail(upload, new UploadFailure("invalid_upload", "Invalid chunk: seq and data are required.")),
      );
      return;
    }
    this.enqueue(upload, sender, () => this.writeChunk(upload, seq, data, replyTo));
  }

  private onEnd(key: string, uploadId: string, sender: PeerChannel, msg: UploadEndMessage): void {
    const upload = this.uploads.get(key);
    if (!upload) {
      this.replyUnknown(key, uploadId, sender);
      return;
    }
    const endSha256 = parseDigest(msg.sha256);
    this.enqueue(upload, sender, () =>
      endSha256 === undefined
        ? this.fail(
            upload,
            new UploadFailure("invalid_upload", "Invalid upload_end: sha256 must be 64 hex characters."),
          )
        : this.finish(upload, endSha256, requestId(msg)),
    );
  }

  /** A frame for an upload this PC does not hold: a finished one repeats its outcome. */
  private replyUnknown(key: string, uploadId: string, sender: PeerChannel): void {
    const done = this.finishedFor(key);
    if (done) {
      this.sendDone(sender, uploadId, done);
      return;
    }
    this.sendError(
      sender,
      uploadId,
      "unknown_upload",
      "The PC has no such upload (it timed out, was cancelled, or Remote OMP restarted).",
    );
  }

  // ── Work on one upload (serialized per upload) ────────────────────────────

  private enqueue(upload: Upload, sender: PeerChannel, op: () => void | Promise<void>): void {
    upload.channel = sender;
    this.armIdle(upload);
    this.run(upload, op);
  }

  /** Queues `op` behind the upload's earlier frames. `always` also runs it once the upload is over. */
  private run(upload: Upload, op: () => void | Promise<void>, always = false): void {
    const step = upload.chain.then(async () => {
      if (upload.closed && !always) return;
      try {
        await op();
      } catch (err) {
        await this.fail(upload, failureFromError(err));
      }
    });
    upload.chain = step;
    this.track(step);
  }

  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    const settled = (): void => {
      this.pending.delete(work);
    };
    work.then(settled, settled);
  }

  private armIdle(upload: Upload): void {
    clearTimeout(upload.idle);
    upload.idle = undefined;
    if (upload.closed || upload.finishing) return;
    const timer = setTimeout(() => {
      upload.idle = undefined;
      this.run(upload, () =>
        this.fail(
          upload,
          new UploadFailure(
            "timeout",
            `The PC received nothing for ${Math.max(1, Math.round(this.idleMs / 1000))} s and dropped the upload.`,
          ),
        ),
      );
    }, this.idleMs);
    timer.unref();
    upload.idle = timer;
  }

  /** Admits `upload` against the disk and creates its temp file under `<uploads>/.incoming`. */
  private async reserve(upload: Upload): Promise<void> {
    const root = this.root();
    const dir = join(root, dateStamp(this.now()));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const incoming = join(root, INCOMING_DIR);
    await mkdir(incoming, { recursive: true, mode: 0o700 });
    this.track(this.sweepStaleParts(incoming));
    const free = await this.freeBytes(dir);
    if (free !== null) {
      const reserve = this.reserveBytes();
      const available = free - reserve - this.promisedBefore(upload);
      if (upload.size > available) {
        throw new UploadFailure(
          "no_space",
          `The file is ${formatMiB(upload.size)} but the PC has ${formatMiB(Math.max(available, 0))} of disk space to spare` +
            (reserve > 0 ? ` (${formatMiB(reserve)} are kept in reserve for the system).` : "."),
        );
      }
    }
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const partPath = join(incoming, `${randomUUID()}.part`);
      try {
        // "wx": never reuse or follow anything that is already there.
        upload.fh = await open(partPath, "wx", 0o600);
      } catch (err) {
        if (errnoOf(err) === "EEXIST") continue;
        throw err;
      }
      upload.partPath = partPath;
      upload.dir = dir;
      return;
    }
    throw new UploadFailure("write_failed", "The PC could not create a temporary file.");
  }

  /** Bytes the uploads admitted before `upload` still have to write: space they were promised. */
  private promisedBefore(upload: Upload): number {
    let promised = 0;
    for (const other of this.uploads.values()) {
      if (other.admission < upload.admission && !other.closed) promised += Math.max(0, other.size - other.received);
    }
    return promised;
  }

  private async writeChunk(upload: Upload, seq: number, data: string, replyTo: string | undefined): Promise<void> {
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_CHUNK_BYTES) {
      await this.fail(upload, new UploadFailure("invalid_upload", `A chunk is larger than ${formatMiB(MAX_CHUNK_BYTES)}.`));
      return;
    }
    if (seq < upload.nextSeq) {
      this.ack(upload, replyTo);  // duplicate: the phone moves on from the ack
      return;
    }
    if (seq > upload.nextSeq) {
      // A gap (frames lost across a reconnect): keep a few, tell the phone where we are.
      if (upload.ahead.has(seq) || upload.ahead.size < MAX_AHEAD_CHUNKS) upload.ahead.set(seq, bytes);
      this.ack(upload, replyTo);
      return;
    }
    let current: Buffer | undefined = bytes;
    while (current) {
      if (upload.received + current.length > upload.size) {
        await this.fail(
          upload,
          new UploadFailure("size_mismatch", `The phone sent more data than the announced ${upload.size} bytes.`),
        );
        return;
      }
      await this.write(upload, current);
      upload.hash.update(current);
      upload.received += current.length;
      upload.nextSeq += 1;
      current = upload.ahead.get(upload.nextSeq);
      upload.ahead.delete(upload.nextSeq);
    }
    this.ack(upload, replyTo);
  }

  private async write(upload: Upload, bytes: Buffer): Promise<void> {
    const fh = upload.fh;
    if (!fh) throw new UploadFailure("write_failed", "The PC lost the file it was writing.");
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, offset, bytes.length - offset, upload.received + offset);
      offset += bytesWritten;
    }
  }

  private async finish(upload: Upload, endSha256: string | null, replyTo: string | undefined): Promise<void> {
    if (upload.received < upload.size) {
      this.ack(upload, replyTo);  // chunks are missing: the phone resends from `seq`
      return;
    }
    if (upload.received !== upload.size || upload.ahead.size > 0) {
      await this.fail(
        upload,
        new UploadFailure("size_mismatch", `The PC received ${upload.received} bytes, expected ${upload.size}.`),
      );
      return;
    }
    upload.finishing = true;
    this.armIdle(upload);
    const fh = upload.fh;
    upload.fh = null;
    await fh?.close();
    const digest = upload.hash.digest("hex");
    if ((upload.sha256 !== null && digest !== upload.sha256) || (endSha256 !== null && digest !== endSha256)) {
      await this.fail(
        upload,
        new UploadFailure("sha_mismatch", "The file arrived damaged (checksum mismatch). Upload it again."),
      );
      return;
    }
    const path = await this.commit(upload);
    this.close(upload);
    this.finished.set(upload.key, { path, size: upload.size, at: Date.now() });
    this.pruneFinished();
    this.sendDone(upload.channel, upload.uploadId, { path, size: upload.size });
  }

  /** Gives the finished temp file its final name without ever replacing another file. */
  private async commit(upload: Upload): Promise<string> {
    const partPath = upload.partPath;
    const dir = upload.dir;
    if (partPath === null || dir === null) throw new UploadFailure("write_failed", "The PC lost the file it was writing.");
    for (let n = upload.nameIndex; n < upload.nameIndex + MAX_NAME_ATTEMPTS; n += 1) {
      const target = join(dir, withCollisionSuffix(upload.name, n));
      try {
        await link(partPath, target);
      } catch (err) {
        const code = errnoOf(err);
        if (code === "EEXIST") continue;
        if (code === "ENOENT") throw err;
        // No hard links on this filesystem: rename, unless something took the name meanwhile.
        if (await exists(target)) continue;
        await rename(partPath, target);
        return target;
      }
      await unlink(partPath).catch(() => undefined);
      return target;
    }
    throw new UploadFailure("write_failed", "The PC could not find a free file name.");
  }

  // ── Ending an upload ──────────────────────────────────────────────────────

  /** Over: forgotten at once, so a frame arriving now starts from "unknown". */
  private close(upload: Upload): void {
    upload.closed = true;
    clearTimeout(upload.idle);
    upload.idle = undefined;
    this.uploads.delete(upload.key);
  }

  /** The phone cancelled (or the session ended): drop the upload and its `.part`. */
  private cancel(upload: Upload): void {
    this.close(upload);
    this.run(upload, () => this.removePart(upload), true);
  }

  private async fail(upload: Upload, failure: UploadFailure): Promise<void> {
    if (upload.closed) return;
    this.close(upload);
    await this.removePart(upload);
    this.sendError(upload.channel, upload.uploadId, failure.uploadCode, failure.message);
  }

  private async removePart(upload: Upload): Promise<void> {
    upload.ahead.clear();
    const fh = upload.fh;
    upload.fh = null;
    await fh?.close().catch(() => undefined);
    if (upload.partPath !== null) await rm(upload.partPath, { force: true }).catch(() => undefined);
  }

  private pruneFinished(): void {
    for (const [key, done] of this.finished) {
      if (this.finished.size <= MAX_FINISHED && Date.now() - done.at <= FINISHED_TTL_MS) break;
      this.finished.delete(key);
    }
  }

  private finishedFor(key: string): Finished | undefined {
    const done = this.finished.get(key);
    if (!done) return undefined;
    if (Date.now() - done.at > FINISHED_TTL_MS) {
      this.finished.delete(key);
      return undefined;
    }
    return done;
  }

  // ── Frames out ────────────────────────────────────────────────────────────

  private ack(upload: Upload, replyTo?: string): void {
    this.send(upload.channel, {
      type: "upload_ack",
      upload_id: upload.uploadId,
      seq: upload.nextSeq,
      received: upload.received,
      ...(replyTo === undefined ? {} : { in_reply_to: replyTo }),
    });
  }

  private sendDone(channel: PeerChannel, uploadId: string, done: { path: string; size: number }): void {
    this.send(channel, { type: "upload_done", upload_id: uploadId, path: done.path, size: done.size });
  }

  private sendError(channel: PeerChannel, uploadId: string, code: UploadErrorCode, message: string): void {
    this.send(channel, { type: "upload_error", upload_id: uploadId, code, message });
  }

  private send(channel: PeerChannel, msg: ServerMessage): void {
    try {
      channel.send(msg);
    } catch {
      /* best-effort, like every other frame */
    }
  }

  // ── Leftovers ─────────────────────────────────────────────────────────────

  /** Once per process: deletes temp files a crash left behind (`<uploads>/.incoming/*.part`, older than a day). Stored files are never looked at. */
  private async sweepStaleParts(incoming: string): Promise<void> {
    if (this.swept) return;
    this.swept = true;
    try {
      const cutoff = Date.now() - STALE_PART_MS;
      for (const entry of await readdir(incoming)) {
        if (!entry.endsWith(".part")) continue;
        const path = join(incoming, entry);
        try {
          if ((await lstat(path)).mtimeMs < cutoff) await rm(path, { force: true });
        } catch {
          /* raced with a delete */
        }
      }
    } catch {
      /* nothing to sweep, or unreadable: not worth failing an upload over */
    }
  }
}

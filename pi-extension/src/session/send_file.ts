/**
 * Plan/65 — send a finished file from this PC to one paired phone.
 *
 * Transport: chunked frames over the existing peer channel (no relay change).
 *
 *   ext → app  file_offer { file_id, name, mime, size, sha256, caption?, turn_id? }
 *   ext → app  file_chunk { file_id, seq, data }       data = base64(≤ 1 MiB)
 *   ext → app  file_end   { file_id, chunks }
 *   app → ext  file_ack   { file_id, next_seq }        cumulative
 *   app → ext  file_done / file_error { file_id, reason? }
 *   either     file_cancel { file_id }
 *
 * Flow control: the relay has no backpressure, so the sender keeps at most
 * `window` (4) chunks in flight beyond the last cumulative ack.
 *
 * Presence: the relay drops frames for an offline peer without telling the
 * sender, so the extension follows the owner's relay presence (`peer_online`
 * / `peer_offline`, see `transport/presence.ts`). A target that is offline
 * per presence gets `offlineWaitMs` (20 s) to come back before the send
 * fails with `phone_offline`; nothing is queued. With no presence frames yet
 * (`unknown`) the attached channel is used and the timers below decide.
 *
 * Timers: the phone acks the offer with `next_seq` 0; no ack within
 * `offerAckMs` (30 s) fails `phone_unreachable`. After that, no ack progress
 * for `stallMs` (60 s) fails `stalled`. Both send a best-effort `file_cancel`.
 *
 * Resume: when acks stop, the sender waits `retransmitMs` (doubling, capped)
 * and probes: `file_offer` again, then the first unacked chunk only, so a
 * phone that missed the offer can start. The phone acks a repeated offer
 * with its current `next_seq` and keeps its `.part`; that first ack after a
 * probe is taken as the phone's position. A re-attached channel probes at
 * once. `peer_offline` mid-transfer pauses (no frames, no offer/stall timer);
 * `peer_online` within `offlineGraceMs` (60 s) resumes with the same probe,
 * otherwise the transfer fails `phone_offline` with the share received.
 */
import type { ExtensionAPI } from "../omp-api.js";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { ClientMessage, FileTransferReason, ServerMessage } from "../protocol/types.js";
import type { PeerChannel } from "../transport/peer_channel.js";

export const FILE_CHUNK_BYTES = 1024 * 1024;
export const FILE_WINDOW = 4;
/** A target offline per relay presence gets this long to come back. */
export const OFFLINE_WAIT_MS = 20_000;
/** The phone must ack the `file_offer` within this. */
export const OFFER_ACK_MS = 30_000;
/** No ack progress for this long fails the transfer as `stalled`. */
export const STALL_MS = 60_000;
/** A phone that went offline mid-transfer must be back within this. */
export const OFFLINE_GRACE_MS = 60_000;
export const RETRANSMIT_MS = 15_000;
export const RETRANSMIT_MAX_MS = 30_000;
export const DEFAULT_MAX_SEND_MIB = 256;

export type SendFileErrorCode =
  | "not_found"
  | "not_a_file"
  | "unreadable"
  | "too_large"
  | "phone_offline"
  | "phone_unreachable"
  | "stalled"
  | "aborted"
  | "cancelled"
  | "sha_mismatch"
  | "no_space"
  | "phone_error";

export class SendFileError extends Error {
  constructor(
    public readonly code: SendFileErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SendFileError";
  }
}

/** Per-file cap in bytes: `REMOTE_OMP_MAX_SEND_MIB` (positive number), else 256 MiB. */
export function maxSendBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env["REMOTE_OMP_MAX_SEND_MIB"];
  const mib = raw === undefined ? NaN : Number(raw);
  const effective = Number.isFinite(mib) && mib > 0 ? mib : DEFAULT_MAX_SEND_MIB;
  return Math.floor(effective * 1024 * 1024);
}

const MIME_BY_EXT: Record<string, string> = {
  ".apk": "application/vnd.android.package-archive",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function guessMime(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export type PhonePresence = "online" | "offline" | "unknown";

/** The extension's view of paired phones. Implemented over `_activePeers`. */
export interface PhoneRegistry {
  /** Attached phones, in attach order: device id → outbound channel. */
  online(): ReadonlyMap<string, PeerChannel>;
  /** Device id of the phone that sent the latest user input, if any. */
  latestInputDevice(): string | null;
  /** Display name for results (falls back to a short id). */
  deviceName(deviceId: string): string;
  /** Relay presence of the owner; `unknown` before any presence frame. */
  presence?(deviceId: string): PhonePresence;
}

const OFFLINE_MESSAGE = "Remote OMP is not connected on the phone. Ask the user to open the app, then try again.";

/**
 * The phone that sent the latest user input when it is online; otherwise the
 * only other online phone. With several online and none of them the latest
 * sender, the most recently attached one. `null` when no phone is online.
 */
export function chooseTargetPhone(
  online: ReadonlyMap<string, PeerChannel>,
  latest: string | null,
): string | null {
  if (latest !== null && online.has(latest)) return latest;
  let last: string | null = null;
  for (const id of online.keys()) last = id;
  return last;
}

export interface SendFileRequest {
  path: string;
  caption?: string;
  turnId?: string;
  /** Base for a relative `path`. Defaults to `process.cwd()`. */
  cwd?: string;
  signal?: AbortSignal;
  /** Called after every ack that advances the transfer. */
  onProgress?: (progress: SendFileProgress) => void;
}

export interface SendFileResult {
  file_id: string;
  name: string;
  size: number;
  device: string;
  chunks: number;
}

export interface SendFileProgress {
  name: string;
  size: number;
  device: string;
  acked_chunks: number;
  total_chunks: number;
}

export interface FileSenderOptions {
  chunkBytes?: number;
  window?: number;
  offlineWaitMs?: number;
  offerAckMs?: number;
  stallMs?: number;
  offlineGraceMs?: number;
  retransmitMs?: number;
  retransmitMaxMs?: number;
  newId?: () => string;
}

function expandPath(path: string, cwd: string | undefined): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function errorForReason(reason: FileTransferReason | undefined): SendFileError {
  switch (reason) {
    case "sha_mismatch":
      return new SendFileError("sha_mismatch", "the phone received the file but its SHA-256 did not match");
    case "no_space":
      return new SendFileError("no_space", "the phone does not have enough free space");
    case "cancelled":
      return new SendFileError("cancelled", "the transfer was cancelled on the phone");
    default:
      return new SendFileError("phone_error", `the phone rejected the file${reason ? ` (${reason})` : ""}`);
  }
}

class Transfer {
  acked = 0;
  nextToSend = 0;
  endSent = false;
  /** After a probe: the next ack is the phone's position, not an increment. */
  resumePending = false;
  /** Probe mode: one chunk in flight until an ack arrives. */
  probe = false;
  /** The phone acked the offer (any `file_ack`). */
  offerAcked = false;
  /** The phone is offline per relay presence: send nothing, wait for it. */
  paused = false;
  settled = false;
  private offer: ServerMessage | null = null;
  private pumping = false;
  private rtoMs: number;
  private rtoTimer: ReturnType<typeof setTimeout> | null = null;
  /** Offer-ack or stall deadline (not armed while paused). */
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveFn!: (r: SendFileResult) => void;
  private rejectFn!: (e: Error) => void;
  readonly done: Promise<SendFileResult>;

  constructor(
    private readonly owner: FileSender,
    readonly fileId: string,
    readonly deviceId: string,
    readonly name: string,
    readonly size: number,
    readonly chunks: number,
    private readonly fh: FileHandle,
    private readonly onProgress: SendFileRequest["onProgress"],
  ) {
    this.rtoMs = owner.retransmitMs;
    this.done = new Promise<SendFileResult>((res, rej) => {
      this.resolveFn = res;
      this.rejectFn = rej;
    });
  }

  private channel(): PeerChannel | undefined {
    return this.owner.phones.online().get(this.deviceId);
  }

  send(msg: ServerMessage): boolean {
    const ch = this.channel();
    if (!ch) return false;
    try {
      ch.send(msg);
    } catch {
      /* best-effort, like every other frame */
    }
    return true;
  }

  start(offer: ServerMessage): void {
    this.offer = offer;
    this.send(offer);
    this.armWatchdog();
    void this.pump();
  }

  /** Share of the file the phone has acked, as a whole percentage. */
  private percent(): number {
    if (this.size === 0) return this.acked >= this.chunks ? 100 : 0;
    const bytes = Math.min(this.acked * this.owner.chunkBytes, this.size);
    return Math.floor((bytes * 100) / this.size);
  }

  private cancelAndFail(err: SendFileError): void {
    this.send({ type: "file_cancel", file_id: this.fileId });
    this.fail(err);
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.settled || this.paused) return;
    if (!this.offerAcked) {
      this.watchdog = setTimeout(() => {
        this.cancelAndFail(new SendFileError(
          "phone_unreachable",
          `the phone did not answer the file offer within ${Math.round(this.owner.offerAckMs / 1000)} s; ` +
            "nothing was received. Ask the user to open Remote OMP on the phone, then try again.",
        ));
      }, this.owner.offerAckMs);
    } else {
      this.watchdog = setTimeout(() => {
        this.cancelAndFail(new SendFileError(
          "stalled",
          `no progress from the phone for ${Math.round(this.owner.stallMs / 1000)} s ` +
            `(${this.percent()}% received); the transfer was cancelled.`,
        ));
      }, this.owner.stallMs);
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private armRto(): void {
    if (this.rtoTimer || this.settled || this.paused) return;
    this.rtoTimer = setTimeout(() => {
      this.rtoTimer = null;
      this.onRetransmitTimeout();
    }, this.rtoMs);
  }

  private clearRto(): void {
    if (this.rtoTimer) clearTimeout(this.rtoTimer);
    this.rtoTimer = null;
  }

  private onRetransmitTimeout(): void {
    if (this.settled) return;
    this.rtoMs = Math.min(this.rtoMs * 2, this.owner.retransmitMaxMs);
    this.startProbe();
  }

  /**
   * Re-sends the offer, then goes back to the first unacked chunk with a
   * window of one. The offer lets a phone that never saw it start; a phone
   * that has it answers with its `next_seq`.
   */
  startProbe(): void {
    if (this.settled || this.paused) return;
    this.clearRto();
    if (this.offer) this.send(this.offer);
    if (this.acked < this.chunks) {
      this.nextToSend = this.acked;
      this.probe = true;
      this.resumePending = true;
      this.endSent = false;
      void this.pump();
    } else {
      // Every chunk is acked but no file_done: file_end may have been lost.
      this.endSent = false;
      void this.pump();
    }
  }

  /** The phone went offline per relay presence. */
  pause(): void {
    if (this.settled || this.paused) return;
    this.paused = true;
    this.clearRto();
    this.clearWatchdog();
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      this.cancelAndFail(new SendFileError(
        "phone_offline",
        `Remote OMP went offline on the phone at ${this.percent()}% received and did not come back within ` +
          `${Math.round(this.owner.offlineGraceMs / 1000)} s. Ask the user to open the app, then send the file again.`,
      ));
    }, this.owner.offlineGraceMs);
  }

  /** The phone is back (presence or a re-attached channel): probe at once. */
  resume(): void {
    if (this.settled) return;
    if (this.paused) {
      this.paused = false;
      if (this.offlineTimer) clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
      this.rtoMs = this.owner.retransmitMs;
      this.armWatchdog();
    }
    this.startProbe();
  }

  onAck(nextSeq: number): void {
    if (this.settled || !Number.isInteger(nextSeq) || nextSeq < 0) return;
    const n = Math.min(nextSeq, this.chunks);
    const before = this.acked;
    const firstAck = !this.offerAcked;
    this.offerAcked = true;
    if (this.resumePending) {
      // The phone reports where it is after a gap: continue from there.
      this.resumePending = false;
      this.probe = false;
      this.acked = n;
      this.nextToSend = n;
      if (n < this.chunks) this.endSent = false;
    } else if (n > this.acked) {
      this.acked = n;
      if (this.nextToSend < n) this.nextToSend = n;
    } else if (!firstAck) {
      return;  // duplicate / stale ack
    }
    this.progress(firstAck || this.acked > before);
    void this.pump();
  }

  /** `advanced`: the offer was acked or `acked` grew (resets the stall timer). */
  private progress(advanced: boolean): void {
    this.rtoMs = this.owner.retransmitMs;
    this.clearRto();
    if (advanced) this.armWatchdog();
    if (this.nextToSend > this.acked || this.endSent) this.armRto();
    try {
      this.onProgress?.({
        name: this.name,
        size: this.size,
        device: this.owner.phones.deviceName(this.deviceId),
        acked_chunks: this.acked,
        total_chunks: this.chunks,
      });
    } catch {
      /* progress is cosmetic */
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.settled || this.paused) return;
    this.pumping = true;
    try {
      while (!this.settled && !this.paused && this.channel()) {
        const limit = this.probe ? 1 : this.owner.window;
        if (this.nextToSend < this.chunks && this.nextToSend - this.acked < limit) {
          const seq = this.nextToSend;
          this.nextToSend += 1;
          const data = await this.readChunk(seq);
          if (this.settled) return;
          if (this.paused || !this.send({ type: "file_chunk", file_id: this.fileId, seq, data })) {
            // Phone went away mid-read: resend this chunk once it is back.
            if (this.nextToSend > seq) this.nextToSend = seq;
            return;
          }
          this.armRto();
          continue;
        }
        if (this.nextToSend >= this.chunks && !this.endSent) {
          this.endSent = true;
          this.send({ type: "file_end", file_id: this.fileId, chunks: this.chunks });
          this.armRto();
        }
        return;
      }
    } catch (err) {
      this.fail(new SendFileError("unreadable", `reading the file failed: ${String(err)}`));
    } finally {
      this.pumping = false;
    }
  }

  private async readChunk(seq: number): Promise<string> {
    const offset = seq * this.owner.chunkBytes;
    const len = Math.min(this.owner.chunkBytes, this.size - offset);
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const { bytesRead } = await this.fh.read(buf, read, len - read, offset + read);
      if (bytesRead === 0) throw new Error("file shrank while sending");
      read += bytesRead;
    }
    return buf.toString("base64");
  }

  succeed(): void {
    if (this.settled) return;
    this.cleanup();
    this.resolveFn({
      file_id: this.fileId,
      name: this.name,
      size: this.size,
      device: this.owner.phones.deviceName(this.deviceId),
      chunks: this.chunks,
    });
  }

  fail(err: Error): void {
    if (this.settled) return;
    this.cleanup();
    this.rejectFn(err);
  }

  private cleanup(): void {
    this.settled = true;
    this.clearRto();
    this.clearWatchdog();
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
    this.owner.forget(this.fileId);
    void this.fh.close().catch(() => undefined);
  }
}

export class FileSender {
  readonly chunkBytes: number;
  readonly window: number;
  readonly offlineWaitMs: number;
  readonly offerAckMs: number;
  readonly stallMs: number;
  readonly offlineGraceMs: number;
  readonly retransmitMs: number;
  readonly retransmitMaxMs: number;
  private readonly newId: () => string;
  private readonly transfers = new Map<string, Transfer>();
  /** `send` calls waiting for a phone to come back (presence or attach). */
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly phones: PhoneRegistry,
    opts: FileSenderOptions = {},
  ) {
    this.chunkBytes = opts.chunkBytes ?? FILE_CHUNK_BYTES;
    this.window = opts.window ?? FILE_WINDOW;
    this.offlineWaitMs = opts.offlineWaitMs ?? OFFLINE_WAIT_MS;
    this.offerAckMs = opts.offerAckMs ?? OFFER_ACK_MS;
    this.stallMs = opts.stallMs ?? STALL_MS;
    this.offlineGraceMs = opts.offlineGraceMs ?? OFFLINE_GRACE_MS;
    this.retransmitMs = opts.retransmitMs ?? RETRANSMIT_MS;
    this.retransmitMaxMs = Math.max(opts.retransmitMaxMs ?? RETRANSMIT_MAX_MS, this.retransmitMs);
    this.newId = opts.newId ?? randomUUID;
  }

  /** Number of transfers still in progress. */
  activeCount(): number {
    return this.transfers.size;
  }

  /** @internal Transfer bookkeeping. */
  forget(fileId: string): void {
    this.transfers.delete(fileId);
  }

  private presenceOf(deviceId: string): PhonePresence {
    return this.phones.presence?.(deviceId) ?? "unknown";
  }

  /**
   * The target among attached phones that are not offline per presence. A
   * phone that is attached but offline gets `offlineWaitMs` to come back;
   * with no attached phone at all the send fails at once.
   */
  private async pickTarget(signal: AbortSignal | undefined): Promise<string> {
    const deadline = Date.now() + this.offlineWaitMs;
    for (;;) {
      const attached = this.phones.online();
      const eligible = new Map<string, PeerChannel>();
      for (const [id, ch] of attached) {
        if (this.presenceOf(id) !== "offline") eligible.set(id, ch);
      }
      const target = chooseTargetPhone(eligible, this.phones.latestInputDevice());
      if (target !== null) return target;
      const remaining = deadline - Date.now();
      if (attached.size === 0 || remaining <= 0) throw new SendFileError("phone_offline", OFFLINE_MESSAGE);
      await this.waitForChange(remaining, signal);
    }
  }

  /** Resolves on the next presence change or attach, or after `ms`. */
  private waitForChange(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", onAbort);
      };
      const wake = (): void => {
        finish();
        resolve();
      };
      const onAbort = (): void => {
        finish();
        reject(new SendFileError("aborted", "the tool call was aborted"));
      };
      const timer = setTimeout(wake, ms);
      this.waiters.add(wake);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private wakeWaiters(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /**
   * Sends one file to the target phone. Resolves on `file_done`; rejects with
   * a {@link SendFileError}. Path, type and size are checked before any frame.
   */
  async send(req: SendFileRequest): Promise<SendFileResult> {
    const { signal } = req;
    if (signal?.aborted) throw new SendFileError("aborted", "the tool call was aborted");

    const fullPath = expandPath(req.path, req.cwd);
    let st;
    try {
      st = await stat(fullPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new SendFileError("not_found", `no such file: ${fullPath}`);
      }
      throw new SendFileError("unreadable", `cannot stat ${fullPath}: ${String(err)}`);
    }
    if (!st.isFile()) throw new SendFileError("not_a_file", `not a regular file: ${fullPath}`);
    const cap = maxSendBytes();
    if (st.size > cap) {
      throw new SendFileError(
        "too_large",
        `${fullPath} is ${st.size} bytes; the limit is ${cap} bytes (REMOTE_OMP_MAX_SEND_MIB)`,
      );
    }

    await this.pickTarget(signal);  // fail fast before hashing a large file

    let fh: FileHandle;
    let sha256: string;
    try {
      sha256 = await sha256File(fullPath);
      fh = await open(fullPath, "r");
    } catch (err) {
      throw new SendFileError("unreadable", `cannot read ${fullPath}: ${String(err)}`);
    }
    if (signal?.aborted) {
      await fh.close().catch(() => undefined);
      throw new SendFileError("aborted", "the tool call was aborted");
    }
    let deviceId: string;
    try {
      deviceId = await this.pickTarget(signal);  // re-check: hashing can take a while
    } catch (err) {
      await fh.close().catch(() => undefined);
      throw err;
    }

    const name = basename(fullPath);
    const fileId = this.newId();
    const chunks = Math.ceil(st.size / this.chunkBytes);
    const transfer = new Transfer(this, fileId, deviceId, name, st.size, chunks, fh, req.onProgress);
    this.transfers.set(fileId, transfer);

    const onAbort = (): void => {
      transfer.send({ type: "file_cancel", file_id: fileId });
      transfer.fail(new SendFileError("aborted", "the tool call was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    transfer.start({
      type: "file_offer",
      file_id: fileId,
      name,
      mime: guessMime(name),
      size: st.size,
      sha256,
      ...(req.caption ? { caption: req.caption } : {}),
      ...(req.turnId ? { turn_id: req.turnId } : {}),
    });
    try {
      return await transfer.done;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Routes an app → ext frame. Returns true for every `file_*` frame (handled
   * or ignored), false for anything else. Frames from a phone other than the
   * transfer's target, or for an unknown `file_id`, are ignored.
   */
  handleMessage(deviceId: string | null, msg: ClientMessage): boolean {
    switch (msg.type) {
      case "file_ack":
      case "file_done":
      case "file_error":
      case "file_cancel":
        break;
      default:
        return false;
    }
    const transfer = typeof msg.file_id === "string" ? this.transfers.get(msg.file_id) : undefined;
    if (!transfer || transfer.deviceId !== deviceId) return true;
    switch (msg.type) {
      case "file_ack":
        transfer.onAck(msg.next_seq);
        break;
      case "file_done":
        transfer.succeed();
        break;
      case "file_error":
        transfer.fail(errorForReason(msg.reason));
        break;
      case "file_cancel":
        transfer.fail(errorForReason("cancelled"));
        break;
    }
    return true;
  }

  /** The phone's channel was (re-)attached: probe so it reports `next_seq`. */
  onPhoneAttached(deviceId: string): void {
    for (const t of this.transfers.values()) {
      if (t.deviceId === deviceId) t.resume();
    }
    this.wakeWaiters();
  }

  /**
   * Relay presence of an owner changed (transitions only). Offline pauses its
   * transfers; online resumes a paused one at once.
   */
  onPresence(deviceId: string, online: boolean): void {
    for (const t of this.transfers.values()) {
      if (t.deviceId !== deviceId) continue;
      if (!online) t.pause();
      else if (t.paused) t.resume();
    }
    this.wakeWaiters();
  }
}

export const SendToPhoneParams = Type.Object({
  path: Type.String({ description: "Path of the finished file on this PC (absolute, ~/…, or relative to the session cwd)." }),
  caption: Type.Optional(Type.String({ description: "Short note shown with the file on the phone." })),
});

export interface SendToPhoneDetails {
  name: string;
  size: number;
  device: string;
  /** Present on progress updates only. */
  acked_chunks?: number;
  total_chunks?: number;
}

/**
 * Registers `send_to_phone({ path, caption? })`. Call once per `pi` (inside
 * the extension factory's first-load-wins guard).
 */
export function registerSendToPhoneTool(
  pi: ExtensionAPI,
  sender: FileSender,
  currentTurnId: () => string | null = () => null,
): void {
  pi.registerTool<typeof SendToPhoneParams, SendToPhoneDetails>({
    name: "send_to_phone",
    label: "Send to phone",
    description:
      "Send a finished file from this PC to the user's paired phone (Remote OMP app), e.g. a built APK, " +
      "a PDF, a zip or a log the user should open there. The file appears as a card in the phone chat; " +
      "nothing opens or installs without the user's tap. Use it only when the user asks for a file on " +
      "their phone. To show an image, `read` it instead: it displays in the chat on the phone and web. " +
      "Returns when the phone confirms receipt. " +
      `Limit ${DEFAULT_MAX_SEND_MIB} MiB per file by default. Fails within about 20 s with phone_offline when ` +
      "Remote OMP is not connected on the phone, and with phone_unreachable or stalled when the phone stops " +
      "answering; then tell the user instead of retrying in a loop.",
    parameters: SendToPhoneParams,
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      const cwd = ctx && typeof (ctx as { cwd?: unknown }).cwd === "string"
        ? (ctx as { cwd: string }).cwd
        : undefined;
      const turnId = currentTurnId();
      const result = await sender.send({
        path: params.path,
        ...(params.caption ? { caption: params.caption } : {}),
        ...(turnId ? { turnId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(signal ? { signal } : {}),
        onProgress: (progress) => {
          if (typeof onUpdate !== "function") return;
          onUpdate({
            content: [{
              type: "text",
              text: `Sending ${progress.name} to ${progress.device}: ${progress.acked_chunks}/${progress.total_chunks} chunks`,
            }],
            details: progress,
          });
        },
      });
      const details: SendToPhoneDetails = { name: result.name, size: result.size, device: result.device };
      return {
        content: [{
          type: "text",
          text: `Sent ${result.name} (${result.size} bytes) to ${result.device}. It is in the phone chat as a file card.`,
        }],
        details,
      };
    },
  });
}

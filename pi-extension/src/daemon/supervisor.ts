import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { addDaemon, listDaemons, migrateRegistryNames, removeDaemon, type DaemonRecord } from "./registry.js";
import { daemonIdForCwd } from "./id.js";
import { isHarness } from "./harness.js";
import { type LocalConfig } from "../session/local_config.js";
import { ipcAddress, usesNamedPipe } from "../session/ipc.js";
import { EXIT_DAEMON_FRESH_SESSION, EXIT_DAEMON_RESTART, RpcChild, type RpcChildExitEvent, type RpcChildOptions } from "./rpc_child.js";
import {
  type ControlReply,
  type ControlRequest,
  type CronJobView,
  type DaemonInfo,
  encodeReply,
  parseRequest,
} from "./control_protocol.js";
import { Cron } from "croner";
import {
  addJob as addCronJob,
  getJob as getCronJob,
  listJobs as listCronJobs,
  nextRunFor,
  recordRun,
  removeJob as removeCronJob,
  setJobEnabled,
  validateSchedule,
  type CronJob,
  type NewJobInput,
} from "./cron_registry.js";
import { appendCronLog, readCronLog, type CronResult } from "./cron_log.js";

/**
 * Central process that owns the daemon fleet (plan/26, plan/67).
 *
 * Responsibilities:
 *   - Spawn one `<harness> --mode rpc` child per registry entry. Track them in
 *     `children: Map<id, ChildSlot>`.
 *   - Own each daemon's lifetime (plan/67): a child that exits for any reason
 *     the supervisor did not request — a crash, or the harness quitting by
 *     itself — is respawned, with a capped backoff, for as long as the
 *     registry lists it.
 *   - Listen on `~/.pi/remote/supervisor.sock` for `ControlRequest`s from
 *     the `remote-pi` CLI. Each connection: 1 request → 1 reply → close.
 *   - Graceful shutdown on SIGTERM/SIGINT: stop all children + unlink
 *     the UDS file so a next supervisor can bind cleanly.
 *
 * The supervisor itself is the only long-running process the user installs as a
 * system service (systemd/launchd/Task Scheduler). If it exits or crashes, the
 * OS service manager restarts it; on restart it re-reads the registry and
 * re-spawns everything.
 */

const SUPERVISOR_SOCK_NAME = "supervisor.sock";
const MAX_REQUEST_BYTES = 1024 * 1024;
const CONNECTION_IDLE_TIMEOUT_MS = 5_000;
const FAST_RECYCLE_THRESHOLD_MS = 5_000;
const MAX_FAST_RECYCLES = 2;

/** Delay before respawning a daemon that exited on its own, by consecutive
 *  attempt; the last value repeats for as long as it keeps failing. The
 *  backoff only spaces retries out — a registered daemon is never abandoned. */
const RESTART_BACKOFFS_MS: readonly [number, ...number[]] = [1_000, 5_000, 30_000, 5 * 60_000];

/** A run at least this long counts as healthy: the next exit starts the
 *  backoff over instead of continuing where a past crash loop left off. */
const STABLE_UPTIME_MS = 60_000;

function supervisorSockPath(): string {
  const root = process.env["REMOTE_PI_HOME"] || homedir();
  // POSIX → ~/.pi/remote/supervisor.sock; Windows → per-user named pipe (plan/40).
  return ipcAddress("supervisor", join(root, ".pi", "remote", SUPERVISOR_SOCK_NAME));
}

function _unlinkIgnoringEnoent(path: string, context: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`[remote-pi-supervisord] unlink ${path} (${context}) failed: ${String(err)}\n`);
    }
  }
}

/** Thrown by `start()` when another live supervisor already holds the UDS.
 *  Prevents a second supervisor from orphaning the first's children. */
export class SupervisorAlreadyRunningError extends Error {
  constructor(public readonly sockPath: string) {
    super(
      `Another pi-supervisord is already running (UDS held at ${sockPath}). ` +
      "Refusing to start a second instance. Use `remote-pi daemon …` to control it, " +
      "or stop the running one first.",
    );
    this.name = "SupervisorAlreadyRunningError";
  }
}

/** Probes whether a live supervisor is accepting connections on `path`.
 *  Resolves true if the connect succeeds (a listener is there), false on
 *  ECONNREFUSED / ENOENT (stale socket file from a crashed supervisor). */
function _probeSupervisor(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = createConnection({ path });
    const done = (alive: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), 1_000);
    sock.once("connect", () => { clearTimeout(timer); done(true); });
    sock.once("error", () => { clearTimeout(timer); done(false); });
  });
}

export interface SupervisorOptions {
  /** Absolute path to remote-pi's `dist/index.js` — passed as `-e` to each
   *  spawned daemon child. */
  extensionPath: string;
  /** Override the harness binary for every daemon. Defaults to the daemon's
   *  harness name (`pi` / `omp`) on PATH. */
  piBin?: string;
  /** Child environment overlay passed to spawned daemons instead of mutating
   *  the supervisor's own `process.env`. */
  childEnv?: NodeJS.ProcessEnv;
  /** Async hook run after UDS binding succeeds to resolve `childEnv`. */
  loadChildEnv?: () => Promise<NodeJS.ProcessEnv | undefined>;
  /** Test seam: replaces `RESTART_BACKOFFS_MS`. Must be non-empty. */
  restartBackoffsMs?: readonly [number, ...number[]];
  /** Test seam: replaces `STABLE_UPTIME_MS`. Must be > 0. */
  stableUptimeMs?: number;
}

/** Pure decision for `fireJob` (plan/39) — picks the action from the daemon's
 *  liveness/busy state + the job's flags. Tested in isolation for all 4 branches. */
export type FireAction = "send" | "wake_and_send" | "skip_down" | "skip_busy";
export function decideFireAction(o: {
  running: boolean;
  busy: boolean;
  wake: boolean;
  skipIfBusy: boolean;
}): FireAction {
  if (!o.running) return o.wake ? "wake_and_send" : "skip_down";
  if (o.skipIfBusy && o.busy) return "skip_busy";
  return "send";
}

interface ChildSlot {
  id: string;
  cwd: string;
  child: RpcChild;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartAttempt: number;
  fastRecycleCount: number;
}

export class Supervisor {
  private server: Server | null = null;
  private readonly children = new Map<string, ChildSlot>();
  /** Live croner schedules, keyed by cron job id (plan/39). */
  private readonly cronJobs = new Map<string, Cron>();
  private childEnv: NodeJS.ProcessEnv | undefined;
  private shuttingDown = false;

  constructor(private readonly opts: SupervisorOptions) {
    this.childEnv = opts.childEnv;
  }

  /** Bind the control UDS + load child env + spawn all registered daemons. */
  async start(): Promise<void> {
    this._mkdirParent();
    // Backfill folder-derived names into legacy registry entries (pre-name
    // field) so every daemon has a stable name to inject via env.
    migrateRegistryNames();
    await this._bindUds();
    if (this.opts.loadChildEnv) {
      const loaded = await this.opts.loadChildEnv();
      if (loaded) this.childEnv = loaded;
    }
    await this._spawnAllFromRegistry();
    // Cron (plan/39): schedule all enabled jobs, then run any missed catchup.
    this._reconcileCron();
    this._runCatchup();
  }

  /** Graceful shutdown: stop all children, close UDS. */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    // Stop all cron schedules (plan/39) so no fire races with teardown.
    for (const c of this.cronJobs.values()) c.stop();
    this.cronJobs.clear();
    // Cancel pending restart timers first so they don't race with stop().
    for (const slot of this.children.values()) {
      this._cancelRestart(slot);
    }
    await Promise.all([...this.children.values()].map((s) => s.child.stop()));
    this.children.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    // Best-effort: clear the socket file so a next supervisor bind succeeds.
    // Windows named pipes have no file (auto-removed on exit) → nothing to do.
    if (!usesNamedPipe()) {
      _unlinkIgnoringEnoent(supervisorSockPath(), "stop");
    }
  }

  // ── UDS binding ──────────────────────────────────────────────────────────

  private _mkdirParent(): void {
    // A named pipe has no parent directory to create (the addr is `\\.\pipe\…`).
    if (usesNamedPipe()) return;
    mkdirSync(dirname(supervisorSockPath()), { recursive: true });
  }

  private async _bindUds(): Promise<void> {
    const path = supervisorSockPath();
    const pipe = usesNamedPipe();
    // Single-instance guard. PROBE first: a live supervisor answering the
    // connect means we must NOT start a second one. Stealing the socket
    // (unlink + bind) would orphan the running supervisor's children.
    if (pipe || existsSync(path)) {
      const alive = await _probeSupervisor(path);
      if (alive) {
        throw new SupervisorAlreadyRunningError(path);
      }
      if (!pipe) {
        _unlinkIgnoringEnoent(path, "stale bind");
      }
    }
    const server = createServer((socket) => this._onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => {
      process.stderr.write(`[remote-pi-supervisord] UDS server error: ${String(err)}\n`);
    });
    this.server = server;
  }

  private _onConnection(socket: Socket): void {
    let buf = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(CONNECTION_IDLE_TIMEOUT_MS, () => {
      if (!handled) socket.destroy();
    });
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(encodeReply({ ok: false, error: "control request too large" }));
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      const line = buf.slice(0, nl);
      void this._handleRequest(line)
        .then((reply) => socket.end(encodeReply(reply)))
        .catch((err) => {
          process.stderr.write(
            `[remote-pi-supervisord] control handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
          );
          socket.end(encodeReply<unknown>({ ok: false, error: String(err) }));
        });
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ECONNRESET") return;
      process.stderr.write(`[remote-pi-supervisord] control socket error: ${String(err)}\n`);
    });
  }

  // ── Request dispatch ─────────────────────────────────────────────────────

  private async _handleRequest(line: string): Promise<ControlReply<unknown>> {
    let req: ControlRequest;
    try { req = parseRequest(line); }
    catch (e) { return { ok: false, error: (e as Error).message }; }

    switch (req.op) {
      case "list":         return { ok: true, data: { daemons: this._listInfo() } };
      case "status":       return { ok: true, data: { daemons: this._listInfo() } };
      case "start_all":    return this._opStartAll();
      case "start":        return this._opStart(req.id);
      case "stop_all":     return this._opStopAll();
      case "stop":         return this._opStop(req.id);
      case "restart_all":  return this._opRestartAll();
      case "restart":      return this._opRestart(req.id);
      case "send":         return this._opSend(req.id, req.text);
      case "register":     return this._opRegister(req);
      case "unregister":   return this._opUnregister(req.id);
      case "cron_add":     return this._opCronAdd(req);
      case "cron_list":    return this._opCronList();
      case "cron_remove":  return this._opCronRemove(req.job_id);
      case "cron_enable":  return this._opCronEnable(req.job_id, req.enabled);
      case "cron_run":     return this._opCronRun(req.job_id);
      case "cron_log":     return this._opCronLog(req.job_id, req.tail);
      default: {
        const unknown = (req as { op: string }).op;
        return { ok: false, error: `unknown op: ${unknown}` };
      }
    }
  }

  // ── Op handlers ──────────────────────────────────────────────────────────

  private _findRegistered(id: string): DaemonRecord | undefined {
    return listDaemons().find((d) => d.id === id);
  }

  private _listInfo(): DaemonInfo[] {
    const registry = listDaemons();
    return registry.map((entry) => {
      const slot = this.children.get(entry.id);
      const info: DaemonInfo = {
        id: entry.id,
        cwd: entry.cwd,
        name: entry.name,
        harness: entry.harness,
        state: slot?.child.state ?? "stopped",
      };
      if (slot) {
        if (slot.child.pid !== undefined) info.pid = slot.child.pid;
        if (slot.child.uptimeMs !== undefined) info.uptime_s = Math.floor(slot.child.uptimeMs / 1000);
        info.restart_count = slot.child.restartCount;
      }
      return info;
    });
  }

  private async _opStartAll(): Promise<ControlReply<unknown>> {
    const started: string[] = [];
    const already: string[] = [];
    const toSpawn: DaemonRecord[] = [];
    for (const entry of listDaemons()) {
      const slot = this.children.get(entry.id);
      if (slot && slot.child.isActive) {
        already.push(entry.id);
        continue;
      }
      toSpawn.push(entry);
      started.push(entry.id);
    }
    await Promise.all(toSpawn.map((entry) => this._spawnEntry(entry)));
    return { ok: true, data: { started, already_running: already } };
  }

  /** Spawn a single registered daemon by id. Idempotent: a daemon already
   *  active returns `started: false`. Unknown id → ok:false. This is what
   *  `/remote-pi create` calls so a freshly-registered folder boots its daemon
   *  immediately instead of waiting for the next supervisor restart. */
  private async _opStart(id: string): Promise<ControlReply<unknown>> {
    const entry = this._findRegistered(id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    const slot = this.children.get(id);
    if (slot && slot.child.isActive) {
      return { ok: true, data: { id, state: slot.child.state, started: false } };
    }
    await this._spawnEntry(entry);
    const state = this.children.get(id)?.child.state ?? "starting";
    return { ok: true, data: { id, state, started: true } };
  }

  private async _opStopAll(): Promise<ControlReply<unknown>> {
    const stopped: string[] = [];
    const already: string[] = [];
    const toStop: Array<{ id: string; slot: ChildSlot }> = [];
    // Cancel every retry timer upfront so none can fire while peers stop.
    for (const [id, slot] of this.children) {
      this._cancelRestart(slot);
      if (!slot.child.isActive) {
        already.push(id);
        continue;
      }
      toStop.push({ id, slot });
    }
    if (toStop.length > 0) {
      process.stderr.write(
        `[remote-pi-supervisord] stopping ${toStop.map((x) => x.id).join(", ")} (stop_all)\n`,
      );
      await Promise.all(toStop.map(async ({ id, slot }) => {
        await slot.child.stop();
        stopped.push(id);
      }));
    }
    return { ok: true, data: { stopped, already_stopped: already } };
  }

  /** Stop a single registered daemon by id. Idempotent: a daemon that isn't
   *  active returns `stopped: false`. Unknown id → ok:false. Cancels any
   *  pending restart backoff unconditionally so a deliberate stop sticks. */
  private async _opStop(id: string): Promise<ControlReply<unknown>> {
    const entry = this._findRegistered(id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    const slot = this.children.get(id);
    if (slot) this._cancelRestart(slot);
    if (!slot || !slot.child.isActive) {
      return { ok: true, data: { id, state: slot?.child.state ?? "stopped", stopped: false } };
    }
    process.stderr.write(`[remote-pi-supervisord] stopping ${id} (requested)\n`);
    await slot.child.stop();
    return { ok: true, data: { id, state: slot.child.state, stopped: true } };
  }

  /** Restart a single registered daemon by id (cancel backoff, stop if active,
   *  then spawn). Unknown id → ok:false. Resets the crash backoff. */
  private async _opRestart(id: string): Promise<ControlReply<unknown>> {
    const entry = this._findRegistered(id);
    if (!entry) return { ok: false, error: `no daemon with id ${id}` };
    const slot = this.children.get(id);
    if (slot) {
      this._cancelRestart(slot);
      if (slot.child.isActive) await slot.child.stop();
    }
    await this._spawnEntry(entry);
    const state = this.children.get(id)?.child.state ?? "starting";
    return { ok: true, data: { id, state, restarted: true } };
  }

  private async _opRestartAll(): Promise<ControlReply<unknown>> {
    const stopReply = await this._opStopAll();
    if (!stopReply.ok) return stopReply;
    const startReply = await this._opStartAll();
    if (!startReply.ok) return startReply;
    const restarted = (startReply.data as { started: string[] }).started;
    return { ok: true, data: { restarted } };
  }

  private _opSend(id: string, text: string): ControlReply<unknown> {
    const slot = this.children.get(id);
    if (!slot) return { ok: false, error: `daemon ${id} not running` };
    if (!slot.child.isActive) {
      return { ok: false, error: `daemon ${id} state is ${slot.child.state}` };
    }
    const ok = slot.child.sendPrompt(text);
    return { ok: true, data: { id, delivered: ok } };
  }

  private _opRegister(req: Extract<ControlRequest, { op: "register" }>): ControlReply<unknown> {
    if (typeof req.cwd !== "string" || !req.cwd.trim()) {
      return { ok: false, error: "cwd is required" };
    }
    if (req.harness !== undefined && !isHarness(req.harness)) {
      return { ok: false, error: `unknown harness "${String(req.harness)}" (expected pi or omp)` };
    }
    if (req.name !== undefined && typeof req.name !== "string") {
      return { ok: false, error: "name must be a string" };
    }
    try {
      const record = addDaemon(req.cwd, req.name, req.harness);
      return { ok: true, data: record };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async _opUnregister(id: string): Promise<ControlReply<unknown>> {
    // Stop the child first so we don't leave an orphan when the registry
    // entry is gone.
    const slot = this.children.get(id);
    if (slot) {
      this._cancelRestart(slot);
      await slot.child.stop();
      this.children.delete(id);
    }
    try {
      const result = removeDaemon(id);
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ── Cron ops + engine (plan/39) ────────────────────────────────────────────

  private _opCronAdd(req: Extract<ControlRequest, { op: "cron_add" }>): ControlReply<unknown> {
    const v = validateSchedule(req.schedule, req.tz);
    if (!v.ok) return { ok: false, error: v.error ?? "invalid schedule" };
    const input: NewJobInput = { daemon_id: req.daemon_id, schedule: req.schedule, prompt: req.prompt };
    if (req.tz !== undefined) input.tz = req.tz;
    if (req.skip_if_busy !== undefined) input.skip_if_busy = req.skip_if_busy;
    if (req.wake !== undefined) input.wake = req.wake;
    if (req.catchup !== undefined) input.catchup = req.catchup;
    const job = addCronJob(input);
    this._scheduleCron(job);
    return { ok: true, data: { job: this._jobView(job) } };
  }

  private _opCronList(): ControlReply<unknown> {
    const jobs = listCronJobs().map((j) => this._jobView(j));
    return { ok: true, data: { jobs } };
  }

  private _opCronRemove(jobId: string): ControlReply<unknown> {
    const removed = removeCronJob(jobId);
    this._stopCron(jobId);
    return { ok: true, data: { removed } };
  }

  private _opCronEnable(jobId: string, enabled: boolean): ControlReply<unknown> {
    const updated = setJobEnabled(jobId, enabled);
    if (updated) {
      this._stopCron(jobId);
      const job = getCronJob(jobId);
      if (enabled && job) this._scheduleCron(job);
    }
    return { ok: true, data: { job_id: jobId, enabled, updated } };
  }

  private async _opCronRun(jobId: string): Promise<ControlReply<unknown>> {
    if (!getCronJob(jobId)) return { ok: false, error: `no cron job with id ${jobId}` };
    const result = await this.fireJob(jobId, { manual: true });
    return { ok: true, data: { job_id: jobId, result } };
  }

  private _opCronLog(jobId: string | undefined, tail: number | undefined): ControlReply<unknown> {
    const opts: { jobId?: string; tail?: number } = {};
    if (jobId !== undefined) opts.jobId = jobId;
    if (tail !== undefined) opts.tail = tail;
    return { ok: true, data: { entries: readCronLog(opts) } };
  }

  private _jobView(job: CronJob): CronJobView {
    const next = nextRunFor(job);
    return { ...job, next_run: next ? next.toISOString() : null };
  }

  /** Rebuild all live `Cron` schedules from the registry (enabled jobs only).
   *  Called on start; mutations reconcile incrementally via _scheduleCron/_stopCron. */
  private _reconcileCron(): void {
    for (const c of this.cronJobs.values()) c.stop();
    this.cronJobs.clear();
    for (const job of listCronJobs()) {
      if (job.enabled) this._scheduleCron(job);
    }
  }

  private _scheduleCron(job: CronJob): void {
    this._stopCron(job.id);
    try {
      const opts = job.tz ? { timezone: job.tz, name: job.id } : { name: job.id };
      const cron = new Cron(job.schedule, opts, () => {
        void this.fireJob(job.id).catch((err) => {
          process.stderr.write(`[remote-pi-supervisord] cron fire failed for ${job.id}: ${String(err)}\n`);
        });
      });
      this.cronJobs.set(job.id, cron);
    } catch (e) {
      process.stderr.write(`[remote-pi-supervisord] cron schedule failed for ${job.id}: ${String(e)}\n`);
    }
  }

  private _stopCron(jobId: string): void {
    const c = this.cronJobs.get(jobId);
    if (c) { c.stop(); this.cronJobs.delete(jobId); }
  }

  /** Detail 2: on start, run a catchup job once if its previous scheduled run
   *  was missed while the supervisor was down. Opt-in (`catchup`), at most 1×. */
  private _runCatchup(): void {
    for (const job of listCronJobs()) {
      if (!job.enabled || !job.catchup) continue;
      try {
        const cron = new Cron(job.schedule, job.tz ? { timezone: job.tz } : {});
        const prev = cron.previousRun();
        cron.stop();
        if (!prev) continue;
        const lastRunMs = job.last_run ? Date.parse(job.last_run) : 0;
        if (prev.getTime() > lastRunMs) {
          void this.fireJob(job.id, { manual: true }).catch((err) => {
            process.stderr.write(`[remote-pi-supervisord] cron catchup failed for ${job.id}: ${String(err)}\n`);
          });
        }
      } catch (err) {
        process.stderr.write(
          `[remote-pi-supervisord] cron catchup skipped for ${job.id} (${job.schedule}): ${String(err)}\n`,
        );
      }
    }
  }

  /**
   * Fires a cron job: resolves the daemon, decides the action (decideFireAction),
   * acts, and records the outcome — ALWAYS one `last_status` update + one JSONL
   * line, for both fires and skips. Returns the result. `manual` bypasses the
   * disabled-skip (used by `cron run` + catchup).
   */
  async fireJob(jobId: string, opts: { manual?: boolean } = {}): Promise<CronResult | "missing"> {
    const job = getCronJob(jobId);
    if (!job) return "missing";

    let result: CronResult;
    if (!job.enabled && !opts.manual) {
      result = "skipped_disabled";
    } else {
      const slot = this.children.get(job.daemon_id);
      const running = !!slot && slot.child.isActive;
      let busy = false;
      if (running && job.skip_if_busy) busy = await slot!.child.refreshBusy();
      const action = decideFireAction({ running, busy, wake: job.wake, skipIfBusy: job.skip_if_busy });
      if (action === "skip_down") {
        result = "skipped_down";
      } else if (action === "skip_busy") {
        result = "skipped_busy";
      } else if (action === "wake_and_send") {
        const entry = this._findRegistered(job.daemon_id);
        if (!entry) {
          result = "skipped_down";
        } else {
          await this._spawnEntry(entry);
          const woke = this.children.get(job.daemon_id);
          result = woke && woke.child.sendPrompt(job.prompt) ? "woke_and_delivered" : "deliver_failed";
        }
      } else {
        result = slot!.child.sendPrompt(job.prompt) ? "delivered" : "deliver_failed";
      }
    }

    const at = new Date().toISOString();
    recordRun(job.id, at, result);
    appendCronLog({ job_id: job.id, daemon_id: job.daemon_id, schedule: job.schedule, result, prompt: job.prompt });
    return result;
  }

  // ── Child lifecycle ──────────────────────────────────────────────────────

  private async _spawnAllFromRegistry(): Promise<void> {
    await Promise.all(listDaemons().map((entry) => this._spawnEntry(entry)));
  }

  private _cancelRestart(slot: ChildSlot): void {
    if (slot.restartTimer === null) return;
    clearTimeout(slot.restartTimer);
    slot.restartTimer = null;
  }

  private async _spawnEntry(entry: DaemonRecord): Promise<void> {
    const { id, cwd } = entry;
    // Clean up any prior slot (e.g. crashed + waiting for backoff) and wait
    // for any still-active child to release its per-cwd UDS lock before spawning.
    const existing = this.children.get(id);
    if (existing) {
      this._cancelRestart(existing);
      if (existing.child.isActive) await existing.child.stop();
    }
    if (this.shuttingDown) return;

    const config: LocalConfig = {
      agent_name: entry.name,
      auto_start_relay: true,
    };
    const childOpts: RpcChildOptions = {
      harness: entry.harness,
      extensionPath: this.opts.extensionPath,
      cwd,
      config,
    };
    if (this.opts.piBin !== undefined) childOpts.piBin = this.opts.piBin;
    if (this.childEnv !== undefined) childOpts.env = this.childEnv;
    const child = new RpcChild(childOpts);
    const slot: ChildSlot = {
      id,
      cwd,
      child,
      restartTimer: null,
      restartAttempt: 0,
      fastRecycleCount: 0,
    };
    this.children.set(id, slot);

    process.stderr.write(
      `[remote-pi-supervisord] spawning ${id} (${entry.harness}, name="${entry.name}") in ${cwd}\n`,
    );
    child.on("exit", (evt: RpcChildExitEvent) => this._onChildExit(slot, evt));
    child.spawn();
  }

  private _onChildExit(slot: ChildSlot, evt: RpcChildExitEvent): void {
    // A slot replaced by a newer spawn of the same daemon no longer decides.
    if (this.shuttingDown || this.children.get(slot.id) !== slot) return;

    // The supervisor asked for this exit (stop / restart / unregister): the
    // daemon stays down until the supervisor starts it again.
    if (evt.requested) {
      process.stderr.write(`[remote-pi-supervisord] ${slot.id} stopped (requested)\n`);
      return;
    }

    if (evt.code === EXIT_DAEMON_FRESH_SESSION || evt.code === EXIT_DAEMON_RESTART) {
      if (evt.uptimeMs < FAST_RECYCLE_THRESHOLD_MS) {
        slot.fastRecycleCount += 1;
      } else {
        slot.fastRecycleCount = 0;
      }
      if (slot.fastRecycleCount <= MAX_FAST_RECYCLES) {
        // App-triggered daemon `/new` or `/restart`: intentional recycle, not a
        // crash. Restart immediately while guarding against runaway sub-5s loops.
        const kind = evt.code === EXIT_DAEMON_FRESH_SESSION ? "fresh session" : "restart";
        process.stderr.write(
          `[remote-pi-supervisord] ${slot.id} exited (code=${evt.code}); immediate recycle (${kind})\n`,
        );
        slot.restartAttempt = 0;
        slot.child.noteRestart();
        slot.child.spawn();
        return;
      }
    }

    // Any other exit — a crash, or the harness quitting by itself (the app's
    // "quit session" is a clean exit 0) — must not cost the daemon: the
    // registry says it runs, and only the supervisor may end it (plan/67).
    // Retry for as long as it is registered.
    const rawBackoffs = this.opts.restartBackoffsMs;
    const backoffs = rawBackoffs && rawBackoffs.length > 0 ? rawBackoffs : RESTART_BACKOFFS_MS;
    const rawStable = this.opts.stableUptimeMs;
    const stableUptimeMs =
      rawStable !== undefined && Number.isFinite(rawStable) && rawStable > 0
        ? rawStable
        : STABLE_UPTIME_MS;

    if (evt.uptimeMs >= stableUptimeMs) {
      slot.restartAttempt = 0;
      slot.fastRecycleCount = 0;
    }
    const rawDelay = backoffs[Math.min(slot.restartAttempt, backoffs.length - 1)] ?? 1_000;
    const delay = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 1_000;
    slot.restartAttempt += 1;
    process.stderr.write(
      `[remote-pi-supervisord] ${slot.id} exited (code=${evt.code} signal=${evt.signal}); ` +
      `restart in ${delay}ms (attempt ${slot.restartAttempt})\n`,
    );
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      if (this.shuttingDown || this.children.get(slot.id) !== slot) return;
      slot.child.noteRestart();
      slot.child.spawn();
    }, delay);
  }
}

/** Test helper: derive id from cwd without going through the registry. */
export function _idForCwdForTest(cwd: string): string { return daemonIdForCwd(cwd); }

/** Exported for the bin/supervisord entry + tests to know where the
 *  supervisor will bind. */
export function getSupervisorSockPath(): string { return supervisorSockPath(); }

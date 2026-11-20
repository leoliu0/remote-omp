/**
 * Plan 69 step 4 — slash commands typed on the phone, on omp.
 *
 * What omp does with a `/…` line, by host:
 *
 *   - TUI: the editor's submit runs builtins (`handleTui`), extension commands,
 *     skills and custom commands. The extension reaches it by typing into the
 *     editor (`_tryExecuteTerminalInput`), so anything the PC can run, the phone can.
 *   - `--mode rpc` (supervised daemon): an RPC `prompt` frame runs skills, builtins
 *     that have a text-mode `handle`, extension and custom commands — and hands
 *     everything else to the model as plain text. omp reserves its RPC stdin for
 *     the host (`claimRpcInput`), and `pi.sendUserMessage` never runs commands
 *     (`expandPromptTemplates:false`), so the only supported way in is the
 *     supervisor: control socket `send` → child stdin → `prompt` frame.
 *
 * Builtins without a text-mode handler (`/new`, `/goal`, `/plan`, `/exit`…) would
 * therefore leak to the model in a headless host. `planHeadlessSlash` decides, for
 * one line, between "forward to omp", "do it here", "say it cannot run" and
 * "ordinary prompt". omp's own registry is the source of truth for which builtin
 * is which; it is read from the running host, never copied.
 *
 * The same registry plus `pi.getCommands()` give the phone its slash menu
 * (`buildSlashCatalog`).
 */

import { callSupervisor, SupervisorOfflineError } from "./daemon/client.js";
import type { ControlReplyFor, ControlRequest } from "./daemon/control_protocol.js";

// ── Parsing ─────────────────────────────────────────────────────────────────

export interface ParsedSlashLine {
  /** omp's `parseSlashCommand` name: ends at the first whitespace or `:`. */
  name: string;
  args: string;
  /** Whole first token without the slash (`skill:foo` for `/skill:foo bar`). */
  token: string;
}

/** omp `slash-commands/helpers/parse.ts#parseSlashCommand`, plus the whole first token. */
export function parseSlashLine(text: string): ParsedSlashLine | null {
  const line = text.trim();
  if (!line.startsWith("/")) return null;
  const body = line.slice(1);
  if (!body) return null;
  const firstWhitespace = body.search(/\s/);
  const firstColon = body.indexOf(":");
  const separator =
    firstWhitespace === -1 ? firstColon : firstColon === -1 ? firstWhitespace : Math.min(firstWhitespace, firstColon);
  const token = firstWhitespace === -1 ? body : body.slice(0, firstWhitespace);
  if (separator === -1) return { name: body, args: "", token };
  return { name: body.slice(0, separator), args: body.slice(separator + 1).trim(), token };
}

/**
 * True for a line that can be a command invocation: `/name…` whose first token
 * has no further `/`. `/etc/hosts is broken` is prose, not a command.
 */
export function looksLikeSlashCommand(text: string): boolean {
  const parsed = parseSlashLine(text);
  return parsed !== null && parsed.token.length > 0 && !parsed.token.includes("/");
}

// ── omp's builtin registry ──────────────────────────────────────────────────

export interface BuiltinCommand {
  name: string;
  aliases: string[];
  /** TUI wording. */
  description: string;
  /** Wording for hosts without a TUI (omp's `acpDescription`), when it has one. */
  headlessDescription?: string;
  hint?: string;
  /**
   * omp's text-mode `handle` exists, so a `prompt` frame runs it. Without it the
   * command is TUI-only and a headless host hands the line to the model.
   */
  headless: boolean;
}

interface RawBuiltin {
  name?: unknown;
  aliases?: unknown;
  description?: unknown;
  acpDescription?: unknown;
  acpInputHint?: unknown;
  inlineHint?: unknown;
  handle?: unknown;
}

/**
 * Reads `BUILTIN_SLASH_COMMANDS_INTERNAL` from the running omp. Inside omp the
 * loader maps `@oh-my-pi/pi-coding-agent/*` to the host's own modules (same
 * mechanism as `actions/model_roles.ts`); anywhere else the import fails and
 * this resolves null.
 */
export async function loadBuiltinCommands(): Promise<BuiltinCommand[] | null> {
  try {
    // Host-only module: it exists only inside omp (the loader maps this specifier to the
    // running host's own copy), so a static import would break the build and every non-omp run.
    const mod = await import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry");
    const raw = mod.BUILTIN_SLASH_COMMANDS_INTERNAL as unknown;
    if (!Array.isArray(raw)) return null;
    const out: BuiltinCommand[] = [];
    for (const entry of raw as RawBuiltin[]) {
      if (!entry || typeof entry.name !== "string" || !entry.name) continue;
      const hint = [entry.acpInputHint, entry.inlineHint].find((h) => typeof h === "string" && h.length > 0);
      out.push({
        name: entry.name,
        aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((a): a is string => typeof a === "string") : [],
        description: typeof entry.description === "string" ? entry.description : "",
        ...(typeof entry.acpDescription === "string" ? { headlessDescription: entry.acpDescription } : {}),
        ...(typeof hint === "string" ? { hint } : {}),
        headless: typeof entry.handle === "function",
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

let _builtins: BuiltinCommand[] | null = null;
let _builtinsLoad: Promise<BuiltinCommand[] | null> | null = null;
/** Bumped by the test seam so a load still in flight cannot overwrite a pinned registry. */
let _builtinsEpoch = 0;

/** The registry once `ensureBuiltinCommands` has resolved; null before that or outside omp. */
export function builtinCommands(): readonly BuiltinCommand[] | null {
  return _builtins;
}

/** Loads the registry once (a failed attempt is retried on the next call). */
export function ensureBuiltinCommands(): Promise<readonly BuiltinCommand[] | null> {
  if (_builtins) return Promise.resolve(_builtins);
  if (!_builtinsLoad) {
    const epoch = _builtinsEpoch;
    _builtinsLoad = loadBuiltinCommands().then((list) => {
      if (epoch === _builtinsEpoch) {
        _builtins = list;
        _builtinsLoad = null;
      }
      return list;
    });
  }
  return _builtinsLoad;
}

/** Test-only: pins the registry the planner and the catalog see. */
export function _setBuiltinCommandsForTest(list: BuiltinCommand[] | null): void {
  _builtinsEpoch++;
  _builtins = list;
  _builtinsLoad = null;
}

// ── Planning a line for a headless host ─────────────────────────────────────

/** Things the extension does itself because omp's RPC has no text-mode command for them. */
export type LocalSlashAction = "new" | "exit" | "restart";

const LOCAL_ACTION_BY_NAME: Readonly<Record<string, LocalSlashAction>> = {
  new: "new",
  exit: "exit",
  quit: "exit",
  q: "exit",
  restart: "restart",
};

const PLAN_COMMANDS: Readonly<Record<string, true>> = { plan: true, "plan-review": true };

function localActionFor(name: string): LocalSlashAction | undefined {
  return Object.hasOwn(LOCAL_ACTION_BY_NAME, name) ? LOCAL_ACTION_BY_NAME[name] : undefined;
}

export type HeadlessSlashPlan =
  /** Not a command (or none omp is known to run): an ordinary prompt. */
  | { kind: "text" }
  /** Hand the line to omp's prompt pipeline through the supervisor. `known`: it names a command omp lists. */
  | { kind: "forward"; known: boolean; daemonId: string }
  | { kind: "local"; action: LocalSlashAction }
  | { kind: "refuse"; code: string; message: string };

export interface HeadlessPlanInput {
  builtins: readonly BuiltinCommand[] | null;
  /** `pi.getCommands()` names (extension, prompt and skill commands). */
  commandNames: ReadonlySet<string>;
  /** Supervised daemon (`REMOTE_OMP_DAEMON=1`): exit/restart codes mean something. */
  daemon: boolean;
  /** `supervisedDaemonId()`: where `sendThroughSupervisor` sends; null when not a supervised child. */
  daemonId: string | null;
  /** Message for the `/plan` family (omp's plan mode is a TUI feature). */
  planMessage: string;
}

export function planHeadlessSlash(text: string, input: HeadlessPlanInput): HeadlessSlashPlan {
  if (!looksLikeSlashCommand(text)) return { kind: "text" };
  const parsed = parseSlashLine(text)!;

  const local = localActionFor(parsed.name);
  if (local !== undefined) {
    if (local === "new" || input.daemon) return { kind: "local", action: local };
    return refuse(parsed.name, "only a supervised daemon can do that");
  }

  const builtin = input.builtins?.find((c) => c.name === parsed.name || c.aliases.includes(parsed.name));
  if (builtin && !builtin.headless) {
    if (Object.hasOwn(PLAN_COMMANDS, builtin.name)) {
      return { kind: "refuse", code: "plan_mode_unavailable", message: input.planMessage };
    }
    return refuse(parsed.name, "it needs omp's interactive terminal UI");
  }
  if (!builtin && Object.hasOwn(PLAN_COMMANDS, parsed.name)) {
    return { kind: "refuse", code: "plan_mode_unavailable", message: input.planMessage };
  }

  const known = builtin !== undefined || input.commandNames.has(parsed.token);
  if (input.daemonId === null) {
    return known
      ? refuse(parsed.name, "this session is not managed by the supervisor, which is how the app reaches omp's commands")
      : { kind: "text" };
  }
  return { kind: "forward", known, daemonId: input.daemonId };
}

/**
 * Whether omp lists a command for this line: one of its builtins (name or alias) or
 * something `pi.getCommands()` reports. The builtins this extension acts on itself
 * (`/new`, `/exit`, `/plan`…) count even when the registry could not be read. File-based
 * slash commands are in neither list, so false is not proof the line is prose.
 */
export function isKnownSlashCommand(
  text: string,
  input: Pick<HeadlessPlanInput, "builtins" | "commandNames">,
): boolean {
  const parsed = looksLikeSlashCommand(text) ? parseSlashLine(text) : null;
  if (!parsed) return false;
  if (localActionFor(parsed.name) !== undefined || Object.hasOwn(PLAN_COMMANDS, parsed.name)) return true;
  const builtin = input.builtins?.find((c) => c.name === parsed.name || c.aliases.includes(parsed.name));
  return builtin !== undefined || input.commandNames.has(parsed.token);
}

function refuse(name: string, why: string): HeadlessSlashPlan {
  return { kind: "refuse", code: "command_unavailable", message: `/${name} can't run from the app: ${why}.` };
}

// ── Reaching omp's RPC input through the supervisor ─────────────────────────

/** The daemon id the supervisor spawned this process under; null when not a supervised child. */
export function supervisedDaemonId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env["REMOTE_OMP_DAEMON"] !== "1") return null;
  const id = env["REMOTE_OMP_DAEMON_ID"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

type SupervisorCall = <Op extends ControlRequest["op"]>(
  req: Extract<ControlRequest, { op: Op }>,
) => Promise<ControlReplyFor<Op>>;

let _call: SupervisorCall = callSupervisor;

/** Test-only: replaces the control-socket client. Pass nothing to restore it. */
export function _setSupervisorCallForTest(call?: SupervisorCall): void {
  _call = call ?? callSupervisor;
}

/** Why a line did not reach omp; `message` is for the phone. */
export class SlashDeliveryError extends Error {
  constructor(message: string, public readonly code: string = "command_unavailable") {
    super(message);
    this.name = "SlashDeliveryError";
  }
}

/**
 * Writes `text` to the daemon's omp RPC input as a `prompt` frame. A line that
 * lands while a run is streaming is queued as a steer (`streaming_behavior`);
 * without one omp refuses a prompt frame during a run.
 */
export async function sendThroughSupervisor(daemonId: string, text: string): Promise<void> {
  let delivered: boolean;
  try {
    const reply = await _call({ op: "send", id: daemonId, text, streaming_behavior: "steer" });
    delivered = reply.delivered === true;
  } catch (err) {
    if (err instanceof SupervisorOfflineError) {
      throw new SlashDeliveryError("The supervisor is not running, so omp's commands are out of reach.");
    }
    throw new SlashDeliveryError(err instanceof Error ? err.message : String(err));
  }
  if (!delivered) throw new SlashDeliveryError("omp is not accepting input right now.");
}

// ── Recognising our own RPC prompts ─────────────────────────────────────────

/**
 * Lines this extension has handed to omp's RPC input, waiting for the `input`
 * hook to see them come back as `source:"rpc"`. Without it the hook would take
 * the phone's own line for something typed at an RPC client and mirror it.
 */
export class ExpectedRpcInputs {
  private readonly entries: Array<{ text: string; expires: number }> = [];

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Registers `text`; the returned function withdraws it (delivery failed). */
  expect(text: string): () => void {
    const entry = { text: text.trim(), expires: this.now() + this.ttlMs };
    this.entries.push(entry);
    return () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    };
  }

  /** True once per registered line, oldest first. */
  consume(text: string): boolean {
    const now = this.now();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.expires <= now) this.entries.splice(i, 1);
    }
    const i = this.entries.findIndex((e) => e.text === text.trim());
    if (i < 0) return false;
    this.entries.splice(i, 1);
    return true;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

// ── What the phone's slash menu shows ───────────────────────────────────────

export type WireCommandSource = "builtin" | "extension" | "prompt" | "skill";

export interface WireCommand {
  name: string;
  description: string;
  source: WireCommandSource;
  hint?: string;
}

export interface SlashCatalog {
  /** `/skill:<name>` commands, in the `{name, description}` shape the app already reads. */
  skills: Array<{ name: string; description: string }>;
  /**
   * Every other command this host can run for the phone. Absent when omp's builtin registry
   * could not be read: a list without the builtins would hide `/compact` and the rest from the
   * app, which then keeps its own menu.
   */
  commands?: WireCommand[];
}

/** One entry of `pi.getCommands()`. */
export interface HostCommandInfo {
  name: string;
  description?: string;
  source?: string;
}

/**
 * omp's command list for the phone: its builtins that run in this host, then
 * what `pi.getCommands()` reports. `host: "tui"` lists every builtin; `"headless"`
 * only those a `prompt` frame runs plus the ones the extension does itself.
 */
export function buildSlashCatalog(input: {
  host: "tui" | "headless";
  builtins: readonly BuiltinCommand[] | null;
  hostCommands: readonly HostCommandInfo[];
}): SlashCatalog {
  const commands: WireCommand[] = [];
  const skills: SlashCatalog["skills"] = [];
  const seen = new Set<string>();
  const add = (command: WireCommand): void => {
    if (!command.name || seen.has(command.name)) return;
    seen.add(command.name);
    commands.push(command);
  };

  for (const b of input.builtins ?? []) {
    const runnable = input.host === "tui" || b.headless || localActionFor(b.name) !== undefined;
    if (!runnable) continue;
    const description = (input.host === "headless" ? b.headlessDescription : undefined) ?? b.description;
    add({ name: b.name, description, source: "builtin", ...(b.hint ? { hint: b.hint } : {}) });
  }

  for (const c of input.hostCommands) {
    if (typeof c?.name !== "string") continue;
    const description = typeof c.description === "string" ? c.description : "";
    if (c.source === "skill") {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        skills.push({ name: c.name, description });
      }
      continue;
    }
    // omp resolves an extension command by the text up to the first space:
    // names with a space are autocomplete-only registrations.
    if (/\s/.test(c.name)) continue;
    add({ name: c.name, description, source: c.source === "prompt" ? "prompt" : "extension" });
  }

  return { skills, ...(input.builtins ? { commands } : {}) };
}

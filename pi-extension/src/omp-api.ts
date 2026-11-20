/**
 * The slice of omp's extension API this extension uses.
 *
 * omp (oh-my-pi, https://github.com/can1357/oh-my-pi) hands an `ExtensionAPI` to
 * every extension factory and an `ExtensionContext` to every handler. Its own
 * declarations (`src/extensibility/extensions/types.ts`) pull in omp's whole
 * type tree (`pi-ai`, `pi-agent-core`, `pi-tui`, …), which an npm-installed
 * plugin cannot depend on, so this module restates just the members the code
 * calls, with the shapes read from omp 19.0.1. A member omp has and this
 * extension never calls is deliberately absent; a payload field is typed only
 * where code reads it, and `unknown` marks "passed through, narrowed at the use".
 *
 * Types only: there is nothing to import at runtime.
 */

import type { Static, TSchema } from "typebox";

// ── Content blocks ───────────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  /** Base64 bytes. */
  data: string;
  mimeType: string;
}

// ── TUI surface ──────────────────────────────────────────────────────────────

/** A drawable terminal node (omp's pi-tui `Component`). */
export interface Component {
  render(width: number): string[];
  invalidate(): void;
}

/** The part of omp's `Theme` a message renderer calls. */
export interface Theme {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
}

export interface MessageRenderOptions {
  expanded: boolean;
}

/** A persisted custom message as a renderer sees it. */
export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | Array<TextContent | ImageContent>;
  display: boolean;
  details?: T;
  timestamp: number;
}

/** Draws one `customType`; returning `undefined` leaves omp's default rendering. */
export type MessageRenderer<T = unknown> = (
  message: CustomMessage<T>,
  options: MessageRenderOptions,
  theme: Theme,
) => Component | undefined;

// ── Context ──────────────────────────────────────────────────────────────────

/** The parts of omp's `ExtensionUIContext` this extension calls. */
export interface ExtensionUIContext {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[], dialogOptions?: unknown): Promise<string | undefined>;
  input(title: string, placeholder?: string, dialogOptions?: unknown): Promise<string | undefined>;
  setStatus(key: string, text: string | undefined): void;
  setTitle(title: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
}

/** Where omp runs: `"tui"` is the only mode with a terminal UI. */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

/** Options of `ctx.compact`. */
export interface CompactOptions {
  onComplete?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

export interface ExtensionAgentIdentity {
  /** `"main"` for a top-level session, `"sub"` for any spawned session. */
  kind: "main" | "sub";
  id: string;
  name: string;
  depth: number;
  parentId?: string;
}

export interface ExtensionContext {
  ui: ExtensionUIContext;
  mode: ExtensionMode;
  /** False in print / RPC mode. */
  hasUI: boolean;
  cwd: string;
  /** The session's read-only manager; code narrows it where it reads it. */
  sessionManager: unknown;
  /** The registry `AgentSession` itself uses; narrowed in `actions/registry.ts`. */
  modelRegistry: unknown;
  model: unknown;
  /** The agent this session runs: a top-level session or a subagent. */
  agent: ExtensionAgentIdentity;
  isIdle(): boolean;
  abort(): void;
  /** Gracefully shuts omp down. */
  shutdown(): void;
  compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
  /**
   * Runs the native built-in of the tool this handler re-registered. Present
   * only while such a tool executes.
   */
  invokeTool?<TDetails = unknown>(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback<TDetails> },
  ): Promise<AgentToolResult<TDetails>>;
}

/** Command handlers get the session-control methods only a user command may call. */
export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
  newSession(options?: {
    parentSession?: string;
    setup?: (sessionManager: unknown) => Promise<void>;
  }): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
}

// ── Tools ────────────────────────────────────────────────────────────────────

export interface AgentToolResult<TDetails = unknown> {
  content: Array<TextContent | ImageContent>;
  details?: TDetails;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (partial: AgentToolResult<TDetails>) => void;

/** `parameters` takes a TypeBox schema (omp's `typebox` shim accepts it). */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  /** Name the LLM calls. */
  name: string;
  /** Human-readable label for the UI. */
  label: string;
  description: string;
  parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}

// ── Events ───────────────────────────────────────────────────────────────────

/** What a handler returns from `input`: `handled: true` stops omp's own input pipeline. */
export interface InputEventResult {
  handled?: boolean;
  text?: string;
  images?: ImageContent[];
}

/** Every handler also gets the context of the session it runs in. */
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

export interface InputEvent {
  type: "input";
  text: string;
  images?: ImageContent[];
  /** `"extension"` is a message an extension injected (`sendUserMessage`). */
  source: "interactive" | "rpc" | "extension";
}

export interface ResourcesDiscoverResult {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
}

export interface ContextEvent {
  type: "context";
  messages: unknown[];
}

export interface ContextEventResult {
  messages?: unknown[];
}

export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation?: {
    messagesToSummarize: unknown[];
    turnPrefixMessages: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SessionCompactEvent {
  type: "session_compact";
  compactionEntry?: unknown;
}

export interface MessageEvent {
  type: "message_start" | "message_update" | "message_end";
  message: unknown;
  /** `message_update` only: the streaming delta of the assistant message. */
  assistantMessageEvent?: unknown;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
  intent?: string;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface AgentEndEvent {
  type: "agent_end";
  willContinue?: boolean;
  [key: string]: unknown;
}

/** Events whose payload the extension never reads. */
export interface BareEvent {
  type: string;
}

/** Event name → [payload, handler result]; the typing of `ExtensionAPI.on`. */
export interface ExtensionEventMap {
  resources_discover: [BareEvent, ResourcesDiscoverResult];
  session_start: [BareEvent, undefined];
  session_shutdown: [BareEvent, undefined];
  session_before_compact: [SessionBeforeCompactEvent, undefined];
  session_compact: [SessionCompactEvent, undefined];
  context: [ContextEvent, ContextEventResult];
  input: [InputEvent, InputEventResult];
  agent_start: [BareEvent, undefined];
  agent_end: [AgentEndEvent, undefined];
  turn_start: [BareEvent, undefined];
  turn_end: [BareEvent, undefined];
  message_start: [MessageEvent, undefined];
  message_update: [MessageEvent, undefined];
  message_end: [MessageEvent, undefined];
  tool_call: [unknown, undefined];
  tool_execution_start: [ToolExecutionStartEvent, undefined];
  tool_execution_end: [ToolExecutionEndEvent, undefined];
  goal_updated: [unknown, undefined];
  mode_changed: [unknown, undefined];
  plan_review_requested: [unknown, undefined];
  plan_review_resolved: [unknown, undefined];
}

// ── API ──────────────────────────────────────────────────────────────────────

/** `pi.sendMessage` input: a custom message for the transcript (and, unless excluded, the model). */
export interface CustomMessagePayload<T = unknown> {
  customType?: string;
  content?: string | Array<TextContent | ImageContent>;
  display?: boolean;
  details?: T;
  /**
   * `true`: a transcript-only row, never part of the model's context. At once when idle,
   * held until the run ends while streaming.
   */
  excludeFromContext?: boolean;
}

export interface SendMessageOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn" | "aside";
}

export interface SendUserMessageOptions {
  /** Omitted: starts a turn when idle, steers while streaming. */
  deliverAs?: "steer" | "followUp" | "aside";
}

/** A slash command as `pi.getCommands()` lists it. */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  source?: string;
}

/** omp's shared event bus (`pi.events`). */
export interface EventBus {
  emit(channel: string, data: unknown): void;
  /** Returns the unsubscribe function. */
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** One completion offered for a command's argument. */
export interface CompletionItem {
  value: string;
  label: string;
}

export interface RegisteredCommandOptions {
  description?: string;
  /** Typed sync in omp's declarations, but its autocomplete awaits the result, so a promise works. */
  getArgumentCompletions?: (argumentPrefix: string) => CompletionItem[] | null | Promise<CompletionItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** What `pi.setModel` accepts: a model from the registry. */
export interface ExtensionModel {
  provider: string;
  id: string;
}

export interface ExtensionAPI {
  /** omp's SDK barrel (`@oh-my-pi/pi-coding-agent`) as injected into every extension; narrowed where it is read. */
  pi: unknown;
  on<E extends keyof ExtensionEventMap>(
    event: E,
    handler: ExtensionHandler<ExtensionEventMap[E][0], ExtensionEventMap[E][1]>,
  ): void;
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
  registerCommand(name: string, options: RegisteredCommandOptions): void;
  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
  sendMessage<T = unknown>(message: CustomMessagePayload<T>, options?: SendMessageOptions): void;
  /** Resolves when the message is admitted; on an idle session omp settles it at the END of the run. */
  sendUserMessage(content: string | Array<TextContent | ImageContent>, options?: SendUserMessageOptions): Promise<void>;
  getCommands(): SlashCommandInfo[];
  /** Switches the live session's model; false when no credential is available. */
  setModel(model: ExtensionModel): Promise<boolean>;
  getThinkingLevel(): string | undefined;
  setThinkingLevel(level: string | undefined): void;
  events: EventBus;
}

/** An extension: called once per session with that session's API. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

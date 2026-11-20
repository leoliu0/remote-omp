export type PairErrorCode =
  | "token_expired"
  | "token_consumed"
  | "token_unknown"
  | "internal_error";

export type StreamingBehavior = "steer";

export type QueuedMessageItem = {
  id: string;
  text: string;
  editable: boolean;
  created_at: number;
};

// ── Plan/57 — extension_ui_request bridge (mirror SDK RPC contract) ───────
// The paired app renders interactive extension prompts (ask_user today, via
// @eko24ive/pi-ask) natively instead of stranding the mobile user. The wire
// mirrors the SDK's `pi --mode rpc` extension_ui_request/response contract
// (RpcExtensionUIRequest/Response in dist/modes/rpc/rpc-types.d.ts) so the
// mobile app and the Cockpit share one interactive-UI vocabulary. Casing is
// snake_case to match the rest of the relay protocol (mirror is semantic, not
// literal). pi-ask's richer schema (multi/preview/notes) rides in an optional
// `ask` envelope; strict clients ignore it. Inert when pi-ask is absent.

export type ExtensionUiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify";

export type AskQuestionWireType = "single" | "multi" | "preview";

export interface AskOptionWire {
  value: string;
  label: string;
  description?: string;
  /** Preview-pane content (preview questions only). */
  preview?: string;
  /** pi-ask addition: option allows freeform custom entry. */
  freeform?: boolean;
}

export interface AskQuestionWire {
  id: string;
  label: string;
  prompt: string;
  type: AskQuestionWireType;
  required: boolean;
  /** pi-ask addition: type actually presented after live toggle / policy. */
  presentedType?: AskQuestionWireType;
  /** pi-ask addition: type originally requested by the model. */
  requestedType?: AskQuestionWireType;
  options: AskOptionWire[];
}

/** Optional pi-ask enrichment on an extension_ui_request — lets the app render
 *  the full flow (multi/preview/notes) instead of the degraded SDK select. A
 *  flow maps to ONE request carrying every question; the app renders a
 *  full-screen modal and submits ONE response with all answers (pi-ask resolves
 *  a flow in a single submit). When `ask` is absent the SDK method/options
 *  drive rendering (future generic prompts). */
export interface AskEnrichmentWire {
  flow_id: string;
  tool_call_id: string | null;
  /** pi-ask RemoteAskSource: "tool" | "answer" | "answer:again" | "ask:replay". */
  source: string;
  title: string | null;
  questions: AskQuestionWire[];
}

/** pi-ask RemoteAskAnswer — one question's answered parts.
 *
 *  CASING EXCEPTION: inside the `ask` envelope the keys mirror pi-ask's own
 *  schema VERBATIM (camelCase: `presentedType`, `requestedType`, `customText`,
 *  `optionNotes`) so the bridge can forward the response to pi-ask's submit
 *  event without a remap pass. The snake_case convention of this protocol
 *  applies at the frame level (`flow_id`, `tool_call_id`, `notify_type`). */
export interface AskAnswerWire {
  values?: string[];
  customText?: string;
  note?: string;
  optionNotes?: Record<string, string>;
}

/** Optional pi-ask enrichment on an extension_ui_response — carries the
 *  structured answer so multi/preview/notes survive the round-trip. */
export type AskResponseEnrichmentWire =
  | {
      flow_id: string;
      kind: "answer";
      mode?: "submit" | "elaborate";
      answers: Record<string, AskAnswerWire>;
    }
  | { flow_id: string; kind: "cancel" };

// ── omp plan mode: plan review + plan state ───────────────────────────────
// omp 19 finishes planning when the agent writes the plan's slug to
// `xd://propose`, aborts that turn and opens its "Plan Review" overlay (a
// TUI-only component, not `ctx.ui.select`). It reports the overlay to
// extensions (`plan_review_requested` / `plan_review_resolved`), so the Pi
// forwards it as an extension_ui_request carrying the `plan` envelope below
// and answers it with `ctx.resolvePlanReview` — no keys are pressed. A review
// that is still open is replayed on every session_sync. Plan mode needs omp's
// interactive TUI: a headless `--mode rpc` daemon has none.

/** The review's choices, in omp's order, each one omp's native choice id:
 *  `approve_execute` = `execute` (clears the session, runs the plan);
 *  `approve_compact` = `compact` (compacts first); `approve_keep` = `keep`
 *  (runs it in the current context; omp disables it above 95 % context);
 *  `refine` = `refine` (the required feedback is omp's next planning prompt;
 *  stays in plan mode); `save_quit` = `save` (omp writes the plan to the
 *  project folder and leaves the review open — omp 19 has no "Save and
 *  quit"; the wire name predates it). A `cancelled` response closes only the
 *  client's sheet: omp offers an extension no way to dismiss its overlay,
 *  which stays open on the PC (and re-opens from the plan button). A plain
 *  chat message sent while the review is open answers it with `refine`. */
export type PlanReviewAction =
  | "approve_execute"
  | "approve_compact"
  | "approve_keep"
  | "refine"
  | "save_quit";

export interface PlanReviewOptionWire {
  action: PlanReviewAction;
  /** omp's label, e.g. "Approve and keep context (~19k / 1m)". */
  label: string;
  /** omp disables `approve_keep` when the context is over 95 % full. */
  disabled?: boolean;
}

/** Present on a plan review's extension_ui_request (`method: "select"`, `id`
 *  prefixed `plan-review:`). Clients that know it render the plan as markdown
 *  with these options and a feedback field for `refine`; others fall back to
 *  the plain select over the same labels. */
export interface PlanReviewWire {
  /** omp's plan path, e.g. "local://hello-txt-plan.md". */
  plan_file_path: string;
  /** omp's plan title (the slug the agent proposed). */
  title: string;
  /** The plan file's markdown; null when it could not be read. */
  content: string | null;
  options: PlanReviewOptionWire[];
}

/** The client's choice on a plan review (`extension_ui_response.plan`). */
export interface PlanReviewAnswerWire {
  action: PlanReviewAction;
  /** `refine` only, required (omp refuses a blank one): omp submits it as the next planning prompt. */
  feedback?: string;
}

/** omp's plan mode as the clients show it: `active` = planning, `paused` =
 *  omp's paused plan mode (one more exit leaves it), `review` = a plan is
 *  waiting for a decision, `idle` = off. Follows omp's `mode_changed`. */
export type PlanStatus = "idle" | "active" | "paused" | "review";

/** ServerMessage: interactive extension prompt. Mirrors RpcExtensionUIRequest
 *  (select/confirm/input/editor/notify). The `ask` envelope is present when the
 *  prompt originates from a pi-ask flow, carrying the full question schema. */
export type ExtensionUiRequestWire =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      ask?: AskEnrichmentWire;
      /** omp plan review: render the plan and its choices (see PlanReviewWire). */
      plan?: PlanReviewWire;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      ask?: AskEnrichmentWire;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      ask?: AskEnrichmentWire;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      ask?: AskEnrichmentWire;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notify_type?: "info" | "warning" | "error";
    };

/** ClientMessage: response to an extension_ui_request. Mirrors
 *  RpcExtensionUIResponse (value / confirmed / cancelled). The `ask` envelope
 *  carries pi-ask's structured answer when the app rendered the rich flow. */
export type ExtensionUiResponseWire =
  | {
      type: "extension_ui_response";
      id: string;
      value: string;
      ask?: AskResponseEnrichmentWire;
    }
  | {
      type: "extension_ui_response";
      id: string;
      confirmed: boolean;
      ask?: AskResponseEnrichmentWire;
    }
  | {
      type: "extension_ui_response";
      id: string;
      cancelled: true;
      ask?: AskResponseEnrichmentWire;
    }
  // Rich pi-ask answer: a client that rendered the full flow from the `ask`
  // envelope submits ONLY the envelope — no value/confirmed/cancelled
  // discriminator (the structured `answers` supersede them). This is the
  // shape the app actually sends for rich submits; routing keys off
  // `ask.kind` before any discriminator is read.
  | {
      type: "extension_ui_response";
      id: string;
      ask: AskResponseEnrichmentWire;
    }
  // omp plan review answer (request carried `plan`): the chosen overlay
  // option, plus feedback for `refine`. Cancel uses `cancelled: true`.
  | {
      type: "extension_ui_response";
      id: string;
      plan: PlanReviewAnswerWire;
      ask?: AskResponseEnrichmentWire;
    };

// ── Plan/65 — send a file from the PC to one phone ────────────────────────
// Chunked over the existing peer channel: each `file_chunk` carries at most
// 1 MiB of raw bytes (base64 in `data`), so a frame stays well under the
// relay's 4 MiB `ct` cap. The sender keeps at most 4 chunks in flight beyond
// the last cumulative `file_ack`. All frames of one transfer go to ONE phone.
// Receivers ignore unknown fields on every `file_*` frame (forward-compat).

/** Why a phone refused or abandoned a transfer. Open for forward-compat. */
export type FileTransferReason =
  | "sha_mismatch"
  | "no_space"
  | "cancelled"
  | (string & {});

/** ext → app: announces a transfer. `sha256` is lowercase hex of the whole file. */
export interface FileOfferMessage {
  type: "file_offer";
  file_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  caption?: string;
  turn_id?: string;
}

/** ext → app: one chunk, `seq` 0-based, `data` base64 of ≤ 1 MiB raw bytes. */
export interface FileChunkMessage {
  type: "file_chunk";
  file_id: string;
  seq: number;
  data: string;
}

/** ext → app: every chunk has been sent; `chunks` is the total count. */
export interface FileEndMessage {
  type: "file_end";
  file_id: string;
  chunks: number;
}

/** app → ext: cumulative ack. `next_seq` = first chunk the phone still needs.
 *  Also sent after a reconnect so the sender resumes from there. */
export interface FileAckMessage {
  type: "file_ack";
  file_id: string;
  next_seq: number;
}

/** app → ext: file stored and its SHA-256 matched. */
export interface FileDoneMessage {
  type: "file_done";
  file_id: string;
  reason?: FileTransferReason;
}

/** app → ext: the phone gave up on the transfer. */
export interface FileErrorMessage {
  type: "file_error";
  file_id: string;
  reason?: FileTransferReason;
}

/** Either direction: abandon the transfer. */
export interface FileCancelMessage {
  type: "file_cancel";
  file_id: string;
}

// ── Plan/68 — upload a file from the phone to this PC ─────────────────────
// The reverse of the plan/65 transfer: the phone sends `upload_chunk` frames
// (256 KiB of raw bytes, base64 in `data`: a frame stays far under the relay's
// 4 MiB `ct` cap and a slow uplink still delivers one in time) and the
// extension answers each with a cumulative `upload_ack`. The phone keeps at
// most 4 chunks in flight beyond the last ack (the relay has no backpressure).
// The file lands in `~/.omp/remote/uploads/YYYY-MM-DD/<name>` and `upload_done`
// carries its absolute path. `id` on the client frames is the usual request
// id; replies are correlated by `upload_id` (a phone-chosen string, unique per
// attempt), and an ack echoes the `id` of the frame it answers in
// `in_reply_to`. Receivers ignore unknown fields.

/** app → ext: announces an upload. `sha256` (lowercase hex of the whole file) is verified when given. */
export interface UploadStartMessage {
  type: "upload_start";
  id: string;
  upload_id: string;
  name: string;
  size: number;
  mime?: string;
  sha256?: string;
}

/** app → ext: one chunk, `seq` 0-based, `data` base64 of raw bytes (the phone sends 256 KiB; up to 2 MiB is accepted). */
export interface UploadChunkMessage {
  type: "upload_chunk";
  id: string;
  upload_id: string;
  seq: number;
  data: string;
}

/**
 * app → ext: every chunk is acked; verify size and sha256, store, reply
 * `upload_done`. `sha256` (lowercase hex of the whole file) is verified when
 * given, in addition to the one on `upload_start`: the phone hashes while it
 * sends, so the digest is only known now.
 */
export interface UploadEndMessage {
  type: "upload_end";
  id: string;
  upload_id: string;
  sha256?: string;
}

/** app → ext: abandon the upload; the partial file is deleted. */
export interface UploadCancelMessage {
  type: "upload_cancel";
  id: string;
  upload_id: string;
}

/**
 * ext → app: cumulative ack. `seq` is the first chunk the PC still needs (every
 * chunk below it is on disk, in order) and `received` the bytes those chunks
 * hold. Sent for `upload_start` (also a repeated one: the phone resumes from
 * `seq`), after every chunk, and for a duplicate or out-of-order chunk or an
 * early `upload_end` (so the phone resends from `seq`). `in_reply_to` is the
 * `id` of the frame being answered: the answer to a repeated `upload_start` is
 * the PC's position after every frame sent before it, which is how the phone
 * tells a lost chunk from a slow link.
 */
export interface UploadAckMessage {
  type: "upload_ack";
  upload_id: string;
  seq: number;
  received: number;
  in_reply_to?: string;
}

/** ext → app: stored. `path` is absolute; a repeated `upload_end` is answered again. */
export interface UploadDoneMessage {
  type: "upload_done";
  upload_id: string;
  path: string;
  size: number;
}

/** Why the extension refused or dropped an upload. Open for forward-compat. */
export type UploadErrorCode =
  | "too_large"
  | "no_space"
  | "invalid_upload"
  | "size_mismatch"
  | "sha_mismatch"
  | "timeout"
  | "unknown_upload"
  | "too_many_uploads"
  | "write_failed"
  | (string & {});

/** ext → app: the upload failed and its partial file is gone. `message` is for the user. */
export interface UploadErrorMessage {
  type: "upload_error";
  upload_id: string;
  code: UploadErrorCode;
  message: string;
}

export type ClientMessage =
  | { type: "pair_request"; id: string; token: string; device_name: string }
  // Plan/30: optional `images` carry inline base64 attachments (one today).
  // Omitted entirely on text-only messages — the no-image path is unchanged.
  | {
      type: "user_message";
      id: string;
      text: string;
      images?: WireImage[];
      streaming_behavior?: StreamingBehavior;
    }
  | { type: "queued_message_set"; id: string; text: string }
  | { type: "queued_message_clear"; id: string; target_id?: string }
  | { type: "approve_tool"; id: string; tool_call_id: string; decision: "allow" | "deny" }
  | { type: "cancel"; id: string; target_id: string }
  | { type: "ping"; id: string }
  | { type: "session_sync"; id: string; limit?: number }
  // Plan/28 — Typed app actions on the paired Pi session. Each carries a
  // structured payload (no string parsing) and gets either `action_ok` or
  // `action_error` back. Visible side-effects (chat output, model change
  // broadcasts, compaction notice) still flow through the normal channels.
  | { type: "session_new"; id: string }
  | { type: "session_compact"; id: string }
  | { type: "model_set"; id: string; provider: string; model_id: string }
  | { type: "thinking_set"; id: string; level: ThinkingLevel }
  | { type: "list_models"; id: string }
  | { type: "reload_plugins"; id: string }
  | { type: "git_status"; id: string }
  | { type: "git_diff"; id: string; path: string; staged?: boolean }
  // Mobile composer `@` file autocomplete — answered with `files_list`.
  | { type: "list_files"; id: string; query: string; limit?: number }
  // Plan/68 — new session from the phone. `list_dirs` browses the PC's folders
  // (answered with `dirs_list`); `spawn_session` starts an omp session in one
  // (answered with `spawn_result`, or an `error` whose `code` says why:
  // cwd_busy, already_registered, not_found, supervisor_offline, …).
  // `persistent` registers an always-on daemon (plan/67) instead of an
  // ephemeral session that ends when the process does.
  | { type: "list_dirs"; id: string; path?: string }
  | { type: "spawn_session"; id: string; cwd: string; name?: string; persistent?: boolean }
  // Plan/66 — omp model roles (`modelRoles` in omp's config.yml). The list is
  // answered with `model_roles`. `model_role_set` assigns a role globally
  // (`provider/model_id[:thinking]`, as omp's TUI writes it); omitting both
  // `provider` and `model_id` clears the role back to omp's default. Replied
  // with action_ok / action_error (`action: "model_role_set"`).
  // `role` asks for that one role only, with its `candidates`.
  | { type: "list_model_roles"; id: string; role?: string }
  | {
      type: "model_role_set";
      id: string;
      role: string;
      provider?: string;
      model_id?: string;
      thinking?: ThinkingLevel;
    }
  // omp plan mode from a client, through `ctx.sessionModes` / `ctx.openPlanReview`:
  // `enter` / `exit` set omp's plan mode (exit leaves it without approving the
  // plan or deleting its draft — clients ask the user first); `review` re-sends
  // the open review, or asks omp to open one on the newest plan.
  // Replied with action_ok / action_error (`action: "plan_mode"`, omp's own
  // refusal text: a busy turn, a conflicting mode, …); the state change itself
  // arrives as `plan_state`.
  | { type: "plan_mode"; id: string; action: "enter" | "exit" | "review" }
  // Plan/68 — re-run the turn that just failed (omp's `/retry`): the same
  // prompt runs again, no second user message. Replied with action_ok
  // (`action: "retry_turn"`) once omp has scheduled the continuation (it then
  // streams as any turn), or `error` with `in_reply_to` and a `code`:
  // `busy` (a turn, compaction or retry is already running), `nothing_to_retry`,
  // `unsupported` (the host is not omp) or `internal_error`.
  | { type: "retry_turn"; id: string }
  // Mirrors RpcExtensionUIResponse; the optional `ask` envelope carries
  // pi-ask's structured answer so multi/preview/notes survive the round-trip.
  | ExtensionUiResponseWire
  // Plan/68 — upload a file from the phone to this PC (see UploadStartMessage).
  | UploadStartMessage
  | UploadChunkMessage
  | UploadEndMessage
  | UploadCancelMessage
  // Plan/65 — file transfer replies from the receiving phone.
  | FileAckMessage
  | FileDoneMessage
  | FileErrorMessage
  | FileCancelMessage;

/**
 * Plan/30 — one inline image attachment on a `user_message`. Mirrors the
 * SDK's `ImageContent` ({@link https }) split across the wire: `data` is the
 * base64-encoded (compressed) image bytes, `mime` its content type
 * (e.g. `"image/jpeg"`). The Pi maps `{ data, mime }` → the SDK's
 * `{ type:"image", data, mimeType }` before handing it to the model.
 */
export interface WireImage {
  /** Base64-encoded image bytes (compressed app-side). */
  data: string;
  /** MIME type, e.g. `"image/jpeg"`. Maps to the SDK's `mimeType`. */
  mime: string;
}

export type Usage = { input_tokens: number; output_tokens: number };

export type KnownErrorCode =
  | "tool_approval_required"
  | "invalid_message"
  | "unsupported_type"
  | "too_large"
  | "rate_limited"
  | "timeout"
  | "internal_error";

// aberto para forward-compat — receivers toleram codes desconhecidos
export type ErrorCode = KnownErrorCode | (string & {});

export type SessionHistoryEvent =
  // Plan/30: `images` replayed in history so a re-sync rebuilds the image
  // bubble (the bytes live in `_messageBuffer`). Omitted on text-only inputs.
  | { ts: number; type: "user_input"; id: string; text: string; images?: WireImage[] }
  | {
      ts: number;
      type: "tool_request";
      tool_call_id: string;
      tool: string;
      args: Record<string, unknown>;
    }
  | {
      ts: number;
      type: "tool_result";
      tool_call_id: string;
      result?: unknown;
      error?: string;
    }
  | {
      ts: number;
      type: "agent_message";
      in_reply_to: string;
      text: string;
      usage?: Usage;
      // A failed turn (assistant `stopReason: "error"`) replays as the same
      // `⚠ <code>: <message>` text the live `error` frame renders, tagged with
      // its code so a client can offer Retry. Receivers that ignore the field
      // show it as plain assistant text.
      error_code?: string;
    }
  // Plan/32: a context-compaction marker, replayed in history (survives
  // re-sync like images) so the app re-renders the "context compacted" notice.
  | { ts: number; type: "compaction"; summary: string; tokens_before: number };

export type ServerMessage =
  | {
      type: "pair_ok";
      in_reply_to: string;
      session_name: string;
      session_started_at: number;
      room_id: string;
      /**
       * Plan/27 Wave A: identifies the host coding agent driving this
       * omp-extension instance. `name` is hardcoded to "omp coding agent"
       * today; future harnesses (Claude Code, OpenCode) populate their own
       * here. `version` is the pi-extension `package.json` version.
       * Optional in the wire schema so app-side parsing tolerates older
       * Pi builds that predate this field — every new pairing emits both.
       */
      harness?: { name: string; version: string };
      /**
       * Plan/27 Wave A: `os.hostname()` of the machine the Pi runs on.
       * App displays it in the device list so the user can distinguish
       * two paired PCs that happen to share a nickname or sit in the
       * same project folder.
       */
      hostname?: string;
    }
  | { type: "pair_error"; in_reply_to: string; code: PairErrorCode; message: string }
  | { type: "user_input"; id: string; text: string; streaming_behavior?: StreamingBehavior }
  // Echo of an app-originated user_message, broadcast by the Pi to every
  // connected owner (including the sender). Source-of-truth model: each
  // app waits for this echo to render the message it sent, so all owners
  // see the same session timeline regardless of who typed.
  // Field shape mirrors the inbound ClientMessage `user_message` exactly,
  // and `id` is the sender-provided id — Pi never re-generates it (lets
  // future dedup logic use id as a stable key). See plan/24 W2D fix.
  // Plan/30: `images` echoed back so every owner renders the same image bubble.
  | {
      type: "user_message";
      id: string;
      text: string;
      images?: WireImage[];
      streaming_behavior?: StreamingBehavior;
    }
  | { type: "queued_message_state"; id?: string; text?: string; items?: QueuedMessageItem[] }
  | { type: "steer_consumed"; id: string }
  | { type: "agent_chunk"; in_reply_to: string; delta: string }
  | { type: "agent_done"; in_reply_to: string; usage?: Usage }
  | { type: "agent_message"; in_reply_to: string; text: string; usage?: Usage }
  // Plan/32: pushed after a context compaction (live, and replayed on history
  // re-sync). `tokens_before` is the pre-compaction token count.
  | { type: "compaction"; summary: string; tokens_before: number; ts?: number }
  | { type: "tool_request"; tool_call_id: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool_call_id: string; result?: unknown; error?: string }
  | { type: "error"; in_reply_to?: string; code: ErrorCode; message: string }
  | { type: "cancelled"; in_reply_to: string; target_id: string }
  | { type: "pong"; in_reply_to: string }
  | { type: "bye"; reason: ByeReason }
  | {
      type: "session_history";
      in_reply_to: string;
      session_started_at: number;
      events: SessionHistoryEvent[];
      eos: boolean;
      truncated: boolean;
      // The session's most recent prompts (oldest first), whatever the
      // `events` window holds: the composer's history recall reads these.
      prompts?: string[];
    }
  // omp's slash-command list for the composer menu (plan 69 step 4): `skills` holds the
  // `/skill:<name>` commands, `commands` every other command this host can run for the phone
  // (omp's builtins that run there, extension and prompt commands). `source` is
  // "builtin" | "extension" | "prompt" | "skill". `commands` is absent from older extensions
  // and when omp's builtin registry could not be read; the app then keeps its own menu.
  | {
      type: "skills_list";
      in_reply_to?: string;
      skills: Array<{ name: string; description: string }>;
      commands?: Array<{ name: string; description: string; source: string; hint?: string }>;
    }
  // Plan/28 — Replies for typed app actions.
  // `action_ok` / `action_error` carry the original `ActionName` so the
  // app can demultiplex by action type rather than having to remember
  // every in-flight request id.
  // `models_list` is the response to a `list_models` request; the optional
  // `current` echoes the model the Pi is using right now so the app can
  // highlight the selected row without a second round-trip.
  | { type: "action_ok"; in_reply_to: string; action: ActionName }
  | { type: "action_error"; in_reply_to: string; action: ActionName; error: string }
  | { type: "models_list"; in_reply_to: string; models: WireModel[]; current?: WireModel }
  // Plan/66 — omp model roles. Reply to `list_model_roles` (with
  // `in_reply_to`), and broadcast without `in_reply_to` to every active owner
  // after a successful `model_role_set`. Full snapshot in omp's role order,
  // without `candidates`; a `list_model_roles` with `role` gets just that role
  // with its `candidates`.
  | { type: "model_roles"; in_reply_to?: string; roles: WireModelRole[] }
  // Running subagents + background jobs (omp's bottom activity panel).
  // Full snapshot, never a delta: replace local state with `jobs` wholesale.
  // Broadcast to active owners on change (throttled to ≤2/s), and sent to an
  // owner on attach and after every session_sync reply. `jobs: []` means
  // nothing is running and nothing finished recently.
  | { type: "agent_activity"; jobs: AgentActivityJob[]; ts: number }
  // omp's footer status row under the composer (default preset, left side).
  // Model + thinking are NOT repeated here: they ride room_meta (`model`,
  // `thinking`). Full snapshot; sent to an owner on attach and after every
  // session_sync reply, then broadcast to active owners on change (deduped,
  // ≤1/s). Main session only, never a subagent.
  | StatusLineMessage
  // Plan/57 — interactive extension prompt (ask_user via pi-ask). Mirrors
  // RpcExtensionUIRequest (select/confirm/input/editor/notify); the optional
  // `ask` envelope carries pi-ask's full question so the app renders richly.
  | ExtensionUiRequestWire
  // omp plan mode state. The relay drops a room_meta `plan` field (its room
  // meta only knows model/thinking/working/goal/loop), so the state rides the
  // owner channel: broadcast on every change, and sent after each
  // session_sync reply. `plan_file_path`/`title` name the latest proposed plan
  // while one exists (so a client can offer "Review plan").
  | { type: "plan_state"; status: PlanStatus; plan_file_path?: string; title?: string }
  // omp's todo list (the TUI's `TODO` panel). Full snapshot of the main
  // session's list, never a delta: replace local state wholesale. Sent to an
  // owner on attach and after every session_sync reply (rebuilt from the
  // session branch, so it survives reconnects and resumes), then broadcast to
  // active owners on change only (deduped). `phases: []` means hide the panel.
  | TodoStateMessage
  // Plan/65 — file transfer to one phone (see FileOfferMessage).
  | FileOfferMessage
  | FileChunkMessage
  | FileEndMessage
  | FileCancelMessage
  // Plan/68 — replies to a phone → PC upload (see UploadAckMessage).
  | UploadAckMessage
  | UploadDoneMessage
  | UploadErrorMessage
  // Mobile Git Diff / Changed Files viewer.
  | GitStatusResultMessage
  | GitDiffResultMessage
  // Mobile composer `@` file autocomplete.
  | FilesListMessage
  // Plan/68 — replies for `list_dirs` / `spawn_session`.
  | DirsListMessage
  | SpawnResultMessage;

/** Reply to `list_files`: ranked paths relative to `root` (the session cwd). */
export interface FilesListMessage {
  type: "files_list";
  in_reply_to: string;
  root: string;
  files: string[];
  truncated: boolean;
}

/** A subfolder in a `dirs_list` (hidden folders are left out). */
export interface WireDirEntry {
  name: string;
  path: string;
  /** Has a `.git` entry. */
  is_git: boolean;
}

/** A folder recently used for agent sessions on this PC. */
export interface WireRecentDir {
  path: string;
  name: string;
  /** Epoch ms of the newest session in the folder; absent for a registered
   *  always-on folder that has no session history. */
  last_used?: number;
}

/** Reply to `list_dirs`. `parent` is null at the filesystem root. `dirs` is
 *  sorted case-insensitively and capped (`truncated`). `recent` newest first. */
export interface DirsListMessage {
  type: "dirs_list";
  in_reply_to: string;
  path: string;
  parent: string | null;
  home: string;
  dirs: WireDirEntry[];
  recent: WireRecentDir[];
  truncated: boolean;
}

/** Reply to `spawn_session`: the session is starting in `cwd` and will show up
 *  as a live room named `name`. `daemon_id` is the supervisor's id for it. */
export interface SpawnResultMessage {
  type: "spawn_result";
  in_reply_to: string;
  cwd: string;
  name: string;
  persistent: boolean;
  daemon_id: string;
}

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export interface WireGitFileChange {
  path: string;
  old_path?: string;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitStatusResultMessage {
  type: "git_status_result";
  in_reply_to: string;
  is_repo: boolean;
  branch?: string;
  repo_root?: string;
  files: WireGitFileChange[];
  truncated?: boolean;
}

export interface GitDiffResultMessage {
  type: "git_diff_result";
  in_reply_to: string;
  path: string;
  staged: boolean;
  diff: string;
  binary?: boolean;
  truncated?: boolean;
  additions?: number;
  deletions?: number;
}

/**
 * One `status_line` snapshot: the values behind omp's footer segments
 * (`packages/tui/src/status-line/segments.ts`). Raw numbers, so each client
 * formats them like the terminal (`35.3%/1M`, `0.01`, `12s`):
 *
 * `π · ⬢ Opus 5.5 · ◕ xhi · 📁 <path> · ⑂ <branch> *U +S ?N · ◫ <ctx> · <cost>`
 */
export interface StatusLineMessage {
  type: "status_line";
  /** Absolute session cwd. */
  cwd: string;
  /**
   * The path segment text exactly as omp prints it: a cwd under a temp root
   * (`os.tmpdir()`, `~/tmp`, `/tmp`, `/var/tmp`) or a work root (`~/Projects`,
   * `~/repos`, `/work`) is shown relative to it, the home dir becomes `~`, and
   * anything over 40 chars keeps its tail behind a leading `…`.
   */
  path: string;
  /** cwd is under a temp root: omp swaps the folder icon for its scratch icon. */
  scratch: boolean;
  /** null outside a git repo (omp hides the segment). */
  git: StatusLineGit | null;
  context: StatusLineContext;
  cost: StatusLineCost;
  /** Epoch ms the running agent started; null when idle. omp's leading `π`
   *  segment shows a spinner + elapsed (`12s`, `3m`, `2h`) while it runs. */
  run_started_at: number | null;
  ts: number;
}

export interface StatusLineGit {
  /** Branch name; `"detached"` for a detached HEAD; null when HEAD is unreadable. */
  branch: string | null;
  /** Counts behind omp's `*unstaged +staged ?untracked` suffix (each shown when > 0). */
  staged: number;
  unstaged: number;
  untracked: number;
}

/** `ctx.getContextUsage()`: tokens in context over the model's window. */
export interface StatusLineContext {
  tokens: number;
  /** 0 when unknown: omp then shows `<tokens>/?`. */
  window: number;
  /** `tokens / window * 100`, unrounded (omp prints `toFixed(1)`). null =
   *  unknown (e.g. right after compaction): omp then shows only the window. */
  percent: number | null;
}

/** Session spend from the session's usage statistics. */
export interface StatusLineCost {
  /** The main agent's own cost (subagents excluded), provider currency (USD). */
  total: number;
  /** Subagent cost, shown as `(+0.42)`. */
  subagents: number;
  /** The model runs on an OAuth subscription: omp shows its subscription
   *  icon instead of `$` (or the icon alone while nothing is spent). */
  subscription: boolean;
  /** Copilot premium requests (`★ N`); 0 elsewhere. */
  premium_requests: number;
}

/** Lifecycle of one activity row. `done`/`failed`/`cancelled` rows linger
 *  a few seconds after `ended_at` (and are dropped at the main agent's
 *  `agent_end`) so clients can flash the outcome before the row disappears. */
export type AgentActivityStatus = "running" | "done" | "failed" | "cancelled";

/**
 * One row of the `agent_activity` panel.
 *
 * - `kind: "subagent"` — an omp `task` subagent. `id` is the subagent name
 *   (`AgentA`, nested: `Outer.Inner`); `label` is omp's short description
 *   (`id` until omp generates one, ~1 s after start).
 * - `kind: "bash"` — an async/background bash job. `id` is the job id
 *   (`bg_1`); `label` and `command` hold the command line.
 * - `kind: "job"` — any other omp background job; `job_type` names it.
 *
 * Elapsed time is NOT on the wire (it would change every snapshot): clients
 * render `now - started_at` while `running`, `ended_at - started_at` after.
 */
export interface AgentActivityJob {
  id: string;
  kind: "subagent" | "bash" | "job";
  label: string;
  status: AgentActivityStatus;
  /** Epoch ms. */
  started_at: number;
  /** Epoch ms; set once `status` is no longer `running`. */
  ended_at?: number;
  /** Subagent: agent definition name (`task`, `scout`, …). */
  agent?: string;
  /** Subagent: omp's generated short description of the assignment. */
  description?: string;
  /** Subagent: the assignment text, truncated to 300 chars. */
  assignment?: string;
  /** Subagent: the `task` tool call that spawned it (ties the row to that tool card). */
  parent_tool_call_id?: string;
  /** Bash: the command line. */
  command?: string;
  /** `kind: "job"`: omp's raw job type. */
  job_type?: string;
  /** One-line "what is it doing now" (subagent intent or `running <tool>`). */
  detail?: string;
  /** Subagent live progress, as last reported by omp. */
  progress?: AgentActivityProgress;
}

export interface AgentActivityProgress {
  /** Tool currently executing, e.g. `bash`. */
  tool?: string;
  /** Its primary argument (command, path, …), truncated to 200 chars. */
  tool_args?: string;
  /** Epoch ms when `tool` started. */
  tool_started_at?: number;
  /** Tool calls made so far. */
  tool_count?: number;
  /** Tokens used so far. */
  tokens?: number;
  /** Cost so far (provider currency units, usually USD). */
  cost?: number;
  /** omp's completion estimate, 0–100, when it reports one. */
  percent?: number;
}

/**
 * Plan/28 — Stable names for the typed actions the app can request. Kept
 * as a closed string union so a switch in either side gets exhaustiveness
 * checking from the compiler.
 */
export type ActionName =
  | "session_new"
  | "session_compact"
  | "model_set"
  | "thinking_set"
  | "reload_plugins"
  | "plan_mode"
  | "model_role_set"
  | "retry_turn";
/**
 * Plan/28 — Mirror of the SDK's `ThinkingLevel` (defined in
 * `@oh-my-pi/pi-agent-core/types`). Re-declared locally so the wire
 * protocol owns its own enum and we don't leak SDK-internal types onto
 * the app's network surface.
 *
 * Note: `"xhigh"`/`"max"` are only honored by select model families; omp
 * offers each model's `thinking.efforts`. The app's picker hides
 * unsupported levels via `WireModel.thinking_levels`.
 */
export type ThinkingLevel =
  | "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/**
 * Plan/28 — Wire shape for one model entry in the app's model picker.
 *
 * Subset of the SDK's `Model<Api>` interface — only the fields the app
 * actually renders. Cost / max-tokens / API class are left off the wire
 * deliberately; if the app's picker grows to need them, they get added
 * here and to the handler's mapping in `index.ts` in one diff.
 */
export interface WireModel {
  /** Stable identifier inside the provider's catalog. E.g. `"claude-opus-4-7"`. */
  id: string;
  /** Display name for the picker row. E.g. `"Claude Opus 4.7"`. */
  name: string;
  /** Provider slug. E.g. `"anthropic"`, `"openai"`. */
  provider: string;
  /** Whether the model supports the thinking surface (`reasoning: true`
   *  in the SDK). Useful so the app can decide whether the thinking
   *  segmented control should be enabled when this model is selected. */
  reasoning: boolean;
  /** Context window in tokens, for display in the picker subtitle. */
  context_window: number;
  /** Plan/30: true when the model accepts image input (SDK `Model.input`
   *  includes `"image"`). The app uses it to enable/disable the attach
   *  button — a text-only model greys out image attachments. */
  vision: boolean;
  /** Thinking levels omp offers for this model, in omp's order: exactly its
   *  Shift+Tab / `/effort` list, `["off", "auto", ...thinking.efforts]`.
   *  Non-reasoning models get `["off"]`. Undefined when the model's metadata
   *  is unknown — clients then offer every level. */
  thinking_levels?: ThinkingLevel[];
}

/** Plan/66 — which omp settings layer supplies a role (`getModelRoleSource`).
 *  `default` = the role is unset and omp picks a model itself. */
export type ModelRoleSource = "project" | "global" | "default";

/** Plan/66 — one omp model role (`default`, `plan`, `task`, `smol`, custom…). */
export interface WireModelRole {
  /** omp role id, e.g. `"plan"`. */
  role: string;
  /** omp's display name (`getRoleInfo(role).name`), e.g. `"Architect"`. */
  name: string;
  /** One line on what omp uses the role for; `""` for custom roles. */
  description: string;
  /** The model the role resolves to; absent when unset or unresolvable. */
  model?: WireModel;
  /** Explicit thinking suffix of the role value (`…:high`), if any. */
  thinking?: ThinkingLevel;
  source: ModelRoleSource;
  /** Models omp accepts for this role (`roleCandidatePool`: authenticated and
   *  of the role's kind), as bare pairs. Only in the reply to a
   *  `list_model_roles` with `role`, and only when the pool differs from the
   *  `models_list` list; absent there means "the full models_list list".
   *  Never in the full list or a broadcast. Older apps ignore it. */
  candidates?: WireRoleCandidate[];
}

/** Plan/66 — one model eligible for a role. */
export interface WireRoleCandidate {
  provider: string;
  model_id: string;
}

export type ByeReason = "peer_stop" | "session_replaced" | "shutdown";

/** omp todo task status (`todo` tool). `abandoned` = dropped by the agent. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoTaskWire {
  /** Task text; the agent addresses tasks by this exact content. */
  content: string;
  status: TodoStatus;
  /** `blocked` only: the agent's reason, when it gave one. */
  blocker?: string;
}

export interface TodoPhaseWire {
  name: string;
  /** Never empty: phases without tasks are dropped (omp never draws them). */
  tasks: TodoTaskWire[];
}

/**
 * `todo_state`: the list as omp's TUI panel shows it, phases in order.
 * omp rules clients mirror: done = `completed` + `abandoned` (the `done/total`
 * counts); the active phase is the first with a `pending`/`in_progress` task
 * (else the last); omp keeps exactly one `in_progress` task while any task is
 * open (it auto-starts the first pending one). `phases: []` also when the TUI
 * auto-dismissed a fully done list (`todo_hud_state`).
 */
export interface TodoStateMessage {
  type: "todo_state";
  phases: TodoPhaseWire[];
  ts: number;
}

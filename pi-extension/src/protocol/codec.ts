import type { ClientMessage, ServerMessage } from "./types.js";

const SERVER_TYPES = new Set<ServerMessage["type"]>([
  "pair_ok",
  "pair_error",
  "user_input",
  "queued_message_state",
  "agent_chunk",
  "agent_done",
  "agent_message",
  "tool_request",
  "tool_result",
  "error",
  "cancelled",
  "pong",
  "bye",
  "session_history",
  // Plan/57 — interactive extension prompt (ask_user via pi-ask).
  "extension_ui_request",
  // Plan/65 — file transfer to one phone. `file_cancel` travels both ways.
  "file_offer",
  "file_chunk",
  "file_end",
  "file_cancel",
  // Plan/66 — omp model roles (reply + broadcast).
  "model_roles",
]);

/** Frames the app (or web client) sends to the extension. */
const CLIENT_TYPES = new Set<ClientMessage["type"]>([
  "pair_request",
  "user_message",
  "queued_message_set",
  "queued_message_clear",
  "approve_tool",
  "cancel",
  "ping",
  "session_sync",
  "session_new",
  "session_compact",
  "model_set",
  "thinking_set",
  "list_models",
  "reload_plugins",
  "plan_mode",
  "extension_ui_response",
  // Plan/65 — replies from the phone receiving a file.
  "file_ack",
  "file_done",
  "file_error",
  "file_cancel",
  // Plan/66 — omp model roles.
  "list_model_roles",
  "model_role_set",
]);

export class DecodeError extends Error {
  constructor(
    public readonly code: "invalid_message" | "unsupported_type",
    message: string,
  ) {
    super(message);
    this.name = "DecodeError";
  }
}

export function encodeClient(msg: ClientMessage): string {
  return JSON.stringify(msg) + "\n";
}

export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify(msg) + "\n";
}

export function decodeServer(line: string): ServerMessage {
  return decodeTyped(line, SERVER_TYPES) as ServerMessage;
}

/** Decodes an app → extension frame. Unknown fields pass through untouched. */
export function decodeClient(line: string): ClientMessage {
  return decodeTyped(line, CLIENT_TYPES) as ClientMessage;
}

function decodeTyped(line: string, types: ReadonlySet<string>): unknown {
  let obj: unknown;
  try {
    obj = JSON.parse(line.trim());
  } catch (e) {
    throw new DecodeError("invalid_message", `not JSON: ${(e as Error).message}`);
  }
  if (
    !obj ||
    typeof obj !== "object" ||
    typeof (obj as Record<string, unknown>).type !== "string"
  ) {
    throw new DecodeError("invalid_message", "missing 'type'");
  }
  const t = (obj as Record<string, unknown>).type as string;
  if (!types.has(t)) {
    throw new DecodeError("unsupported_type", `unknown type: ${t}`);
  }
  return obj;
}

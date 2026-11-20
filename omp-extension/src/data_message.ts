import type { CustomMessagePayload, ExtensionAPI } from "./omp-api.js";

/**
 * Send a message that exists for the host's UI and RPC clients, not for the model
 * (relay state, pairing, mesh name, notices, previews).
 *
 * omp steers a custom message into a LIVE run, which buys a provider pass on
 * unchanged context and leaves the row in the session file as model input.
 * `excludeFromContext: true` makes it a transcript-only row instead: appended
 * at once when idle, held until the run ends when streaming, and never part of
 * the model's context (`pi-agent-core` `convertToLlm`).
 *
 * Messages that must wake the agent (the mesh delivery) call `pi.sendMessage`
 * directly: they are the one place a turn is the point.
 */
export function sendDataMessage(pi: Pick<ExtensionAPI, "sendMessage"> | null | undefined, message: CustomMessagePayload): void {
  pi?.sendMessage({ ...message, excludeFromContext: true });
}

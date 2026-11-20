/**
 * Footer renderer for the omp TUI. One combined status slot + window title.
 *
 * The slot key is intentionally namespaced so other extensions don't collide:
 *   - remote-omp — relay state (off / on / paired), the local session + peer
 *                  count, and the active mobile device, if paired
 */
export interface FooterContext {
  ui: {
    setStatus(key: string, value: string | undefined): void;
    setTitle(title: string): void;
  };
}

export interface FooterState {
  session?: string;
  peerCount?: number;
  relayOn?: boolean;
  /** Active device session right now (drives the 📱 slot).
   *  Independent from `hasPairings` — a device may be paired globally
   *  in peers.json without being actively connected to THIS omp process. */
  devicePaired?: string;
  /** At least one device has been paired with this machine before
   *  (peers.json is non-empty). Drives the 🟢/🟡 icon on the relay slot:
   *  🟢 when true (ready — devices can connect), 🟡 when false (first
   *  pairing needed). Pairing is per-machine (global), not per-process. */
  hasPairings?: boolean;
  /** Assigned agent name in the current session. Becomes the title prefix
   *  (e.g. "backend · foo · relay") when set. Falls back to "omp" otherwise. */
  agentName?: string;
}

const K_STATUS = "remote-omp";

export function updateFooter(ctx: FooterContext, state: FooterState): void {
  const parts: string[] = [];

  if (state.relayOn) {
    parts.push(state.hasPairings ? "🟢 relay" : "🟡 relay waiting for pairing");
  }

  if (state.session) {
    const count = state.peerCount ?? 0;
    parts.push(`📡 ${state.session} (${count})`);
  }

  if (state.devicePaired) {
    parts.push(`📱 ${state.devicePaired}`);
  }

  if (parts.length > 0) {
    ctx.ui.setStatus(K_STATUS, parts.join("  "));
  } else {
    ctx.ui.setStatus(K_STATUS, undefined);
  }

  // Terminal title — two parts only: `<agent-name> · <On|Off>`.
  // Pre-2026-05-24 the title carried three segments (`name · local · relay`),
  // but `local` was always the same string (single fixed UDS session) and
  // `relay` repeated information the relay slot already shows. Collapsed
  // to "name + relay state in plain English" — same info, clearer at a
  // glance: terminal tabs read like `backend · On` / `backend · Off`.
  const prefix = state.agentName?.trim() || "omp";
  const relayState = state.relayOn ? "On" : "Off";
  ctx.ui.setTitle(`${prefix} · ${relayState}`);
}

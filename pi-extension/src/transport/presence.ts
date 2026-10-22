/**
 * Relay presence of this PC's paired owners (relay control frames, plano 12).
 *
 *   → { type: "subscribe_presence", peers }  replaces this connection's set;
 *                                            the relay backfills peer_online
 *   → { type: "presence_check", peers }      ← { type: "presence", states: [{ peer, online }] }
 *   ← { type: "peer_online", peer }
 *   ← { type: "peer_offline", peer, since_ts }
 *
 * Subscriptions belong to one relay connection, so the owner list is sent
 * again after every (re)connect. Until a frame arrives for an owner its state
 * is `unknown`; a closed relay link makes every owner `unknown` again.
 */
export type PresenceState = "online" | "offline" | "unknown";

export type PresenceFrame =
  | { type: "subscribe_presence"; peers: string[] }
  | { type: "presence_check"; peers: string[] };

export class OwnerPresence {
  private readonly states = new Map<string, boolean>();
  private subscribed = new Set<string>();

  /** `onChange` fires on transitions only (a repeated peer_online is not one). */
  constructor(
    private readonly onChange: (peer: string, online: boolean, prev: PresenceState) => void = () => undefined,
  ) {}

  state(peer: string): PresenceState {
    const online = this.states.get(peer);
    return online === undefined ? "unknown" : online ? "online" : "offline";
  }

  isSubscribed(peer: string): boolean {
    return this.subscribed.has(peer);
  }

  /** Frames that (re)subscribe this connection to `peers`. */
  subscribeFrames(peers: readonly string[]): PresenceFrame[] {
    const list = [...new Set(peers)].sort();
    this.subscribed = new Set(list);
    const frames: PresenceFrame[] = [{ type: "subscribe_presence", peers: list }];
    if (list.length > 0) frames.push({ type: "presence_check", peers: list });
    return frames;
  }

  /** Parses one relay line. True when it was a presence frame. */
  handleLine(line: string): boolean {
    // Envelopes are `{peer, room, ct}` with a base64 `ct`: no "type" key.
    if (!line.includes('"type"')) return false;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return false;
    }
    if (!frame || typeof frame !== "object") return false;
    const f = frame as { type?: unknown; peer?: unknown; states?: unknown };
    switch (f.type) {
      case "peer_online":
      case "peer_offline":
        if (typeof f.peer !== "string" || f.peer === "") return false;
        this.set(f.peer, f.type === "peer_online");
        return true;
      case "presence":
        if (!Array.isArray(f.states)) return false;
        for (const s of f.states as unknown[]) {
          const st = s as { peer?: unknown; online?: unknown } | null;
          if (st && typeof st.peer === "string" && typeof st.online === "boolean") this.set(st.peer, st.online);
        }
        return true;
      default:
        return false;
    }
  }

  /** The relay link closed: owners are unknown until the next subscription. */
  reset(): void {
    this.states.clear();
    this.subscribed.clear();
  }

  private set(peer: string, online: boolean): void {
    const prev = this.state(peer);
    this.states.set(peer, online);
    if (prev !== (online ? "online" : "offline")) this.onChange(peer, online, prev);
  }
}

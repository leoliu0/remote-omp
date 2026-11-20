import { describe, expect, test } from "vitest";
import { OwnerPresence } from "./presence.js";

describe("OwnerPresence — relay presence of paired owners", () => {
  test("subscribe frames: subscribe_presence then presence_check, peers de-duplicated", () => {
    const p = new OwnerPresence();
    expect(p.subscribeFrames(["B", "A", "B"])).toEqual([
      { type: "subscribe_presence", peers: ["A", "B"] },
      { type: "presence_check", peers: ["A", "B"] },
    ]);
    expect(p.isSubscribed("A")).toBe(true);
    expect(p.isSubscribed("C")).toBe(false);
    // An empty list clears the relay subscription; nothing to check.
    expect(p.subscribeFrames([])).toEqual([{ type: "subscribe_presence", peers: [] }]);
  });

  test("state is unknown until a frame arrives, then follows peer_online / peer_offline", () => {
    const p = new OwnerPresence();
    expect(p.state("A")).toBe("unknown");
    expect(p.handleLine(JSON.stringify({ type: "peer_online", peer: "A" }))).toBe(true);
    expect(p.state("A")).toBe("online");
    expect(p.handleLine(JSON.stringify({ peer: "A", since_ts: 1, type: "peer_offline" }))).toBe(true);
    expect(p.state("A")).toBe("offline");
  });

  test("the presence snapshot sets every listed peer", () => {
    const p = new OwnerPresence();
    p.handleLine(JSON.stringify({
      type: "presence",
      states: [{ peer: "A", online: false, since_ts: 5 }, { peer: "B", online: true }],
    }));
    expect(p.state("A")).toBe("offline");
    expect(p.state("B")).toBe("online");
  });

  test("onChange fires on transitions only, with the previous state", () => {
    const seen: string[] = [];
    const p = new OwnerPresence((peer, online, prev) => seen.push(`${peer}:${prev}->${online ? "online" : "offline"}`));
    p.handleLine(JSON.stringify({ type: "peer_online", peer: "A" }));
    p.handleLine(JSON.stringify({ type: "peer_online", peer: "A" }));  // backfill after a resubscribe
    p.handleLine(JSON.stringify({ type: "presence", states: [{ peer: "A", online: true }] }));
    p.handleLine(JSON.stringify({ type: "peer_offline", peer: "A" }));
    p.handleLine(JSON.stringify({ type: "peer_online", peer: "A" }));
    expect(seen).toEqual(["A:unknown->online", "A:online->offline", "A:offline->online"]);
  });

  test("envelopes, other control frames and junk are not presence frames", () => {
    const p = new OwnerPresence();
    expect(p.handleLine(JSON.stringify({ peer: "A", room: "r", ct: "eyJ0eXBlIjoicGluZyJ9" }))).toBe(false);
    expect(p.handleLine(JSON.stringify({ type: "rooms", peer: "A", rooms: [] }))).toBe(false);
    expect(p.handleLine("not json")).toBe(false);
    expect(p.handleLine(JSON.stringify({ type: "peer_online" }))).toBe(false);
    expect(p.state("A")).toBe("unknown");
  });

  test("reset (relay link closed) makes every owner unknown without firing onChange", () => {
    let calls = 0;
    const p = new OwnerPresence(() => { calls += 1; });
    p.subscribeFrames(["A"]);
    p.handleLine(JSON.stringify({ type: "peer_online", peer: "A" }));
    p.reset();
    expect(p.state("A")).toBe("unknown");
    expect(p.isSubscribed("A")).toBe(false);
    expect(calls).toBe(1);
  });

  test("anyOnline tracks whether any owner is online across updates and reset", () => {
    const p = new OwnerPresence();
    expect(p.anyOnline()).toBe(false);
    p.handleLine(JSON.stringify({ type: "peer_offline", peer: "A", since_ts: 1 }));
    expect(p.anyOnline()).toBe(false);
    p.handleLine(JSON.stringify({ type: "peer_online", peer: "B" }));
    expect(p.anyOnline()).toBe(true);
    p.handleLine(JSON.stringify({ type: "peer_offline", peer: "B", since_ts: 2 }));
    expect(p.anyOnline()).toBe(false);
    p.handleLine(JSON.stringify({
      type: "presence",
      states: [{ peer: "A", online: true }, { peer: "B", online: false }],
    }));
    expect(p.anyOnline()).toBe(true);
    p.reset();
    expect(p.anyOnline()).toBe(false);
  });
});

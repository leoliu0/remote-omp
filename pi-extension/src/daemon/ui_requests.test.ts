import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UiRequestTimeBox, type UiCancelFrame } from "./ui_requests.js";

const req = (method: string, id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "extension_ui_request", id, method, ...extra });

describe("UiRequestTimeBox", () => {
  let sent: UiCancelFrame[];
  let box: UiRequestTimeBox;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    box = new UiRequestTimeBox((f) => sent.push(f), () => 1000);
  });
  afterEach(() => {
    box.dispose();
    vi.useRealTimers();
  });

  test.each(["select", "confirm", "input", "editor", "ask"])(
    "an unanswered %s dialog is cancelled after the time box",
    (method) => {
      box.ingest(req(method, "r1", { title: "t", options: [] }));
      expect(box.pending).toBe(1);
      vi.advanceTimersByTime(999);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual([{ type: "extension_ui_response", id: "r1", cancelled: true, timedOut: true }]);
      expect(box.pending).toBe(0);
    },
  );

  test("fire-and-forget methods and other frames are ignored", () => {
    box.ingest(req("notify", "n1", { message: "hi" }));
    box.ingest(req("setStatus", "s1"));
    box.ingest(JSON.stringify({ type: "message_end" }));
    box.ingest("not json but mentions \"extension_ui_request\"");
    expect(box.pending).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });

  test("a `cancel` frame for the dialog withdraws it (nothing is sent later)", () => {
    box.ingest(req("confirm", "c1", { title: "t", message: "m" }));
    box.ingest(req("cancel", "x", { targetId: "c1" }));
    expect(box.pending).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });

  test("dispose drops pending dialogs (child exited)", () => {
    box.ingest(req("select", "a", { title: "t", options: [] }));
    box.ingest(req("input", "b", { title: "t" }));
    box.dispose();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });

  test("a repeated id does not start a second timer", () => {
    box.ingest(req("select", "a", { title: "t", options: [] }));
    box.ingest(req("select", "a", { title: "t", options: [] }));
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });
});

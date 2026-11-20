import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  DecodeError,
  decodeClient,
  decodeServer,
  encodeClient,
  encodeServer,
} from "./codec.js";
import type { ClientMessage, ServerMessage } from "./types.js";

const fixtureDir = fileURLToPath(
  new URL("../../../.orchestration/contracts/fixtures", import.meta.url),
);

const SERVER_TYPE_FILES = new Set([
  "pair_ok.jsonl",
  "pair_error.jsonl",
  "user_input.jsonl",
  "agent_stream.jsonl",
  "agent_message.jsonl",
  "tool_request.jsonl",
  "tool_result.jsonl",
  "error.jsonl",
  "cancelled.jsonl",
  "pong.jsonl",
  "bye.jsonl",
  "session_history.jsonl",
]);

describe("fixtures", () => {
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".jsonl"));

  test("31 fixture files present", () => {
    expect(files).toHaveLength(31);
  });

  for (const file of files) {
    test(file, () => {
      const lines = readFileSync(`${fixtureDir}/${file}`, "utf8")
        .split("\n")
        .filter(Boolean);

      for (const line of lines) {
        if (SERVER_TYPE_FILES.has(file)) {
          const msg = decodeServer(line);
          expect(msg).toHaveProperty("type");
        } else {
          // client-only fixture — must throw unsupported_type, not invalid_message
          let caught: unknown;
          try {
            decodeServer(line);
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(DecodeError);
          expect((caught as DecodeError).code).toBe("unsupported_type");
        }
      }
    });
  }
});

describe("rejects junk", () => {
  test("invalid JSON → DecodeError invalid_message", () => {
    let err: unknown;
    try {
      decodeServer("not json {{{");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe("invalid_message");
  });

  test("missing type field → DecodeError invalid_message", () => {
    let err: unknown;
    try {
      decodeServer('{"foo":1}');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe("invalid_message");
    expect((err as DecodeError).message).toMatch(/missing 'type'/);
  });

  test("unknown type → DecodeError unsupported_type", () => {
    let err: unknown;
    try {
      decodeServer('{"type":"made_up"}');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe("unsupported_type");
    expect((err as DecodeError).message).toMatch(/unknown type/);
  });
});

describe("encodeClient roundtrip", () => {
  test("ping", () => {
    const msg = { type: "ping" as const, id: "018f9c2a" };
    const encoded = encodeClient(msg);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(JSON.parse(encoded.trim())).toEqual(msg);
  });

  test("user_message", () => {
    const msg = { type: "user_message" as const, id: "018f9c2a", text: "hello" };
    expect(JSON.parse(encodeClient(msg).trim())).toEqual(msg);
  });

  test("user_message with steer streaming behavior", () => {
    const msg = {
      type: "user_message" as const,
      id: "018f9c2a",
      text: "refine this",
      streaming_behavior: "steer" as const,
    };
    expect(JSON.parse(encodeClient(msg).trim())).toEqual(msg);
  });
});

// Plan/65 — file transfer frames. Field names are the wire contract shared
// with app/lib/protocol/protocol.dart: snake_case, exactly as in the plan.
describe("file transfer frames (plan/65)", () => {
  const serverFrames: ServerMessage[] = [
    {
      type: "file_offer",
      file_id: "f-1",
      name: "app-release.apk",
      mime: "application/vnd.android.package-archive",
      size: 33_554_432,
      sha256: "a".repeat(64),
      caption: "Fresh build",
      turn_id: "turn-9",
    },
    {
      type: "file_offer",
      file_id: "f-2",
      name: "notes.txt",
      mime: "text/plain",
      size: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    { type: "file_chunk", file_id: "f-1", seq: 3, data: "AAEC" },
    { type: "file_end", file_id: "f-1", chunks: 32 },
    { type: "file_cancel", file_id: "f-1" },
  ];
  const clientFrames: ClientMessage[] = [
    { type: "file_ack", file_id: "f-1", next_seq: 4 },
    { type: "file_done", file_id: "f-1" },
    { type: "file_error", file_id: "f-1", reason: "sha_mismatch" },
    { type: "file_error", file_id: "f-1", reason: "no_space" },
    { type: "file_error", file_id: "f-1", reason: "cancelled" },
    { type: "file_cancel", file_id: "f-1" },
  ];

  for (const frame of serverFrames) {
    test(`ext → app ${frame.type} round-trips (${JSON.stringify(frame).length} B)`, () => {
      const line = encodeServer(frame);
      expect(line.endsWith("\n")).toBe(true);
      expect(decodeServer(line)).toEqual(frame);
    });
  }

  for (const frame of clientFrames) {
    test(`app → ext ${frame.type} round-trips (${JSON.stringify(frame)})`, () => {
      expect(decodeClient(encodeClient(frame))).toEqual(frame);
    });
  }

  test("wire field names are exactly the plan's snake_case names", () => {
    expect(Object.keys(JSON.parse(encodeServer(serverFrames[0]!)))).toEqual([
      "type", "file_id", "name", "mime", "size", "sha256", "caption", "turn_id",
    ]);
    expect(Object.keys(JSON.parse(encodeServer(serverFrames[2]!)))).toEqual([
      "type", "file_id", "seq", "data",
    ]);
    expect(Object.keys(JSON.parse(encodeServer(serverFrames[3]!)))).toEqual([
      "type", "file_id", "chunks",
    ]);
    expect(Object.keys(JSON.parse(encodeClient(clientFrames[0]!)))).toEqual([
      "type", "file_id", "next_seq",
    ]);
  });

  test("unknown fields on file_* frames are ignored, not fatal", () => {
    const offer = decodeServer(
      '{"type":"file_offer","file_id":"f","name":"a.pdf","mime":"application/pdf",' +
        '"size":1,"sha256":"00","future_field":{"x":1}}',
    );
    expect(offer).toMatchObject({ type: "file_offer", file_id: "f", name: "a.pdf" });
    const chunk = decodeServer('{"type":"file_chunk","file_id":"f","seq":0,"data":"AA==","crc":7}');
    expect(chunk).toMatchObject({ type: "file_chunk", seq: 0 });
    const ack = decodeClient('{"type":"file_ack","file_id":"f","next_seq":2,"window":8}');
    expect(ack).toMatchObject({ type: "file_ack", next_seq: 2 });
    const done = decodeClient('{"type":"file_done","file_id":"f","path":"/x"}');
    expect(done).toMatchObject({ type: "file_done", file_id: "f" });
  });

  test("direction is enforced: app-only frames are not server frames and vice versa", () => {
    for (const t of ["file_ack", "file_done", "file_error"]) {
      expect(() => decodeServer(`{"type":"${t}","file_id":"f"}`)).toThrow(DecodeError);
    }
    for (const t of ["file_offer", "file_chunk", "file_end"]) {
      expect(() => decodeClient(`{"type":"${t}","file_id":"f"}`)).toThrow(DecodeError);
    }
    // file_cancel travels both ways.
    expect(decodeServer('{"type":"file_cancel","file_id":"f"}').type).toBe("file_cancel");
    expect(decodeClient('{"type":"file_cancel","file_id":"f"}').type).toBe("file_cancel");
  });
});

// Plan/66 — omp model roles. Field names are the wire contract shared with
// app/lib/protocol/protocol.dart: snake_case, exactly as in the plan.
describe("model role frames (plan/66)", () => {
  const opus = {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    provider: "anthropic",
    reasoning: true,
    context_window: 1_000_000,
    vision: true,
    thinking_levels: ["off", "auto", "low", "medium", "high", "xhigh", "max"],
  } as const;
  const serverFrames: ServerMessage[] = [
    {
      type: "model_roles",
      in_reply_to: "r-1",
      roles: [
        {
          role: "plan",
          name: "Architect",
          description: "Model for plan mode",
          model: { ...opus, thinking_levels: [...opus.thinking_levels] },
          thinking: "max",
          source: "global",
        },
        {
          role: "slow",
          name: "Thinking",
          description: "",
          source: "default",
          candidates: [
            { provider: "anthropic", model_id: "claude-opus-5-5" },
            { provider: "anthropic", model_id: "claude-sonnet-5-5" },
          ],
        },
      ],
    },
    // Broadcast after a model_role_set: no in_reply_to.
    { type: "model_roles", roles: [] },
  ];
  const clientFrames: ClientMessage[] = [
    { type: "list_model_roles", id: "r-1" },
    // On-demand candidates for one role.
    { type: "list_model_roles", id: "r-5", role: "web" },
    {
      type: "model_role_set",
      id: "r-2",
      role: "plan",
      provider: "anthropic",
      model_id: "claude-opus-5-5",
      thinking: "high",
    },
    { type: "model_role_set", id: "r-3", role: "task", provider: "anthropic", model_id: "claude-sonnet-5-5" },
    // Clear: no provider / model_id.
    { type: "model_role_set", id: "r-4", role: "task" },
  ];

  for (const frame of serverFrames) {
    test(`ext → app ${frame.type} round-trips (${JSON.stringify(frame).length} B)`, () => {
      const line = encodeServer(frame);
      expect(line.endsWith("\n")).toBe(true);
      expect(decodeServer(line)).toEqual(frame);
    });
  }

  for (const frame of clientFrames) {
    test(`app → ext ${frame.type} round-trips (${JSON.stringify(frame)})`, () => {
      expect(decodeClient(encodeClient(frame))).toEqual(frame);
    });
  }

  test("wire field names are exactly the plan's snake_case names", () => {
    const roles = JSON.parse(encodeServer(serverFrames[0]!));
    expect(Object.keys(roles)).toEqual(["type", "in_reply_to", "roles"]);
    expect(Object.keys(roles.roles[0])).toEqual([
      "role", "name", "description", "model", "thinking", "source",
    ]);
    expect(Object.keys(roles.roles[1].candidates[0])).toEqual(["provider", "model_id"]);
    expect(Object.keys(JSON.parse(encodeClient(clientFrames[1]!)))).toEqual(["type", "id", "role"]);
    expect(Object.keys(JSON.parse(encodeClient(clientFrames[2]!)))).toEqual([
      "type", "id", "role", "provider", "model_id", "thinking",
    ]);
  });

  test("direction is enforced", () => {
    expect(() => decodeServer('{"type":"list_model_roles","id":"x"}')).toThrow(DecodeError);
    expect(() => decodeServer('{"type":"model_role_set","id":"x","role":"plan"}')).toThrow(DecodeError);
    expect(() => decodeClient('{"type":"model_roles","roles":[]}')).toThrow(DecodeError);
  });
});

describe("git_status and git_diff frames", () => {
  test("client git frames encode/decode cleanly", () => {
    const req1: ClientMessage = { type: "git_status", id: "act_1" };
    const req2: ClientMessage = { type: "git_diff", id: "act_2", path: "src/app.ts", staged: true };
    expect(decodeClient(encodeClient(req1))).toEqual(req1);
    expect(decodeClient(encodeClient(req2))).toEqual(req2);
  });

  test("server git frames encode/decode and enforce direction", () => {
    const res1: ServerMessage = {
      type: "git_status_result",
      in_reply_to: "act_1",
      is_repo: true,
      branch: "main",
      files: [
        { path: "src/app.ts", status: "modified", staged: false, unstaged: true, additions: 3, deletions: 1 },
      ],
    };
    const res2: ServerMessage = {
      type: "git_diff_result",
      in_reply_to: "act_2",
      path: "src/app.ts",
      staged: true,
      diff: "@@ -1 +1 @@\n-old\n+new\n",
      additions: 1,
      deletions: 1,
    };
    expect(decodeServer(encodeServer(res1))).toEqual(res1);
    expect(decodeServer(encodeServer(res2))).toEqual(res2);
    expect(() => decodeServer('{"type":"git_status","id":"act_1"}')).toThrow(DecodeError);
    expect(() => decodeClient('{"type":"git_status_result","in_reply_to":"act_1","is_repo":true,"files":[]}')).toThrow(DecodeError);
  });
});

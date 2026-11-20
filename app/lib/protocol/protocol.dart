// ignore_for_file: lines_longer_than_80_chars

// ---------------------------------------------------------------------------
// Control frames (plano 12 — presence)
//
// These travel raw over the WS (no outer envelope) and are routed by the
// relay itself, not the Pi. They never enter the inner-message switch.
// ---------------------------------------------------------------------------

/// Inbound control frame (relay → app).
sealed class ControlInbound {
  const ControlInbound();

  /// Parses a top-level JSON map into a control inbound. Returns null when
  /// the `type` is unknown (forward-compat).
  static ControlInbound? tryFromJson(Map<String, dynamic> j) {
    return switch (j['type']) {
      'peer_online' => PeerOnline(peer: j['peer'] as String),
      'peer_offline' => PeerOffline(
        peer: j['peer'] as String,
        sinceTs: (j['since_ts'] as num).toInt(),
      ),
      'presence' => PresenceSnapshot(
        states: (j['states'] as List<dynamic>)
            .map((e) => PeerPresence.fromJson(e as Map<String, dynamic>))
            .toList(),
      ),
      'room_announced' => () {
        // Plan/28 Wave D — thinking arrives either as a top-level
        // field (post-relay-flatten) or nested under `meta.thinking`
        // (pre-flatten relay forwarding the Pi's room_meta verbatim).
        // Read both so the app stays forward-compat with either side.
        final metaJson = j['meta'] as Map<String, dynamic>?;
        final rawThinking =
            (j['thinking'] as String?) ?? (metaJson?['thinking'] as String?);
        // Plan/32 — `working` arrives top-level (RoomMeta serializes flat)
        // or nested under `meta.working`; read both for forward-compat.
        final rawWorking =
            (j['working'] as bool?) ?? (metaJson?['working'] as bool?);
        final rawGoal = (j['goal'] as String?) ?? (metaJson?['goal'] as String?);
        final rawLoop = (j['loop'] as String?) ?? (metaJson?['loop'] as String?);
        return RoomAnnounced(
          peer: j['peer'] as String,
          roomId: j['room_id'] as String,
          name: j['name'] as String?,
          cwd: j['cwd'] as String?,
          startedAt: (j['started_at'] as num).toInt(),
          model: j['model'] as String?,
          thinking: rawThinking != null
              ? ThinkingLevel.fromWire(rawThinking)
              : null,
          working: rawWorking,
          goal: rawGoal,
          loop: rawLoop,
        );
      }(),
      'room_ended' => RoomEnded(
        peer: j['peer'] as String,
        roomId: j['room_id'] as String,
        sinceTs: (j['since_ts'] as num).toInt(),
      ),
      'rooms' => RoomsSnapshot(
        peer: j['peer'] as String,
        rooms: (j['rooms'] as List<dynamic>)
            .map((e) => RoomInfo.fromJson(e as Map<String, dynamic>))
            .toList(),
      ),
      'room_meta_updated' => () {
        final meta = j['meta'] as Map<String, dynamic>?;
        final hasModel = meta?.containsKey('model') ?? false;
        final hasThinking = meta?.containsKey('thinking') ?? false;
        final hasGoal = meta?.containsKey('goal') ?? false;
        final hasLoop = meta?.containsKey('loop') ?? false;
        final rawThinking = meta?['thinking'] as String?;
        return RoomMetaUpdated(
          peer: j['peer'] as String,
          roomId: j['room_id'] as String,
          model: meta?['model'] as String?,
          thinking: rawThinking != null
              ? ThinkingLevel.fromWire(rawThinking)
              : null,
          working: meta?['working'] as bool?,
          goal: meta?['goal'] as String?,
          loop: meta?['loop'] as String?,
          hasModel: hasModel,
          hasThinking: hasThinking,
          hasGoal: hasGoal,
          hasLoop: hasLoop,
        );
      }(),
      _ => null,
    };
  }
}

class PeerOnline extends ControlInbound {
  final String peer;
  const PeerOnline({required this.peer});
}

class PeerOffline extends ControlInbound {
  final String peer;
  final int sinceTs;
  const PeerOffline({required this.peer, required this.sinceTs});
}

class PresenceSnapshot extends ControlInbound {
  final List<PeerPresence> states;
  const PresenceSnapshot({required this.states});
}

class PeerPresence {
  final String peer;
  final bool online;
  final int? sinceTs;
  const PeerPresence({
    required this.peer,
    required this.online,
    required this.sinceTs,
  });

  factory PeerPresence.fromJson(Map<String, dynamic> j) => PeerPresence(
    peer: j['peer'] as String,
    online: j['online'] as bool,
    sinceTs: (j['since_ts'] as num?)?.toInt(),
  );
}

// --- Outbound control frames (helpers; the wire shape is just a Map) ---

Map<String, dynamic> subscribePresenceFrame(List<String> peers) => {
  'type': 'subscribe_presence',
  'peers': peers,
};

Map<String, dynamic> unsubscribePresenceFrame(List<String> peers) => {
  'type': 'unsubscribe_presence',
  'peers': peers,
};

Map<String, dynamic> presenceCheckFrame(List<String> peers) => {
  'type': 'presence_check',
  'peers': peers,
};

Map<String, dynamic> subscribeRoomsFrame(List<String> peers) => {
  'type': 'subscribe_rooms',
  'peers': peers,
};

Map<String, dynamic> unsubscribeRoomsFrame(List<String> peers) => {
  'type': 'unsubscribe_rooms',
  'peers': peers,
};

Map<String, dynamic> roomsCheckFrame(List<String> peers) => {
  'type': 'rooms_check',
  'peers': peers,
};

// ---------------------------------------------------------------------------
// Rooms (plan 17 — multi-cwd per Mac)
//
// Each omp-extension instance opens one room per active session (cwd).
// The relay tracks room metadata per peer and pushes:
//   - room_announced: a new room came online for a peer
//   - room_ended: a room closed (Pi exited or stopped that cwd)
//   - rooms (snapshot): full list for a peer (sent after subscribe_rooms
//     or rooms_check).
// The app subscribes via `subscribe_rooms(peers)` and renders them as
// tiles grouped by Mac.
// ---------------------------------------------------------------------------

// Sentinel for nullable copyWith parameters that need to distinguish
// "keep current" (omit) from "set to null" (pass `null` explicitly).
const Object _kRoomInfoUnset = Object();

/// Snapshot of a single Pi room (one cwd / session).
class RoomInfo {
  final String roomId;
  final String? name;
  final String? cwd;
  final int startedAt;

  /// Plan 18 — display model the omp-extension is running with (e.g.
  /// `claude-sonnet-4.5`, `gpt-4o`). Optional; Pi-ext may omit and
  /// the app falls back to `last paired` in the subtitle.
  final String? model;

  /// Plan/28 Wave D — current thinking level the omp-extension session
  /// is running with. Optional; Pi-ext may omit when it cannot resolve
  /// it from the SDK, and legacy Pis don't publish this field at all.
  /// Drives the initial highlight of the Quick Actions thinking
  /// segmented control.
  final ThinkingLevel? thinking;

  /// Plan/32 — `true` when the room currently has an in-flight agent
  /// turn. The relay broadcasts `meta.working` for EVERY subscribed room
  /// (like presence), so Home can light the blue "working" dot on any
  /// session — not just the single connected one. Defaults to `false`
  /// (idle / not reported yet).
  final bool working;
  final String? goal;
  final String? loop;

  const RoomInfo({
    required this.roomId,
    required this.startedAt,
    this.name,
    this.cwd,
    this.model,
    this.thinking,
    this.working = false,
    this.goal,
    this.loop,
  });

  factory RoomInfo.fromJson(Map<String, dynamic> j) {
    final rawThinking = j['thinking'] as String?;
    return RoomInfo(
      roomId: j['room_id'] as String,
      name: j['name'] as String?,
      cwd: j['cwd'] as String?,
      startedAt: (j['started_at'] as num).toInt(),
      model: j['model'] as String?,
      thinking: rawThinking != null
          ? ThinkingLevel.fromWire(rawThinking)
          : null,
      working: (j['working'] as bool?) ?? false,
      goal: j['goal'] as String?,
      loop: j['loop'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'room_id': roomId,
    'name': name,
    'cwd': cwd,
    'started_at': startedAt,
    'model': model,
    if (thinking != null) 'thinking': thinking!.wire,
    'working': working,
    if (goal != null) 'goal': goal,
    if (loop != null) 'loop': loop,
  };

  RoomInfo copyWith({
    String? name,
    String? cwd,
    int? startedAt,
    Object? model = _kRoomInfoUnset,
    Object? thinking = _kRoomInfoUnset,
    bool? working,
    Object? goal = _kRoomInfoUnset,
    Object? loop = _kRoomInfoUnset,
  }) => RoomInfo(
    roomId: roomId,
    name: name ?? this.name,
    cwd: cwd ?? this.cwd,
    startedAt: startedAt ?? this.startedAt,
    model: identical(model, _kRoomInfoUnset) ? this.model : model as String?,
    thinking: identical(thinking, _kRoomInfoUnset)
        ? this.thinking
        : thinking as ThinkingLevel?,
    working: working ?? this.working,
    goal: identical(goal, _kRoomInfoUnset) ? this.goal : goal as String?,
    loop: identical(loop, _kRoomInfoUnset) ? this.loop : loop as String?,
  );

  @override
  bool operator ==(Object other) =>
      other is RoomInfo &&
      other.roomId == roomId &&
      other.name == name &&
      other.cwd == cwd &&
      other.startedAt == startedAt &&
      other.model == model &&
      other.thinking == thinking &&
      other.working == working &&
      other.goal == goal &&
      other.loop == loop;
  @override
  int get hashCode => Object.hash(
        roomId,
        name,
        cwd,
        startedAt,
        model,
        thinking,
        working,
        goal,
        loop,
      );
}

class RoomAnnounced extends ControlInbound {
  final String peer;
  final String roomId;
  final String? name;
  final String? cwd;
  final int startedAt;

  /// Plan 18 — display model the omp-extension is running with.
  final String? model;

  /// Plan/28 Wave D — current thinking level the Pi seeds at
  /// session start. Parsed from `meta.thinking` or top-level
  /// `thinking` depending on whether the relay flattens metadata.
  final ThinkingLevel? thinking;

  /// Plan/32 — in-flight agent turn at announce time. `null` when the
  /// frame omitted it (legacy relay); the ConnectionManager then keeps
  /// any previously-known value instead of forcing `false`.
  final bool? working;
  final String? goal;
  final String? loop;
  const RoomAnnounced({
    required this.peer,
    required this.roomId,
    required this.startedAt,
    this.name,
    this.cwd,
    this.model,
    this.thinking,
    this.working,
    this.goal,
    this.loop,
  });
}

class RoomEnded extends ControlInbound {
  final String peer;
  final String roomId;
  final int sinceTs;
  const RoomEnded({
    required this.peer,
    required this.roomId,
    required this.sinceTs,
  });
}

class RoomsSnapshot extends ControlInbound {
  final String peer;
  final List<RoomInfo> rooms;
  const RoomsSnapshot({required this.peer, required this.rooms});
}

/// Plan 18 — incremental update to a room's metadata (model is the
/// only field for now, but the `meta` envelope is open-ended). The
/// relay pushes this when the omp-extension swaps its model
/// mid-session.
class RoomMetaUpdated extends ControlInbound {
  final String peer;
  final String roomId;
  final String? model;

  /// Plan/28 Wave D — current thinking level, parsed from
  /// `meta.thinking`. Null when the Pi only published a model change.
  /// The app treats both fields as independently optional so an update
  /// for only one of them doesn't clobber the other on the cache side.
  final ThinkingLevel? thinking;

  /// Plan/28 Wave D — `true` when the `meta` envelope carried a `model`
  /// key (even if value is null). Lets the ConnectionManager handler
  /// distinguish "model was not part of this update" from "model was
  /// explicitly cleared", which matters now that updates can be
  /// thinking-only.
  ///
  /// Defaults to `true` for ergonomic programmatic construction
  /// (callers / tests can pass `model: x` without also remembering
  /// the boolean). [RoomMetaUpdated.fromJson] passes the precise
  /// presence-of-key boolean instead.
  final bool hasModel;

  /// Plan/28 Wave D — same convention for `thinking`.
  final bool hasThinking;

  /// Plan/32 — in-flight agent turn for this room. `null` = the update
  /// did not carry `working` (preserve the cached value); non-null =
  /// set. No separate `hasWorking` flag is needed because `working` can
  /// never be "explicitly null" on the wire — `false` is the off state.
  final bool? working;
  final String? goal;
  final bool hasGoal;
  final String? loop;
  final bool hasLoop;
  const RoomMetaUpdated({
    required this.peer,
    required this.roomId,
    this.model,
    this.thinking,
    this.working,
    this.goal,
    this.loop,
    this.hasModel = true,
    this.hasThinking = true,
    this.hasGoal = false,
    this.hasLoop = false,
  });
}

// ---------------------------------------------------------------------------
// PresenceState — per-peer summary kept by ConnectionManager.
// ---------------------------------------------------------------------------

sealed class PresenceState {
  const PresenceState();
}

class PresenceUnknown extends PresenceState {
  const PresenceUnknown();
}

class PresenceOnline extends PresenceState {
  final int? sinceTs;
  const PresenceOnline({this.sinceTs});
}

class PresenceOffline extends PresenceState {
  final int? sinceTs;
  const PresenceOffline({this.sinceTs});
}

// --- Supporting types ---

class Usage {
  final int inputTokens;
  final int outputTokens;

  const Usage({required this.inputTokens, required this.outputTokens});

  factory Usage.fromJson(Map<String, dynamic> j) => Usage(
    inputTokens: j['input_tokens'] as int,
    outputTokens: j['output_tokens'] as int,
  );
}

enum ApproveDecision { allow, deny }

class UnsupportedTypeException implements Exception {
  final String type;
  const UnsupportedTypeException(this.type);

  @override
  String toString() => 'UnsupportedTypeException: unknown type "$type"';
}

// --- ClientMessage (app → extension) ---
// MVP: 1 pairing = 1 Pi session — no session management messages.

sealed class ClientMessage {
  Map<String, dynamic> toJson();
}

/// Plan/30 — one image carried inline on a `user_message` (base64 + mime).
/// Mirrors `WireImage` in `omp-extension/src/protocol/types.ts` and the SDK's
/// `ImageContent`. The relay forwards it opaquely inside the existing `ct`.
class WireImage {
  final String data; // base64, no data-URI prefix
  final String mime; // e.g. image/jpeg
  const WireImage({required this.data, required this.mime});

  factory WireImage.fromJson(Map<String, dynamic> j) =>
      WireImage(data: j['data'] as String, mime: j['mime'] as String);

  Map<String, dynamic> toJson() => {'data': data, 'mime': mime};

  @override
  bool operator ==(Object other) =>
      other is WireImage && other.data == data && other.mime == mime;

  @override
  int get hashCode => Object.hash(data, mime);
}

enum UserMessageStreamingBehavior {
  steer;

  /// Mirrors the Pi wire shape. Keep permissive parsing for forward-compat.
  static UserMessageStreamingBehavior? fromWire(String? raw) {
    return switch (raw) {
      'steer' => UserMessageStreamingBehavior.steer,
      _ => null,
    };
  }

  String get wireValue {
    return switch (this) {
      UserMessageStreamingBehavior.steer => 'steer',
    };
  }
}

class UserMessage extends ClientMessage {
  final String id;
  final String text;

  /// Optional steering behavior for this message. Omitted when null for
  /// compatibility with older Pi extensions.
  final UserMessageStreamingBehavior? streamingBehavior;

  /// Plan/30 — optional attached images. The feature sends at most one, but
  /// the wire shape is a list to mirror the SDK's `(TextContent|ImageContent)[]`
  /// and stay forward-compatible. Omitted entirely when empty (retro-compat).
  final List<WireImage>? images;

  UserMessage({
    required this.id,
    required this.text,
    this.streamingBehavior,
    this.images,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'user_message',
    'id': id,
    'text': text,
    if (streamingBehavior != null)
      'streaming_behavior': streamingBehavior!.wireValue,
    if (images != null && images!.isNotEmpty)
      'images': images!.map((i) => i.toJson()).toList(),
  };
}

class QueuedMessageSet extends ClientMessage {
  final String id;
  final String text;
  QueuedMessageSet({required this.id, required this.text});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'queued_message_set',
    'id': id,
    'text': text,
  };
}

class QueuedMessageClear extends ClientMessage {
  final String id;
  final String? targetId;
  QueuedMessageClear({required this.id, this.targetId});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'queued_message_clear',
    'id': id,
    if (targetId != null) 'target_id': targetId,
  };
}

class ApproveTool extends ClientMessage {
  final String id;
  final String toolCallId;
  final ApproveDecision decision;
  ApproveTool({
    required this.id,
    required this.toolCallId,
    required this.decision,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'approve_tool',
    'id': id,
    'tool_call_id': toolCallId,
    'decision': decision.name,
  };
}

class Cancel extends ClientMessage {
  final String id;
  final String targetId;
  Cancel({required this.id, required this.targetId});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'cancel',
    'id': id,
    'target_id': targetId,
  };
}

class Ping extends ClientMessage {
  final String id;
  Ping({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'ping', 'id': id};
}

class PairRequest extends ClientMessage {
  final String id;
  final String token;
  final String deviceName;
  PairRequest({
    required this.id,
    required this.token,
    required this.deviceName,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'pair_request',
    'id': id,
    'token': token,
    'device_name': deviceName,
  };
}

/// Sent on reconnect / re-entry to request the current view of Pi's
/// session. With the mirror-cache strategy (plan/16) the app no longer
/// negotiates incremental since_ts; it just asks for the latest N
/// events and replaces local state with whatever Pi returns.
class SessionSync extends ClientMessage {
  final String id;
  final int? limit;
  SessionSync({required this.id, this.limit});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'session_sync',
    'id': id,
    if (limit != null) 'limit': limit,
  };
}

// ---------------------------------------------------------------------------
// Plan/28 — Typed app actions
// ---------------------------------------------------------------------------

/// Request-id prefix of every typed action the app sends (`act_<uuid7>`).
/// Replies to these ids, including `error` frames, belong to the actions
/// layer, not the chat.
const kActionRequestIdPrefix = 'act_';

/// Plan/28 — Curated catalogue of actions the app can dispatch on the
/// Pi-side session. Each value matches an `action_ok`/`action_error`
/// reply emitted by the omp-extension handlers in
/// `omp-extension/src/actions/handlers.ts`.
enum ActionName {
  sessionNew('session_new'),
  sessionCompact('session_compact'),
  modelSet('model_set'),
  thinkingSet('thinking_set'),
  reloadPlugins('reload_plugins'),
  planMode('plan_mode'),
  // Plan 66 — omp model role change; replies with action_ok / action_error.
  modelRoleSet('model_role_set'),
  // Plan 68 — re-runs the failed turn; replies with action_ok or an `error`.
  retryTurn('retry_turn');
  final String wire;
  const ActionName(this.wire);

  static ActionName? fromWire(String s) {
    for (final a in values) {
      if (a.wire == s) return a;
    }
    return null;
  }
}

/// Plan/28 — Mirror of the SDK's `ThinkingLevel`. Six fixed values; the
/// wire format is the lower-case string. `xhigh` is honored only by
/// select models — the app surfaces every level and the SDK falls back
/// when the active model doesn't support the requested one.
enum ThinkingLevel {
  auto('auto'),
  off('off'),
  minimal('minimal'),
  low('low'),
  medium('medium'),
  high('high'),
  xhigh('xhigh'),
  max('max');
  final String wire;
  const ThinkingLevel(this.wire);

  static ThinkingLevel? fromWire(String s) {
    for (final l in values) {
      if (l.wire == s) return l;
    }
    return null;
  }
}

/// Plan/28 — Wire shape for one entry in the model picker. Subset of
/// the SDK's `Model` interface; matches the `WireModel` declared in
/// `omp-extension/src/protocol/types.ts`.
class WireModel {
  /// Stable id inside the provider's catalog (e.g. `claude-opus-4-7`).
  final String id;

  /// Display name shown in the picker (e.g. `Claude Opus 4.7`).
  final String name;

  /// Provider slug (e.g. `anthropic`, `openai`).
  final String provider;

  /// Whether this model exposes the thinking surface. Drives the
  /// thinking segmented control's enabled state on the picker side.
  final bool reasoning;

  /// Context window in tokens — surfaced as picker subtitle.
  final int contextWindow;

  /// Plan/30 — whether the model accepts image input (multimodal). Derived
  /// pi-side from `model.input.includes("image")`. Drives the attach
  /// button's enabled state (#9): a text-only model greys it out.
  final bool vision;

  /// Thinking levels this model supports (from the Pi's
  /// `Model.thinkingLevelMap`; `null` marks a level unsupported and the
  /// level is omitted). `null` when the daemon's catalog predates
  /// per-model maps — the picker then shows every level.
  final List<ThinkingLevel>? thinkingLevels;

  const WireModel({
    required this.id,
    required this.name,
    required this.provider,
    required this.reasoning,
    required this.contextWindow,
    this.vision = false,
    this.thinkingLevels,
  });

  factory WireModel.fromJson(Map<String, dynamic> j) => WireModel(
    id: j['id'] as String,
    name: j['name'] as String,
    provider: j['provider'] as String,
    reasoning: (j['reasoning'] as bool?) ?? false,
    contextWindow: (j['context_window'] as num?)?.toInt() ?? 0,
    vision: (j['vision'] as bool?) ?? false,
    thinkingLevels: (j['thinking_levels'] as List<dynamic>?)
        ?.map((e) => ThinkingLevel.fromWire(e as String))
        .whereType<ThinkingLevel>()
        .toList(),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'provider': provider,
    'reasoning': reasoning,
    'context_window': contextWindow,
    'vision': vision,
    if (thinkingLevels != null)
      'thinking_levels': thinkingLevels!.map((l) => l.wire).toList(),
  };

  @override
  bool operator ==(Object other) =>
      other is WireModel &&
      other.id == id &&
      other.provider == provider &&
      other.name == name &&
      other.reasoning == reasoning &&
      other.contextWindow == contextWindow &&
      other.vision == vision;

  @override
  int get hashCode =>
      Object.hash(id, provider, name, reasoning, contextWindow, vision);
}

class SessionCompact extends ClientMessage {
  final String id;
  SessionCompact({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'session_compact', 'id': id};
}

class SessionNew extends ClientMessage {
  final String id;
  SessionNew({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'session_new', 'id': id};
}

class ModelSet extends ClientMessage {
  final String id;
  final String provider;
  final String modelId;
  ModelSet({required this.id, required this.provider, required this.modelId});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'model_set',
    'id': id,
    'provider': provider,
    'model_id': modelId,
  };
}

class ThinkingSet extends ClientMessage {
  final String id;
  final ThinkingLevel level;
  ThinkingSet({required this.id, required this.level});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'thinking_set',
    'id': id,
    'level': level.wire,
  };
}

class ListModels extends ClientMessage {
  final String id;
  ListModels({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'list_models', 'id': id};
}

/// Plan 66 — one omp model role (`modelRoles` in omp's config.yml), as
/// reported in a `model_roles` frame. [model] reuses [WireModel] so the
/// picker can reuse its model rows and per-model thinking levels.
class WireModelRole {
  /// Role id (`default`, `plan`, `task`, `smol`, ...).
  final String role;

  /// Display name from omp's role info.
  final String name;
  final String description;

  /// Model the role resolves to; `null` when unset or unresolvable.
  final WireModel? model;

  /// Thinking level carried by the role (`provider/model:thinking`).
  final ThinkingLevel? thinking;

  /// Where the role comes from: `global`, `project` or `default`.
  final String source;

  /// Models eligible for this role, as `{provider, model_id}` refs. Only on
  /// the reply to a role-scoped `list_model_roles {role}`, and left out when
  /// the pool equals the full `models_list`. `null` = show every model.
  final List<WireModelRef>? candidates;

  const WireModelRole({
    required this.role,
    required this.name,
    required this.description,
    required this.source,
    this.model,
    this.thinking,
    this.candidates,
  });

  factory WireModelRole.fromJson(Map<String, dynamic> j) {
    final model = j['model'];
    final thinking = j['thinking'];
    return WireModelRole(
      role: j['role'] as String,
      name: (j['name'] as String?) ?? (j['role'] as String),
      description: (j['description'] as String?) ?? '',
      source: (j['source'] as String?) ?? 'default',
      model: model is Map<String, dynamic> ? WireModel.fromJson(model) : null,
      thinking: thinking is String ? ThinkingLevel.fromWire(thinking) : null,
      candidates: (j['candidates'] as List<dynamic>?)
          ?.map((e) => WireModelRef.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Map<String, dynamic> toJson() => {
    'role': role,
    'name': name,
    'description': description,
    if (model != null) 'model': model!.toJson(),
    if (thinking != null) 'thinking': thinking!.wire,
    'source': source,
    if (candidates != null)
      'candidates': candidates!.map((m) => m.toJson()).toList(),
  };

  @override
  bool operator ==(Object other) =>
      other is WireModelRole &&
      other.role == role &&
      other.name == name &&
      other.description == description &&
      other.model == model &&
      other.thinking == thinking &&
      other.source == source &&
      (other.candidates == null
          ? candidates == null
          : candidates != null &&
                _listEquals(other.candidates!, candidates!));

  @override
  int get hashCode => Object.hash(
    role,
    name,
    description,
    model,
    thinking,
    source,
    candidates == null ? null : Object.hashAll(candidates!),
  );
}

/// Plan 66 — a `{provider, model_id}` pair naming one model in a role's
/// candidate pool. Matched against the `models_list` catalogue.
class WireModelRef {
  final String provider;
  final String modelId;
  const WireModelRef({required this.provider, required this.modelId});

  factory WireModelRef.fromJson(Map<String, dynamic> j) => WireModelRef(
    provider: j['provider'] as String,
    modelId: j['model_id'] as String,
  );

  Map<String, dynamic> toJson() => {'provider': provider, 'model_id': modelId};

  bool matches(WireModel m) => m.provider == provider && m.id == modelId;

  @override
  bool operator ==(Object other) =>
      other is WireModelRef &&
      other.provider == provider &&
      other.modelId == modelId;

  @override
  int get hashCode => Object.hash(provider, modelId);
}

/// Plan 66 — asks the extension for omp's model roles. Replied with a
/// `model_roles` frame carrying `in_reply_to`. With [role], the reply holds
/// only that role plus its `candidates`.
class ListModelRoles extends ClientMessage {
  final String id;
  final String? role;
  ListModelRoles({required this.id, this.role});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'list_model_roles',
    'id': id,
    if (role != null) 'role': role,
  };
}

/// Plan 66 — sets (or clears) one omp model role. Omitting [provider] and
/// [modelId] clears the role back to its default. Replies with `action_ok`
/// / `action_error`; on success the extension broadcasts `model_roles`.
class ModelRoleSet extends ClientMessage {
  final String id;
  final String role;
  final String? provider;
  final String? modelId;
  final ThinkingLevel? thinking;
  ModelRoleSet({
    required this.id,
    required this.role,
    this.provider,
    this.modelId,
    this.thinking,
  }) : assert(
         (provider == null) == (modelId == null),
         'provider and modelId go together',
       );

  @override
  Map<String, dynamic> toJson() => {
    'type': 'model_role_set',
    'id': id,
    'role': role,
    if (provider != null) 'provider': provider,
    if (modelId != null) 'model_id': modelId,
    if (thinking != null) 'thinking': thinking!.wire,
  };
}

class ReloadPlugins extends ClientMessage {
  final String id;
  ReloadPlugins({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'reload_plugins', 'id': id};
}

/// Asks the extension for changed files and branch in the active session's repo.
class GitStatusRequest extends ClientMessage {
  final String id;
  GitStatusRequest({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'git_status', 'id': id};
}

/// Plan 68 — re-runs the turn that just failed (omp's `/retry`) without a
/// second user message. Answered with `action_ok`, or an `error` whose code
/// is `nothing_to_retry` / `busy` / `unsupported`.
class RetryTurnRequest extends ClientMessage {
  final String id;
  RetryTurnRequest({required this.id});

  @override
  Map<String, dynamic> toJson() => {'type': 'retry_turn', 'id': id};
}

/// Asks the extension for the unified diff of one repo-relative [path].
class GitDiffRequest extends ClientMessage {
  final String id;
  final String path;
  final bool staged;
  GitDiffRequest({required this.id, required this.path, this.staged = false});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'git_diff',
    'id': id,
    'path': path,
    if (staged) 'staged': true,
  };
}

/// Asks the extension for files under the session cwd matching [query]
/// (composer `@` autocomplete).
class ListFilesRequest extends ClientMessage {
  final String id;
  final String query;
  final int? limit;
  ListFilesRequest({required this.id, required this.query, this.limit});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'list_files',
    'id': id,
    'query': query,
    if (limit != null) 'limit': limit,
  };
}

/// Plan 68 — asks the extension for the subfolders of [path] on the PC (null =
/// the PC's home) and for the folders recently used for sessions.
class ListDirsRequest extends ClientMessage {
  final String id;
  final String? path;
  ListDirsRequest({required this.id, this.path});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'list_dirs',
    'id': id,
    if (path != null) 'path': path,
  };
}

/// Plan 68 — starts an omp session in [cwd] on the PC. [persistent] registers
/// an always-on daemon there instead of a session that ends when its process
/// does. An empty or null [name] leaves the choice to the PC (the folder name).
class SpawnSessionRequest extends ClientMessage {
  final String id;
  final String cwd;
  final String? name;
  final bool persistent;
  SpawnSessionRequest({
    required this.id,
    required this.cwd,
    this.name,
    this.persistent = false,
  });

  @override
  Map<String, dynamic> toJson() => {
    'type': 'spawn_session',
    'id': id,
    'cwd': cwd,
    if (name != null && name!.isNotEmpty) 'name': name,
    if (persistent) 'persistent': true,
  };
}

/// omp plan mode command (typed action like `session_compact`): `enter` =
/// `/plan`, `exit` = leave plan mode (the client confirms with the user first
/// when a plan exists), `review` = `/plan-review` (re-opens the review).
enum PlanModeAction {
  enter('enter'),
  exit('exit'),
  review('review');

  final String wire;
  const PlanModeAction(this.wire);
}

class PlanMode extends ClientMessage {
  final String id;
  final PlanModeAction action;
  PlanMode({required this.id, required this.action});

  @override
  Map<String, dynamic> toJson() => {
    'type': 'plan_mode',
    'id': id,
    'action': action.wire,
  };
}

// --- ServerMessage (extension → app) ---
// 1 pairing = 1 session: no session_id on any message.
// Sealed: all subtypes in this file — switch exhaustiveness enforced by compiler.

sealed class ServerMessage {
  const ServerMessage();

  factory ServerMessage.fromJson(Map<String, dynamic> json) {
    final type = json['type'] as String?;
    return switch (type) {
      'agent_chunk' => AgentChunk.fromJson(json),
      'agent_done' => AgentDone.fromJson(json),
      'tool_request' => ToolRequest.fromJson(json),
      'tool_result' => ToolResult.fromJson(json),
      'error' => ErrorMessage.fromJson(json),
      'cancelled' => Cancelled.fromJson(json),
      'pong' => Pong.fromJson(json),
      'pair_ok' => PairOk.fromJson(json),
      'pair_error' => PairError.fromJson(json),
      // Plan/24-fix-app-source-of-truth + follow-up: Pi rebroadcasts
      // every accepted user_message via this stream. Some omp-extension
      // versions emit `type: "user_input"` (mirror of a terminal-side
      // input), others reuse the original `user_message` type when
      // echoing back. Treat both as the same payload — `UserInput`
      // here is the "user-text-arrived" event regardless of origin.
      'user_input' || 'user_message' => UserInput.fromJson(json),
      'queued_message_state' => QueuedMessageState.fromJson(json),
      'steer_consumed' => SteerConsumed.fromJson(json),
      'agent_message' => AgentMessage.fromJson(json),
      // Plan/32 — omp-extension emits this when a context compaction finishes.
      'compaction' => Compaction.fromJson(json),
      'session_history' => SessionHistory.fromJson(json),
      'bye' => Bye.fromJson(json),
      'action_ok' => ActionOk.fromJson(json),
      'action_error' => ActionError.fromJson(json),
      'models_list' => ModelsList.fromJson(json),
      // Plan 66 — omp model roles: reply to list_model_roles (in_reply_to
      // set) or a broadcast after any role change (no in_reply_to).
      'model_roles' => ModelRoles.fromJson(json),
      // Plan/57 — interactive extension prompt (ask_user via pi-ask). Mirrors
      // the SDK's extension_ui_request RPC contract; optional `ask` envelope
      // carries pi-ask's full question so the app renders multi/preview/notes.
      'extension_ui_request' => ExtensionUiRequest.fromJson(json),
      'skills_list' => SkillsList.fromJson(json),
      // Running subagents + background jobs (omp's bottom activity panel).
      // Full snapshot: replace local state wholesale, never merge.
      'agent_activity' => AgentActivity.fromJson(json),
      // omp plan mode state (idle/active/paused/review), broadcast on change
      // and after every session_sync reply. The only plan state source: the
      // relay drops room_meta `plan`.
      'plan_state' => PlanState.fromJson(json),
      // omp's todo list (the TUI's TODO panel), full snapshot of the main
      // session's list on attach, after every session_sync reply and on
      // change. `phases: []` hides the panel.
      'todo_state' => TodoState.fromJson(json),
      // Plan 65 — files sent to the phone (chunked over the peer channel).
      'file_offer' => FileOffer.fromJson(json),
      'file_chunk' => FileChunk.fromJson(json),
      'file_end' => FileEnd.fromJson(json),
      'file_cancel' => FileCancel.fromJson(json),
      // Plan 68 — replies to a file uploaded from the phone.
      'upload_ack' => UploadAck.fromJson(json),
      'upload_done' => UploadDone.fromJson(json),
      'upload_error' => UploadError.fromJson(json),
      // Mobile Git Diff viewer.
      'git_status_result' => GitStatusResult.fromJson(json),
      'git_diff_result' => GitDiffResult.fromJson(json),
      // Composer `@` file autocomplete.
      'files_list' => FilesListResult.fromJson(json),
      // Plan 68 — new session from the phone.
      'dirs_list' => DirsListResult.fromJson(json),
      'spawn_result' => SpawnResult.fromJson(json),
      // forward-compat: unknown types are not fatal — callers catch and log
      _ => throw UnsupportedTypeException(type ?? ''),
    };
  }
}

class AgentChunk extends ServerMessage {
  final String inReplyTo;
  final String delta;
  AgentChunk({required this.inReplyTo, required this.delta});

  factory AgentChunk.fromJson(Map<String, dynamic> j) => AgentChunk(
    inReplyTo: j['in_reply_to'] as String,
    delta: j['delta'] as String,
  );
}

class AgentDone extends ServerMessage {
  final String inReplyTo;
  final Usage? usage;
  AgentDone({required this.inReplyTo, this.usage});

  factory AgentDone.fromJson(Map<String, dynamic> j) => AgentDone(
    inReplyTo: j['in_reply_to'] as String,
    usage: j['usage'] != null
        ? Usage.fromJson(j['usage'] as Map<String, dynamic>)
        : null,
  );
}

class ToolRequest extends ServerMessage {
  final String toolCallId;
  final String tool;
  final dynamic args;
  ToolRequest({
    required this.toolCallId,
    required this.tool,
    required this.args,
  });

  factory ToolRequest.fromJson(Map<String, dynamic> j) => ToolRequest(
    toolCallId: j['tool_call_id'] as String,
    tool: j['tool'] as String,
    args: j['args'],
  );
}

class ToolResult extends ServerMessage {
  final String toolCallId;
  final dynamic result;
  final String? error;
  ToolResult({required this.toolCallId, this.result, this.error});

  factory ToolResult.fromJson(Map<String, dynamic> j) => ToolResult(
    toolCallId: j['tool_call_id'] as String,
    result: j['result'],
    error: j['error'] as String?,
  );
}

class ErrorMessage extends ServerMessage {
  final String? inReplyTo;
  final String code;
  final String message;
  ErrorMessage({this.inReplyTo, required this.code, required this.message});

  factory ErrorMessage.fromJson(Map<String, dynamic> j) => ErrorMessage(
    inReplyTo: j['in_reply_to'] as String?,
    code: j['code'] as String,
    message: j['message'] as String,
  );
}

class Cancelled extends ServerMessage {
  final String inReplyTo;
  final String targetId;
  Cancelled({required this.inReplyTo, required this.targetId});

  factory Cancelled.fromJson(Map<String, dynamic> j) => Cancelled(
    inReplyTo: j['in_reply_to'] as String,
    targetId: j['target_id'] as String,
  );
}

class Pong extends ServerMessage {
  final String inReplyTo;
  Pong({required this.inReplyTo});

  factory Pong.fromJson(Map<String, dynamic> j) =>
      Pong(inReplyTo: j['in_reply_to'] as String);
}

/// Plan/27 Wave A — identifies the agent harness the paired PC is
/// running. Surfaced as a subtitle on the PC card ("via omp coding
/// agent"). The omp-extension is expected to publish this in `pair_ok`
/// (contract for the next omp-extension dispatch); the app falls back
/// to a sensible default when the field is absent so legacy PCs keep
/// working.
class PiHarness {
  final String name;
  final String version;
  const PiHarness({required this.name, required this.version});

  /// Default used when `pair_ok` omits `harness` (current
  /// omp-extension behaviour) and when migrating legacy PeerRecords.
  static const PiHarness piCodingAgentUnknown = PiHarness(
    name: 'omp coding agent',
    version: '—',
  );

  Map<String, dynamic> toJson() => {'name': name, 'version': version};

  static PiHarness fromJson(Map<String, dynamic> j) => PiHarness(
    name: (j['name'] as String?) ?? piCodingAgentUnknown.name,
    version: (j['version'] as String?) ?? piCodingAgentUnknown.version,
  );

  @override
  bool operator ==(Object other) =>
      other is PiHarness && other.name == name && other.version == version;

  @override
  int get hashCode => Object.hash(name, version);
}

class PairOk extends ServerMessage {
  final String inReplyTo;
  final String sessionName;

  /// Epoch-ms timestamp when the Pi started this session. The app caches
  /// it locally so a future `session_sync` can detect a Pi restart (value
  /// changed) and replace the cache instead of appending stale events.
  final int sessionStartedAt;

  /// Plan 17 fix — Pi-side room id (cwd-session) that confirmed this
  /// pair. The app persists this on the PeerRecord so subsequent
  /// reconnects can address the right (peer, room) directly without
  /// having to wait for subscribe_rooms / discovery. Legacy Pis that
  /// don't emit `room_id` fall back to `'main'`.
  final String roomId;

  /// Plan/27 Wave A — agent harness identification. `null` when the
  /// omp-extension hasn't been upgraded to publish it; consumers fall
  /// back to [PiHarness.piCodingAgentUnknown] so the UI never renders
  /// an empty subtitle.
  final PiHarness? harness;

  /// Plan/27 Wave A — hostname hint for the post-pair nickname modal.
  /// The omp-extension reports its OS hostname so the modal can
  /// pre-fill a sensible placeholder ("Mac do Jacob") instead of a
  /// generic "PC". `null` on legacy extensions.
  final String? hostname;
  PairOk({
    required this.inReplyTo,
    required this.sessionName,
    required this.sessionStartedAt,
    required this.roomId,
    this.harness,
    this.hostname,
  });

  factory PairOk.fromJson(Map<String, dynamic> j) {
    final harnessJson = j['harness'];
    final hostname = j['hostname'];
    final startedAt = j['session_started_at'];
    return PairOk(
      inReplyTo: j['in_reply_to'] as String,
      sessionName: j['session_name'] as String,
      // Legacy Pis (pre-session_sync) don't emit session_started_at.
      // The downstream caller treats `0` as "unknown" and skips the
      // restart-detection branch.
      sessionStartedAt: startedAt is num ? startedAt.toInt() : 0,
      // Backward-compat: pre-fix Pis don't emit room_id → use 'main'.
      // Callers that need to distinguish "Pi said main" from "Pi
      // omitted room" should peek at the raw JSON instead.
      roomId: (j['room_id'] as String?) ?? 'main',
      harness: harnessJson is Map<String, dynamic>
          ? PiHarness.fromJson(harnessJson)
          : null,
      hostname: hostname is String && hostname.isNotEmpty ? hostname : null,
    );
  }
}

/// Mirror of user input typed directly in the Pi's terminal (or injected via
/// RPC). The Pi emits this so the app can show what was sent even though it
/// did not originate from the app's own [UserMessage] flow.
/// Parse an optional `images` array (the Pi echoes back whatever the app
/// sent on `user_message`). Returns the first image — the feature is one
/// image per message — or null when absent/empty.
WireImage? _firstImage(dynamic raw) {
  if (raw is! List || raw.isEmpty) return null;
  final first = raw.first;
  if (first is! Map) return null;
  return WireImage.fromJson(first.cast<String, dynamic>());
}

class QueuedMessageItem {
  final String id;
  final String text;
  final bool editable;
  final DateTime createdAt;

  const QueuedMessageItem({
    required this.id,
    required this.text,
    required this.editable,
    required this.createdAt,
  });

  factory QueuedMessageItem.fromJson(Map<String, dynamic> j) =>
      QueuedMessageItem(
        id: j['id'] as String,
        text: (j['text'] as String?) ?? '',
        editable: (j['editable'] as bool?) ?? true,
        createdAt: DateTime.fromMillisecondsSinceEpoch(
          (j['created_at'] as num?)?.toInt() ?? 0,
        ),
      );
}

class QueuedMessageState extends ServerMessage {
  final List<QueuedMessageItem> items;
  QueuedMessageState({this.items = const []});

  String? get id => items.isEmpty ? null : items.first.id;
  String? get text => items.isEmpty ? null : items.first.text;

  factory QueuedMessageState.fromJson(Map<String, dynamic> j) {
    final rawItems = j['items'];
    if (rawItems is List) {
      return QueuedMessageState(
        items: rawItems
            .whereType<Map>()
            .map((m) => QueuedMessageItem.fromJson(m.cast<String, dynamic>()))
            .where((item) => item.text.isNotEmpty)
            .toList(growable: false),
      );
    }
    final id = j['id'] as String?;
    final text = j['text'] as String?;
    if (id == null || text == null || text.isEmpty) {
      return QueuedMessageState();
    }
    return QueuedMessageState(
      items: [
        QueuedMessageItem(
          id: id,
          text: text,
          editable: true,
          createdAt: DateTime.fromMillisecondsSinceEpoch(0),
        ),
      ],
    );
  }
}

class SteerConsumed extends ServerMessage {
  final String id;
  SteerConsumed({required this.id});

  factory SteerConsumed.fromJson(Map<String, dynamic> j) =>
      SteerConsumed(id: j['id'] as String);
}

class UserInput extends ServerMessage {
  final String id;
  final String text;

  /// Present when the message was sent with `streaming_behavior` (currently used
  /// for steering).
  final UserMessageStreamingBehavior? streamingBehavior;

  /// Plan/30 — echoed-back attached image (the Pi rebroadcasts `images`).
  final WireImage? image;

  UserInput({
    required this.id,
    required this.text,
    this.streamingBehavior,
    this.image,
  });

  factory UserInput.fromJson(Map<String, dynamic> j) => UserInput(
    id: j['id'] as String,
    text: j['text'] as String,
    streamingBehavior: UserMessageStreamingBehavior.fromWire(
      j['streaming_behavior'] as String?,
    ),
    image: _firstImage(j['images']),
  );
}

/// Consolidated assistant reply, used only inside `session_history` events
/// (history dumps); real-time replies still flow as `agent_chunk` +
/// `agent_done`. May also arrive standalone for backfill — treated as a
/// final assistant message for the given `inReplyTo`.
class AgentMessage extends ServerMessage {
  final String inReplyTo;
  final String text;
  final Usage? usage;
  AgentMessage({required this.inReplyTo, required this.text, this.usage});

  factory AgentMessage.fromJson(Map<String, dynamic> j) => AgentMessage(
    inReplyTo: j['in_reply_to'] as String,
    text: j['text'] as String,
    usage: j['usage'] != null
        ? Usage.fromJson(j['usage'] as Map<String, dynamic>)
        : null,
  );
}

/// Plan/32 — emitted by the omp-extension when a context compaction finishes.
/// Rendered as a system bubble in the chat (✓ Contexto compactado + summary +
/// the token count that was reclaimed). `ts` is optional (epoch millis).
class Compaction extends ServerMessage {
  final String summary;
  final int? tokensBefore;
  final int? ts;
  Compaction({required this.summary, this.tokensBefore, this.ts});

  factory Compaction.fromJson(Map<String, dynamic> j) => Compaction(
    summary: (j['summary'] as String?) ?? '',
    tokensBefore: (j['tokens_before'] as num?)?.toInt(),
    ts: (j['ts'] as num?)?.toInt(),
  );
}

// ---------------------------------------------------------------------------
// SessionHistory + embedded event types
// ---------------------------------------------------------------------------

/// Reply to a `session_sync`. May arrive in batches; the final batch
/// sets `eos: true`. `truncated: true` indicates Pi had more events
/// than the requested `limit` and dropped the oldest — surfaced to
/// logs only (no UI affordance per plan/16 D1=B).
class SessionHistory extends ServerMessage {
  final String inReplyTo;
  final int sessionStartedAt;
  final List<SessionHistoryEvent> events;
  final bool eos;
  final bool truncated;

  /// The session's most recent prompts, oldest first, beyond the `events`
  /// window. Null from a Pi that predates the field.
  final List<String>? prompts;
  SessionHistory({
    required this.inReplyTo,
    required this.sessionStartedAt,
    required this.events,
    required this.eos,
    this.truncated = false,
    this.prompts,
  });

  factory SessionHistory.fromJson(Map<String, dynamic> j) => SessionHistory(
    inReplyTo: j['in_reply_to'] as String,
    sessionStartedAt: (j['session_started_at'] as num).toInt(),
    events: (j['events'] as List<dynamic>)
        .map((e) => SessionHistoryEvent.fromJson(e as Map<String, dynamic>))
        .toList(),
    eos: j['eos'] as bool,
    // Tolerate absence during the protocol transition window.
    truncated: (j['truncated'] as bool?) ?? false,
    prompts: (j['prompts'] as List<dynamic>?)?.cast<String>(),
  );
}

sealed class SessionHistoryEvent {
  final int ts;
  const SessionHistoryEvent({required this.ts});

  factory SessionHistoryEvent.fromJson(Map<String, dynamic> j) {
    final ts = (j['ts'] as num).toInt();
    return switch (j['type'] as String?) {
      'user_input' => UserInputEvt(
        ts: ts,
        id: j['id'] as String,
        text: j['text'] as String,
        image: _firstImage(j['images']),
      ),
      'tool_request' => ToolRequestEvt(
        ts: ts,
        toolCallId: j['tool_call_id'] as String,
        tool: j['tool'] as String,
        args: j['args'],
      ),
      'tool_result' => ToolResultEvt(
        ts: ts,
        toolCallId: j['tool_call_id'] as String,
        result: j['result'],
        error: j['error'] as String?,
      ),
      'agent_message' => AgentMessageEvt(
        ts: ts,
        inReplyTo: j['in_reply_to'] as String,
        text: j['text'] as String,
        errorCode: j['error_code'] as String?,
      ),
      // Plan/32 — compaction replayed from history so the system bubble
      // survives a re-sync.
      'compaction' => CompactionEvt(
        ts: ts,
        summary: (j['summary'] as String?) ?? '',
        tokensBefore: (j['tokens_before'] as num?)?.toInt(),
      ),
      final t => throw UnsupportedTypeException(t ?? ''),
    };
  }
}

class UserInputEvt extends SessionHistoryEvent {
  final String id;
  final String text;

  /// Plan/30 — image replayed from history (decision #8 — bytes always
  /// travel, so the bubble reconstructs on cold start / reconnect).
  final WireImage? image;

  const UserInputEvt({
    required super.ts,
    required this.id,
    required this.text,
    this.image,
  });
}

class ToolRequestEvt extends SessionHistoryEvent {
  final String toolCallId;
  final String tool;
  final dynamic args;
  const ToolRequestEvt({
    required super.ts,
    required this.toolCallId,
    required this.tool,
    required this.args,
  });
}

class ToolResultEvt extends SessionHistoryEvent {
  final String toolCallId;
  final dynamic result;
  final String? error;
  const ToolResultEvt({
    required super.ts,
    required this.toolCallId,
    this.result,
    this.error,
  });
}

class AgentMessageEvt extends SessionHistoryEvent {
  final String inReplyTo;
  final String text;
  /// Plan 68 — set on a replayed failed turn (`provider_error`), so the chat
  /// can offer Retry under it. Null on an ordinary answer and from older Pis.
  final String? errorCode;
  const AgentMessageEvt({
    required super.ts,
    required this.inReplyTo,
    required this.text,
    this.errorCode,
  });
}

/// Plan/32 — a context compaction replayed from `session_history`.
class CompactionEvt extends SessionHistoryEvent {
  final String summary;
  final int? tokensBefore;
  const CompactionEvt({
    required super.ts,
    required this.summary,
    this.tokensBefore,
  });
}

class PairError extends ServerMessage {
  final String inReplyTo;
  final String code;
  final String message;
  PairError({
    required this.inReplyTo,
    required this.code,
    required this.message,
  });

  factory PairError.fromJson(Map<String, dynamic> j) => PairError(
    inReplyTo: j['in_reply_to'] as String,
    code: j['code'] as String,
    message: j['message'] as String,
  );
}

/// Graceful disconnect notice sent by the Pi right before it closes the
/// channel (e.g. `/remote-omp stop`, session replaced, shutdown). The app
/// treats this as a terminal "PC went offline" signal, stops the retry
/// loop, and surfaces a banner. Reconnect is manual.
enum ByeReason { peerStop, sessionReplaced, shutdown, unknown }

// ---------------------------------------------------------------------------
// Plan/28 — Replies for typed app actions.
//
// `action_ok` / `action_error` use the original `ActionName` so the app
// can demultiplex by intended action (no need to remember every
// in-flight request id). `models_list` is the reply to `list_models`
// and optionally echoes the model the Pi is using right now so the
// picker highlights the right row immediately.
// ---------------------------------------------------------------------------

class ActionOk extends ServerMessage {
  final String inReplyTo;
  final ActionName action;

  /// Raw wire string for `action` kept verbatim so a future Pi adds
  /// a new action without us silently dropping the ack.
  final String rawAction;
  ActionOk({
    required this.inReplyTo,
    required this.action,
    required this.rawAction,
  });

  factory ActionOk.fromJson(Map<String, dynamic> j) {
    final raw = (j['action'] as String?) ?? '';
    final parsed = ActionName.fromWire(raw);
    return ActionOk(
      inReplyTo: j['in_reply_to'] as String,
      action: parsed ?? ActionName.sessionCompact,
      rawAction: raw,
    );
  }
}

class ActionError extends ServerMessage {
  final String inReplyTo;
  final ActionName action;
  final String rawAction;
  final String error;
  ActionError({
    required this.inReplyTo,
    required this.action,
    required this.rawAction,
    required this.error,
  });

  factory ActionError.fromJson(Map<String, dynamic> j) {
    final raw = (j['action'] as String?) ?? '';
    final parsed = ActionName.fromWire(raw);
    return ActionError(
      inReplyTo: j['in_reply_to'] as String,
      action: parsed ?? ActionName.sessionCompact,
      rawAction: raw,
      error: (j['error'] as String?) ?? '',
    );
  }
}

class ModelsList extends ServerMessage {
  final String inReplyTo;
  final List<WireModel> models;

  /// Echoes the model the Pi is using right now (if it can be
  /// resolved). `null` is honest absence — the UI should fall back to
  /// the cached `model_select` event from the rooms layer.
  final WireModel? current;
  ModelsList({required this.inReplyTo, required this.models, this.current});

  factory ModelsList.fromJson(Map<String, dynamic> j) {
    final list = (j['models'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => WireModel.fromJson(e as Map<String, dynamic>))
        .toList();
    final cur = j['current'];
    return ModelsList(
      inReplyTo: j['in_reply_to'] as String,
      models: list,
      current: cur is Map<String, dynamic> ? WireModel.fromJson(cur) : null,
    );
  }
}

/// Plan 66 — omp's model roles. [inReplyTo] is set on the reply to a
/// `list_model_roles`; `null` marks a broadcast after a role change.
class ModelRoles extends ServerMessage {
  final String? inReplyTo;
  final List<WireModelRole> roles;
  ModelRoles({this.inReplyTo, required this.roles});

  factory ModelRoles.fromJson(Map<String, dynamic> j) => ModelRoles(
    inReplyTo: j['in_reply_to'] as String?,
    roles: (j['roles'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => WireModelRole.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

class Bye extends ServerMessage {
  final ByeReason reason;

  /// Raw wire value (kept for logging/debugging if the enum mapping turns
  /// it into [ByeReason.unknown]).
  final String rawReason;
  Bye({required this.reason, required this.rawReason});

  factory Bye.fromJson(Map<String, dynamic> j) {
    final raw = (j['reason'] as String?) ?? '';
    return Bye(reason: _parseReason(raw), rawReason: raw);
  }

  static ByeReason _parseReason(String s) => switch (s) {
    'peer_stop' => ByeReason.peerStop,
    'session_replaced' => ByeReason.sessionReplaced,
    'shutdown' => ByeReason.shutdown,
    _ => ByeReason.unknown,
  };
}

// ---------------------------------------------------------------------------
// Plan/57 — extension_ui_request bridge (mirror SDK RPC contract)
//
// Interactive extension prompts (ask_user today, via @eko24ive/pi-ask) are
// rendered natively instead of stranding the mobile user. The wire mirrors the
// SDK's `pi --mode rpc` extension_ui_request / extension_ui_response contract
// (RpcExtensionUIRequest/Response), so the app and the Cockpit share one
// interactive-UI vocabulary. pi-ask's richer schema (multi/preview/notes) rides
// in an optional `ask` envelope; strict handling ignores it. Inert when pi-ask
// is absent (the tool doesn't exist → no frames ever arrive).
// ---------------------------------------------------------------------------

/// `select` | `confirm` | `input` | `editor` | `notify` (SDK methods). `notify`
/// is fire-and-forget; the rest expect an `extension_ui_response`.
enum ExtensionUiMethod {
  select('select'),
  confirm('confirm'),
  input('input'),
  editor('editor'),
  notify('notify');

  final String wire;
  const ExtensionUiMethod(this.wire);

  static ExtensionUiMethod? fromWire(String? s) {
    for (final m in values) {
      if (m.wire == s) return m;
    }
    return null;
  }
}

/// pi-ask AskQuestionType — `single` (one answer) | `multi` (several) |
/// `preview` (options carry a preview pane).
enum AskQuestionWireType {
  single('single'),
  multi('multi'),
  preview('preview');

  final String wire;
  const AskQuestionWireType(this.wire);

  static AskQuestionWireType? fromWire(String? s) {
    for (final t in values) {
      if (t.wire == s) return t;
    }
    return null;
  }
}

class AskOptionWire {
  final String value;
  final String label;
  final String? description;
  final String? preview;
  final bool freeform;

  const AskOptionWire({
    required this.value,
    required this.label,
    this.description,
    this.preview,
    this.freeform = false,
  });

  factory AskOptionWire.fromJson(Map<String, dynamic> j) {
    final value = (j['value'] as String?) ?? (j['label'] as String?) ?? '';
    final label = (j['label'] as String?) ?? value;
    return AskOptionWire(
      value: value,
      label: label,
      description: j['description'] as String?,
      preview: j['preview'] as String?,
      freeform: (j['freeform'] as bool?) ?? false,
    );
  }
}

class AskQuestionWire {
  final String id;
  final String label;
  final String prompt;
  final AskQuestionWireType type;
  final bool required;
  final AskQuestionWireType? presentedType;
  final AskQuestionWireType? requestedType;
  final List<AskOptionWire> options;

  const AskQuestionWire({
    required this.id,
    required this.label,
    required this.prompt,
    required this.type,
    required this.required,
    this.presentedType,
    this.requestedType,
    this.options = const <AskOptionWire>[],
  });

  factory AskQuestionWire.fromJson(Map<String, dynamic> j) => AskQuestionWire(
        id: j['id'] as String? ?? '',
        label: (j['label'] as String?) ?? (j['prompt'] as String?) ?? '',
        prompt: j['prompt'] as String? ?? '',
        type: AskQuestionWireType.fromWire(j['type'] as String?) ??
            AskQuestionWireType.single,
        required: (j['required'] as bool?) ?? false,
        presentedType:
            AskQuestionWireType.fromWire(j['presentedType'] as String?),
        requestedType:
            AskQuestionWireType.fromWire(j['requestedType'] as String?),
        options: (j['options'] as List<dynamic>? ?? const <dynamic>[])
            .whereType<Map>()
            .map((m) => AskOptionWire.fromJson(m.cast<String, dynamic>()))
            .toList(growable: false),
      );
}

/// Optional pi-ask enrichment on an `extension_ui_request`. When present, the
/// app renders the full flow (multi/preview/notes) from [questions] instead of
/// the degraded SDK method. One request carries the whole flow.
class AskEnrichmentWire {
  final String flowId;
  final String? toolCallId;
  final String source;
  final String? title;
  final List<AskQuestionWire> questions;

  const AskEnrichmentWire({
    required this.flowId,
    this.toolCallId,
    required this.source,
    this.title,
    this.questions = const <AskQuestionWire>[],
  });

  factory AskEnrichmentWire.fromJson(Map<String, dynamic> j) => AskEnrichmentWire(
        flowId: j['flow_id'] as String? ?? '',
        toolCallId: j['tool_call_id'] as String?,
        source: (j['source'] as String?) ?? 'tool',
        title: j['title'] as String?,
        questions: (j['questions'] as List<dynamic>? ?? const <dynamic>[])
            .whereType<Map>()
            .map((m) => AskQuestionWire.fromJson(m.cast<String, dynamic>()))
            .toList(growable: false),
      );
}

class SkillsList extends ServerMessage {
  final String? inReplyTo;
  final List<WireSkill> skills;

  /// omp's own slash-command list for this host: the builtins that run there
  /// plus extension and prompt commands (skills stay in [skills]). Null when the
  /// peer's extension predates the field; the app then shows its built-in list.
  final List<WireCommand>? commands;

  SkillsList({this.inReplyTo, required this.skills, this.commands});

  factory SkillsList.fromJson(Map<String, dynamic> j) => SkillsList(
    inReplyTo: j['in_reply_to'] as String?,
    skills: (j['skills'] as List<dynamic>?)
            ?.map((e) => WireSkill.fromJson(e as Map<String, dynamic>))
            .toList() ??
        const [],
    commands: (j['commands'] as List<dynamic>?)
        ?.whereType<Map>()
        .map((e) => WireCommand.fromJson(e.cast<String, dynamic>()))
        .where((c) => c.name.isNotEmpty)
        .toList(growable: false),
  );
}

class WireSkill {
  final String name;
  final String description;

  const WireSkill({required this.name, required this.description});

  factory WireSkill.fromJson(Map<String, dynamic> j) => WireSkill(
    name: (j['name'] as String?) ?? '',
    description: (j['description'] as String?) ?? '',
  );

  Map<String, dynamic> toJson() => {
    'name': name,
    'description': description,
  };
}

/// One slash command the host can run, as `skills_list.commands` lists it.
/// [source] stays raw (`builtin` | `extension` | `prompt`) for forward-compat.
class WireCommand {
  final String name;
  final String description;
  final String source;

  /// Argument hint (`<model>`), when omp has one for the command.
  final String? hint;

  const WireCommand({
    required this.name,
    required this.description,
    this.source = '',
    this.hint,
  });

  factory WireCommand.fromJson(Map<String, dynamic> j) => WireCommand(
    name: (j['name'] as String?) ?? '',
    description: (j['description'] as String?) ?? '',
    source: (j['source'] as String?) ?? '',
    hint: j['hint'] as String?,
  );
}

/// ServerMessage: interactive extension prompt. Mirrors RpcExtensionUIRequest.
/// `notifyType` is kept raw (info/warning/error) for forward-compat.
class ExtensionUiRequest extends ServerMessage {
  final String id;
  final ExtensionUiMethod method;
  final String? title;
  final String? message; // confirm
  final String? placeholder; // input
  final String? prefill; // editor
  final List<String> options; // select
  final String? notifyType; // notify
  final AskEnrichmentWire? ask;

  /// omp plan review envelope (present only on the `select` that carries a
  /// proposed plan); clients that know it render the plan review sheet
  /// instead of the plain select over [options].
  final PlanReview? plan;

  const ExtensionUiRequest({
    required this.id,
    required this.method,
    this.title,
    this.message,
    this.placeholder,
    this.prefill,
    this.options = const <String>[],
    this.notifyType,
    this.ask,
    this.plan,
  });

  factory ExtensionUiRequest.fromJson(Map<String, dynamic> j) =>
      ExtensionUiRequest(
        id: j['id'] as String? ?? '',
        method: ExtensionUiMethod.fromWire(j['method'] as String?) ??
            ExtensionUiMethod.select,
        title: j['title'] as String?,
        message: j['message'] as String?,
        placeholder: j['placeholder'] as String?,
        prefill: j['prefill'] as String?,
        options: (j['options'] as List<dynamic>? ?? const <dynamic>[])
            .map((e) => e.toString())
            .toList(growable: false),
        notifyType: j['notify_type'] as String?,
        ask: j['ask'] is Map<String, dynamic>
            ? AskEnrichmentWire.fromJson(j['ask'] as Map<String, dynamic>)
            : null,
        plan: j['plan'] is Map<String, dynamic>
            ? PlanReview.fromJson(j['plan'] as Map<String, dynamic>)
            : null,
      );
}

// ---------------------------------------------------------------------------
// omp plan mode — plan review + plan state.
// Contract: omp-extension/src/protocol/types.ts (PlanReviewWire,
// PlanReviewAnswerWire, PlanStatus, `plan_state`, `plan_mode`). Older Pi
// builds never send any of it, so every field stays optional on the app side.
// ---------------------------------------------------------------------------

/// omp's plan review choices, in omp's order. A `cancelled` response (not an
/// action) is the overlay's Esc: close the review, keep planning.
enum PlanReviewAction {
  approveExecute('approve_execute'),
  approveCompact('approve_compact'),
  approveKeep('approve_keep'),
  refine('refine'),
  saveQuit('save_quit');

  final String wire;
  const PlanReviewAction(this.wire);

  static PlanReviewAction? fromWire(String? s) {
    for (final a in values) {
      if (a.wire == s) return a;
    }
    return null;
  }
}

class PlanReviewOption {
  final PlanReviewAction action;

  /// omp's label, e.g. "Approve and keep context (~19k / 1m)".
  final String label;

  /// omp disables `approve_keep` when the context is over 95 % full.
  final bool disabled;

  const PlanReviewOption({
    required this.action,
    required this.label,
    this.disabled = false,
  });
}

/// The `plan` envelope of a plan review request.
class PlanReview {
  /// omp's plan path, e.g. "local://hello-txt-plan.md".
  final String planFilePath;
  final String title;

  /// The plan file's markdown; null when the Pi could not read it.
  final String? content;

  /// omp's choices in order. Options with an action this build does not know
  /// are dropped (a newer Pi may add some).
  final List<PlanReviewOption> options;

  const PlanReview({
    required this.planFilePath,
    required this.title,
    this.content,
    this.options = const <PlanReviewOption>[],
  });

  factory PlanReview.fromJson(Map<String, dynamic> j) => PlanReview(
    planFilePath: j['plan_file_path'] as String? ?? '',
    title: j['title'] as String? ?? '',
    content: j['content'] as String?,
    options: [
      for (final o in (j['options'] as List<dynamic>? ?? const <dynamic>[])
          .whereType<Map<String, dynamic>>())
        if (PlanReviewAction.fromWire(o['action'] as String?) case final action?)
          PlanReviewOption(
            action: action,
            label: o['label'] as String? ?? action.wire,
            disabled: (o['disabled'] as bool?) ?? false,
          ),
    ],
  );
}

/// The client's choice on a plan review (`extension_ui_response.plan`).
class PlanReviewAnswer {
  final PlanReviewAction action;

  /// Used by `refine` only (sent as the next prompt); trimmed, omitted when
  /// empty and for every other action.
  final String? feedback;

  const PlanReviewAnswer({required this.action, this.feedback});

  Map<String, dynamic> toJson() {
    final text = action == PlanReviewAction.refine ? feedback?.trim() : null;
    return {
      'action': action.wire,
      if (text != null && text.isNotEmpty) 'feedback': text,
    };
  }
}

/// omp's plan mode as clients show it: `active` = planning, `paused` = omp's
/// `plan_paused` (one more exit fully leaves), `review` = a plan waits for a
/// decision, `idle` = off.
enum PlanStatus {
  idle('idle'),
  active('active'),
  paused('paused'),
  review('review');

  final String wire;
  const PlanStatus(this.wire);

  static PlanStatus? fromWire(String? s) {
    for (final st in values) {
      if (st.wire == s) return st;
    }
    return null;
  }
}

/// ServerMessage: the active session's plan mode state. [planFilePath] /
/// [title] are present while a proposed plan exists (lets the client offer
/// "Review plan" while still planning).
class PlanState extends ServerMessage {
  final PlanStatus status;
  final String? planFilePath;
  final String? title;

  const PlanState({required this.status, this.planFilePath, this.title});

  /// An unknown status (newer Pi) reads as idle: the plan button then offers
  /// only "Enter plan mode", which every build understands.
  factory PlanState.fromJson(Map<String, dynamic> j) => PlanState(
    status: PlanStatus.fromWire(j['status'] as String?) ?? PlanStatus.idle,
    planFilePath: j['plan_file_path'] as String?,
    title: j['title'] as String?,
  );
}

/// pi-ask RemoteAskAnswer — one question's answered parts (outbound).
class AskAnswerWire {
  final List<String> values;
  final String? customText;
  final String? note;
  final Map<String, String> optionNotes;

  const AskAnswerWire({
    this.values = const <String>[],
    this.customText,
    this.note,
    this.optionNotes = const <String, String>{},
  });

  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{};
    if (values.isNotEmpty) m['values'] = values;
    if (customText != null && customText!.isNotEmpty) m['customText'] = customText;
    if (note != null && note!.isNotEmpty) m['note'] = note;
    if (optionNotes.isNotEmpty) m['optionNotes'] = optionNotes;
    return m;
  }
}

/// Optional pi-ask enrichment on an `extension_ui_response` (outbound). Carries
/// the structured answer so multi/preview/notes survive the round-trip.
class AskResponseEnrichmentWire {
  final String flowId;
  final bool isCancel;
  /// 'submit' | 'elaborate' (null when cancel). Raw string for forward-compat.
  final String? mode;
  final Map<String, AskAnswerWire> answers;

  const AskResponseEnrichmentWire({
    required this.flowId,
    this.isCancel = false,
    this.mode,
    this.answers = const <String, AskAnswerWire>{},
  });

  Map<String, dynamic> toJson() {
    if (isCancel) return {'flow_id': flowId, 'kind': 'cancel'};
    return <String, dynamic>{
      'flow_id': flowId,
      'kind': 'answer',
      if (mode != null) 'mode': mode,
      'answers': answers.map((k, v) => MapEntry(k, v.toJson())),
    };
  }
}

/// ClientMessage: response to an `extension_ui_request`. Mirrors
/// RpcExtensionUIResponse (value / confirmed / cancelled) + optional `ask`
/// envelope carrying pi-ask's structured answer, or the [plan] choice for a
/// plan review.
class ExtensionUiResponse extends ClientMessage {
  final String id;
  final String? value;
  final bool? confirmed;
  final bool cancelled;
  final AskResponseEnrichmentWire? ask;
  final PlanReviewAnswer? plan;

  ExtensionUiResponse({
    required this.id,
    this.value,
    this.confirmed,
    this.cancelled = false,
    this.ask,
    this.plan,
  });

  @override
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{'type': 'extension_ui_response', 'id': id};
    if (cancelled) m['cancelled'] = true;
    if (value != null) m['value'] = value;
    if (confirmed != null) m['confirmed'] = confirmed;
    if (ask != null) m['ask'] = ask!.toJson();
    if (plan != null) m['plan'] = plan!.toJson();
    return m;
  }
}

// ---------------------------------------------------------------------------
// agent_activity — running subagents + background jobs (omp's bottom panel).
// Contract: omp-extension/src/protocol/types.ts (AgentActivityJob) and
// omp-extension/src/activity.ts. Every frame is a FULL snapshot; `jobs: []`
// means nothing is running. Elapsed time is not on the wire: clients render
// `now - started_at` while running, `ended_at - started_at` after.
// ---------------------------------------------------------------------------

enum AgentActivityKind {
  subagent('subagent'),
  bash('bash'),
  job('job');

  final String wire;
  const AgentActivityKind(this.wire);

  /// Unknown kinds render like a generic background job (forward-compat).
  static AgentActivityKind fromWire(String? s) {
    for (final k in values) {
      if (k.wire == s) return k;
    }
    return AgentActivityKind.job;
  }
}

enum AgentActivityStatus {
  running('running'),
  done('done'),
  failed('failed'),
  cancelled('cancelled');

  final String wire;
  const AgentActivityStatus(this.wire);

  /// Unknown statuses count as finished (mirrors the extension's mapping).
  static AgentActivityStatus fromWire(String? s) {
    for (final st in values) {
      if (st.wire == s) return st;
    }
    return AgentActivityStatus.done;
  }
}

/// Subagent live progress, as last reported by omp.
class AgentActivityProgress {
  final String? tool;
  final String? toolArgs;
  final int? toolStartedAt;
  final int? toolCount;
  final int? tokens;
  final double? cost;
  final double? percent;

  const AgentActivityProgress({
    this.tool,
    this.toolArgs,
    this.toolStartedAt,
    this.toolCount,
    this.tokens,
    this.cost,
    this.percent,
  });

  factory AgentActivityProgress.fromJson(Map<String, dynamic> j) =>
      AgentActivityProgress(
        tool: j['tool'] as String?,
        toolArgs: j['tool_args'] as String?,
        toolStartedAt: (j['tool_started_at'] as num?)?.toInt(),
        toolCount: (j['tool_count'] as num?)?.toInt(),
        tokens: (j['tokens'] as num?)?.toInt(),
        cost: (j['cost'] as num?)?.toDouble(),
        percent: (j['percent'] as num?)?.toDouble(),
      );
}

/// One row of the activity panel.
class AgentActivityJob {
  final String id;
  final AgentActivityKind kind;
  final String label;
  final AgentActivityStatus status;

  /// Epoch ms.
  final int startedAt;

  /// Epoch ms; set once [status] is no longer running.
  final int? endedAt;
  final String? agent;
  final String? description;
  final String? assignment;
  final String? parentToolCallId;
  final String? command;
  final String? jobType;
  final String? detail;
  final AgentActivityProgress? progress;

  const AgentActivityJob({
    required this.id,
    required this.kind,
    required this.label,
    required this.status,
    required this.startedAt,
    this.endedAt,
    this.agent,
    this.description,
    this.assignment,
    this.parentToolCallId,
    this.command,
    this.jobType,
    this.detail,
    this.progress,
  });

  factory AgentActivityJob.fromJson(Map<String, dynamic> j) {
    final id = j['id'] as String? ?? '';
    return AgentActivityJob(
      id: id,
      kind: AgentActivityKind.fromWire(j['kind'] as String?),
      label: (j['label'] as String?) ?? id,
      status: AgentActivityStatus.fromWire(j['status'] as String?),
      startedAt: (j['started_at'] as num?)?.toInt() ?? 0,
      endedAt: (j['ended_at'] as num?)?.toInt(),
      agent: j['agent'] as String?,
      description: j['description'] as String?,
      assignment: j['assignment'] as String?,
      parentToolCallId: j['parent_tool_call_id'] as String?,
      command: j['command'] as String?,
      jobType: j['job_type'] as String?,
      detail: j['detail'] as String?,
      progress: j['progress'] is Map
          ? AgentActivityProgress.fromJson(
              (j['progress'] as Map).cast<String, dynamic>(),
            )
          : null,
    );
  }
}

/// ServerMessage: full snapshot of the session's running subagents + jobs.
class AgentActivity extends ServerMessage {
  final List<AgentActivityJob> jobs;
  final int? ts;

  const AgentActivity({required this.jobs, this.ts});

  factory AgentActivity.fromJson(Map<String, dynamic> j) => AgentActivity(
    jobs: (j['jobs'] as List<dynamic>? ?? const <dynamic>[])
        .whereType<Map>()
        .map((m) => AgentActivityJob.fromJson(m.cast<String, dynamic>()))
        .toList(growable: false),
    ts: (j['ts'] as num?)?.toInt(),
  );
}

// ---------------------------------------------------------------------------
// todo_state — omp's todo list (the `todo` tool's phases and tasks).
// Contract: omp-extension/src/protocol/types.ts (TodoStateMessage) and
// omp-extension/src/todo_state.ts. Every frame is a FULL snapshot; phases are
// never empty; `phases: []` means no list (or the TUI dismissed a done one).
// ---------------------------------------------------------------------------

enum TodoStatus {
  pending('pending'),
  inProgress('in_progress'),
  completed('completed'),
  abandoned('abandoned'),
  blocked('blocked');

  final String wire;
  const TodoStatus(this.wire);

  /// Null for a status this build does not know (the task is dropped).
  static TodoStatus? fromWire(Object? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return null;
  }

  /// omp counts dropped (`abandoned`) tasks as done.
  bool get isDone => this == completed || this == abandoned;
}

class TodoTask {
  final String content;
  final TodoStatus status;

  /// `blocked` only: the agent's reason.
  final String? blocker;

  const TodoTask({required this.content, required this.status, this.blocker});

  @override
  bool operator ==(Object other) =>
      other is TodoTask &&
      other.content == content &&
      other.status == status &&
      other.blocker == blocker;

  @override
  int get hashCode => Object.hash(content, status, blocker);
}

class TodoPhase {
  final String name;
  final List<TodoTask> tasks;

  const TodoPhase({required this.name, required this.tasks});

  @override
  bool operator ==(Object other) =>
      other is TodoPhase &&
      other.name == name &&
      _listEquals(other.tasks, tasks);

  @override
  int get hashCode => Object.hash(name, Object.hashAll(tasks));
}

bool _listEquals<T>(List<T> a, List<T> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

class TodoState extends ServerMessage {
  final List<TodoPhase> phases;
  final int? ts;

  const TodoState({required this.phases, this.ts});

  /// Malformed tasks and phases left without tasks are dropped.
  factory TodoState.fromJson(Map<String, dynamic> j) {
    final phases = <TodoPhase>[];
    for (final p in (j['phases'] as List<dynamic>? ?? const []).whereType<Map>()) {
      final name = p['name'];
      if (name is! String) continue;
      final tasks = <TodoTask>[];
      for (final t in (p['tasks'] as List<dynamic>? ?? const []).whereType<Map>()) {
        final content = t['content'];
        final status = TodoStatus.fromWire(t['status']);
        if (content is! String || status == null) continue;
        final blocker = t['blocker'];
        tasks.add(TodoTask(
          content: content,
          status: status,
          blocker: blocker is String && blocker.isNotEmpty ? blocker : null,
        ));
      }
      if (tasks.isNotEmpty) {
        phases.add(TodoPhase(name: name, tasks: List.unmodifiable(tasks)));
      }
    }
    return TodoState(
      phases: List.unmodifiable(phases),
      ts: (j['ts'] as num?)?.toInt(),
    );
  }
}

// ---------------------------------------------------------------------------
// Plan 65 — send files to the phone.
// Contract: plan/65-send-file-to-phone.md (table) and
// omp-extension/src/protocol/types.ts. ext → app: file_offer, file_chunk,
// file_end; app → ext: file_ack (cumulative next_seq), file_done, file_error;
// file_cancel travels both ways. Unknown extra fields are ignored.
// ---------------------------------------------------------------------------

/// ServerMessage: the extension offers a file. Chunks follow immediately.
class FileOffer extends ServerMessage {
  final String fileId;
  final String name;
  final String mime;
  final int size;

  /// Hex SHA-256 of the whole file.
  final String sha256;
  final String? caption;
  final String? turnId;

  const FileOffer({
    required this.fileId,
    required this.name,
    required this.mime,
    required this.size,
    required this.sha256,
    this.caption,
    this.turnId,
  });

  factory FileOffer.fromJson(Map<String, dynamic> j) => FileOffer(
    fileId: j['file_id'] as String,
    name: j['name'] as String,
    mime: (j['mime'] as String?) ?? 'application/octet-stream',
    size: (j['size'] as num).toInt(),
    sha256: j['sha256'] as String,
    caption: j['caption'] as String?,
    turnId: j['turn_id'] as String?,
  );

  Map<String, dynamic> toJson() => {
    'type': 'file_offer',
    'file_id': fileId,
    'name': name,
    'mime': mime,
    'size': size,
    'sha256': sha256,
    if (caption != null) 'caption': caption,
    if (turnId != null) 'turn_id': turnId,
  };

  @override
  bool operator ==(Object other) =>
      other is FileOffer &&
      other.fileId == fileId &&
      other.name == name &&
      other.mime == mime &&
      other.size == size &&
      other.sha256 == sha256 &&
      other.caption == caption &&
      other.turnId == turnId;

  @override
  int get hashCode =>
      Object.hash(fileId, name, mime, size, sha256, caption, turnId);
}

/// ServerMessage: one chunk of a file (`data` is base64, `seq` from 0).
class FileChunk extends ServerMessage {
  final String fileId;
  final int seq;
  final String data;

  const FileChunk({required this.fileId, required this.seq, required this.data});

  factory FileChunk.fromJson(Map<String, dynamic> j) => FileChunk(
    fileId: j['file_id'] as String,
    seq: (j['seq'] as num).toInt(),
    data: j['data'] as String,
  );

  Map<String, dynamic> toJson() => {
    'type': 'file_chunk',
    'file_id': fileId,
    'seq': seq,
    'data': data,
  };

  @override
  bool operator ==(Object other) =>
      other is FileChunk &&
      other.fileId == fileId &&
      other.seq == seq &&
      other.data == data;

  @override
  int get hashCode => Object.hash(fileId, seq, data);
}

/// ServerMessage: the sender has sent all [chunks] chunks.
class FileEnd extends ServerMessage {
  final String fileId;
  final int chunks;

  const FileEnd({required this.fileId, required this.chunks});

  factory FileEnd.fromJson(Map<String, dynamic> j) => FileEnd(
    fileId: j['file_id'] as String,
    chunks: (j['chunks'] as num).toInt(),
  );

  Map<String, dynamic> toJson() => {
    'type': 'file_end',
    'file_id': fileId,
    'chunks': chunks,
  };

  @override
  bool operator ==(Object other) =>
      other is FileEnd && other.fileId == fileId && other.chunks == chunks;

  @override
  int get hashCode => Object.hash(fileId, chunks);
}

/// `file_cancel` travels both ways: the extension aborts a send (inbound
/// [ServerMessage]) or the user cancels a download (outbound [ClientMessage]).
class FileCancel extends ServerMessage implements ClientMessage {
  final String fileId;

  const FileCancel({required this.fileId});

  factory FileCancel.fromJson(Map<String, dynamic> j) =>
      FileCancel(fileId: j['file_id'] as String);

  @override
  Map<String, dynamic> toJson() => {'type': 'file_cancel', 'file_id': fileId};

  @override
  bool operator ==(Object other) =>
      other is FileCancel && other.fileId == fileId;

  @override
  int get hashCode => fileId.hashCode;
}

/// ClientMessage: every chunk below [nextSeq] is on disk (cumulative ack).
/// Also re-sent on reconnect so the sender resumes from [nextSeq].
class FileAck extends ClientMessage {
  final String fileId;
  final int nextSeq;

  FileAck({required this.fileId, required this.nextSeq});

  factory FileAck.fromJson(Map<String, dynamic> j) => FileAck(
    fileId: j['file_id'] as String,
    nextSeq: (j['next_seq'] as num).toInt(),
  );

  @override
  Map<String, dynamic> toJson() => {
    'type': 'file_ack',
    'file_id': fileId,
    'next_seq': nextSeq,
  };

  @override
  bool operator ==(Object other) =>
      other is FileAck && other.fileId == fileId && other.nextSeq == nextSeq;

  @override
  int get hashCode => Object.hash(fileId, nextSeq);
}

/// ClientMessage: the file is complete and its SHA-256 matched.
class FileDone extends ClientMessage {
  final String fileId;

  FileDone({required this.fileId});

  factory FileDone.fromJson(Map<String, dynamic> j) =>
      FileDone(fileId: j['file_id'] as String);

  @override
  Map<String, dynamic> toJson() => {'type': 'file_done', 'file_id': fileId};

  @override
  bool operator ==(Object other) => other is FileDone && other.fileId == fileId;

  @override
  int get hashCode => fileId.hashCode;
}

enum FileErrorReason {
  shaMismatch('sha_mismatch'),
  noSpace('no_space'),
  cancelled('cancelled');

  final String wire;
  const FileErrorReason(this.wire);

  static FileErrorReason? fromWire(Object? s) {
    for (final r in values) {
      if (r.wire == s) return r;
    }
    return null;
  }
}

/// ClientMessage: the phone gave up on the file.
class FileError extends ClientMessage {
  final String fileId;
  final FileErrorReason? reason;

  FileError({required this.fileId, this.reason});

  factory FileError.fromJson(Map<String, dynamic> j) => FileError(
    fileId: j['file_id'] as String,
    reason: FileErrorReason.fromWire(j['reason']),
  );

  @override
  Map<String, dynamic> toJson() => {
    'type': 'file_error',
    'file_id': fileId,
    if (reason != null) 'reason': reason!.wire,
  };

  @override
  bool operator ==(Object other) =>
      other is FileError && other.fileId == fileId && other.reason == reason;

  @override
  int get hashCode => Object.hash(fileId, reason);
}

// ---------------------------------------------------------------------------
// Plan 68 — upload a file from the phone to the PC.
// Contract: plan/68-mobile-parity-pack.md and
// omp-extension/src/protocol/types.ts. app → ext: upload_start, upload_chunk
// (≤ 1 MiB raw, base64 in `data`), upload_end, upload_cancel; each carries the
// usual request `id`. ext → app: upload_ack (cumulative: `seq` is the first
// chunk the PC still needs), upload_done {path}, upload_error {code, message}.
// Replies are correlated by `upload_id`. Unknown extra fields are ignored.
// ---------------------------------------------------------------------------

/// ClientMessage: announces an upload. [sha256] is the lowercase hex digest
/// of the whole file; the PC verifies it when present.
class UploadStart extends ClientMessage {
  final String id;
  final String uploadId;
  final String name;
  final int size;
  final String? mime;
  final String? sha256;

  UploadStart({
    required this.id,
    required this.uploadId,
    required this.name,
    required this.size,
    this.mime,
    this.sha256,
  });

  factory UploadStart.fromJson(Map<String, dynamic> j) => UploadStart(
    id: j['id'] as String,
    uploadId: j['upload_id'] as String,
    name: j['name'] as String,
    size: (j['size'] as num).toInt(),
    mime: j['mime'] as String?,
    sha256: j['sha256'] as String?,
  );

  @override
  Map<String, dynamic> toJson() => {
    'type': 'upload_start',
    'id': id,
    'upload_id': uploadId,
    'name': name,
    'size': size,
    if (mime != null) 'mime': mime,
    if (sha256 != null) 'sha256': sha256,
  };

  @override
  bool operator ==(Object other) =>
      other is UploadStart &&
      other.id == id &&
      other.uploadId == uploadId &&
      other.name == name &&
      other.size == size &&
      other.mime == mime &&
      other.sha256 == sha256;

  @override
  int get hashCode => Object.hash(id, uploadId, name, size, mime, sha256);
}

/// ClientMessage: one chunk of the file (`data` is base64, `seq` from 0).
class UploadChunk extends ClientMessage {
  final String id;
  final String uploadId;
  final int seq;
  final String data;

  UploadChunk({
    required this.id,
    required this.uploadId,
    required this.seq,
    required this.data,
  });

  factory UploadChunk.fromJson(Map<String, dynamic> j) => UploadChunk(
    id: j['id'] as String,
    uploadId: j['upload_id'] as String,
    seq: (j['seq'] as num).toInt(),
    data: j['data'] as String,
  );

  @override
  Map<String, dynamic> toJson() => {
    'type': 'upload_chunk',
    'id': id,
    'upload_id': uploadId,
    'seq': seq,
    'data': data,
  };

  @override
  bool operator ==(Object other) =>
      other is UploadChunk &&
      other.id == id &&
      other.uploadId == uploadId &&
      other.seq == seq &&
      other.data == data;

  @override
  int get hashCode => Object.hash(id, uploadId, seq, data);
}

/// ClientMessage: every chunk is acked; the PC verifies and stores the file.
/// [sha256] is the lowercase hex digest of the whole file, which the phone only
/// knows now (it hashes while it sends); the PC verifies it when present.
class UploadEnd extends ClientMessage {
  final String id;
  final String uploadId;
  final String? sha256;

  UploadEnd({required this.id, required this.uploadId, this.sha256});

  factory UploadEnd.fromJson(Map<String, dynamic> j) => UploadEnd(
    id: j['id'] as String,
    uploadId: j['upload_id'] as String,
    sha256: j['sha256'] as String?,
  );

  @override
  Map<String, dynamic> toJson() => {
    'type': 'upload_end',
    'id': id,
    'upload_id': uploadId,
    if (sha256 != null) 'sha256': sha256,
  };

  @override
  bool operator ==(Object other) =>
      other is UploadEnd &&
      other.id == id &&
      other.uploadId == uploadId &&
      other.sha256 == sha256;

  @override
  int get hashCode => Object.hash(id, uploadId, sha256);
}

/// ClientMessage: abandon the upload; the PC deletes the partial file.
class UploadCancel extends ClientMessage {
  final String id;
  final String uploadId;

  UploadCancel({required this.id, required this.uploadId});

  factory UploadCancel.fromJson(Map<String, dynamic> j) =>
      UploadCancel(id: j['id'] as String, uploadId: j['upload_id'] as String);

  @override
  Map<String, dynamic> toJson() => {
    'type': 'upload_cancel',
    'id': id,
    'upload_id': uploadId,
  };

  @override
  bool operator ==(Object other) =>
      other is UploadCancel && other.id == id && other.uploadId == uploadId;

  @override
  int get hashCode => Object.hash(id, uploadId);
}

/// ServerMessage: every chunk below [seq] is on the PC's disk, in order
/// (cumulative); [received] is the number of bytes those chunks hold. Also the
/// answer to a repeated `upload_start`, a duplicate or out-of-order chunk and
/// an early `upload_end`, so the phone resumes or resends from [seq].
///
/// [inReplyTo] is the request `id` of the frame this ack answers. The answer to
/// a repeated `upload_start` (a probe) is the PC's position after every frame
/// the phone sent before it, which is how a lost chunk is told from a slow
/// link. Null from a PC that predates the echo.
class UploadAck extends ServerMessage {
  final String uploadId;
  final int seq;
  final int received;
  final String? inReplyTo;

  const UploadAck({
    required this.uploadId,
    required this.seq,
    required this.received,
    this.inReplyTo,
  });

  factory UploadAck.fromJson(Map<String, dynamic> j) => UploadAck(
    uploadId: j['upload_id'] as String,
    seq: (j['seq'] as num).toInt(),
    received: (j['received'] as num?)?.toInt() ?? 0,
    inReplyTo: j['in_reply_to'] as String?,
  );

  Map<String, dynamic> toJson() => {
    'type': 'upload_ack',
    'upload_id': uploadId,
    'seq': seq,
    'received': received,
    if (inReplyTo != null) 'in_reply_to': inReplyTo,
  };

  @override
  bool operator ==(Object other) =>
      other is UploadAck &&
      other.uploadId == uploadId &&
      other.seq == seq &&
      other.received == received &&
      other.inReplyTo == inReplyTo;

  @override
  int get hashCode => Object.hash(uploadId, seq, received, inReplyTo);
}

/// ServerMessage: the file is stored; [path] is its absolute path on the PC.
class UploadDone extends ServerMessage {
  final String uploadId;
  final String path;
  final int size;

  const UploadDone({
    required this.uploadId,
    required this.path,
    required this.size,
  });

  factory UploadDone.fromJson(Map<String, dynamic> j) => UploadDone(
    uploadId: j['upload_id'] as String,
    path: j['path'] as String,
    size: (j['size'] as num?)?.toInt() ?? 0,
  );

  Map<String, dynamic> toJson() => {
    'type': 'upload_done',
    'upload_id': uploadId,
    'path': path,
    'size': size,
  };

  @override
  bool operator ==(Object other) =>
      other is UploadDone &&
      other.uploadId == uploadId &&
      other.path == path &&
      other.size == size;

  @override
  int get hashCode => Object.hash(uploadId, path, size);
}

/// ServerMessage: the upload failed and the PC removed its partial file.
/// [code] is open-ended (`too_large`, `no_space`, `invalid_upload`,
/// `size_mismatch`, `sha_mismatch`, `timeout`, `unknown_upload`,
/// `too_many_uploads`, `write_failed`, …); [message] is for the user.
class UploadError extends ServerMessage {
  final String uploadId;
  final String code;
  final String message;

  const UploadError({
    required this.uploadId,
    required this.code,
    required this.message,
  });

  factory UploadError.fromJson(Map<String, dynamic> j) => UploadError(
    uploadId: j['upload_id'] as String,
    code: (j['code'] as String?) ?? 'unknown',
    message: (j['message'] as String?) ?? '',
  );

  Map<String, dynamic> toJson() => {
    'type': 'upload_error',
    'upload_id': uploadId,
    'code': code,
    'message': message,
  };

  @override
  bool operator ==(Object other) =>
      other is UploadError &&
      other.uploadId == uploadId &&
      other.code == code &&
      other.message == message;

  @override
  int get hashCode => Object.hash(uploadId, code, message);
}

// ---------------------------------------------------------------------------
// Mobile Git Diff / Changed Files viewer
// ---------------------------------------------------------------------------

enum GitFileStatus {
  modified('modified'),
  added('added'),
  deleted('deleted'),
  renamed('renamed'),
  untracked('untracked'),
  conflicted('conflicted');

  final String wire;
  const GitFileStatus(this.wire);

  static GitFileStatus fromWire(String? raw) {
    for (final s in values) {
      if (s.wire == raw) return s;
    }
    return GitFileStatus.modified;
  }
}

class WireGitFileChange {
  final String path;
  final String? oldPath;
  final GitFileStatus status;
  final bool staged;
  final bool unstaged;
  final int? additions;
  final int? deletions;
  final bool binary;

  const WireGitFileChange({
    required this.path,
    this.oldPath,
    required this.status,
    required this.staged,
    required this.unstaged,
    this.additions,
    this.deletions,
    this.binary = false,
  });

  factory WireGitFileChange.fromJson(Map<String, dynamic> j) =>
      WireGitFileChange(
        path: (j['path'] as String?) ?? '',
        oldPath: j['old_path'] as String?,
        status: GitFileStatus.fromWire(j['status'] as String?),
        staged: (j['staged'] as bool?) ?? false,
        unstaged: (j['unstaged'] as bool?) ?? false,
        additions: (j['additions'] as num?)?.toInt(),
        deletions: (j['deletions'] as num?)?.toInt(),
        binary: (j['binary'] as bool?) ?? false,
      );

  @override
  bool operator ==(Object other) =>
      other is WireGitFileChange &&
      other.path == path &&
      other.oldPath == oldPath &&
      other.status == status &&
      other.staged == staged &&
      other.unstaged == unstaged &&
      other.additions == additions &&
      other.deletions == deletions &&
      other.binary == binary;

  @override
  int get hashCode => Object.hash(
    path,
    oldPath,
    status,
    staged,
    unstaged,
    additions,
    deletions,
    binary,
  );
}

class GitStatusResult extends ServerMessage {
  final String inReplyTo;
  final bool isRepo;
  final String? branch;
  final String? repoRoot;
  final List<WireGitFileChange> files;
  final bool truncated;

  const GitStatusResult({
    required this.inReplyTo,
    required this.isRepo,
    this.branch,
    this.repoRoot,
    required this.files,
    this.truncated = false,
  });

  factory GitStatusResult.fromJson(Map<String, dynamic> j) => GitStatusResult(
    inReplyTo: (j['in_reply_to'] as String?) ?? '',
    isRepo: (j['is_repo'] as bool?) ?? false,
    branch: j['branch'] as String?,
    repoRoot: j['repo_root'] as String?,
    files: (j['files'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => WireGitFileChange.fromJson(e as Map<String, dynamic>))
        .toList(),
    truncated: (j['truncated'] as bool?) ?? false,
  );

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    if (other is! GitStatusResult ||
        other.inReplyTo != inReplyTo ||
        other.isRepo != isRepo ||
        other.branch != branch ||
        other.repoRoot != repoRoot ||
        other.truncated != truncated ||
        other.files.length != files.length) {
      return false;
    }
    for (var i = 0; i < files.length; i++) {
      if (files[i] != other.files[i]) return false;
    }
    return true;
  }

  @override
  int get hashCode => Object.hash(
    inReplyTo,
    isRepo,
    branch,
    repoRoot,
    truncated,
    Object.hashAll(files),
  );
}

class GitDiffResult extends ServerMessage {
  final String inReplyTo;
  final String path;
  final bool staged;
  final String diff;
  final bool binary;
  final bool truncated;
  final int? additions;
  final int? deletions;

  const GitDiffResult({
    required this.inReplyTo,
    required this.path,
    required this.staged,
    required this.diff,
    this.binary = false,
    this.truncated = false,
    this.additions,
    this.deletions,
  });

  factory GitDiffResult.fromJson(Map<String, dynamic> j) => GitDiffResult(
    inReplyTo: (j['in_reply_to'] as String?) ?? '',
    path: (j['path'] as String?) ?? '',
    staged: (j['staged'] as bool?) ?? false,
    diff: (j['diff'] as String?) ?? '',
    binary: (j['binary'] as bool?) ?? false,
    truncated: (j['truncated'] as bool?) ?? false,
    additions: (j['additions'] as num?)?.toInt(),
    deletions: (j['deletions'] as num?)?.toInt(),
  );

  @override
  bool operator ==(Object other) =>
      other is GitDiffResult &&
      other.inReplyTo == inReplyTo &&
      other.path == path &&
      other.staged == staged &&
      other.diff == diff &&
      other.binary == binary &&
      other.truncated == truncated &&
      other.additions == additions &&
      other.deletions == deletions;

  @override
  int get hashCode => Object.hash(
    inReplyTo,
    path,
    staged,
    diff,
    binary,
    truncated,
    additions,
    deletions,
  );
}

/// Reply to [ListFilesRequest]: ranked [files] relative to [root].
class FilesListResult extends ServerMessage {
  final String inReplyTo;
  final String root;
  final List<String> files;
  final bool truncated;

  const FilesListResult({
    required this.inReplyTo,
    required this.root,
    required this.files,
    this.truncated = false,
  });

  factory FilesListResult.fromJson(Map<String, dynamic> j) => FilesListResult(
    inReplyTo: (j['in_reply_to'] as String?) ?? '',
    root: (j['root'] as String?) ?? '',
    files: [
      for (final f in (j['files'] as List<dynamic>? ?? const []))
        if (f is String) f,
    ],
    truncated: (j['truncated'] as bool?) ?? false,
  );

  @override
  bool operator ==(Object other) =>
      other is FilesListResult &&
      other.inReplyTo == inReplyTo &&
      other.root == root &&
      other.truncated == truncated &&
      _filesEqual(other.files, files);

  static bool _filesEqual(List<String> a, List<String> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  @override
  int get hashCode => Object.hash(inReplyTo, root, truncated, Object.hashAll(files));
}

/// A subfolder in a [DirsListResult] (hidden folders are never listed).
class WireDirEntry {
  final String name;
  final String path;
  final bool isGit;

  const WireDirEntry({
    required this.name,
    required this.path,
    this.isGit = false,
  });

  factory WireDirEntry.fromJson(Map<String, dynamic> j) => WireDirEntry(
    name: (j['name'] as String?) ?? '',
    path: (j['path'] as String?) ?? '',
    isGit: (j['is_git'] as bool?) ?? false,
  );

  @override
  bool operator ==(Object other) =>
      other is WireDirEntry &&
      other.name == name &&
      other.path == path &&
      other.isGit == isGit;

  @override
  int get hashCode => Object.hash(name, path, isGit);
}

/// A folder recently used for agent sessions on the PC. [lastUsed] is epoch
/// milliseconds; null for an always-on folder with no session history.
class WireRecentDir {
  final String path;
  final String name;
  final int? lastUsed;

  const WireRecentDir({required this.path, required this.name, this.lastUsed});

  factory WireRecentDir.fromJson(Map<String, dynamic> j) => WireRecentDir(
    path: (j['path'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    lastUsed: (j['last_used'] as num?)?.toInt(),
  );

  @override
  bool operator ==(Object other) =>
      other is WireRecentDir &&
      other.path == path &&
      other.name == name &&
      other.lastUsed == lastUsed;

  @override
  int get hashCode => Object.hash(path, name, lastUsed);
}

/// Reply to [ListDirsRequest]. [parent] is null at the filesystem root;
/// [dirs] is sorted by name and may be [truncated]; [recent] is newest first.
class DirsListResult extends ServerMessage {
  final String inReplyTo;
  final String path;
  final String? parent;
  final String home;
  final List<WireDirEntry> dirs;
  final List<WireRecentDir> recent;
  final bool truncated;

  const DirsListResult({
    required this.inReplyTo,
    required this.path,
    this.parent,
    required this.home,
    required this.dirs,
    this.recent = const [],
    this.truncated = false,
  });

  factory DirsListResult.fromJson(Map<String, dynamic> j) => DirsListResult(
    inReplyTo: (j['in_reply_to'] as String?) ?? '',
    path: (j['path'] as String?) ?? '',
    parent: j['parent'] as String?,
    home: (j['home'] as String?) ?? '',
    dirs: [
      for (final d in (j['dirs'] as List<dynamic>? ?? const []))
        if (d is Map<String, dynamic>) WireDirEntry.fromJson(d),
    ],
    recent: [
      for (final r in (j['recent'] as List<dynamic>? ?? const []))
        if (r is Map<String, dynamic>) WireRecentDir.fromJson(r),
    ],
    truncated: (j['truncated'] as bool?) ?? false,
  );

  @override
  bool operator ==(Object other) =>
      other is DirsListResult &&
      other.inReplyTo == inReplyTo &&
      other.path == path &&
      other.parent == parent &&
      other.home == home &&
      other.truncated == truncated &&
      _listEquals(other.dirs, dirs) &&
      _listEquals(other.recent, recent);

  @override
  int get hashCode => Object.hash(
    inReplyTo,
    path,
    parent,
    home,
    truncated,
    Object.hashAll(dirs),
    Object.hashAll(recent),
  );
}

/// Reply to [SpawnSessionRequest]: the session is starting in [cwd] and will
/// appear as a live room named [name]. [daemonId] is the supervisor's id for it.
class SpawnResult extends ServerMessage {
  final String inReplyTo;
  final String cwd;
  final String name;
  final bool persistent;
  final String daemonId;

  const SpawnResult({
    required this.inReplyTo,
    required this.cwd,
    required this.name,
    this.persistent = false,
    this.daemonId = '',
  });

  factory SpawnResult.fromJson(Map<String, dynamic> j) => SpawnResult(
    inReplyTo: (j['in_reply_to'] as String?) ?? '',
    cwd: (j['cwd'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    persistent: (j['persistent'] as bool?) ?? false,
    daemonId: (j['daemon_id'] as String?) ?? '',
  );

  @override
  bool operator ==(Object other) =>
      other is SpawnResult &&
      other.inReplyTo == inReplyTo &&
      other.cwd == cwd &&
      other.name == name &&
      other.persistent == persistent &&
      other.daemonId == daemonId;

  @override
  int get hashCode => Object.hash(inReplyTo, cwd, name, persistent, daemonId);
}

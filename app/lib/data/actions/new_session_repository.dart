// NewSessionRepository — plan 68: start an agent session on a PC from Home.
//
// Browsing the PC's folders and spawning the session are typed requests like
// the ones ActionsRepository sends, but Home has no chat open: there is no
// "active room" to ask. They go to a live room of the PC instead (any live
// agent can answer — the folder tree and the supervisor are machine-wide) and
// the reply is matched on `in_reply_to`, like every typed action.
// ConnectionManager.sendToRoom addresses that room just for the send and has
// the transport admit the reply, so the UI's own room is never touched.

import 'dart:async';

import 'package:app/data/transport/connection_manager.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/protocol/uuid7.dart';

/// Why a new-session request failed. [code] is the extension's `error.code`
/// (`cwd_busy`, `not_found`, `supervisor_offline`, …) or one of the app's own:
/// `unavailable` (no live session to ask), `offline`, `disconnected`,
/// `timeout`. [message] is the extension's text, when there was one.
class NewSessionFailure implements Exception {
  final String code;
  final String message;
  const NewSessionFailure(this.code, [this.message = '']);

  /// What to tell the user. An extension from before plan 68 never answers
  /// the new messages (and one that rejects them says `unsupported_type`), so
  /// both end in "update Remote OMP on the PC" rather than a hang.
  String get userMessage => switch (code) {
    'timeout' =>
      'No answer from the PC. If Remote OMP on the PC is an older version, '
          'update it and try again.',
    'unsupported_type' =>
      "This PC's Remote OMP is too old to start sessions. "
          'Update Remote OMP on the PC.',
    'unavailable' => 'This PC needs a running session to talk to first.',
    'offline' || 'disconnected' =>
      'Not connected to the PC. Check your connection and try again.',
    'not_found' => 'That folder no longer exists on the PC.',
    'permission_denied' => 'The PC does not allow reading that folder.',
    'cwd_busy' =>
      'A session is already running in that folder. Open it from the list.',
    'already_registered' =>
      'That folder already has an always-on session. Open it from the list.',
    'supervisor_offline' =>
      'Starting sessions from the phone needs the Remote OMP service on the '
          'PC. Run "remote-omp install" there.',
    'supervisor_outdated' =>
      'The Remote OMP service on the PC is out of date. '
          'Run "remote-omp restart-supervisor" there.',
    _ => message.isEmpty ? 'Something went wrong ($code).' : message,
  };

  @override
  String toString() => 'NewSessionFailure($code${message.isEmpty ? '' : ': $message'})';
}

/// What the New session sheet needs: one PC, reached through one of its live
/// sessions. Every method throws [NewSessionFailure].
abstract class NewSessionRequester {
  /// Subfolders of [path] on the PC (null = its home) and the recent folders.
  Future<DirsListResult> listDirs({String? path});

  /// Starts an omp session in [cwd]. [persistent] registers an always-on
  /// daemon instead of a session that ends when its process does.
  Future<SpawnResult> spawn({
    required String cwd,
    String? name,
    bool persistent = false,
  });

  /// Waits until the session [result] describes is live as a room of the PC,
  /// and returns it; null when it has not appeared within [timeout].
  Future<RoomInfo?> awaitRoom(
    SpawnResult result, {
    Duration timeout = const Duration(seconds: 20),
  });
}

class NewSessionRepository implements NewSessionRequester {
  final ConnectionManager _conn;
  final String epk;
  final Duration _timeout;

  NewSessionRepository(
    this._conn, {
    required this.epk,
    Duration timeout = const Duration(seconds: 15),
  }) : _timeout = timeout;

  @override
  Future<DirsListResult> listDirs({String? path}) =>
      _request<DirsListResult>((id) => ListDirsRequest(id: id, path: path));

  @override
  Future<SpawnResult> spawn({
    required String cwd,
    String? name,
    bool persistent = false,
  }) => _request<SpawnResult>(
    (id) => SpawnSessionRequest(
      id: id,
      cwd: cwd,
      name: name,
      persistent: persistent,
    ),
  );

  /// The live room to send through. The room the UI has open when it is live
  /// (nothing is retargeted then), else an idle live room of the PC, else any.
  String? _pickRoom() {
    final live = [
      for (final r in _conn.roomsFor(epk))
        if (_conn.isRoomLive(epk, r.roomId)) r,
    ];
    if (live.isEmpty) return null;
    final active = _conn.activeRoomId;
    if (live.any((r) => r.roomId == active)) return active;
    final idle = live.where((r) => !_conn.isRoomWorking(epk, r.roomId));
    return (idle.isEmpty ? live.first : idle.first).roomId;
  }

  Future<T> _request<T extends ServerMessage>(
    ClientMessage Function(String id) build,
  ) async {
    final roomId = _pickRoom();
    final channel = _conn.channel;
    if (roomId == null || channel == null) {
      throw const NewSessionFailure('unavailable');
    }
    final id = '$kActionRequestIdPrefix${uuid7()}';
    final reply = Completer<ServerMessage>();
    // Completed with an error before anyone awaits it (a drop mid-send) must
    // not surface as an unhandled error; the await below still throws it.
    reply.future.ignore();
    // Listen before sending: a fast reply must not slip past.
    final messages = channel.serverMessages.listen((m) {
      final replyTo = switch (m) {
        DirsListResult(:final inReplyTo) => inReplyTo,
        SpawnResult(:final inReplyTo) => inReplyTo,
        ErrorMessage(:final inReplyTo) => inReplyTo,
        _ => null,
      };
      if (replyTo == id && !reply.isCompleted) reply.complete(m);
    }, onError: (Object _) {});
    final status = _conn.statusStream.listen((s) {
      if (s is! StatusOnline && !reply.isCompleted) {
        reply.completeError(const NewSessionFailure('disconnected'));
      }
    });
    final timer = Timer(_timeout, () {
      if (!reply.isCompleted) {
        reply.completeError(const NewSessionFailure('timeout'));
      }
    });
    try {
      final bool sent;
      try {
        sent = await _conn.sendToRoom(
          epk,
          roomId,
          build(id),
          requestId: id,
        );
      } catch (e) {
        throw NewSessionFailure('offline', e.toString());
      }
      if (!sent) throw const NewSessionFailure('offline');
      final m = await reply.future;
      if (m is T) return m;
      if (m is ErrorMessage) throw NewSessionFailure(m.code, m.message);
      throw const NewSessionFailure('invalid_reply');
    } finally {
      timer.cancel();
      await messages.cancel();
      await status.cancel();
      _conn.cancelRoomReply(id);
    }
  }

  @override
  Future<RoomInfo?> awaitRoom(
    SpawnResult result, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    RoomInfo? find() {
      final want = _trimSlash(result.cwd);
      final matches = [
        for (final r in _conn.roomsFor(epk))
          if (r.cwd != null &&
              _trimSlash(r.cwd!) == want &&
              _conn.isRoomLive(epk, r.roomId))
            r,
      ];
      if (matches.isEmpty) return null;
      // Several agents may share a folder: the one we named is ours.
      return matches.firstWhere(
        (r) => r.name == result.name,
        orElse: () => matches.first,
      );
    }

    final now = find();
    if (now != null) return now;
    final found = Completer<RoomInfo?>();
    final rooms = _conn.roomsStream.listen((_) {
      final room = find();
      if (room != null && !found.isCompleted) found.complete(room);
    });
    final timer = Timer(timeout, () {
      if (!found.isCompleted) found.complete(null);
    });
    try {
      return await found.future;
    } finally {
      timer.cancel();
      await rooms.cancel();
    }
  }

  static String _trimSlash(String path) =>
      path.length > 1 && (path.endsWith('/') || path.endsWith(r'\'))
      ? path.substring(0, path.length - 1)
      : path;
}

// Plan 68 — NewSessionRepository + ConnectionManager.sendToRoom: typed requests
// to one live room of the PC while the UI stays on its own room, answered on
// `in_reply_to`.

import 'dart:async';

import 'package:app/data/actions/new_session_repository.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

const _epk = 'epkA';
const _peer = PeerRecord(
  remoteEpk: _epk,
  sessionName: 'Pi A',
  relayUrl: 'ws://localhost:8080',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _FakeStorage extends PairingStorage {
  _FakeStorage() : super(AppDatabase.memory());

  @override
  Future<List<PeerRecord>> listPeers() async => [_peer];

  @override
  Future<void> savePeer(
    PeerRecord r, {
    required PeerSaveIntent intent,
  }) async {}

  @override
  Future<void> deletePeer(String epk) async {}

  final Map<String, List<PersistedRoom>> _rooms = {};
  @override
  Future<void> saveRooms(String epk, List<PersistedRoom> rooms) async {
    _rooms[epk] = rooms;
  }

  @override
  Future<List<PersistedRoom>> loadRooms(String epk) async =>
      _rooms[epk] ?? const [];

  @override
  Future<void> deleteRooms(String epk) async {
    _rooms.remove(epk);
  }
}

/// A relay channel that records which room each envelope is addressed to at
/// the moment it is sent, and which replies the transport was told to expect.
class _Channel implements IChannel, IControlLink {
  final _messages = StreamController<ServerMessage>.broadcast();
  final _control = StreamController<ControlInbound>.broadcast();

  String? activeRoom;
  final List<({ClientMessage msg, String? room})> sent = [];

  /// requestId → room, for replies the transport currently lets through.
  final Map<String, String> awaiting = {};
  final List<String> cancelled = [];

  /// Called inside `send`, so a test can answer (or not) like a PC would.
  void Function(ClientMessage msg)? onSend;

  void setActiveRoom(String room) => activeRoom = room;
  void expectReply(String requestId, String room) =>
      awaiting[requestId] = room;
  void cancelReply(String requestId) {
    awaiting.remove(requestId);
    cancelled.add(requestId);
  }

  @override
  Stream<ServerMessage> get serverMessages => _messages.stream;

  @override
  Future<void> send(ClientMessage msg) async {
    sent.add((msg: msg, room: activeRoom));
    onSend?.call(msg);
  }

  @override
  Stream<ControlInbound> get controlFrames => _control.stream;

  @override
  void sendControl(Map<String, dynamic> json) {}

  @override
  Future<void> close() async {
    if (!_messages.isClosed) await _messages.close();
    if (!_control.isClosed) await _control.close();
  }

  void push(ServerMessage m) => _messages.add(m);
  void pushControl(ControlInbound c) => _control.add(c);
  Future<void> dropConnection() => _messages.close();
}

RoomAnnounced _room(String id, String cwd, {String? name}) => RoomAnnounced(
  peer: _epk,
  roomId: id,
  name: name ?? id,
  cwd: cwd,
  startedAt: 1,
);

/// A manager connected to [_peer] through a [_Channel], with [rooms] live.
Future<(ConnectionManager, _Channel)> _online({
  List<RoomAnnounced> rooms = const [],
}) async {
  final ch = _Channel();
  final cm = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage(),
    emitDebounce: Duration.zero,
  );
  await cm.connectTo(_peer);
  await Future<void>.delayed(const Duration(milliseconds: 10));
  for (final r in rooms) {
    ch.pushControl(r);
  }
  await Future<void>.delayed(const Duration(milliseconds: 10));
  addTearDown(cm.dispose);
  return (cm, ch);
}

/// Answers every [ListDirsRequest] with an empty listing of its path.
void _answerListDirs(_Channel ch) {
  ch.onSend = (msg) {
    if (msg is ListDirsRequest) {
      scheduleMicrotask(
        () => ch.push(
          DirsListResult(
            inReplyTo: msg.id,
            path: msg.path ?? '/home/leo',
            home: '/home/leo',
            dirs: const [],
          ),
        ),
      );
    }
  };
}

Matcher _failure(String code) => throwsA(
  isA<NewSessionFailure>().having((e) => e.code, 'code', code),
);

void main() {
  group('NewSessionRepository requests', () {
    test('go to an idle live room of the PC and the UI room is restored', () async {
      final (cm, ch) = await _online(
        rooms: [_room('busy', '/a'), _room('idle', '/b')],
      );
      ch.pushControl(
        const RoomMetaUpdated(
          peer: _epk,
          roomId: 'busy',
          working: true,
          hasModel: false,
          hasThinking: false,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));
      // The first room announced to a peer paired before rooms existed is
      // adopted as the UI's room; park the UI on a room that is not live, as
      // on Home with no chat open, so the picker has to choose.
      cm.switchRoom('home');
      _answerListDirs(ch);
      final uiRoom = cm.activeRoomId;

      final r = await NewSessionRepository(cm, epk: _epk).listDirs(path: '/w');

      expect(r.path, '/w');
      final sent = ch.sent.single;
      final req = sent.msg as ListDirsRequest;
      expect(req.path, '/w');
      expect(req.id, startsWith(kActionRequestIdPrefix));
      // The envelope was addressed to the idle live room, only for the send…
      expect(sent.room, 'idle');
      expect(ch.activeRoom, uiRoom);
      expect(cm.activeRoomId, uiRoom);
      // …and the transport was let through for exactly that request's reply,
      // then told to stop expecting it.
      expect(ch.cancelled, [req.id]);
      expect(ch.awaiting, isEmpty);
    });

    test('use the room the UI has open when it is live', () async {
      final (cm, ch) = await _online(rooms: [_room('r1', '/a'), _room('r2', '/b')]);
      cm.switchRoom('r1');
      _answerListDirs(ch);

      await NewSessionRepository(cm, epk: _epk).listDirs();

      expect(ch.sent.single.room, 'r1');
      expect(ch.activeRoom, 'r1');
    });

    test('the reply is awaited with the room it will come from registered first', () async {
      final (cm, ch) = await _online(rooms: [_room('r2', '/b')]);
      String? roomExpectedAtSend;
      ch.onSend = (msg) {
        msg as SpawnSessionRequest;
        roomExpectedAtSend = ch.awaiting[msg.id];
        scheduleMicrotask(
          () => ch.push(
            SpawnResult(
              inReplyTo: msg.id,
              cwd: msg.cwd,
              name: msg.name ?? 'proj',
              persistent: msg.persistent,
              daemonId: 'd1',
            ),
          ),
        );
      };

      final r = await NewSessionRepository(
        cm,
        epk: _epk,
      ).spawn(cwd: '/w/proj', name: 'proj', persistent: true);

      expect(r.daemonId, 'd1');
      expect(r.persistent, isTrue);
      expect(roomExpectedAtSend, 'r2');
      final req = ch.sent.single.msg as SpawnSessionRequest;
      expect(req.cwd, '/w/proj');
      expect(req.persistent, isTrue);
    });

    test('no live session to send through is "unavailable", nothing is sent', () async {
      final (cm, ch) = await _online();
      await expectLater(
        NewSessionRepository(cm, epk: _epk).listDirs(),
        _failure('unavailable'),
      );
      expect(ch.sent, isEmpty);
    });

    test('an error reply becomes a failure with the extension code', () async {
      final (cm, ch) = await _online(rooms: [_room('r1', '/a')]);
      ch.onSend = (msg) {
        msg as SpawnSessionRequest;
        // Someone else's error first: it must not end this request.
        ch.push(
          ErrorMessage(
            inReplyTo: 'act_unrelated',
            code: 'internal_error',
            message: 'nope',
          ),
        );
        scheduleMicrotask(
          () => ch.push(
            ErrorMessage(
              inReplyTo: msg.id,
              code: 'cwd_busy',
              message: 'A session is already running in /w',
            ),
          ),
        );
      };

      await expectLater(
        NewSessionRepository(cm, epk: _epk).spawn(cwd: '/w'),
        throwsA(
          isA<NewSessionFailure>()
              .having((e) => e.code, 'code', 'cwd_busy')
              .having((e) => e.message, 'message', contains('/w')),
        ),
      );
      expect(ch.awaiting, isEmpty);
    });

    test('silence ends in a timeout failure and the expectation is dropped', () async {
      final (cm, ch) = await _online(rooms: [_room('r1', '/a')]);
      final repo = NewSessionRepository(
        cm,
        epk: _epk,
        timeout: const Duration(milliseconds: 60),
      );

      await expectLater(repo.listDirs(), _failure('timeout'));

      expect(ch.cancelled, hasLength(1));
      expect(ch.awaiting, isEmpty);
    });

    test('losing the relay while waiting ends the request, no 15 s hang', () async {
      final (cm, ch) = await _online(rooms: [_room('r1', '/a')]);
      final repo = NewSessionRepository(cm, epk: _epk);

      final pending = repo.listDirs();
      // Sent, unanswered: the link drops.
      unawaited(
        Future<void>.delayed(
          const Duration(milliseconds: 20),
          ch.dropConnection,
        ),
      );

      await expectLater(pending, _failure('disconnected'));
    });
  });

  group('ConnectionManager.sendToRoom', () {
    final probe = ListDirsRequest(id: 'act_probe');

    test('sends nothing unless connected to that PC with that room live', () async {
      final (cm, ch) = await _online(rooms: [_room('r1', '/a')]);

      expect(await cm.sendToRoom('epkB', 'r1', probe, requestId: 'a'), isFalse);
      expect(await cm.sendToRoom(_epk, 'gone', probe, requestId: 'b'), isFalse);
      expect(ch.sent, isEmpty);
      expect(ch.awaiting, isEmpty);

      expect(await cm.sendToRoom(_epk, 'r1', probe, requestId: 'c'), isTrue);
      expect(ch.sent.single.room, 'r1');
      expect(ch.awaiting, {'c': 'r1'});
    });

    test('a manager that never connected sends nothing', () async {
      final cm = ConnectionManager(
        factory: (_, _) async => _Channel(),
        storage: _FakeStorage(),
      );
      addTearDown(cm.dispose);
      expect(await cm.sendToRoom(_epk, 'r1', probe, requestId: 'a'), isFalse);
    });

    test('a failed send is rethrown and the UI room is still restored', () async {
      final (cm, ch) = await _online(rooms: [_room('r1', '/a')]);
      cm.switchRoom('r1');
      ch.onSend = (_) => throw StateError('socket gone');
      // `send` is async: the throw surfaces from awaiting it.
      await expectLater(
        cm.sendToRoom(_epk, 'r1', probe, requestId: 'a'),
        throwsA(isA<StateError>()),
      );
      expect(ch.activeRoom, 'r1');
    });
  });

  group('NewSessionRepository.awaitRoom', () {
    const spawned = SpawnResult(
      inReplyTo: 'act_1',
      cwd: '/w/app/',
      name: 'app',
      persistent: false,
      daemonId: 'd1',
    );

    test('returns the live room that is already there (trailing slash ignored)', () async {
      final (cm, _) = await _online(rooms: [_room('r1', '/w/app', name: 'app')]);
      final room = await NewSessionRepository(cm, epk: _epk).awaitRoom(spawned);
      expect(room?.roomId, 'r1');
    });

    test('waits for the room to be announced', () async {
      final (cm, ch) = await _online(rooms: [_room('other', '/x')]);
      final found = NewSessionRepository(cm, epk: _epk).awaitRoom(spawned);

      await Future<void>.delayed(const Duration(milliseconds: 20));
      ch.pushControl(_room('new', '/w/app', name: 'app'));

      expect((await found)?.roomId, 'new');
    });

    test('among agents in the same folder, the one we named wins', () async {
      final (cm, _) = await _online(
        rooms: [
          _room('old', '/w/app', name: 'another agent'),
          _room('ours', '/w/app', name: 'app'),
        ],
      );
      final room = await NewSessionRepository(cm, epk: _epk).awaitRoom(spawned);
      expect(room?.roomId, 'ours');
    });

    test('gives up with null, not an error, when it never shows up', () async {
      final (cm, _) = await _online(rooms: [_room('other', '/x')]);
      final room = await NewSessionRepository(
        cm,
        epk: _epk,
      ).awaitRoom(spawned, timeout: const Duration(milliseconds: 50));
      expect(room, isNull);
    });

    test('prefers expectedRoomId when matching a revived live room', () async {
      final (cm, _) = await _online(
        rooms: [
          _room('other', '/w/app', name: 'app'),
          _room('revived-room', '/w/app', name: 'custom'),
        ],
      );
      final room = await NewSessionRepository(
        cm,
        epk: _epk,
      ).awaitRoom(spawned, expectedRoomId: 'revived-room');
      expect(room?.roomId, 'revived-room');
    });

    test('spawn forwards resume and roomId when reviving', () async {
      final (cm, ch) = await _online(rooms: [_room('r2', '/b')]);
      ch.onSend = (msg) {
        msg as SpawnSessionRequest;
        scheduleMicrotask(
          () => ch.push(
            SpawnResult(
              inReplyTo: msg.id,
              cwd: msg.cwd,
              name: msg.name ?? 'app',
              persistent: msg.persistent,
              daemonId: 'd2',
            ),
          ),
        );
      };

      await NewSessionRepository(cm, epk: _epk).spawn(
        cwd: '/w/app',
        name: 'app',
        resume: true,
        roomId: 'room-abc',
      );
      final req = ch.sent.single.msg as SpawnSessionRequest;
      expect(req.resume, isTrue);
      expect(req.roomId, 'room-abc');
    });
  });

  group('NewSessionFailure.userMessage', () {
    test('an old extension ends in "update Remote OMP", never a hang', () {
      // An extension from before plan 68 either ignores the request (timeout)
      // or rejects the type.
      for (final code in ['timeout', 'unsupported_type']) {
        expect(
          NewSessionFailure(code).userMessage.toLowerCase(),
          contains('update'),
          reason: code,
        );
      }
    });

    test('every code the extension sends has its own text', () {
      final texts = {
        for (final code in [
          'not_found',
          'permission_denied',
          'cwd_busy',
          'already_registered',
          'supervisor_offline',
          'supervisor_outdated',
          'unavailable',
          'offline',
        ])
          code: NewSessionFailure(code).userMessage,
      };
      // `offline` is deliberately shared with `disconnected`; nothing else is.
      expect(texts.values.toSet(), hasLength(texts.length));
      expect(texts['supervisor_offline'], contains('remote-omp install'));
    });

    test('an unknown code falls back to the extension message, then to the code', () {
      expect(
        const NewSessionFailure('weird', 'because').userMessage,
        'because',
      );
      expect(const NewSessionFailure('weird').userMessage, contains('weird'));
    });
  });
}

// Plan 68 — what Home needs to know before offering "New session" on a PC.

import 'dart:async';

import 'package:app/data/local/app_database.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/home/viewmodels/home_viewmodel.dart';
import 'package:flutter_test/flutter_test.dart';

const _pcA = PeerRecord(
  remoteEpk: 'epk_A',
  sessionName: 'PC A',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);
const _pcB = PeerRecord(
  remoteEpk: 'epk_B',
  sessionName: 'PC B',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-02T00:00:00Z',
);

class _FakeStorage extends PairingStorage {
  _FakeStorage() : super(AppDatabase.memory());

  @override
  Future<List<PeerRecord>> listPeers() async => [_pcA, _pcB];

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

class _Channel implements IChannel, IControlLink {
  final _messages = StreamController<ServerMessage>.broadcast();
  final _control = StreamController<ControlInbound>.broadcast();

  @override
  Stream<ServerMessage> get serverMessages => _messages.stream;
  @override
  Future<void> send(ClientMessage msg) async {}
  @override
  Stream<ControlInbound> get controlFrames => _control.stream;
  @override
  void sendControl(Map<String, dynamic> json) {}
  @override
  Future<void> close() async {
    await _messages.close();
    await _control.close();
  }

  void pushControl(ControlInbound c) => _control.add(c);
}

Future<void> _settle() =>
    Future<void>.delayed(const Duration(milliseconds: 10));

void main() {
  late _Channel ch;
  late ConnectionManager conn;
  late HomeViewModel vm;

  setUp(() {
    ch = _Channel();
    conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(),
      emitDebounce: Duration.zero,
    );
    vm = HomeViewModel(_FakeStorage(), Preferences(AppDatabase.memory()), conn);
    addTearDown(() async {
      vm.dispose();
      await conn.disconnect();
      conn.dispose();
    });
  });

  test('not offered before the relay is up', () {
    expect(vm.canStartSession('epk_A'), isFalse);
  });

  test('offered once the connected PC has a live session', () async {
    await conn.connectTo(_pcA);
    await _settle();
    // Connected, but nothing to send the request through yet.
    expect(vm.canStartSession('epk_A'), isFalse);

    ch.pushControl(
      const RoomAnnounced(
        peer: 'epk_A',
        roomId: 'r1',
        name: 'app',
        cwd: '/w/app',
        startedAt: 1,
      ),
    );
    await _settle();
    expect(vm.canStartSession('epk_A'), isTrue);
  });

  test('not offered for a PC the app is not connected to', () async {
    await conn.connectTo(_pcA);
    await _settle();
    ch.pushControl(
      const RoomAnnounced(peer: 'epk_A', roomId: 'r1', startedAt: 1),
    );
    await _settle();

    expect(vm.canStartSession('epk_B'), isFalse);
  });

  test('a session that ended no longer counts as live', () async {
    await conn.connectTo(_pcA);
    await _settle();
    ch.pushControl(
      const RoomAnnounced(peer: 'epk_A', roomId: 'r1', startedAt: 1),
    );
    await _settle();
    expect(vm.canStartSession('epk_A'), isTrue);

    ch.pushControl(
      const RoomEnded(peer: 'epk_A', roomId: 'r1', sinceTs: 2),
    );
    await _settle();
    expect(vm.canStartSession('epk_A'), isFalse);
  });

  test('liveSessionFolders lists only the folders of live sessions', () async {
    await conn.connectTo(_pcA);
    await _settle();
    ch.pushControl(
      const RoomAnnounced(
        peer: 'epk_A',
        roomId: 'r1',
        cwd: '/w/app',
        startedAt: 1,
      ),
    );
    ch.pushControl(
      const RoomAnnounced(
        peer: 'epk_A',
        roomId: 'r2',
        cwd: '/w/api',
        startedAt: 2,
      ),
    );
    ch.pushControl(
      const RoomAnnounced(peer: 'epk_A', roomId: 'r3', startedAt: 3),
    );
    await _settle();
    ch.pushControl(const RoomEnded(peer: 'epk_A', roomId: 'r2', sinceTs: 4));
    await _settle();

    expect(vm.liveSessionFolders('epk_A'), {'/w/app'});
    expect(vm.liveSessionFolders('epk_B'), isEmpty);
  });
}

import 'dart:async';

import 'package:app/data/actions/new_session_repository.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/domain/contracts/dismissed_update_store.dart';
import 'package:app/domain/contracts/update_checker.dart';
import 'package:app/domain/contracts/url_opener.dart';
import 'package:app/domain/entities/update_info.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/home/home_page.dart';
import 'package:app/ui/home/states/home_state.dart';
import 'package:app/ui/home/viewmodels/home_viewmodel.dart';
import 'package:app/ui/home/widgets/widgets.dart';
import 'package:app/ui/update/viewmodels/update_banner_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

const _pcA = PeerRecord(
  remoteEpk: 'epk_A',
  sessionName: 'PC A',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _FakeStorage extends PairingStorage {
  final List<PeerRecord> peers;
  _FakeStorage([this.peers = const [_pcA]]) : super(AppDatabase.memory());

  @override
  Future<List<PeerRecord>> listPeers() async => List.of(peers);

  @override
  Future<void> savePeer(
    PeerRecord r, {
    required PeerSaveIntent intent,
  }) async {}

  @override
  Future<void> deletePeer(String epk) async {}

  final Map<String, List<PersistedRoom>> _rooms = {};
  @override
  Future<void> saveRooms(String epk, List<PersistedRoom> rooms) async =>
      _rooms[epk] = rooms;

  @override
  Future<List<PersistedRoom>> loadRooms(String epk) async =>
      _rooms[epk] ?? const [];

  @override
  Future<void> deleteRooms(String epk) async => _rooms.remove(epk);
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

class _FakeRequester implements NewSessionRequester {
  final List<({String cwd, String? name, bool persistent, bool resume, String? roomId})>
  spawnCalls = [];
  final List<({SpawnResult result, String? expectedRoomId})> awaitCalls = [];

  Future<SpawnResult> Function(
    String cwd,
    String? name,
    bool persistent,
    bool resume,
    String? roomId,
  )?
  onSpawn;
  Future<RoomInfo?> Function(SpawnResult result, String? expectedRoomId)? onAwait;

  @override
  Future<DirsListResult> listDirs({String? path}) => throw UnimplementedError();

  @override
  Future<SpawnResult> spawn({
    required String cwd,
    String? name,
    bool persistent = false,
    bool resume = false,
    String? roomId,
  }) {
    spawnCalls.add((
      cwd: cwd,
      name: name,
      persistent: persistent,
      resume: resume,
      roomId: roomId,
    ));
    final h = onSpawn;
    if (h != null) return h(cwd, name, persistent, resume, roomId);
    return Future.value(
      SpawnResult(
        inReplyTo: 'r1',
        cwd: cwd,
        name: name ?? 'agent',
        persistent: persistent,
        daemonId: 'd1',
      ),
    );
  }

  @override
  Future<RoomInfo?> awaitRoom(
    SpawnResult result, {
    Duration timeout = const Duration(seconds: 20),
    String? expectedRoomId,
  }) {
    awaitCalls.add((result: result, expectedRoomId: expectedRoomId));
    final h = onAwait;
    if (h != null) return h(result, expectedRoomId);
    return Future.value(
      RoomInfo(
        roomId: expectedRoomId ?? 'r_revived',
        startedAt: 2,
        name: result.name,
        cwd: result.cwd,
      ),
    );
  }
}

class _NoChecker implements UpdateChecker {
  @override
  Future<UpdateInfo?> fetchLatest() async => null;
}

class _NoDismissed implements DismissedUpdateStore {
  @override
  Future<String?> dismissedVersion() async => null;
  @override
  Future<void> dismiss(String version) async {}
}

class _NoOpener implements UrlOpener {
  @override
  Future<bool> open(String url) async => true;
}

Future<void> _settle() =>
    Future<void>.delayed(const Duration(milliseconds: 10));

void main() {
  late _Channel ch;
  late _FakeStorage storage;
  late ConnectionManager conn;
  late _FakeRequester requester;
  late HomeViewModel vm;

  setUp(() {
    ch = _Channel();
    storage = _FakeStorage();
    conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: storage,
      emitDebounce: Duration.zero,
    );
    requester = _FakeRequester();
    vm = HomeViewModel(
      storage,
      Preferences(AppDatabase.memory()),
      conn,
      requesterFactory: (_) => requester,
    );
  });

  tearDown(() async {
    vm.dispose();
    await conn.disconnect();
    conn.dispose();
  });

  test('canReviveSession requires offline room with cwd, another live room, and free folder', () async {
    const offline = RoomInfo(
      roomId: 'r_off',
      startedAt: 1,
      name: 'proj',
      cwd: '/w/proj',
    );
    const liveOther = RoomInfo(
      roomId: 'r_live',
      startedAt: 2,
      name: 'home',
      cwd: '/w/home',
    );
    const noCwd = RoomInfo(roomId: 'r_nocwd', startedAt: 3, name: 'x');

    // Relay not up yet.
    expect(vm.canReviveSession(_pcA.remoteEpk, offline), isFalse);

    await conn.connectTo(_pcA);
    await _settle();
    ch.pushControl(
      const RoomAnnounced(
        peer: 'epk_A',
        roomId: 'r_live',
        name: 'home',
        cwd: '/w/home',
        startedAt: 2,
      ),
    );
    ch.pushControl(
      const RoomAnnounced(
        peer: 'epk_A',
        roomId: 'r_off',
        name: 'proj',
        cwd: '/w/proj',
        startedAt: 1,
      ),
    );
    ch.pushControl(const RoomEnded(peer: 'epk_A', roomId: 'r_off', sinceTs: 5));
    await _settle();

    expect(vm.canReviveSession(_pcA.remoteEpk, offline), isTrue);
    expect(vm.canReviveSession(_pcA.remoteEpk, liveOther), isFalse);
    expect(vm.canReviveSession(_pcA.remoteEpk, noCwd), isFalse);

    // Another live room already running in the same cwd (trailing slash ignored).
    ch.pushControl(
      const RoomAnnounced(
        peer: 'epk_A',
        roomId: 'r_same_cwd',
        name: 'proj2',
        cwd: '/w/proj/',
        startedAt: 6,
      ),
    );
    await _settle();
    expect(vm.canReviveSession(_pcA.remoteEpk, offline), isFalse);
  });

  test('reviveSession tracks in-flight state, sends resume: true, and ignores duplicate taps', () async {
    const offline = RoomInfo(
      roomId: 'r_off',
      startedAt: 1,
      name: 'proj',
      cwd: '/w/proj',
    );
    final spawnGate = Completer<SpawnResult>();
    requester.onSpawn = (_, _, _, _, _) => spawnGate.future;

    final first = vm.reviveSession(_pcA.remoteEpk, offline);
    expect(vm.isReviving(_pcA.remoteEpk, 'r_off'), isTrue);
    expect(await vm.reviveSession(_pcA.remoteEpk, offline), isNull);
    expect(requester.spawnCalls, hasLength(1));

    spawnGate.complete(
      const SpawnResult(
        inReplyTo: 'r1',
        cwd: '/w/proj',
        name: 'proj',
        persistent: false,
        daemonId: 'd1',
      ),
    );
    final outcome = await first;
    expect(outcome?.room?.roomId, 'r_off');
    expect(vm.isReviving(_pcA.remoteEpk, 'r_off'), isFalse);
    expect(requester.spawnCalls.single, (
      cwd: '/w/proj',
      name: 'proj',
      persistent: false,
      resume: true,
      roomId: 'r_off',
    ));
    expect(requester.awaitCalls.single.expectedRoomId, 'r_off');
  });

  test('reviveSession clears isReviving when spawn throws NewSessionFailure', () async {
    const offline = RoomInfo(
      roomId: 'r_off',
      startedAt: 1,
      name: 'proj',
      cwd: '/w/proj',
    );
    requester.onSpawn = (_, _, _, _, _) async =>
        throw const NewSessionFailure('supervisor_offline');

    await expectLater(
      vm.reviveSession(_pcA.remoteEpk, offline),
      throwsA(isA<NewSessionFailure>()),
    );
    expect(vm.isReviving(_pcA.remoteEpk, 'r_off'), isFalse);
  });

  testWidgets('SessionTile renders Revive button and fires onRevive without onOpen', (
    tester,
  ) async {
    var opened = 0;
    var revived = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildDarkTheme(),
        home: Scaffold(
          body: SessionTile(
            peer: _pcA,
            isLive: false,
            room: const RoomInfo(roomId: 'r_off', startedAt: 1, cwd: '/w/proj'),
            onOpen: () => opened++,
            onRevive: () => revived++,
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('Revive session'));
    await tester.pump();
    expect(revived, 1);
    expect(opened, 0);
  });

  testWidgets('HomePage shows Revive on offline tile, in long-press menu, and shows error snackbar', (
    tester,
  ) async {
    final pageCh = _Channel();
    final pageStorage = _FakeStorage();
    final pageConn = ConnectionManager(
      factory: (_, _) async => pageCh,
      storage: pageStorage,
      emitDebounce: Duration.zero,
    );
    final pageReq = _FakeRequester();
    final pageVm = HomeViewModel(
      pageStorage,
      Preferences(AppDatabase.memory()),
      pageConn,
      requesterFactory: (_) => pageReq,
    );
    await pageConn.connectTo(_pcA);
    await tester.pump(const Duration(milliseconds: 20));
    pageCh.pushControl(
      const RoomAnnounced(
        peer: 'epk_A',
        roomId: 'r_live',
        name: 'home',
        cwd: '/w/home',
        startedAt: 1,
      ),
    );
    pageCh.pushControl(
      const RoomAnnounced(
        peer: 'epk_A',
        roomId: 'r_off',
        name: 'proj',
        cwd: '/w/proj',
        startedAt: 2,
      ),
    );
    pageCh.pushControl(
      const RoomEnded(peer: 'epk_A', roomId: 'r_off', sinceTs: 3),
    );
    await tester.pump(const Duration(milliseconds: 20));
    expect(pageVm.state, isA<HomeList>());
    pageVm.setFilter(HomeFilter.offline);

    final banner = UpdateBannerViewModel(
      _NoChecker(),
      _NoDismissed(),
      _NoOpener(),
      currentVersion: '2.0.0',
      enabled: false,
    );

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<HomeViewModel>.value(value: pageVm),
          ChangeNotifierProvider<ShellLayout>.value(value: ShellLayout()),
          ChangeNotifierProvider<SessionSelection>.value(value: SessionSelection()),
          ChangeNotifierProvider<UpdateBannerViewModel>.value(value: banner),
        ],
        child: MaterialApp(theme: buildDarkTheme(), home: const HomePage()),
      ),
    );
    await tester.pump();

    expect(find.byTooltip('Revive session'), findsOneWidget);

    // Trigger failure via long-press menu -> Revive session.
    pageReq.onSpawn = (_, _, _, _, _) async =>
        throw const NewSessionFailure('supervisor_offline');
    await tester.longPress(find.text('proj'));
    await tester.pumpAndSettle();
    expect(find.text('Revive session'), findsOneWidget);
    await tester.tap(find.text('Revive session'));
    await tester.pumpAndSettle();

    expect(pageReq.spawnCalls, hasLength(1));
    expect(pageReq.spawnCalls.single.resume, isTrue);
    expect(
      find.textContaining('Run "remote-omp install" there.'),
      findsOneWidget,
    );

    await tester.pumpWidget(const SizedBox());
    pageVm.dispose();
    banner.dispose();
    await pageConn.disconnect();
    pageConn.dispose();
  });
}

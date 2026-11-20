import 'dart:async';

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/data/actions/new_session_repository.dart';
import 'package:app/data/images/image_picker_service.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/local/session_store.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/repositories/session_read_repository.dart';
import 'package:app/data/sync/sync_service.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/data/voice/speech_service.dart';
import 'package:app/domain/session_state.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/chat/attachment/viewmodels/attachment_viewmodel.dart';
import 'package:app/ui/chat/chat_page.dart';
import 'package:app/ui/chat/states/chat_state.dart';
import 'package:app/ui/chat/viewmodels/chat_viewmodel.dart';
import 'package:app/ui/chat/voice/viewmodels/voice_input_viewmodel.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

const _peer = PeerRecord(
  remoteEpk: 'epk_chat_revive',
  sessionName: 'Test PC',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _FakeStorage extends PairingStorage {
  _FakeStorage() : super(AppDatabase.memory());

  @override
  Future<List<PeerRecord>> listPeers() async => const [_peer];
  @override
  Future<PeerRecord?> loadPeer(String epk) async =>
      epk == _peer.remoteEpk ? _peer : null;
  @override
  Future<void> savePeer(
    PeerRecord r, {
    required PeerSaveIntent intent,
  }) async {}

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

class _FakeChannel implements IChannel, IControlLink {
  final _ctrl = StreamController<ServerMessage>.broadcast();
  final _control = StreamController<ControlInbound>.broadcast();
  final List<ClientMessage> sent = [];

  @override
  Stream<ServerMessage> get serverMessages => _ctrl.stream;
  @override
  Stream<ControlInbound> get controlFrames => _control.stream;
  @override
  void sendControl(Map<String, dynamic> json) {}
  @override
  Future<void> send(ClientMessage msg) async => sent.add(msg);
  @override
  Future<void> close() async {
    await _ctrl.close();
    await _control.close();
  }

  void push(ServerMessage m) => _ctrl.add(m);
  void pushControl(ControlInbound c) => _control.add(c);
}

class _FakeRequester implements NewSessionRequester {
  final List<({String cwd, String? name, bool resume, String? roomId})>
  spawnCalls = [];
  Future<SpawnResult> Function()? onSpawn;
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
    spawnCalls.add((cwd: cwd, name: name, resume: resume, roomId: roomId));
    final h = onSpawn;
    if (h != null) return h();
    return Future.value(
      SpawnResult(
        inReplyTo: 'r1',
        cwd: cwd,
        name: name ?? 'proj',
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
    final h = onAwait;
    if (h != null) return h(result, expectedRoomId);
    return Future.value(
      RoomInfo(
        roomId: expectedRoomId ?? 'r_off',
        startedAt: 2,
        name: result.name,
        cwd: result.cwd,
      ),
    );
  }
}

class _FakeChatVm extends ChangeNotifier implements ChatViewModel {
  @override
  ChatState state;
  @override
  bool canReviveActiveRoom;
  @override
  bool isReviving;
  String? reviveResult;
  int reviveCalls = 0;

  _FakeChatVm(
    this.state, {
    this.canReviveActiveRoom = false,
    this.isReviving = false,
    this.reviveResult,
  });

  @override
  Future<String?> reviveActiveRoom() async {
    reviveCalls++;
    return reviveResult;
  }

  @override
  bool get connectionResolved => true;
  @override
  bool get isRoomLive => false;
  @override
  bool get isWorking => false;
  @override
  String? get retryMessageId => null;
  @override
  PeerRecord? get activePeer => _peer;
  @override
  RoomInfo? get activeRoom => null;
  @override
  List<WireSkill> get dynamicSkills => const [];
  @override
  List<WireCommand>? get hostCommands => null;
  @override
  List<String>? get promptHistory => null;
  @override
  String? get cancelTargetId => null;
  @override
  List<QueuedMsg> get queuedMessages => const [];

  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

class _FakeSpeech implements SpeechService {
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

class _FakePicker implements IImagePickerService {
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

Future<void> _settle() =>
    Future<void>.delayed(const Duration(milliseconds: 20));

void main() {
  group('ChatViewModel revive', () {
    late AppDatabase db;
    late SessionStore store;
    late _FakeChannel ch;
    late _FakeStorage storage;
    late ConnectionManager conn;
    late SyncService sync;
    late SessionReadRepository read;
    late Preferences prefs;
    late _FakeRequester requester;
    late ChatViewModel vm;

    setUp(() async {
      db = AppDatabase.memory();
      store = SessionStore(db);
      ch = _FakeChannel();
      storage = _FakeStorage();
      conn = ConnectionManager(
        factory: (_, _) async => ch,
        storage: storage,
        emitDebounce: Duration.zero,
      );
      sync = SyncService(conn, store);
      read = SessionReadRepository(store);
      prefs = Preferences(db);
      requester = _FakeRequester();

      await prefs.setSelectedRoom(epk: _peer.remoteEpk, roomId: 'r_off');
      await conn.connectTo(_peer);
      await _settle();

      ch.pushControl(
        const RoomAnnounced(
          peer: 'epk_chat_revive',
          roomId: 'r_live',
          name: 'home',
          cwd: '/w/home',
          startedAt: 1,
        ),
      );
      ch.pushControl(
        const RoomAnnounced(
          peer: 'epk_chat_revive',
          roomId: 'r_off',
          name: 'proj',
          cwd: '/w/proj',
          startedAt: 2,
        ),
      );
      ch.pushControl(
        const RoomEnded(
          peer: 'epk_chat_revive',
          roomId: 'r_off',
          sinceTs: 3,
        ),
      );
      await _settle();

      vm = ChatViewModel(
        read,
        sync,
        conn,
        prefs,
        storage,
        ActionsRepository(conn),
        newSessionRequester: (_) => requester,
      );
      await _settle();
    });

    tearDown(() async {
      vm.dispose();
      sync.dispose();
      await conn.disconnect();
      conn.dispose();
      store.dispose();
      db.dispose();
    });

    test('offers revive only while room is offline and PC has another live room', () async {
      expect(vm.canReviveActiveRoom, isTrue);

      // Room comes live -> revive hides and sync runs.
      ch.sent.clear();
      ch.push(Bye(reason: ByeReason.shutdown, rawReason: 'shutdown'));
      await _settle();
      expect((vm.state as ChatReady).peerOfflineReason, 'shutdown');

      ch.pushControl(
        const RoomAnnounced(
          peer: 'epk_chat_revive',
          roomId: 'r_off',
          name: 'proj',
          cwd: '/w/proj',
          startedAt: 4,
        ),
      );
      await _settle();

      expect(vm.canReviveActiveRoom, isFalse);
      expect((vm.state as ChatReady).peerOfflineReason, isNull);
      expect(ch.sent.whereType<SessionSync>(), isNotEmpty);
    });

    test('reviveActiveRoom sends resume: true, clears peerOfflineReason, and syncs', () async {
      ch.push(Bye(reason: ByeReason.shutdown, rawReason: 'shutdown'));
      await _settle();
      ch.sent.clear();

      requester.onAwait = (result, expectedRoomId) async {
        ch.pushControl(
          RoomAnnounced(
            peer: _peer.remoteEpk,
            roomId: 'r_off',
            name: result.name,
            cwd: result.cwd,
            startedAt: 10,
          ),
        );
        await _settle();
        return RoomInfo(
          roomId: 'r_off',
          startedAt: 10,
          name: result.name,
          cwd: result.cwd,
        );
      };

      final msg = await vm.reviveActiveRoom();
      expect(msg, isNull);
      expect(requester.spawnCalls.single, (
        cwd: '/w/proj',
        name: 'proj',
        resume: true,
        roomId: 'r_off',
      ));
      expect((vm.state as ChatReady).peerOfflineReason, isNull);
      expect(ch.sent.whereType<SessionSync>(), isNotEmpty);
    });

    test('returns friendly message on timeout or NewSessionFailure', () async {
      requester.onAwait = (_, _) async => null;
      expect(
        await vm.reviveActiveRoom(),
        'Reviving "proj"… It will connect shortly.',
      );

      requester.onSpawn = () async =>
          throw const NewSessionFailure('supervisor_offline');
      expect(
        await vm.reviveActiveRoom(),
        contains('Run "remote-omp install" there.'),
      );
      expect(vm.isReviving, isFalse);
    });
  });

  group('ChatPage _ReviveSessionBar', () {
    final cleanups = <Future<void> Function()>[];

    Future<void> unmount(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      for (final c in cleanups) {
        await c();
      }
      cleanups.clear();
    }

    Future<_FakeChatVm> pumpPage(
      WidgetTester tester, {
      required ChatState state,
      bool canRevive = false,
      bool isReviving = false,
      String? reviveResult,
    }) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 2.0;
      addTearDown(tester.view.reset);

      final db = AppDatabase.memory();
      final prefs = Preferences(db);
      final conn = ConnectionManager(
        factory: (_, _) async => _FakeChannel(),
        storage: _FakeStorage(),
      );
      final actions = ActionsRepository(conn);
      final voice = VoiceInputViewModel(_FakeSpeech());
      final attach = AttachmentViewModel(_FakePicker(), actions);
      final sel = SessionSelection();
      final vm = _FakeChatVm(
        state,
        canReviveActiveRoom: canRevive,
        isReviving: isReviving,
        reviveResult: reviveResult,
      );
      cleanups.add(() async {
        vm.dispose();
        attach.dispose();
        voice.dispose();
        actions.dispose();
        sel.dispose();
        await conn.disconnect();
        conn.dispose();
        db.dispose();
      });

      await tester.pumpWidget(
        MaterialApp(
          theme: buildDarkTheme(),
          home: MultiProvider(
            providers: [
              ChangeNotifierProvider<ChatViewModel>.value(value: vm),
              ChangeNotifierProvider<VoiceInputViewModel>.value(value: voice),
              ChangeNotifierProvider<AttachmentViewModel>.value(value: attach),
              ChangeNotifierProvider<Preferences>.value(value: prefs),
              ChangeNotifierProvider<SessionSelection>.value(value: sel),
            ],
            child: const ChatPage(
              initialTitle: 'proj',
              initialDevice: 'Test PC',
              initialOnline: false,
            ),
          ),
        ),
      );
      await tester.pump();
      return vm;
    }

    testWidgets('shows Revive bar when offline and revivable, hides otherwise', (
      tester,
    ) async {
      await pumpPage(
        tester,
        state: const ChatReady(messages: [], isOffline: false),
        canRevive: false,
      );
      expect(find.byKey(const Key('chat_revive_bar')), findsNothing);
      await unmount(tester);

      final vm = await pumpPage(
        tester,
        state: const ChatReady(messages: [], isOffline: false),
        canRevive: true,
        reviveResult: 'Reviving "proj"… It will connect shortly.',
      );
      expect(find.byKey(const Key('chat_revive_bar')), findsOneWidget);
      expect(find.text('Session is offline'), findsOneWidget);
      await tester.tap(find.text('Revive'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(vm.reviveCalls, 1);
      expect(
        find.text('Reviving "proj"… It will connect shortly.'),
        findsOneWidget,
      );
      await unmount(tester);
    });

    testWidgets('shows Reviving… spinner and hides when pairing revoked', (
      tester,
    ) async {
      await pumpPage(
        tester,
        state: const ChatReady(messages: [], isOffline: false),
        canRevive: true,
        isReviving: true,
      );
      expect(find.text('Reviving…'), findsOneWidget);
      await unmount(tester);

      await pumpPage(
        tester,
        state: const ChatReady(messages: [], pairingRevoked: true),
        canRevive: true,
      );
      expect(find.byKey(const Key('chat_revive_bar')), findsNothing);
      await unmount(tester);
    });
  });
}

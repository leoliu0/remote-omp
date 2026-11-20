// Regression: Back while the composer's @ suggestions are showing closes the
// suggestions only. ChatPage's fullscreen PopScope is also notified of a
// blocked pop and must not lock portrait / reset the landscape composer.

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/data/images/image_picker_service.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/preferences/preferences.dart';
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
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

const _peer = PeerRecord(
  remoteEpk: 'epk_back_test',
  sessionName: 'Test Pi',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _FakeChatViewModel extends ChangeNotifier implements ChatViewModel {
  @override
  ChatState state = const ChatReady(messages: []);

  @override
  Future<List<String>> searchFiles(String query, {int? limit}) async => [
    'omp-extension/src/daemon/supervisor.ts',
  ];

  @override
  bool get connectionResolved => true;
  @override
  bool get isRoomLive => true;
  @override
  bool get canReviveActiveRoom => false;
  @override
  bool get isReviving => false;
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

class _FakeChannel implements IChannel {
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

class _FakeStorage extends PairingStorage {
  _FakeStorage() : super(AppDatabase.memory());
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

void main() {
  testWidgets('Back closes the @ suggestions without touching orientation', (
    tester,
  ) async {
    final calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method.startsWith('SystemChrome.set')) calls.add(call);
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.0;
    addTearDown(tester.view.reset);

    final prefs = Preferences(AppDatabase.memory());
    final vm = _FakeChatViewModel();
    final voice = VoiceInputViewModel(_FakeSpeech());
    final conn = ConnectionManager(
      factory: (_, _) async => _FakeChannel(),
      storage: _FakeStorage(),
    );
    final actions = ActionsRepository(conn);
    final attach = AttachmentViewModel(_FakePicker(), actions);
    final sel = SessionSelection();
    await tester.pumpWidget(
      MaterialApp(
        home: MultiProvider(
          providers: [
            ChangeNotifierProvider<ChatViewModel>.value(value: vm),
            ChangeNotifierProvider<VoiceInputViewModel>.value(value: voice),
            ChangeNotifierProvider<AttachmentViewModel>.value(value: attach),
            ChangeNotifierProvider<Preferences>.value(value: prefs),
            ChangeNotifierProvider<SessionSelection>.value(value: sel),
          ],
          child: const ChatPage(
            initialTitle: 'Test Session',
            initialDevice: 'MacBook',
            initialOnline: true,
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.enterText(find.byType(TextField), '@sup');
    await tester.pump(const Duration(milliseconds: 130));
    await tester.pump();
    expect(find.byKey(const Key('file-mention-menu')), findsOneWidget);

    calls.clear(); // ignore the app's own startup chrome calls
    await tester.binding.handlePopRoute(); // Android Back
    await tester.pump();

    expect(find.byKey(const Key('file-mention-menu')), findsNothing);
    expect(
      calls.map((c) => '${c.method} ${c.arguments}'),
      isNot(contains(
        'SystemChrome.setPreferredOrientations [DeviceOrientation.portraitUp]',
      )),
    );
    expect(calls, isEmpty);

    await tester.pumpWidget(const SizedBox());
    vm.dispose();
    attach.dispose();
    voice.dispose();
    actions.dispose();
    sel.dispose();
    conn.dispose();
  });
}

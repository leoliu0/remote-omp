// ChatPage wiring for Plan 68: the Retry button under a failed turn (what it
// calls, what a refusal shows) and the session colour bar / switcher tap target
// in the app bar.

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
import 'package:app/ui/chat/widgets/retry_turn_button.dart';
import 'package:app/ui/core/themes/session_color.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

const _peer = PeerRecord(
  remoteEpk: 'epk_retry_page',
  sessionName: 'Test Pi',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

const _failedTurn = AssistantMsg(
  id: 'err_1',
  text: '⚠ provider_error: overloaded',
  errorCode: kProviderErrorCode,
);

class _FakeChatViewModel extends ChangeNotifier implements ChatViewModel {
  @override
  ChatState state;

  /// The id the real view model derives from the transcript; set per test.
  @override
  String? retryMessageId;

  /// What [retryTurn] resolves to: null = scheduled, text = refusal.
  String? retryResult;
  int retries = 0;

  _FakeChatViewModel(this.state, {this.retryMessageId, this.retryResult});

  @override
  Future<String?> retryTurn() async {
    retries++;
    return retryResult;
  }

  @override
  bool get connectionResolved => true;
  @override
  bool get isRoomLive => true;
  @override
  bool get isWorking => false;
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
  final cleanups = <void Function()>[];

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    for (final c in cleanups) {
      c();
    }
    cleanups.clear();
  }

  Future<_FakeChatViewModel> pumpChat(
    WidgetTester tester, {
    String? retryMessageId,
    String? retryResult,
  }) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.0;
    addTearDown(tester.view.reset);
    final prefs = Preferences(AppDatabase.memory());
    final vm = _FakeChatViewModel(
      const ChatReady(
        messages: [UserMsg(id: 'u1', text: 'run it'), _failedTurn],
      ),
      retryMessageId: retryMessageId,
      retryResult: retryResult,
    );
    final voice = VoiceInputViewModel(_FakeSpeech());
    final conn = ConnectionManager(
      factory: (_, _) async => _FakeChannel(),
      storage: _FakeStorage(),
    );
    final actions = ActionsRepository(conn);
    final attach = AttachmentViewModel(_FakePicker(), actions);
    final sel = SessionSelection();
    cleanups.add(() {
      vm.dispose();
      attach.dispose();
      voice.dispose();
      actions.dispose();
      sel.dispose();
      conn.dispose();
    });
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
    return vm;
  }

  final retryButton = find.byKey(const Key('retry_turn_button'));

  testWidgets('Retry sits under the failed turn and runs retryTurn once', (
    tester,
  ) async {
    final vm = await pumpChat(tester, retryMessageId: 'err_1');
    expect(retryButton, findsOneWidget);

    await tester.tap(retryButton);
    await tester.pump();
    await tester.pump();

    expect(vm.retries, 1);
    // Scheduled: the button waits for the turn to stream (and goes away with
    // it) instead of offering a second tap.
    expect(find.text('Retrying…'), findsOneWidget);

    await unmount(tester);
  });

  testWidgets('no Retry when the view model offers none (busy, or not the newest item)', (
    tester,
  ) async {
    await pumpChat(tester, retryMessageId: null);
    expect(find.byType(RetryTurnButton), findsNothing);

    await unmount(tester);
  });

  testWidgets("a refused retry shows the extension's message and offers Retry again", (
    tester,
  ) async {
    final vm = await pumpChat(
      tester,
      retryMessageId: 'err_1',
      retryResult: 'Nothing to retry.',
    );

    await tester.tap(retryButton);
    await tester.pump();
    await tester.pump();

    expect(vm.retries, 1);
    expect(find.text('Nothing to retry.'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);

    await unmount(tester);
  });

  testWidgets('the app bar carries the session colour and the switcher tap target', (
    tester,
  ) async {
    await pumpChat(tester);

    expect(find.byKey(const Key('chat_title_switcher')), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('chat_title_switcher')),
        matching: find.byType(SessionColorBar),
      ),
      findsOneWidget,
    );

    await unmount(tester);
  });
}

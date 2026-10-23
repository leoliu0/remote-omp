// Landscape chat: transcript only, composer on demand.

import 'dart:async';

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/data/images/image_picker_service.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/local/session_store.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/repositories/session_read_repository.dart';
import 'package:app/data/sync/sync_service.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/data/voice/speech_service.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/chat/attachment/viewmodels/attachment_viewmodel.dart';
import 'package:app/ui/chat/chat_page.dart';
import 'package:app/ui/chat/widgets/input_bar.dart';
import 'package:app/ui/chat/viewmodels/chat_viewmodel.dart';
import 'package:app/ui/chat/voice/viewmodels/voice_input_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

class _FakeChannel implements IChannel {
  final _ctrl = StreamController<ServerMessage>.broadcast();
  @override
  Stream<ServerMessage> get serverMessages => _ctrl.stream;
  @override
  Future<void> send(ClientMessage msg) async {}
  @override
  Future<void> close() => _ctrl.close();
}

/// No peer paired → ChatViewModel stays with activePeer == null (the case we
/// want: the subtitle must come from initialDevice, not the PeerRecord).
class _FakeStorage extends PairingStorage {
  _FakeStorage() : super(AppDatabase.memory());
  @override
  Future<List<PeerRecord>> listPeers() async => const [];
  @override
  Future<PeerRecord?> loadPeer(String epk) async => null;
}

class _FakeSpeech implements SpeechService {
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

class _FakePicker implements IImagePickerService {
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

void main() {
  // In landscape the chat gives the screen to the transcript: no top bar, no
  // composer. A floating keyboard button shows and hides the composer.
  Future<void> withChat(
    WidgetTester tester,
    Size size,
    Future<void> Function() body,
  ) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio =
        2.5; // 2560x1600 → 1024x640; 2400x1080 → 960x432
    addTearDown(tester.view.reset);
    final database = AppDatabase.memory();
    addTearDown(database.dispose);
    final store = SessionStore(database);
    final conn = ConnectionManager(
      factory: (_, _) async => _FakeChannel(),
      storage: _FakeStorage(),
    );
    final sync = SyncService(conn, store);
    final read = SessionReadRepository(store);
    final prefs = Preferences(database);
    final actions = ActionsRepository(conn);
    final vm = ChatViewModel(read, sync, conn, prefs, _FakeStorage(), actions);
    final voice = VoiceInputViewModel(_FakeSpeech());
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
            initialTitle: 'My Project',
            initialDevice: 'MacBook',
            initialOnline: true,
          ),
        ),
      ),
    );
    await tester.pump();
    await body();
    await tester.pumpWidget(const SizedBox());
    vm.dispose();
    attach.dispose();
    voice.dispose();
    actions.dispose();
    sync.dispose();
    sel.dispose();
    conn.dispose();
  }

  const composeKey = Key('chat_landscape_compose');
  final composer = find.byKey(const Key('chat_composer'));

  testWidgets('portrait keeps the top bar and the composer', (tester) async {
    await withChat(tester, const Size(1080, 2400), () async {
      expect(find.text('My Project'), findsOneWidget);
      expect(composer, findsOneWidget);
      expect(find.byKey(composeKey), findsNothing);
    });
  });

  testWidgets('a tablet in landscape keeps the top bar and the composer', (
    tester,
  ) async {
    await withChat(tester, const Size(2560, 1600), () async {
      expect(find.text('My Project'), findsOneWidget);
      expect(composer, findsOneWidget);
      expect(find.byKey(composeKey), findsNothing);
    });
  });

  testWidgets(
    'landscape hides the top bar and the composer; the button toggles the composer',
    (tester) async {
      await withChat(tester, const Size(2400, 1080), () async {
        expect(find.text('My Project'), findsNothing);
        expect(composer, findsNothing);
        expect(find.byKey(composeKey), findsOneWidget);

        await tester.tap(find.byKey(composeKey));
        await tester.pump();
        expect(composer, findsOneWidget);
        expect(find.text('My Project'), findsNothing);

        await tester.tap(find.byKey(composeKey));
        await tester.pump();
        expect(composer, findsNothing);
      });
    },
  );

  // Fullscreen: the top-bar button turns a phone sideways (landscape lock,
  // system bars hidden); the exit button in landscape turns it back. Records
  // the SystemChrome calls, since the test surface itself never rotates.
  List<MethodCall> recordSystemChrome(WidgetTester tester) {
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
    return calls;
  }

  const fullscreenKey = Key('chat_fullscreen');
  const exitKey = Key('chat_exit_fullscreen');

  testWidgets('the fullscreen button locks landscape and hides the bars', (
    tester,
  ) async {
    final calls = recordSystemChrome(tester);
    await withChat(tester, const Size(1080, 2400), () async {
      expect(find.byKey(exitKey), findsNothing);
      await tester.tap(find.byKey(fullscreenKey));
      await tester.pump();
      expect(
        calls.map((c) => '${c.method} ${c.arguments}'),
        containsAll([
          'SystemChrome.setEnabledSystemUIMode SystemUiMode.immersiveSticky',
          'SystemChrome.setPreferredOrientations [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]',
        ]),
      );
      calls.clear();
    });
    // Leaving the page releases the lock and brings the bars back.
    expect(
      calls.map((c) => '${c.method} ${c.arguments}'),
      containsAll([
        'SystemChrome.setPreferredOrientations []',
        'SystemChrome.setEnabledSystemUIMode SystemUiMode.edgeToEdge',
      ]),
    );
  });

  testWidgets('the exit button in landscape locks portrait and shows the bars', (
    tester,
  ) async {
    final calls = recordSystemChrome(tester);
    await withChat(tester, const Size(2400, 1080), () async {
      expect(find.byKey(fullscreenKey), findsNothing);
      await tester.tap(find.byKey(exitKey));
      await tester.pump();
      expect(
        calls.map((c) => '${c.method} ${c.arguments}'),
        containsAll([
          'SystemChrome.setEnabledSystemUIMode SystemUiMode.edgeToEdge',
          'SystemChrome.setPreferredOrientations [DeviceOrientation.portraitUp]',
        ]),
      );
    });
  });

  testWidgets('landscape with the keyboard up hides the floating buttons', (
    tester,
  ) async {
    tester.view.viewInsets = const FakeViewPadding(bottom: 600);
    addTearDown(tester.view.resetViewInsets);
    await withChat(tester, const Size(2400, 1080), () async {
      expect(find.byKey(exitKey), findsNothing);
      expect(find.byKey(composeKey), findsNothing);
    });
  });

  testWidgets('a tablet has no fullscreen button', (tester) async {
    await withChat(tester, const Size(1600, 2560), () async {
      expect(find.text('My Project'), findsOneWidget);
      expect(find.byKey(fullscreenKey), findsNothing);
    });
  });

  // The landscape button opens the composer with `autofocus`, so one tap is
  // enough to type.
  for (final autofocus in [true, false]) {
    testWidgets('InputBar autofocus: $autofocus', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: InputBar(onSend: (_) {}, autofocus: autofocus),
          ),
        ),
      );
      await tester.pump();
      final field = tester.widget<EditableText>(find.byType(EditableText));
      expect(field.focusNode.hasFocus, autofocus);
    });
  }
}

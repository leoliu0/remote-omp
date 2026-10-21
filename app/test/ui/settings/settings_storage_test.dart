// Plan 65 — Settings → Storage → "Clear received files".

import 'dart:async';
import 'dart:typed_data';

import 'package:app/data/local/app_database.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/data/transport/peer_channel.dart';
import 'package:app/domain/entities/received_file.dart';
import 'package:app/domain/repositories/received_files_repository.dart';
import 'package:app/pairing/pair_request_flow.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/settings/settings_page.dart';
import 'package:app/ui/settings/viewmodels/settings_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

class _NoopTransport implements PeerTransport {
  @override
  Future<void> send(Uint8List data) async {}
  @override
  Future<Uint8List> receive() => Completer<Uint8List>().future;
  @override
  Future<void> close() async {}
}

class _FakeStorage extends PairingStorage {
  _FakeStorage() : super(AppDatabase.memory());
  @override
  Future<List<PeerRecord>> listPeers() async => const [];
}

class _FakeFiles implements ReceivedFilesRepository {
  int bytes = 3 * 1024 * 1024;
  int clears = 0;
  @override
  Stream<List<ReceivedFile>> watchSession(String epk, String roomId) =>
      const Stream.empty();
  @override
  Future<void> cancel(String fileId) async {}
  @override
  Future<void> clearAll() async {
    clears++;
    bytes = 0;
  }

  @override
  Future<int> diskUsage() async => bytes;
}

void main() {
  Future<(SettingsViewModel, _FakeFiles, void Function())> pumpPage(
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(400, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final prefs = Preferences(AppDatabase.memory());
    await prefs.load();
    final conn = ConnectionManager(
      factory: (_, _) async => PlainPeerChannel(transport: _NoopTransport()),
      storage: _FakeStorage(),
    );
    final files = _FakeFiles();
    final vm = SettingsViewModel(
      _FakeStorage(),
      prefs,
      conn,
      null,
      null,
      null,
      files,
    );
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<Preferences>.value(value: prefs),
          ChangeNotifierProvider<SettingsViewModel>.value(value: vm),
        ],
        child: MaterialApp(theme: buildDarkTheme(), home: const SettingsPage()),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return (
      vm,
      files,
      () {
        vm.dispose();
        conn.dispose();
        prefs.dispose();
      },
    );
  }

  testWidgets('Storage shows usage and clears after confirmation', (
    tester,
  ) async {
    final (_, files, dispose) = await pumpPage(tester);
    expect(find.text('STORAGE'), findsOneWidget);
    final tile = find.byKey(const Key('settings_clear_received_files'));
    expect(tile, findsOneWidget);
    expect(find.text('Clear received files'), findsOneWidget);
    expect(find.textContaining('3.0 MB'), findsOneWidget);

    // Cancel keeps everything.
    await tester.tap(tile);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(files.clears, 0);

    await tester.tap(tile);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();
    expect(files.clears, 1);
    expect(find.text('Received files cleared'), findsOneWidget);
    expect(find.textContaining('0 B'), findsOneWidget);
    // Let the snackbar time out so no timer outlives the test.
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    dispose();
  });

  test('without the repository the view model reports no storage', () async {
    final prefs = Preferences(AppDatabase.memory());
    final conn = ConnectionManager(
      factory: (_, _) async => PlainPeerChannel(transport: _NoopTransport()),
      storage: _FakeStorage(),
    );
    final vm = SettingsViewModel(_FakeStorage(), prefs, conn);
    addTearDown(vm.dispose);
    expect(vm.hasReceivedFiles, isFalse);
    expect(await vm.receivedFilesUsage(), 0);
    await vm.clearReceivedFiles(); // no-op, no throw
  });
}

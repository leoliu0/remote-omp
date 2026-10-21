// Plan 65 step 4 — the chat file card: progress → done → actions; Install
// only for APKs; nothing opens without a tap.

import 'package:app/domain/entities/received_file.dart';
import 'package:app/ui/chat/widgets/file_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

ReceivedFile _file({
  String name = 'report.pdf',
  String mime = 'application/pdf',
  ReceivedFileStatus status = ReceivedFileStatus.done,
  int received = 2 * 1024 * 1024,
  String? errorReason,
}) => ReceivedFile(
  fileId: 'f1',
  epk: 'e',
  roomId: 'main',
  name: name,
  mime: mime,
  size: 2 * 1024 * 1024,
  sha256: 'ab' * 32,
  caption: 'Build output',
  status: status,
  receivedBytes: received,
  path: '/data/received/f1/$name',
  errorReason: errorReason,
  createdAt: DateTime(2026, 10, 20),
  updatedAt: DateTime(2026, 10, 20),
);

void main() {
  final taps = <String>[];

  Future<void> pump(
    WidgetTester tester,
    ReceivedFile file, {
    bool canSave = true,
    bool canInstall = true,
  }) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: FileCard(
          file: file,
          canSaveToDownloads: canSave,
          canInstall: canInstall,
          onOpen: () => taps.add('open'),
          onShare: () => taps.add('share'),
          onSave: () => taps.add('save'),
          onInstall: () => taps.add('install'),
          onCancel: () => taps.add('cancel'),
        ),
      ),
    ),
  );

  setUp(taps.clear);

  testWidgets('receiving: name, size, caption, progress bar, no actions', (
    tester,
  ) async {
    await pump(
      tester,
      _file(status: ReceivedFileStatus.receiving, received: 512 * 1024),
    );
    expect(find.text('report.pdf'), findsOneWidget);
    expect(find.text('Build output'), findsOneWidget);
    expect(find.textContaining('512 KB / 2.0 MB'), findsOneWidget);
    final bar = tester.widget<LinearProgressIndicator>(
      find.byKey(const Key('file_card_progress')),
    );
    expect(bar.value, closeTo(0.25, 1e-9));
    expect(find.byKey(const Key('file_card_open')), findsNothing);
    expect(find.byKey(const Key('file_card_share')), findsNothing);
    expect(taps, isEmpty);

    await tester.tap(find.byKey(const Key('file_card_cancel')));
    expect(taps, ['cancel']);
  });

  testWidgets('done: size, Open / Share / Save, no progress bar', (
    tester,
  ) async {
    await pump(tester, _file());
    expect(find.text('2.0 MB'), findsOneWidget);
    expect(find.byKey(const Key('file_card_progress')), findsNothing);
    expect(find.byKey(const Key('file_card_cancel')), findsNothing);

    await tester.tap(find.byKey(const Key('file_card_open')));
    await tester.tap(find.byKey(const Key('file_card_share')));
    await tester.tap(find.byKey(const Key('file_card_save')));
    expect(taps, ['open', 'share', 'save']);
  });

  testWidgets('progress → done swaps the bar for the actions', (tester) async {
    await pump(
      tester,
      _file(status: ReceivedFileStatus.receiving, received: 1024),
    );
    expect(find.byKey(const Key('file_card_progress')), findsOneWidget);
    await pump(tester, _file());
    expect(find.byKey(const Key('file_card_progress')), findsNothing);
    expect(find.byKey(const Key('file_card_open')), findsOneWidget);
  });

  testWidgets('an APK card shows Install; a PDF card does not', (tester) async {
    await pump(tester, _file());
    expect(find.byKey(const Key('file_card_install')), findsNothing);

    await pump(
      tester,
      _file(name: 'app-release.apk', mime: ReceivedFile.apkMime),
    );
    expect(find.byKey(const Key('file_card_install')), findsOneWidget);
    // Install never fires by itself.
    expect(taps, isEmpty);
    await tester.tap(find.byKey(const Key('file_card_install')));
    expect(taps, ['install']);
  });

  testWidgets('APK detected by extension even with a generic mime', (
    tester,
  ) async {
    await pump(
      tester,
      _file(name: 'debug.apk', mime: 'application/octet-stream'),
    );
    expect(find.byKey(const Key('file_card_install')), findsOneWidget);
  });

  testWidgets('platform without Downloads/Install hides those actions', (
    tester,
  ) async {
    await pump(
      tester,
      _file(name: 'a.apk', mime: ReceivedFile.apkMime),
      canSave: false,
      canInstall: false,
    );
    expect(find.byKey(const Key('file_card_save')), findsNothing);
    expect(find.byKey(const Key('file_card_install')), findsNothing);
    expect(find.byKey(const Key('file_card_open')), findsOneWidget);
  });

  testWidgets('failed: shows the reason, no actions', (tester) async {
    await pump(
      tester,
      _file(status: ReceivedFileStatus.failed, errorReason: 'sha_mismatch'),
    );
    expect(find.textContaining('checksum'), findsOneWidget);
    expect(find.byKey(const Key('file_card_open')), findsNothing);
  });

  test('formatBytes', () {
    expect(formatBytes(0), '0 B');
    expect(formatBytes(1023), '1023 B');
    expect(formatBytes(512 * 1024), '512 KB');
    expect(formatBytes(33 * 1024 * 1024), '33.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
  });
}

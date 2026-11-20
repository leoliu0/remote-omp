// Plan 68 - the composer's upload strip: progress rows with cancel, the
// confirmation and error lines, and the picker placeholder.

import 'package:app/data/files/file_uploader.dart';
import 'package:app/ui/chat/upload/states/upload_state.dart';
import 'package:app/ui/chat/upload/widgets/upload_strip.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

UploadProgress _row({
  String id = 'u1',
  String name = 'report.pdf',
  int size = 20 * 1024 * 1024,
  int acked = 5 * 1024 * 1024,
  UploadPhase phase = UploadPhase.sending,
  bool waiting = false,
}) => UploadProgress(
  id: id,
  name: name,
  size: size,
  ackedBytes: acked,
  phase: phase,
  epk: 'epk1',
  roomId: 'main',
  waiting: waiting,
);

void main() {
  Future<void> pumpStrip(
    WidgetTester tester,
    UploadState state, {
    void Function(String)? onCancel,
    void Function(String)? onDismiss,
  }) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: UploadStrip(
          state: state,
          onCancel: onCancel ?? (_) {},
          onDismiss: onDismiss ?? (_) {},
        ),
      ),
    ),
  );

  testWidgets('shows nothing when there is nothing to show', (tester) async {
    await pumpStrip(tester, const UploadState());
    expect(find.byKey(const Key('upload-strip')), findsNothing);
  });

  testWidgets('a row shows the name, bytes and percent, and a determinate bar', (
    tester,
  ) async {
    await pumpStrip(tester, UploadState(uploads: [_row()]));

    expect(find.text('report.pdf'), findsOneWidget);
    expect(find.text('5.0 MB of 20.0 MB · 25%'), findsOneWidget);
    final bar = tester.widget<LinearProgressIndicator>(
      find.byKey(const Key('upload-progress-u1')),
    );
    expect(bar.value, 0.25);
  });

  testWidgets('the cancel button reports which upload to stop', (tester) async {
    final cancelled = <String>[];
    await pumpStrip(
      tester,
      UploadState(uploads: [_row(id: 'a'), _row(id: 'b', name: 'b.zip')]),
      onCancel: cancelled.add,
    );

    await tester.tap(find.byKey(const Key('upload-cancel-b')));
    expect(cancelled, ['b']);
  });

  testWidgets('before the PC answers the bar is indeterminate', (tester) async {
    await pumpStrip(
      tester,
      UploadState(uploads: [_row(phase: UploadPhase.starting, acked: 0)]),
    );
    expect(find.text('Waiting for the PC…'), findsOneWidget);
    expect(
      tester
          .widget<LinearProgressIndicator>(
            find.byKey(const Key('upload-progress-u1')),
          )
          .value,
      isNull,
    );
  });

  testWidgets('starting and finishing say so', (tester) async {
    await pumpStrip(
      tester,
      UploadState(
        uploads: [
          _row(id: 'a', phase: UploadPhase.starting, acked: 0),
          _row(id: 'b', phase: UploadPhase.finishing, acked: 20 * 1024 * 1024),
        ],
      ),
    );
    expect(find.text('Waiting for the PC…'), findsOneWidget);
    expect(find.text('Finishing on the PC…'), findsOneWidget);
  });

  testWidgets('a paused upload says it is waiting for the connection', (
    tester,
  ) async {
    await pumpStrip(tester, UploadState(uploads: [_row(waiting: true)]));
    expect(find.text('Waiting for the connection…'), findsOneWidget);
  });

  testWidgets('an error line shows the reason and can be dismissed', (
    tester,
  ) async {
    final dismissed = <String>[];
    await pumpStrip(
      tester,
      const UploadState(
        notices: [
          UploadNotice(
            id: 'n1',
            name: 'report.pdf',
            message: 'Remote OMP on the PC is too old to receive files.',
            failed: true,
          ),
        ],
      ),
      onDismiss: dismissed.add,
    );

    expect(find.text('report.pdf'), findsOneWidget);
    expect(
      find.text('Remote OMP on the PC is too old to receive files.'),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('upload-notice-dismiss-n1')));
    expect(dismissed, ['n1']);
  });

  testWidgets('a confirmation line names the file', (tester) async {
    await pumpStrip(
      tester,
      const UploadState(
        notices: [
          UploadNotice(
            id: 'n2',
            name: 'report.pdf',
            message: 'Uploaded — path added to your message',
          ),
        ],
      ),
    );
    expect(find.text('Uploaded — path added to your message'), findsOneWidget);
  });

  testWidgets('shows a placeholder while the picker copies the file', (
    tester,
  ) async {
    await pumpStrip(tester, const UploadState(picking: true));
    expect(find.byKey(const Key('upload-picking')), findsOneWidget);
    expect(find.text('Opening the file…'), findsOneWidget);
  });
}

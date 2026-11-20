// Plan 68 - InputBar upload wiring: the strip above the field, a finished
// upload's path appended to the text, and File keeping the attach button
// usable when no image can be attached.

import 'dart:async';

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/data/images/image_picker_service.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/data/files/file_uploader.dart';
import 'package:app/ui/chat/attachment/viewmodels/attachment_viewmodel.dart';
import 'package:app/ui/chat/upload/viewmodels/upload_viewmodel.dart';
import 'package:app/ui/chat/widgets/input_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'upload_fakes.dart';

const _path = '/home/leo/.omp/remote/uploads/2026-11-20/report.pdf';

class _NoPicker implements IImagePickerService {
  @override
  Future<PickedImage?> pickFromCamera() async => null;
  @override
  Future<PickedImage?> pickFromGallery() async => null;
}

/// Only the model catalogue matters: a text-only model rules images out.
class _TextOnlyActions implements IActionsRepository {
  static const _model = WireModel(
    id: 'id',
    name: 'M',
    provider: 'p',
    reasoning: false,
    contextWindow: 1,
    vision: false,
  );
  final _ctrl = StreamController<ActiveRoomMeta>.broadcast();

  @override
  Future<ModelsCatalogue> listModels({bool forceRefresh = false}) async =>
      const ModelsCatalogue(models: [_model], current: _model);
  @override
  ActiveRoomMeta get activeRoomMeta => const ActiveRoomMeta();
  @override
  Stream<ActiveRoomMeta> get activeRoomMetaStream => _ctrl.stream;
  @override
  void dispose() => _ctrl.close();
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

void main() {
  late AppDatabase db;
  late Preferences prefs;
  late FakeUploader uploader;
  late FakeUploadPicker picker;
  late UploadViewModel vm;

  setUp(() async {
    db = AppDatabase.memory();
    prefs = Preferences(db);
    await prefs.setSelectedRoom(epk: 'epk1', roomId: 'main');
    uploader = FakeUploader();
    picker = FakeUploadPicker();
    vm = UploadViewModel(uploader, picker, prefs);
  });

  tearDown(() async {
    vm.dispose();
    await uploader.dispose();
    prefs.dispose();
    db.dispose();
  });

  Future<void> pumpBar(
    WidgetTester tester, {
    String initialText = '',
    void Function(String)? onDraftChanged,
    AttachmentViewModel? attachment,
    bool withUpload = true,
  }) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: InputBar(
            onSend: (_) {},
            initialText: initialText,
            onDraftChanged: onDraftChanged,
            attachment: attachment,
            upload: withUpload ? vm : null,
            onOpenAttach: () {},
          ),
        ),
      ),
    ),
  );

  String fieldText(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).controller!.text;

  /// An event from the fake uploader reaches the view model on a later
  /// microtask, so the frame that shows it is the second one.
  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump();
  }

  testWidgets('a finished upload appends its path to the text, after a space', (
    tester,
  ) async {
    final drafts = <String>[];
    await pumpBar(tester, initialText: 'Summarise', onDraftChanged: drafts.add);
    picker.next = FakeUploadSource();
    await vm.pickAndUpload();
    await tester.pump();

    uploader.finish('u1', path: _path);
    await settle(tester);

    expect(fieldText(tester), 'Summarise $_path ');
    expect(drafts.last, 'Summarise $_path ', reason: 'the draft follows the text');
    // The confirmation line names the file; the row is gone.
    expect(find.byKey(const Key('upload-row-u1')), findsNothing);
    expect(find.text('Uploaded — path added to your message'), findsOneWidget);
    // Let the confirmation's timer run out before the test ends.
    await tester.pump(const Duration(seconds: 6));
    expect(find.text('Uploaded — path added to your message'), findsNothing);
  });

  testWidgets('progress shows above the field and cancel stops the upload', (
    tester,
  ) async {
    await pumpBar(tester);
    picker.next = FakeUploadSource();
    await vm.pickAndUpload();
    await tester.pump();

    expect(find.byKey(const Key('upload-row-u1')), findsOneWidget);
    expect(find.text('report.pdf'), findsOneWidget);

    uploader.progress('u1', 10 * 1024 * 1024);
    await settle(tester);
    expect(find.text('10.0 MB of 20.0 MB · 50%'), findsOneWidget);

    await tester.tap(find.byKey(const Key('upload-cancel-u1')));
    await settle(tester);
    expect(uploader.cancelled, ['u1']);
    expect(find.byKey(const Key('upload-row-u1')), findsNothing);
    expect(fieldText(tester), isEmpty);
  });

  testWidgets('a failed upload shows why and can be dismissed', (tester) async {
    await pumpBar(tester);
    picker.next = FakeUploadSource();
    await vm.pickAndUpload();
    uploader.fail(
      'u1',
      const UploadFailure('too_large', 'That file is larger than the 256 MiB limit.'),
    );
    await settle(tester);

    expect(
      find.text('That file is larger than the 256 MiB limit.'),
      findsOneWidget,
    );
    await tester.tap(
      find.byKey(Key('upload-notice-dismiss-${vm.state.notices.single.id}')),
    );
    await settle(tester);
    expect(
      find.text('That file is larger than the 256 MiB limit.'),
      findsNothing,
    );
  });

  testWidgets('File keeps the attach button on for a text-only model', (
    tester,
  ) async {
    final attachment = AttachmentViewModel(_NoPicker(), _TextOnlyActions());
    addTearDown(attachment.dispose);

    await pumpBar(tester, attachment: attachment, withUpload: false);
    await tester.pump(); // the model catalogue resolves: no vision
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('input-bar-attach')))
          .onPressed,
      isNull,
      reason: 'without uploads a text-only model has nothing to attach',
    );

    await pumpBar(tester, attachment: attachment);
    await tester.pump();
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('input-bar-attach')))
          .onPressed,
      isNotNull,
      reason: 'File works with any model',
    );
  });
}

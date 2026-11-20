// Plan 68 - UploadViewModel: what the composer shows for "Attach > File" and
// where a finished upload's path goes.

import 'dart:async';

import 'package:app/data/files/file_uploader.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/ui/chat/upload/viewmodels/upload_viewmodel.dart';
import 'package:flutter_test/flutter_test.dart';

import 'upload_fakes.dart';

const _path = '/home/leo/.omp/remote/uploads/2026-11-20/report.pdf';

void main() {
  late AppDatabase db;
  late Preferences prefs;
  late FakeUploader uploader;
  late FakeUploadPicker picker;
  late UploadViewModel vm;

  UploadViewModel makeVm({Duration doneFor = const Duration(seconds: 5)}) =>
      UploadViewModel(uploader, picker, prefs, doneNoticeDuration: doneFor);

  setUp(() async {
    db = AppDatabase.memory();
    prefs = Preferences(db);
    await prefs.setSelectedRoom(epk: 'epk1', roomId: 'main');
    // The wiring of dependencies.dart: a path no chat took joins its draft.
    uploader = FakeUploader(
      onUnhandledResult: (r) => keepUploadedPathInDraft(prefs, r),
    );
    picker = FakeUploadPicker();
    vm = makeVm();
  });

  tearDown(() async {
    vm.dispose();
    await uploader.dispose();
    prefs.dispose();
    db.dispose();
  });

  group('appendToComposerText', () {
    test('separates the path from the text with one space, keeps typing open', () {
      expect(appendToComposerText('', '/a/b.pdf'), '/a/b.pdf ');
      expect(appendToComposerText('Summarise', '/a/b.pdf'), 'Summarise /a/b.pdf ');
      expect(appendToComposerText('Summarise ', '/a/b.pdf'), 'Summarise /a/b.pdf ');
      expect(appendToComposerText('line one\n', '/a/b.pdf'), 'line one\n/a/b.pdf ');
    });
  });

  group('picking', () {
    test('uploads the picked file and shows its progress in this chat', () async {
      final src = FakeUploadSource();
      picker.next = src;
      final gate = picker.gate = Completer<void>();

      final picking = vm.pickAndUpload();
      await pumpEventQueue();
      expect(vm.state.picking, isTrue);
      gate.complete();
      await picking;

      expect(vm.state.picking, isFalse);
      expect(uploader.sources['u1'], same(src));
      final row = vm.state.uploads.single;
      expect(row.name, 'report.pdf');
      expect(row.ackedBytes, 0);

      uploader.progress('u1', 5 * 1024 * 1024);
      await pumpEventQueue();
      expect(vm.state.uploads.single.ackedBytes, 5 * 1024 * 1024);
    });

    test('backing out of the picker starts nothing and says nothing', () async {
      picker.next = null;
      await vm.pickAndUpload();
      expect(uploader.sources, isEmpty);
      expect(vm.state.isEmpty, isTrue);
    });

    test('a pick that cannot be read shows why', () async {
      picker.error = const UploadFailure('unreadable', "Couldn't read that file.");
      await vm.pickAndUpload();
      expect(uploader.sources, isEmpty);
      final notice = vm.state.notices.single;
      expect(notice.failed, isTrue);
      expect(notice.message, "Couldn't read that file.");
      expect(vm.state.picking, isFalse);
    });

    test('an unexpected picker error still ends in a message', () async {
      picker.error = StateError('plugin crashed');
      await vm.pickAndUpload();
      expect(vm.state.notices.single.failed, isTrue);
      expect(vm.state.notices.single.message, contains('picker'));
    });

    test('a second tap while the picker is open does nothing', () async {
      picker.next = FakeUploadSource();
      final gate = picker.gate = Completer<void>();
      final first = vm.pickAndUpload();
      await pumpEventQueue();
      await vm.pickAndUpload();
      expect(picker.picks, 1);
      gate.complete();
      await first;
      expect(uploader.sources, hasLength(1));
    });

    test('offline: says so and releases the picked copy', () async {
      final src = FakeUploadSource();
      picker.next = src;
      uploader.failStart = const UploadFailure('offline', 'Not connected to the PC.');
      await vm.pickAndUpload();

      expect(vm.state.uploads, isEmpty);
      expect(vm.state.notices.single.message, 'Not connected to the PC.');
      expect(vm.state.notices.single.name, 'report.pdf');
      expect(src.released, isTrue);
    });

    test('the chat closing while the picker is open drops the pick', () async {
      final src = FakeUploadSource();
      picker.next = src;
      final gate = picker.gate = Completer<void>();
      final picking = vm.pickAndUpload();
      await pumpEventQueue();
      vm.dispose();
      gate.complete();
      await picking;

      expect(uploader.sources, isEmpty);
      expect(src.released, isTrue);
      // tearDown disposes again: a second dispose must not throw.
      vm = makeVm();
    });
  });

  group('cancel and failures', () {
    test('cancel stops the upload without an error line', () async {
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();

      vm.cancel('u1');
      await pumpEventQueue();
      expect(uploader.cancelled, ['u1']);
      expect(vm.state.uploads, isEmpty);
      expect(vm.state.notices, isEmpty);
    });

    test('a failed upload stays as an error line until dismissed', () async {
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();

      uploader.fail(
        'u1',
        const UploadFailure('too_large', 'That file is larger than the 256 MiB limit.'),
      );
      await pumpEventQueue();
      final notice = vm.state.notices.single;
      expect(notice.failed, isTrue);
      expect(notice.name, 'report.pdf');
      expect(notice.message, 'That file is larger than the 256 MiB limit.');
      expect(vm.state.uploads, isEmpty);

      vm.dismissNotice(notice.id);
      expect(vm.state.notices, isEmpty);
    });

    test('a PC too old for uploads is reported with the update hint', () async {
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();
      uploader.fail(
        'u1',
        const UploadFailure(
          'unsupported',
          'Remote OMP on the PC is too old to receive files. Update it on the PC and try again.',
        ),
      );
      await pumpEventQueue();
      expect(vm.state.notices.single.message, contains('Update it on the PC'));
    });

    test('keeps only the last three lines', () async {
      for (var i = 1; i <= 4; i++) {
        picker.next = FakeUploadSource(name: 'f$i.txt');
        await vm.pickAndUpload();
        uploader.fail('u$i', UploadFailure('x', 'failed $i'));
        await pumpEventQueue();
      }
      expect(vm.state.notices.map((n) => n.message), [
        'failed 2',
        'failed 3',
        'failed 4',
      ]);
    });
  });

  group('finishing', () {
    test('hands the path to a composer on screen and confirms briefly', () async {
      vm.dispose();
      vm = makeVm(doneFor: const Duration(milliseconds: 60));
      final inserted = <String>[];
      final sub = vm.insertions.listen(inserted.add);
      addTearDown(sub.cancel);
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();

      uploader.finish('u1', path: _path);
      await pumpEventQueue();

      expect(inserted, [_path]);
      expect(prefs.getDraft('epk1', 'main'), '', reason: 'the composer owns the draft');
      final notice = vm.state.notices.single;
      expect(notice.failed, isFalse);
      expect(notice.name, 'report.pdf');
      expect(vm.state.uploads, isEmpty);

      // The confirmation fades by itself.
      final end = DateTime.now().add(const Duration(seconds: 3));
      while (vm.state.notices.isNotEmpty && DateTime.now().isBefore(end)) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(vm.state.notices, isEmpty);
    });

    test('with no composer listening the path joins that chat\'s saved draft', () async {
      prefs.setDraft('epk1', 'main', 'Summarise');
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();

      uploader.finish('u1', path: _path);
      await pumpEventQueue();

      expect(prefs.getDraft('epk1', 'main'), 'Summarise $_path ');
    });

    test('the chat having been closed, the path still reaches the draft', () async {
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();
      vm.dispose();

      uploader.finish('u1', path: _path);
      await pumpEventQueue();

      expect(prefs.getDraft('epk1', 'main'), '$_path ');
      vm = makeVm(); // for tearDown
    });

    test('an upload from another session lands in that session\'s draft', () async {
      uploader.epk = 'epk2';
      uploader.roomId = 'room-b';
      final inserted = <String>[];
      final sub = vm.insertions.listen(inserted.add);
      addTearDown(sub.cancel);
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();
      expect(vm.state.uploads, isEmpty, reason: 'not the open chat');

      uploader.finish('u1', path: _path);
      await pumpEventQueue();

      expect(inserted, isEmpty);
      expect(prefs.getDraft('epk1', 'main'), '');
      expect(prefs.getDraft('epk2', 'room-b'), '$_path ');
    });
  });

  group('sessions', () {
    test('only the open session\'s uploads show; switching follows the selection', () async {
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();
      expect(vm.state.uploads, hasLength(1));

      await prefs.setSelectedRoom(epk: 'epk1', roomId: 'room-b');
      expect(vm.state.uploads, isEmpty);

      await prefs.setSelectedRoom(epk: 'epk1', roomId: 'main');
      expect(vm.state.uploads, hasLength(1));
    });

    test('a failure belongs to the chat it happened in', () async {
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();
      uploader.fail('u1', const UploadFailure('x', 'boom'));
      await pumpEventQueue();
      expect(vm.state.notices, hasLength(1));

      await prefs.setSelectedRoom(epk: 'epk1', roomId: 'room-b');
      expect(vm.state.notices, isEmpty);
      await prefs.setSelectedRoom(epk: 'epk1', roomId: 'main');
      expect(vm.state.notices, hasLength(1));
    });

    test('url-safe and standard epks name the same session', () async {
      // Stores keep base64url, the relay speaks standard base64.
      await prefs.setSelectedRoom(epk: 'ab-_', roomId: 'main');
      uploader.epk = 'ab+/';
      picker.next = FakeUploadSource();
      await vm.pickAndUpload();
      expect(vm.state.uploads, hasLength(1));
    });
  });
}

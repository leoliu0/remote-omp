// Plan 68 - PlatformUploadFilePicker: a copy the file picker made is the app's
// own. It is moved into a directory made for that upload, so picking the same
// name again cannot replace what an upload is still reading (iOS keeps every
// pick at `<tmp>/<name>`), and it goes away with the upload. A file the picker
// handed back in place is somebody's original and is never deleted.

import 'dart:io';

import 'package:app/data/files/file_uploader.dart';
import 'package:app/data/files/upload_file_picker.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory root;
  late Directory cache;
  late Directory systemTemp;

  setUp(() {
    root = Directory.systemTemp.createTempSync('rp_picker_');
    cache = Directory('${root.path}/cache')..createSync();
    systemTemp = Directory('${root.path}/tmp')..createSync();
  });

  tearDown(() => root.deleteSync(recursive: true));

  File write(String path, String text) {
    final f = File(path)..createSync(recursive: true);
    f.writeAsStringSync(text);
    return f;
  }

  FilePickerResult picked(File f) => FilePickerResult([
    PlatformFile(
      name: f.uri.pathSegments.last,
      size: f.lengthSync(),
      path: f.path,
    ),
  ]);

  Future<String> read(UploadSource s) async => String.fromCharCodes([
    for (final part in await s.openRead().toList()) ...part,
  ]);

  PlatformUploadFilePicker pickerOf(
    Future<FilePickerResult?> Function() pickFiles, {
    bool isIOS = false,
    String Function()? newId,
  }) => PlatformUploadFilePicker(
    pickFiles: pickFiles,
    tempDir: () async => cache,
    systemTempDir: systemTemp,
    isIOS: isIOS,
    newId: newId,
  );

  test('a pick in the app cache gets a directory of its own and goes away with the upload', () async {
    final f = write('${cache.path}/file_picker/111/report.pdf', 'hello');
    final src = (await pickerOf(
      () async => picked(f),
      newId: () => 'id1',
    ).pick())!;

    expect(src.name, 'report.pdf');
    expect(src.size, 5);
    expect(await read(src), 'hello');
    expect(f.existsSync(), isFalse, reason: 'moved out of the plugin folder');
    expect(
      Directory('${cache.path}/file_picker/111').existsSync(),
      isFalse,
      reason: 'the emptied plugin folder goes too',
    );
    expect(File('${cache.path}/rp_uploads/id1/report.pdf').existsSync(), isTrue);

    await src.release();
    expect(Directory('${cache.path}/rp_uploads/id1').existsSync(), isFalse);
  });

  test('the same name picked again does not replace a file still being read (iOS)', () async {
    var round = 0;
    final picker = pickerOf(
      () async {
        round++;
        // The plugin rewrites `<tmp>/report.pdf` on every pick.
        return picked(write('${systemTemp.path}/report.pdf', 'pick $round'));
      },
      isIOS: true,
      newId: () => 'id$round',
    );

    final first = (await picker.pick())!;
    final second = (await picker.pick())!;

    expect(await read(first), 'pick 1');
    expect(await read(second), 'pick 2');
    await first.release();
    expect(await read(second), 'pick 2', reason: 'releasing one leaves the other');
    await second.release();
    expect(Directory('${cache.path}/rp_uploads').listSync(), isEmpty);
  });

  test('a file picked where the plugin keeps no copies is used in place and never deleted', () async {
    final original = write('${root.path}/docs/report.pdf', 'mine');
    final src = (await pickerOf(() async => picked(original)).pick())!;

    expect(await read(src), 'mine');
    await src.release();
    expect(original.existsSync(), isTrue);
  });

  test('outside iOS the system temp directory is not the plugin\'s', () async {
    final f = write('${systemTemp.path}/report.pdf', 'mine');
    final src = (await pickerOf(() async => picked(f)).pick())!;

    expect(await read(src), 'mine');
    await src.release();
    expect(f.existsSync(), isTrue);
  });

  test('backing out of the picker is not an error', () async {
    expect(await pickerOf(() async => null).pick(), isNull);
    expect(await pickerOf(() async => const FilePickerResult([])).pick(), isNull);
  });

  test('a pick without a path cannot be read', () async {
    final picker = pickerOf(
      () async => FilePickerResult([PlatformFile(name: 'x', size: 1)]),
    );
    await expectLater(
      picker.pick(),
      throwsA(
        isA<UploadFailure>().having((e) => e.code, 'code', 'unreadable'),
      ),
    );
  });
}

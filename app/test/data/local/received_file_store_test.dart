// Plan 65 — received files persist metadata + path only, never bytes.

import 'dart:io';

import 'package:app/data/local/app_database.dart';
import 'package:app/data/local/received_file_store.dart';
import 'package:app/domain/entities/received_file.dart';
import 'package:flutter_test/flutter_test.dart';

ReceivedFile _file(
  String id, {
  String epk = 'e1',
  String room = 'main',
  DateTime? at,
  ReceivedFileStatus status = ReceivedFileStatus.done,
}) {
  final t = at ?? DateTime(2026, 10, 20, 12);
  return ReceivedFile(
    fileId: id,
    epk: epk,
    roomId: room,
    name: '$id.pdf',
    mime: 'application/pdf',
    size: 42,
    sha256: 'ab' * 32,
    caption: 'cap',
    turnId: 't1',
    status: status,
    nextSeq: 1,
    receivedBytes: 42,
    path: '/data/received/$id/$id.pdf',
    createdAt: t,
    updatedAt: t,
  );
}

void main() {
  test('round-trips every field and survives a reopen', () {
    final dir = Directory.systemTemp.createTempSync('rp_rf_store_');
    addTearDown(() => dir.deleteSync(recursive: true));
    final path = '${dir.path}/db.sqlite';
    var db = AppDatabase.openForTest(path);
    var store = ReceivedFileStore(db);
    final f = _file('a');
    store.upsert(f);
    store.dispose();
    db.dispose();

    db = AppDatabase.openForTest(path);
    store = ReceivedFileStore(db);
    addTearDown(() {
      store.dispose();
      db.dispose();
    });
    expect(store.get('a'), f);
  });

  test('schema holds metadata and a path, no blob column', () {
    final db = AppDatabase.memory();
    final store = ReceivedFileStore(db);
    addTearDown(() {
      store.dispose();
      db.dispose();
    });
    final cols = db.db
        .select('PRAGMA table_info(received_files)')
        .map((r) => '${r['name']}:${r['type']}')
        .toList();
    expect(cols, isNot(contains(predicate<String>((c) => c.endsWith('BLOB')))));
    expect(cols.map((c) => c.split(':').first), contains('path'));
  });

  test('forSession filters by peer+room and orders by creation', () {
    final db = AppDatabase.memory();
    final store = ReceivedFileStore(db);
    addTearDown(() {
      store.dispose();
      db.dispose();
    });
    store.upsert(_file('late', at: DateTime(2026, 1, 2)));
    store.upsert(_file('early', at: DateTime(2026, 1, 1)));
    store.upsert(_file('other', epk: 'e2'));
    store.upsert(_file('room2', room: 'r2'));
    expect(store.forSession('e1', 'main').map((f) => f.fileId), [
      'early',
      'late',
    ]);
    store.deleteAll();
    expect(store.all(), isEmpty);
  });

  test('watchSession emits the current list then each change', () async {
    final db = AppDatabase.memory();
    final store = ReceivedFileStore(db);
    addTearDown(() {
      store.dispose();
      db.dispose();
    });
    final events = <List<String>>[];
    final sub = store
        .watchSession('e1', 'main')
        .listen((l) => events.add(l.map((f) => f.fileId).toList()));
    addTearDown(sub.cancel);
    await Future<void>.delayed(Duration.zero);
    store.upsert(_file('a', status: ReceivedFileStatus.receiving));
    store.upsert(_file('b', epk: 'e2'));
    await Future<void>.delayed(Duration.zero);
    expect(events, [
      <String>[],
      ['a'],
    ]);
  });
}

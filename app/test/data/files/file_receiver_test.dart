// Plan 65 step 4 — FileReceiver acceptance: chunk ordering, SHA check,
// disk errors, resume on reconnect, restart cleanup. Driven through a fake
// channel adopted by a real ConnectionManager.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:app/data/files/file_receiver.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/local/received_file_store.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/domain/entities/received_file.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter_test/flutter_test.dart';

class _FakeChannel implements IChannel {
  final _ctrl = StreamController<ServerMessage>.broadcast();
  final List<ClientMessage> sent = [];
  @override
  Stream<ServerMessage> get serverMessages => _ctrl.stream;
  @override
  Future<void> send(ClientMessage msg) async => sent.add(msg);
  @override
  Future<void> close() async {
    if (!_ctrl.isClosed) await _ctrl.close();
  }

  void push(ServerMessage m) => _ctrl.add(m);

  /// File frames only (ConnectionManager also pings).
  List<ClientMessage> get fileFrames => [
    for (final m in sent)
      if (m is FileAck || m is FileDone || m is FileError || m is FileCancel) m,
  ];
}

class _FakeStorage extends PairingStorage {
  _FakeStorage(super.db);
  @override
  Future<List<PeerRecord>> listPeers() async => const [];
}

/// Simulates a full disk: every append fails like ENOSPC.
class _FullDiskSink extends IoChunkSink {
  @override
  Future<void> append(String path, List<int> bytes) async {
    throw FileSystemException(
      'No space left on device',
      path,
      const OSError('No space left on device', 28),
    );
  }
}

const _peer = PeerRecord(
  remoteEpk: 'epk_files',
  sessionName: 'Pi',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

String _sha(List<int> bytes) => crypto.sha256.convert(bytes).toString();

List<FileChunk> _chunks(String id, List<int> bytes, int size) => [
  for (var i = 0, seq = 0; i < bytes.length; i += size, seq++)
    FileChunk(
      fileId: id,
      seq: seq,
      data: base64Encode(
        bytes.sublist(i, i + size > bytes.length ? bytes.length : i + size),
      ),
    ),
];

FileOffer _offer(
  String id,
  List<int> bytes, {
  String name = 'notes.pdf',
  String mime = 'application/pdf',
  String? sha,
}) => FileOffer(
  fileId: id,
  name: name,
  mime: mime,
  size: bytes.length,
  sha256: sha ?? _sha(bytes),
  caption: 'Here you go',
);

void main() {
  late Directory root;
  late AppDatabase db;
  late ReceivedFileStore store;
  late DateTime clock;
  final disposers = <FutureOr<void> Function()>[];

  setUp(() {
    root = Directory.systemTemp.createTempSync('rp_files_');
    db = AppDatabase.memory();
    store = ReceivedFileStore(db);
    clock = DateTime(2026, 10, 20, 12);
  });

  tearDown(() async {
    for (final d in disposers.reversed) {
      await d();
    }
    disposers.clear();
    store.dispose();
    db.dispose();
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  Future<({FileReceiver rx, _FakeChannel ch, ConnectionManager conn})> setup({
    ChunkSink? sink,
    ReceivedFileStore? withStore,
  }) async {
    final ch = _FakeChannel();
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(db),
      emitDebounce: Duration.zero,
    );
    final rx = FileReceiver(
      conn,
      withStore ?? store,
      rootDir: () async => root,
      sink: sink,
      now: () => clock,
    );
    disposers.add(conn.dispose);
    disposers.add(rx.dispose);
    await rx.ready;
    conn.adopt(ch, _peer);
    await rx.idle;
    return (rx: rx, ch: ch, conn: conn);
  }

  Future<void> push(
    ({FileReceiver rx, _FakeChannel ch, ConnectionManager conn}) s,
    Iterable<ServerMessage> frames,
  ) async {
    for (final f in frames) {
      s.ch.push(f);
    }
    await Future<void>.delayed(Duration.zero);
    await s.rx.idle;
  }

  final bytes = Uint8List.fromList(List<int>.generate(10, (i) => i * 7));

  test(
    'in-order transfer: acks each chunk, verifies, renames, file_done',
    () async {
      final s = await setup();
      final chunks = _chunks('f1', bytes, 4); // 3 chunks
      await push(s, [_offer('f1', bytes), ...chunks]);

      final part = File('${root.path}/received/f1/notes.pdf.part');
      expect(part.existsSync(), isTrue);
      expect(store.get('f1')!.status, ReceivedFileStatus.receiving);
      expect(store.get('f1')!.receivedBytes, 10);

      await push(s, [const FileEnd(fileId: 'f1', chunks: 3)]);

      final done = File('${root.path}/received/f1/notes.pdf');
      expect(done.readAsBytesSync(), bytes);
      expect(part.existsSync(), isFalse);
      final rec = store.get('f1')!;
      expect(rec.status, ReceivedFileStatus.done);
      expect(rec.path, done.path);
      expect(rec.caption, 'Here you go');
      expect(rec.epk, _peer.remoteEpk);
      expect(rec.roomId, 'main');
      expect(s.ch.fileFrames, [
        FileAck(fileId: 'f1', nextSeq: 0),
        FileAck(fileId: 'f1', nextSeq: 1),
        FileAck(fileId: 'f1', nextSeq: 2),
        FileAck(fileId: 'f1', nextSeq: 3),
        FileDone(fileId: 'f1'),
      ]);
    },
  );

  test(
    'out-of-order and duplicate chunks: cumulative acks, exact bytes',
    () async {
      final s = await setup();
      final c = _chunks('f2', bytes, 4);
      await push(s, [
        _offer('f2', bytes),
        c[1], // ahead → buffered, ack stays 0
        c[0], // fills the gap → drains 1 → ack 2
        c[0], // duplicate → re-ack 2
        c[2],
        c[2], // duplicate
        const FileEnd(fileId: 'f2', chunks: 3),
      ]);

      expect(
        File('${root.path}/received/f2/notes.pdf').readAsBytesSync(),
        bytes,
      );
      final acks = s.ch.fileFrames.whereType<FileAck>().map((a) => a.nextSeq);
      expect(acks, [0, 0, 2, 2, 3, 3]);
      expect(s.ch.fileFrames.last, FileDone(fileId: 'f2'));
    },
  );

  test('file_end before the last chunk waits for it', () async {
    final s = await setup();
    final c = _chunks('f3', bytes, 4);
    await push(s, [
      _offer('f3', bytes),
      c[0],
      c[2],
      const FileEnd(fileId: 'f3', chunks: 3),
    ]);
    expect(store.get('f3')!.status, ReceivedFileStatus.receiving);
    expect(s.ch.fileFrames.whereType<FileDone>(), isEmpty);

    await push(s, [c[1]]);
    expect(store.get('f3')!.status, ReceivedFileStatus.done);
    expect(File('${root.path}/received/f3/notes.pdf').readAsBytesSync(), bytes);
    expect(s.ch.fileFrames.last, FileDone(fileId: 'f3'));
  });

  test(
    'SHA mismatch deletes the file and sends file_error sha_mismatch',
    () async {
      final s = await setup();
      await push(s, [
        _offer('f4', bytes, sha: '00' * 32),
        ..._chunks('f4', bytes, 4),
        const FileEnd(fileId: 'f4', chunks: 3),
      ]);

      expect(Directory('${root.path}/received/f4').existsSync(), isFalse);
      final rec = store.get('f4')!;
      expect(rec.status, ReceivedFileStatus.failed);
      expect(rec.errorReason, 'sha_mismatch');
      expect(
        s.ch.fileFrames.last,
        FileError(fileId: 'f4', reason: FileErrorReason.shaMismatch),
      );
      expect(s.ch.fileFrames.whereType<FileDone>(), isEmpty);
    },
  );

  test('SHA comparison ignores hex case', () async {
    final s = await setup();
    await push(s, [
      _offer('f4u', bytes, sha: _sha(bytes).toUpperCase()),
      ..._chunks('f4u', bytes, 4),
      const FileEnd(fileId: 'f4u', chunks: 3),
    ]);
    expect(store.get('f4u')!.status, ReceivedFileStatus.done);
  });

  test(
    'low disk space sends file_error no_space and drops the partial',
    () async {
      final s = await setup(sink: _FullDiskSink());
      await push(s, [_offer('f5', bytes), ..._chunks('f5', bytes, 4)]);

      final rec = store.get('f5')!;
      expect(rec.status, ReceivedFileStatus.failed);
      expect(rec.errorReason, 'no_space');
      expect(Directory('${root.path}/received/f5').existsSync(), isFalse);
      final errors = s.ch.fileFrames.whereType<FileError>().toList();
      // The first failing chunk reports it; later in-flight chunks get the
      // same answer (the sender may have missed the first).
      expect(errors, isNotEmpty);
      expect(errors.toSet(), {
        FileError(fileId: 'f5', reason: FileErrorReason.noSpace),
      });
    },
  );

  test('file_cancel from the sender deletes the partial', () async {
    final s = await setup();
    final c = _chunks('f6', bytes, 4);
    await push(s, [_offer('f6', bytes), c[0], const FileCancel(fileId: 'f6')]);
    expect(Directory('${root.path}/received/f6').existsSync(), isFalse);
    expect(store.get('f6')!.status, ReceivedFileStatus.cancelled);
    // Late chunks for a cancelled transfer are not written.
    await push(s, [c[1]]);
    expect(Directory('${root.path}/received/f6').existsSync(), isFalse);
  });

  test('user cancel sends file_cancel and drops the partial', () async {
    final s = await setup();
    await push(s, [_offer('f7', bytes), _chunks('f7', bytes, 4)[0]]);
    await s.rx.cancel('f7');
    expect(s.ch.fileFrames.last, const FileCancel(fileId: 'f7'));
    expect(store.get('f7')!.status, ReceivedFileStatus.cancelled);
    expect(Directory('${root.path}/received/f7').existsSync(), isFalse);
  });

  test(
    'reconnect re-sends file_ack next_seq for transfers < 10 min old',
    () async {
      final s = await setup();
      final c = _chunks('f8', bytes, 4);
      await push(s, [_offer('f8', bytes), c[0], c[1]]);

      // Phone drops and comes back 4 minutes later on a new socket.
      clock = clock.add(const Duration(minutes: 4));
      final ch2 = _FakeChannel();
      s.conn.adopt(ch2, _peer);
      await Future<void>.delayed(Duration.zero);
      await s.rx.idle;
      expect(ch2.fileFrames, [FileAck(fileId: 'f8', nextSeq: 2)]);

      // The sender resumes at 2 and the file completes on the new socket.
      ch2.push(c[2]);
      ch2.push(const FileEnd(fileId: 'f8', chunks: 3));
      await Future<void>.delayed(Duration.zero);
      await s.rx.idle;
      expect(store.get('f8')!.status, ReceivedFileStatus.done);
      expect(
        File('${root.path}/received/f8/notes.pdf').readAsBytesSync(),
        bytes,
      );
    },
  );

  test(
    'reconnect after 10 min does not resume and drops the partial',
    () async {
      final s = await setup();
      await push(s, [_offer('f9', bytes), _chunks('f9', bytes, 4)[0]]);

      clock = clock.add(const Duration(minutes: 11));
      final ch2 = _FakeChannel();
      s.conn.adopt(ch2, _peer);
      await Future<void>.delayed(Duration.zero);
      await s.rx.idle;
      expect(ch2.fileFrames, isEmpty);
      expect(store.get('f9')!.status, ReceivedFileStatus.failed);
      expect(Directory('${root.path}/received/f9').existsSync(), isFalse);
    },
  );

  test(
    'restart keeps finished files and drops .part files older than 10 min',
    () async {
      final s = await setup();
      final c = _chunks('done1', bytes, 4);
      await push(s, [
        _offer('done1', bytes),
        ...c,
        const FileEnd(fileId: 'done1', chunks: 3),
      ]);
      await push(s, [_offer('old1', bytes), _chunks('old1', bytes, 4)[0]]);
      clock = clock.add(const Duration(minutes: 8));
      await push(s, [_offer('new1', bytes), _chunks('new1', bytes, 4)[0]]);
      // An orphaned .part with no record at all (crash before the insert).
      final orphan = File('${root.path}/received/orphan/x.bin.part')
        ..createSync(recursive: true);
      orphan.setLastModifiedSync(clock.subtract(const Duration(minutes: 30)));
      s.rx.dispose();
      disposers.remove(s.rx.dispose);

      // App restarts 3 minutes later: old1 is 11 min stale, new1 is 3 min.
      clock = clock.add(const Duration(minutes: 3));
      final store2 = ReceivedFileStore(db);
      final rx2 = FileReceiver(
        s.conn,
        store2,
        rootDir: () async => root,
        now: () => clock,
      );
      disposers.add(rx2.dispose);
      disposers.add(store2.dispose);
      await rx2.ready;
      await rx2.idle;

      expect(store2.get('done1')!.status, ReceivedFileStatus.done);
      expect(
        File('${root.path}/received/done1/notes.pdf').existsSync(),
        isTrue,
      );
      expect(store2.get('old1')!.status, ReceivedFileStatus.failed);
      expect(store2.get('old1')!.errorReason, 'expired');
      expect(Directory('${root.path}/received/old1').existsSync(), isFalse);
      expect(store2.get('new1')!.status, ReceivedFileStatus.receiving);
      expect(
        File('${root.path}/received/new1/notes.pdf.part').existsSync(),
        isTrue,
      );
      expect(orphan.existsSync(), isFalse);
    },
  );

  test(
    'a .part longer than the recorded progress is truncated on resume',
    () async {
      final s = await setup();
      final c = _chunks('f10', bytes, 4);
      await push(s, [_offer('f10', bytes), c[0]]);
      // Crash after the write of chunk 1 but before its record update.
      File(
        '${root.path}/received/f10/notes.pdf.part',
      ).writeAsBytesSync([9, 9, 9], mode: FileMode.append);

      final ch2 = _FakeChannel();
      s.conn.adopt(ch2, _peer);
      await Future<void>.delayed(Duration.zero);
      await s.rx.idle;
      expect(ch2.fileFrames, [FileAck(fileId: 'f10', nextSeq: 1)]);
      ch2.push(c[1]);
      ch2.push(c[2]);
      ch2.push(const FileEnd(fileId: 'f10', chunks: 3));
      await Future<void>.delayed(Duration.zero);
      await s.rx.idle;
      expect(store.get('f10')!.status, ReceivedFileStatus.done);
    },
  );

  test('a re-offer of a finished file answers file_done again', () async {
    final s = await setup();
    await push(s, [
      _offer('f11', bytes),
      ..._chunks('f11', bytes, 4),
      const FileEnd(fileId: 'f11', chunks: 3),
    ]);
    s.ch.sent.clear();
    await push(s, [_offer('f11', bytes)]);
    expect(s.ch.fileFrames, [FileDone(fileId: 'f11')]);
  });

  test('a probe chunk after file_done answers file_done again', () async {
    final s = await setup();
    final c = _chunks('p1', bytes, 4);
    await push(s, [
      _offer('p1', bytes),
      ...c,
      const FileEnd(fileId: 'p1', chunks: 3),
    ]);
    s.ch.sent.clear();
    // The sender lost our file_done and probes with its first unacked chunk.
    await push(s, [c[2]]);
    expect(s.ch.fileFrames, [FileDone(fileId: 'p1')]);
  });

  test('a probe chunk after a failure answers file_error again', () async {
    final s = await setup();
    final c = _chunks('p2', bytes, 4);
    await push(s, [
      _offer('p2', bytes, sha: '00' * 32),
      ...c,
      const FileEnd(fileId: 'p2', chunks: 3),
    ]);
    s.ch.sent.clear();
    await push(s, [c[0]]);
    expect(s.ch.fileFrames, [
      FileError(fileId: 'p2', reason: FileErrorReason.shaMismatch),
    ]);
  });

  test('a probe chunk after a user cancel answers file_cancel again', () async {
    final s = await setup();
    final c = _chunks('p3', bytes, 4);
    await push(s, [_offer('p3', bytes), c[0]]);
    await s.rx.cancel('p3');
    s.ch.sent.clear();
    await push(s, [c[1]]);
    expect(s.ch.fileFrames, [const FileCancel(fileId: 'p3')]);
  });

  test('every probe duplicate is acked with the current next_seq', () async {
    final s = await setup();
    final c = _chunks('p4', bytes, 4);
    await push(s, [_offer('p4', bytes), c[0], c[1]]);
    s.ch.sent.clear();
    await push(s, [c[1], c[1], c[0]]);
    expect(s.ch.fileFrames, [
      FileAck(fileId: 'p4', nextSeq: 2),
      FileAck(fileId: 'p4', nextSeq: 2),
      FileAck(fileId: 'p4', nextSeq: 2),
    ]);
  });

  test('names are sanitized; a path-traversal file_id is ignored', () async {
    final s = await setup();
    await push(s, [
      _offer('f12', bytes, name: '../../etc/passwd'),
      _offer('../evil', bytes),
    ]);
    expect(store.get('f12')!.name, 'passwd');
    expect(File('${root.path}/received/f12/passwd.part').existsSync(), isTrue);
    expect(store.get('../evil'), isNull);
    expect(File('${root.path}/evil').existsSync(), isFalse);
  });

  test('clearAll deletes files on disk and their records', () async {
    final s = await setup();
    await push(s, [
      _offer('f13', bytes),
      ..._chunks('f13', bytes, 4),
      const FileEnd(fileId: 'f13', chunks: 3),
    ]);
    await push(s, [_offer('f14', bytes), _chunks('f14', bytes, 4)[0]]);
    expect(await s.rx.diskUsage(), greaterThan(0));

    await s.rx.clearAll();
    expect(store.all(), isEmpty);
    expect(Directory('${root.path}/received').existsSync(), isFalse);
    expect(await s.rx.diskUsage(), 0);
    // The in-flight one was cancelled at the sender.
    expect(s.ch.fileFrames.last, const FileCancel(fileId: 'f14'));
  });

  test('watchSession streams progress for the active chat', () async {
    final s = await setup();
    final seen = <List<ReceivedFile>>[];
    final sub = s.rx.watchSession(_peer.remoteEpk, 'main').listen(seen.add);
    addTearDown(sub.cancel);
    await push(s, [_offer('f15', bytes), _chunks('f15', bytes, 4)[0]]);
    expect(seen.last.single.receivedBytes, 4);
    expect(seen.last.single.progress, closeTo(0.4, 1e-9));
  });
}

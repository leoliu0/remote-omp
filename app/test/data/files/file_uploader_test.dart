// Plan 68 - FileUploader acceptance: chunking, the ack window, probing on an ack
// timeout, error mapping (incl. a PC too old for uploads), cancel and
// reconnect. Driven through a fake channel adopted by a real ConnectionManager,
// the same harness as the FileReceiver tests.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:app/data/files/file_uploader.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
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

  List<UploadStart> get starts => sent.whereType<UploadStart>().toList();
  List<UploadChunk> get chunks => sent.whereType<UploadChunk>().toList();
  List<UploadEnd> get ends => sent.whereType<UploadEnd>().toList();
  List<UploadCancel> get cancels => sent.whereType<UploadCancel>().toList();
  List<int> get chunkSeqs => [for (final c in chunks) c.seq];
}

class _FakeStorage extends PairingStorage {
  _FakeStorage(super.db);
  @override
  Future<List<PeerRecord>> listPeers() async => const [];
}

/// A file held in memory that records how it was read.
class _MemorySource extends UploadSource {
  _MemorySource(this.bytes, {this.name = 'report.pdf', this.readGate});

  final Uint8List bytes;

  /// When set, every read waits for this.
  final Completer<void>? readGate;

  @override
  final String name;

  /// `start-end` of every range read.
  final List<String> reads = [];
  bool released = false;

  @override
  int get size => bytes.length;

  @override
  Stream<List<int>> openRead([int? start, int? end]) {
    reads.add('$start-$end');
    final slice = bytes.sublist(start ?? 0, end ?? bytes.length);
    final gate = readGate;
    if (gate != null) return Stream.fromFuture(gate.future.then((_) => slice));
    return Stream.value(slice);
  }

  @override
  Future<void> release() async {
    released = true;
  }
}

const _peer = PeerRecord(
  remoteEpk: 'epk_upload',
  sessionName: 'Pi',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

const _donePath = '/home/leo/.omp/remote/uploads/2026-11-20/report.pdf';

String _sha(List<int> bytes) => crypto.sha256.convert(bytes).toString();
String _b64(List<int> bytes) => base64Encode(bytes);

UploadAck _ack(String id, int seq, {int received = 0, String? echo}) =>
    UploadAck(uploadId: id, seq: seq, received: received, inReplyTo: echo);

UploadDone _done(String id, {int size = 10}) =>
    UploadDone(uploadId: id, path: _donePath, size: size);

/// Polls [cond] (real time) until it holds; the uploader's timers are real.
Future<void> _until(
  bool Function() cond, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final end = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(end)) fail('condition not met within $timeout');
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

Matcher _failure(String code, {Object? message}) => isA<UploadFailure>()
    .having((e) => e.code, 'code', code)
    .having((e) => e.message, 'message', message ?? isNotEmpty);

typedef _Rig = ({FileUploader up, _FakeChannel ch, ConnectionManager conn});

void main() {
  late AppDatabase db;
  final disposers = <FutureOr<void> Function()>[];

  setUp(() => db = AppDatabase.memory());

  tearDown(() async {
    for (final d in disposers.reversed) {
      await d();
    }
    disposers.clear();
    db.dispose();
  });

  Future<_Rig> setup({
    int chunk = 4,
    int window = 2,
    Duration startAckTimeout = const Duration(seconds: 30),
    int startAttempts = 3,
    Duration ackTimeout = const Duration(seconds: 30),
    Duration maxAckTimeout = const Duration(seconds: 30),
    Duration stallTimeout = const Duration(seconds: 90),
    Duration pauseGrace = const Duration(seconds: 60),
    int maxRestarts = 2,
    bool online = true,
  }) async {
    final ch = _FakeChannel();
    final conn = ConnectionManager(
      factory: (_, _) async => ch,
      storage: _FakeStorage(db),
      emitDebounce: Duration.zero,
    );
    var n = 0;
    final up = FileUploader(
      conn,
      chunkBytes: chunk,
      window: window,
      startAckTimeout: startAckTimeout,
      startAttempts: startAttempts,
      ackTimeout: ackTimeout,
      maxAckTimeout: maxAckTimeout,
      stallTimeout: stallTimeout,
      pauseGrace: pauseGrace,
      maxRestarts: maxRestarts,
      newId: () => 'u${++n}',
    );
    disposers
      ..add(conn.dispose)
      ..add(up.dispose);
    if (online) conn.adopt(ch, _peer);
    await pumpEventQueue();
    return (up: up, ch: ch, conn: conn);
  }

  final bytes = Uint8List.fromList(List<int>.generate(10, (i) => i * 7 + 1));

  group('sending', () {
    test('announces the file, keeps the window, completes on upload_done', () async {
      final s = await setup(); // 4-byte chunks, window 2 -> 3 chunks
      final seen = <int>[];
      final sub = s.up.uploadsStream.listen((l) {
        if (l.isNotEmpty) seen.add(l.single.ackedBytes);
      });
      addTearDown(sub.cancel);
      final src = _MemorySource(bytes);

      final handle = s.up.start(src);
      expect(s.up.uploads.single.phase, UploadPhase.starting);
      expect(s.up.uploads.single.name, 'report.pdf');
      await _until(() => s.ch.starts.isNotEmpty);
      final start = s.ch.starts.single;
      expect(start.uploadId, 'u1');
      expect(start.id, startsWith(kActionRequestIdPrefix));
      expect(start.name, 'report.pdf');
      expect(start.size, 10);
      expect(start.sha256, isNull, reason: 'the digest is known once the last chunk is read');
      await pumpEventQueue();
      expect(s.ch.chunks, isEmpty, reason: 'nothing flows before the first ack');

      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.length == 2);
      expect(s.ch.chunkSeqs, [0, 1]);
      expect(s.ch.chunks[0].data, _b64(bytes.sublist(0, 4)));
      expect(s.ch.chunks[1].data, _b64(bytes.sublist(4, 8)));
      await pumpEventQueue();
      expect(s.ch.chunks, hasLength(2), reason: 'at most 2 beyond the last ack');

      s.ch.push(_ack('u1', 1, received: 4));
      await _until(() => s.ch.chunks.length == 3);
      expect(s.ch.chunks[2].seq, 2);
      expect(s.ch.chunks[2].data, _b64(bytes.sublist(8)));
      expect(s.ch.ends, isEmpty, reason: 'upload_end waits for every ack');

      s.ch.push(_ack('u1', 3, received: 10));
      await _until(() => s.ch.ends.isNotEmpty);
      expect(s.ch.ends.single.uploadId, 'u1');
      expect(s.ch.ends.single.sha256, _sha(bytes));
      expect(s.up.uploads.single.phase, UploadPhase.finishing);
      expect(s.up.uploads.single.fraction, 1.0);

      s.ch.push(_done('u1'));
      final res = await handle.result;
      expect(res.path, _donePath);
      expect(res.name, 'report.pdf');
      expect(res.size, 10);
      expect(res.epk, _peer.remoteEpk);
      expect(res.roomId, 'main');
      expect(s.up.uploads, isEmpty);
      await _until(() => src.released);
      expect(seen, containsAllInOrder([0, 4, 10]));
      expect(seen, [...seen]..sort(), reason: 'progress never goes backwards');
    });

    test('reads the file one chunk at a time, never whole', () async {
      final s = await setup();
      final src = _MemorySource(bytes);
      final handle = s.up.start(src);
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.length == 2);
      s.ch.push(_ack('u1', 1));
      await _until(() => s.ch.chunks.length == 3);
      s.ch.push(_ack('u1', 3));
      await _until(() => s.ch.ends.isNotEmpty);
      s.ch.push(_done('u1'));
      await handle.result;

      expect(src.reads, ['0-4', '4-8', '8-10']);
    });

    test('an empty file is announced and ended without chunks', () async {
      final s = await setup();
      final src = _MemorySource(Uint8List(0), name: 'empty.txt');
      final handle = s.up.start(src);
      await _until(() => s.ch.starts.isNotEmpty);
      expect(s.ch.starts.single.size, 0);

      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.ends.isNotEmpty);
      expect(s.ch.ends.single.sha256, _sha(const <int>[]));
      expect(s.ch.chunks, isEmpty);
      s.ch.push(_done('u1', size: 0));
      expect((await handle.result).size, 0);
    });

    test('uploads are told apart by upload_id', () async {
      final s = await setup();
      final a = s.up.start(_MemorySource(bytes, name: 'a.bin'));
      final b = s.up.start(_MemorySource(bytes, name: 'b.bin'));
      await _until(() => s.ch.starts.length == 2);
      expect(s.up.uploads.map((u) => u.name), ['a.bin', 'b.bin']);

      s.ch.push(_ack('u2', 0));
      await _until(() => s.ch.chunks.length == 2);
      expect({for (final c in s.ch.chunks) c.uploadId}, {'u2'});
      s.ch.push(_ack('u2', 3));
      await _until(() => s.ch.ends.isNotEmpty);
      expect(s.ch.ends.single.uploadId, 'u2');
      s.ch.push(_done('u2'));
      expect((await b.result).name, 'b.bin');
      expect(s.up.uploads.single.id, 'u1');

      a.cancel();
      await expectLater(a.result, throwsA(_failure('cancelled')));
      expect(s.up.uploads, isEmpty);
    });

    test('progress: no fraction until the PC answers, then acked / size', () {
      UploadProgress p(UploadPhase phase, int acked, {int size = 10}) =>
          UploadProgress(
            id: 'x',
            name: 'n',
            size: size,
            ackedBytes: acked,
            phase: phase,
            epk: 'e',
            roomId: 'main',
          );
      expect(p(UploadPhase.starting, 0).fraction, isNull);
      expect(p(UploadPhase.sending, 4).fraction, 0.4);
      expect(p(UploadPhase.finishing, 10).fraction, 1.0);
      expect(p(UploadPhase.sending, 0, size: 0).fraction, 1.0);
    });

    test('start throws offline without a connection', () async {
      final s = await setup(online: false);
      expect(
        () => s.up.start(_MemorySource(bytes)),
        throwsA(_failure('offline')),
      );
      expect(s.up.uploads, isEmpty);
    });
  });

  group('resilience', () {
    test('an ack timeout only asks where the PC stands; chunks follow its answer', () async {
      final s = await setup(
        ackTimeout: const Duration(milliseconds: 150),
        maxAckTimeout: const Duration(milliseconds: 600),
      );
      final handle = s.up.start(_MemorySource(bytes));
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.length == 2);
      expect(s.ch.chunkSeqs, [0, 1]);

      // No ack comes back, which is also what a slow uplink looks like: chunks
      // sent again would only queue behind the ones still in the socket. The
      // probe is a repeated upload_start, and nothing else goes out until the
      // PC answers it.
      await _until(() => s.ch.starts.length >= 2);
      final probe = s.ch.starts.last;
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(s.ch.chunkSeqs, [0, 1], reason: 'no chunk while the probe is open');

      // The PC had chunk 0 only: its answer wins, sending continues there.
      s.ch.push(_ack('u1', 1, received: 4, echo: probe.id));
      await _until(() => s.ch.chunkSeqs.contains(2));
      expect(s.ch.chunkSeqs.sublist(2), [1, 2]);
      s.ch.push(_ack('u1', 3, received: 10));
      await _until(() => s.ch.ends.isNotEmpty);
      s.ch.push(_done('u1'));
      expect((await handle.result).path, _donePath);
    });

    test('no answer to upload_start: resent, then fails saying to update the PC', () async {
      final s = await setup(
        startAckTimeout: const Duration(milliseconds: 40),
        startAttempts: 3,
      );
      final src = _MemorySource(bytes);
      final handle = s.up.start(src);

      await expectLater(
        handle.result,
        throwsA(_failure('no_response', message: contains('update'))),
      );
      expect(s.ch.starts, hasLength(3));
      expect(s.up.uploads, isEmpty);
      await _until(() => src.released);
    });

    test('acks stop while connected: fails as stalled and tells the PC', () async {
      final s = await setup(
        ackTimeout: const Duration(milliseconds: 40),
        maxAckTimeout: const Duration(milliseconds: 40),
        stallTimeout: const Duration(milliseconds: 150),
      );
      final handle = s.up.start(_MemorySource(bytes));
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));

      await expectLater(
        handle.result,
        throwsA(_failure('stalled', message: contains('stalled'))),
      );
      await _until(() => s.ch.cancels.isNotEmpty);
      expect(s.ch.cancels.single.uploadId, 'u1');
    });

    test('a PC that lost the upload gets it started over, once per loss', () async {
      final s = await setup();
      final handle = s.up.start(_MemorySource(bytes));
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.length == 2);

      // Frames already in flight draw one `unknown_upload` each.
      for (var i = 0; i < 2; i++) {
        s.ch.push(
          const UploadError(
            uploadId: 'u1',
            code: 'unknown_upload',
            message: 'No such upload.',
          ),
        );
      }
      await _until(() => s.ch.starts.length == 2);
      await pumpEventQueue();
      expect(s.ch.starts, hasLength(2), reason: 'only the first one restarts');

      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.length == 4);
      expect(s.ch.chunkSeqs, [0, 1, 0, 1]);
      s.ch.push(_ack('u1', 3));
      await _until(() => s.ch.ends.isNotEmpty);
      s.ch.push(_done('u1'));
      expect((await handle.result).path, _donePath);
    });

    test('gives up when the PC keeps losing the upload', () async {
      final s = await setup(maxRestarts: 0);
      final handle = s.up.start(_MemorySource(bytes));
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.isNotEmpty);
      s.ch.push(
        const UploadError(
          uploadId: 'u1',
          code: 'unknown_upload',
          message: 'No such upload.',
        ),
      );
      await expectLater(handle.result, throwsA(_failure('unknown_upload')));
    });

    test('connection drop pauses the upload; the new connection resumes it', () async {
      final s = await setup();
      final handle = s.up.start(_MemorySource(bytes));
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.length == 2);

      await s.conn.disconnect();
      await _until(() => s.up.uploads.single.waiting);

      final ch2 = _FakeChannel();
      s.conn.adopt(ch2, _peer);
      await _until(() => ch2.starts.isNotEmpty);
      expect(s.up.uploads.single.waiting, isFalse);
      expect(ch2.starts.single.uploadId, 'u1');
      await pumpEventQueue();
      expect(ch2.chunks, isEmpty, reason: 'only the question until the PC answers');

      // The PC kept chunk 0: it continues from there.
      ch2.push(_ack('u1', 1, received: 4, echo: ch2.starts.single.id));
      await _until(() => ch2.chunks.length == 2);
      expect(ch2.chunkSeqs, [1, 2]);
      ch2.push(_ack('u1', 3, received: 10));
      await _until(() => ch2.ends.isNotEmpty);
      ch2.push(_done('u1'));
      expect((await handle.result).path, _donePath);
    });

    test('another session open pauses the upload; coming back resumes it', () async {
      final s = await setup();
      final handle = s.up.start(_MemorySource(bytes));
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.length == 2);

      s.conn.switchRoom('other-room');
      await _until(() => s.up.uploads.single.waiting);
      s.conn.switchRoom('main');
      await _until(() => !s.up.uploads.single.waiting);
      await _until(() => s.ch.starts.length >= 2);

      s.ch.push(_ack('u1', 2, received: 8));
      await _until(() => s.ch.chunkSeqs.contains(2));
      s.ch.push(_ack('u1', 3));
      await _until(() => s.ch.ends.isNotEmpty);
      s.ch.push(_done('u1'));
      expect((await handle.result).path, _donePath);
    });

    test('offline for longer than the grace fails as connection_lost', () async {
      final s = await setup(pauseGrace: const Duration(milliseconds: 60));
      final handle = s.up.start(_MemorySource(bytes));
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.isNotEmpty);

      await s.conn.disconnect();
      await expectLater(handle.result, throwsA(_failure('connection_lost')));
      expect(s.up.uploads, isEmpty);
    });
  });

  group('errors from the PC', () {
    test('upload_error fails the upload with the PC\'s words and no cancel', () async {
      final s = await setup();
      final src = _MemorySource(bytes);
      final handle = s.up.start(src);
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.isNotEmpty);

      s.ch.push(
        const UploadError(
          uploadId: 'u1',
          code: 'too_large',
          message: 'That file is larger than the 256 MiB limit.',
        ),
      );
      await expectLater(
        handle.result,
        throwsA(
          _failure(
            'too_large',
            message: 'That file is larger than the 256 MiB limit.',
          ),
        ),
      );
      expect(s.up.uploads, isEmpty);
      expect(s.ch.cancels, isEmpty, reason: 'the PC already dropped it');
      await _until(() => src.released);
    });

    test('a PC without upload support answers with an error: "too old"', () async {
      final s = await setup();
      final handle = s.up.start(_MemorySource(bytes));
      await _until(() => s.ch.starts.isNotEmpty);

      // Errors of other requests (and of the chat) are not ours.
      s.ch.push(
        ErrorMessage(
          inReplyTo: '${kActionRequestIdPrefix}models_1',
          code: 'internal_error',
          message: 'nope',
        ),
      );
      s.ch.push(
        ErrorMessage(inReplyTo: 'turn-1', code: 'boom', message: 'nope'),
      );
      await pumpEventQueue();
      expect(s.up.uploads, hasLength(1));

      s.ch.push(
        ErrorMessage(
          inReplyTo: s.ch.starts.single.id,
          code: 'unsupported_type',
          message: 'unknown type: upload_start',
        ),
      );
      await expectLater(
        handle.result,
        throwsA(_failure('unsupported', message: contains('too old'))),
      );
      expect(s.up.uploads, isEmpty);
    });
  });

  group('cancel', () {
    test('tells the PC, fails the result as cancelled, ignores late acks', () async {
      final s = await setup();
      final src = _MemorySource(bytes);
      final handle = s.up.start(src);
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => s.ch.chunks.length == 2);

      handle.cancel();
      await expectLater(
        handle.result,
        throwsA(isA<UploadFailure>().having((e) => e.cancelled, 'cancelled', isTrue)),
      );
      expect(s.up.uploads, isEmpty);
      await _until(() => s.ch.cancels.isNotEmpty);
      expect(s.ch.cancels.single.uploadId, 'u1');
      await _until(() => src.released);

      s.ch.push(_ack('u1', 1));
      s.ch.push(_done('u1'));
      await pumpEventQueue();
      expect(s.ch.chunks, hasLength(2));
      expect(s.up.uploads, isEmpty);
    });

    test('the announcement leaves before a byte is read, and cancel tells the PC', () async {
      final s = await setup();
      final src = _MemorySource(bytes);
      final handle = s.up.start(src);
      expect(s.up.uploads.single.phase, UploadPhase.starting);
      await _until(() => s.ch.starts.isNotEmpty);
      expect(src.reads, isEmpty);

      s.up.cancel(handle.id);
      await expectLater(handle.result, throwsA(_failure('cancelled')));

      expect(s.ch.cancels.map((c) => c.uploadId), ['u1']);
      expect(s.up.uploads, isEmpty);
      expect(src.reads, isEmpty);
      await _until(() => src.released);
    });

    test('cancel while a chunk is being read sends nothing more', () async {
      final s = await setup();
      final gate = Completer<void>();
      final src = _MemorySource(bytes, readGate: gate);
      final handle = s.up.start(src);
      await _until(() => s.ch.starts.isNotEmpty);
      s.ch.push(_ack('u1', 0));
      await _until(() => src.reads.isNotEmpty); // chunk 0 is being read

      s.up.cancel(handle.id);
      await expectLater(handle.result, throwsA(_failure('cancelled')));
      gate.complete();
      await pumpEventQueue();

      expect(s.ch.chunks, isEmpty);
      expect(s.ch.ends, isEmpty);
      expect(s.ch.cancels.map((c) => c.uploadId), ['u1']);
      await _until(() => src.released);
    });
  });
}

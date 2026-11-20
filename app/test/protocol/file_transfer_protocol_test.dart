// Plan 65 step 1 — file transfer frames. Wire names mirror the table in
// plan/65-send-file-to-phone.md exactly (shared with omp-extension's codec).

import 'dart:convert';

import 'package:app/protocol/codec.dart';
import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

ServerMessage _decode(Map<String, dynamic> json) =>
    decodeServer(jsonEncode(json));

Map<String, dynamic> _encode(ClientMessage m) =>
    jsonDecode(encodeClient(m)) as Map<String, dynamic>;

void main() {
  group('inbound (ext → app)', () {
    test('file_offer round-trips with every field', () {
      final offer = FileOffer(
        fileId: 'f1',
        name: 'app-release.apk',
        mime: 'application/vnd.android.package-archive',
        size: 34603008,
        sha256: 'ab' * 32,
        caption: 'Fresh build',
        turnId: 't9',
      );
      final json = offer.toJson();
      expect(json, {
        'type': 'file_offer',
        'file_id': 'f1',
        'name': 'app-release.apk',
        'mime': 'application/vnd.android.package-archive',
        'size': 34603008,
        'sha256': 'ab' * 32,
        'caption': 'Fresh build',
        'turn_id': 't9',
      });
      final back = _decode(json);
      expect(back, isA<FileOffer>());
      expect(back, offer);
    });

    test('file_offer without optional caption/turn_id', () {
      final back =
          _decode({
                'type': 'file_offer',
                'file_id': 'f2',
                'name': 'README.md',
                'mime': 'text/markdown',
                'size': 12,
                'sha256': 'cd' * 32,
              })
              as FileOffer;
      expect(back.caption, isNull);
      expect(back.turnId, isNull);
      expect(back.toJson().containsKey('caption'), isFalse);
      expect(back.toJson().containsKey('turn_id'), isFalse);
    });

    test('file_chunk round-trips', () {
      final chunk = FileChunk(
        fileId: 'f1',
        seq: 3,
        data: base64Encode([1, 2, 3]),
      );
      expect(chunk.toJson(), {
        'type': 'file_chunk',
        'file_id': 'f1',
        'seq': 3,
        'data': 'AQID',
      });
      expect(_decode(chunk.toJson()), chunk);
    });

    test('file_end round-trips', () {
      const end = FileEnd(fileId: 'f1', chunks: 33);
      expect(end.toJson(), {'type': 'file_end', 'file_id': 'f1', 'chunks': 33});
      expect(_decode(end.toJson()), end);
    });

    test('file_cancel from the extension decodes', () {
      const cancel = FileCancel(fileId: 'f1');
      expect(_decode({'type': 'file_cancel', 'file_id': 'f1'}), cancel);
    });

    test('unknown extra fields on every file_* frame are ignored', () {
      final frames = <Map<String, dynamic>>[
        {
          'type': 'file_offer',
          'file_id': 'f1',
          'name': 'a.pdf',
          'mime': 'application/pdf',
          'size': 1,
          'sha256': 'ee' * 32,
          'future_field': {'nested': true},
          'source_session': 'omp',
        },
        {
          'type': 'file_chunk',
          'file_id': 'f1',
          'seq': 0,
          'data': 'AA==',
          'compression': 'none',
        },
        {'type': 'file_end', 'file_id': 'f1', 'chunks': 1, 'elapsed_ms': 9},
        {'type': 'file_cancel', 'file_id': 'f1', 'why': 'abort'},
      ];
      for (final f in frames) {
        expect(() => _decode(f), returnsNormally, reason: f['type'] as String);
      }
      expect((_decode(frames[0]) as FileOffer).name, 'a.pdf');
      expect((_decode(frames[1]) as FileChunk).seq, 0);
      expect((_decode(frames[2]) as FileEnd).chunks, 1);
    });

    test('numeric fields accept JSON doubles', () {
      final chunk =
          _decode({
                'type': 'file_chunk',
                'file_id': 'f1',
                'seq': 2.0,
                'data': '',
              })
              as FileChunk;
      expect(chunk.seq, 2);
    });
  });

  group('outbound (app → ext)', () {
    test('file_ack carries the cumulative next_seq', () {
      final json = _encode(FileAck(fileId: 'f1', nextSeq: 4));
      expect(json, {'type': 'file_ack', 'file_id': 'f1', 'next_seq': 4});
      expect(FileAck.fromJson(json), FileAck(fileId: 'f1', nextSeq: 4));
    });

    test('file_done', () {
      final json = _encode(FileDone(fileId: 'f1'));
      expect(json, {'type': 'file_done', 'file_id': 'f1'});
      expect(FileDone.fromJson(json), FileDone(fileId: 'f1'));
    });

    test('file_error with each reason', () {
      for (final r in FileErrorReason.values) {
        final json = _encode(FileError(fileId: 'f1', reason: r));
        expect(json, {'type': 'file_error', 'file_id': 'f1', 'reason': r.wire});
        expect(FileError.fromJson(json), FileError(fileId: 'f1', reason: r));
      }
      expect(FileErrorReason.values.map((r) => r.wire), [
        'sha_mismatch',
        'no_space',
        'cancelled',
      ]);
    });

    test('file_error without reason omits the field', () {
      final json = _encode(FileError(fileId: 'f1'));
      expect(json, {'type': 'file_error', 'file_id': 'f1'});
      expect(FileError.fromJson(json).reason, isNull);
    });

    test('file_error with an unknown reason parses as null, not fatal', () {
      final e = FileError.fromJson({
        'type': 'file_error',
        'file_id': 'f1',
        'reason': 'disk_on_fire',
      });
      expect(e.reason, isNull);
    });

    test('file_cancel is sendable by the app', () {
      final json = _encode(const FileCancel(fileId: 'f1'));
      expect(json, {'type': 'file_cancel', 'file_id': 'f1'});
    });

    test('outbound fromJson ignores unknown extra fields', () {
      expect(
        FileAck.fromJson({
          'type': 'file_ack',
          'file_id': 'f1',
          'next_seq': 2,
          'x': 1,
        }),
        FileAck(fileId: 'f1', nextSeq: 2),
      );
    });
  });
}

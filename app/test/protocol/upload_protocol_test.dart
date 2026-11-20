// Plan 68 - upload frames. Field names are the wire contract shared with
// pi-extension/src/protocol/types.ts (snake_case, exactly as in the plan).

import 'dart:convert';
import 'dart:typed_data';

import 'package:app/protocol/codec.dart';
import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('upload ClientMessage serialization', () {
    test('upload_start carries the file facts; mime and sha256 are optional', () {
      expect(
        UploadStart(
          id: 'act_up_s',
          uploadId: 'u-1',
          name: 'report.pdf',
          size: 20971520,
          mime: 'application/pdf',
          sha256: 'a' * 64,
        ).toJson(),
        {
          'type': 'upload_start',
          'id': 'act_up_s',
          'upload_id': 'u-1',
          'name': 'report.pdf',
          'size': 20971520,
          'mime': 'application/pdf',
          'sha256': 'a' * 64,
        },
      );
      expect(
        UploadStart(
          id: 'act_up_s',
          uploadId: 'u-1',
          name: 'a.bin',
          size: 0,
        ).toJson(),
        {
          'type': 'upload_start',
          'id': 'act_up_s',
          'upload_id': 'u-1',
          'name': 'a.bin',
          'size': 0,
        },
      );
    });

    test('upload_chunk, upload_end and upload_cancel', () {
      expect(
        UploadChunk(id: 'c', uploadId: 'u-1', seq: 4, data: 'AAEC').toJson(),
        {'type': 'upload_chunk', 'id': 'c', 'upload_id': 'u-1', 'seq': 4, 'data': 'AAEC'},
      );
      expect(UploadEnd(id: 'e', uploadId: 'u-1').toJson(), {
        'type': 'upload_end',
        'id': 'e',
        'upload_id': 'u-1',
      });
      expect(UploadCancel(id: 'x', uploadId: 'u-1').toJson(), {
        'type': 'upload_cancel',
        'id': 'x',
        'upload_id': 'u-1',
      });
    });

    test('client frames survive a JSON round trip', () {
      final frames = <ClientMessage>[
        UploadStart(
          id: 'a',
          uploadId: 'u',
          name: 'n.txt',
          size: 3,
          mime: 'text/plain',
          sha256: 'b' * 64,
        ),
        UploadChunk(id: 'b', uploadId: 'u', seq: 0, data: 'AAEC'),
        UploadEnd(id: 'c', uploadId: 'u'),
        UploadCancel(id: 'd', uploadId: 'u'),
      ];
      for (final f in frames) {
        final json = jsonDecode(encodeClient(f)) as Map<String, dynamic>;
        final back = switch (json['type']) {
          'upload_start' => UploadStart.fromJson(json),
          'upload_chunk' => UploadChunk.fromJson(json),
          'upload_end' => UploadEnd.fromJson(json),
          'upload_cancel' => UploadCancel.fromJson(json),
          final t => fail('unexpected type $t'),
        };
        expect(back, f);
        expect(back.hashCode, f.hashCode);
      }
    });

    test('a full 1 MiB chunk stays far below the relay\'s 4 MiB cap', () {
      final chunk = UploadChunk(
        id: 'c',
        uploadId: '0194a3c2-5b7e-7c1d-8f3a-2b9d4e6f7a10',
        seq: 255,
        data: base64Encode(Uint8List(1024 * 1024)),
      );
      // The relay compares the base64-decoded `ct` (this JSON) with its cap.
      final inner = utf8.encode(jsonEncode(chunk.toJson())).length;
      expect(inner, lessThan(2 * 1024 * 1024));
      expect(inner, greaterThan(1024 * 1024));
    });
  });

  group('upload ServerMessage parsing', () {
    test('upload_ack is cumulative: seq is the first chunk still needed', () {
      final msg = ServerMessage.fromJson({
        'type': 'upload_ack',
        'upload_id': 'u-1',
        'seq': 5,
        'received': 5242880,
      });
      expect(msg, isA<UploadAck>());
      final ack = msg as UploadAck;
      expect(ack.uploadId, 'u-1');
      expect(ack.seq, 5);
      expect(ack.received, 5242880);
      expect(ack, const UploadAck(uploadId: 'u-1', seq: 5, received: 5242880));
    });

    test('upload_done carries the absolute path on the PC', () {
      final msg = decodeServer(
        '{"type":"upload_done","upload_id":"u-1",'
        '"path":"/home/leo/.omp/remote/uploads/2026-11-20/report.pdf",'
        '"size":20971520}',
      );
      expect(
        msg,
        const UploadDone(
          uploadId: 'u-1',
          path: '/home/leo/.omp/remote/uploads/2026-11-20/report.pdf',
          size: 20971520,
        ),
      );
    });

    test('upload_error keeps the code and the user-facing message', () {
      final msg = decodeServer(
        '{"type":"upload_error","upload_id":"u-1","code":"sha_mismatch",'
        '"message":"The file arrived damaged.","extra":"ignored"}',
      );
      expect(
        msg,
        const UploadError(
          uploadId: 'u-1',
          code: 'sha_mismatch',
          message: 'The file arrived damaged.',
        ),
      );
    });

    test('missing optional fields fall back instead of throwing', () {
      expect(
        ServerMessage.fromJson({
          'type': 'upload_error',
          'upload_id': 'u',
        }),
        const UploadError(uploadId: 'u', code: 'unknown', message: ''),
      );
      expect(
        ServerMessage.fromJson({
          'type': 'upload_ack',
          'upload_id': 'u',
          'seq': 0,
        }),
        const UploadAck(uploadId: 'u', seq: 0, received: 0),
      );
    });

    test('toJson mirrors the frames the PC sends', () {
      const frames = <Map<String, dynamic>>[
        {'type': 'upload_ack', 'upload_id': 'u', 'seq': 2, 'received': 2048},
        {'type': 'upload_done', 'upload_id': 'u', 'path': '/p/a.txt', 'size': 7},
        {
          'type': 'upload_error',
          'upload_id': 'u',
          'code': 'too_large',
          'message': 'Too big.',
        },
      ];
      for (final json in frames) {
        final msg = ServerMessage.fromJson(json);
        final out = switch (msg) {
          final UploadAck m => m.toJson(),
          final UploadDone m => m.toJson(),
          final UploadError m => m.toJson(),
          _ => fail('unexpected ${msg.runtimeType}'),
        };
        expect(out, json);
      }
    });
  });
}

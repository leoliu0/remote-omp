// RoomDemux — which inbound envelopes reach the app (plan 18 follow-up demux +
// the plan 68 exception for the reply to a request sent to another room).

import 'dart:convert';
import 'dart:typed_data';

import 'package:app/data/transport/room_demux.dart';
import 'package:flutter_test/flutter_test.dart';

Uint8List _frame(Map<String, dynamic> json) =>
    Uint8List.fromList(utf8.encode(jsonEncode(json)));

void main() {
  late DateTime clock;
  late RoomDemux demux;

  setUp(() {
    clock = DateTime(2026, 11, 20, 12);
    demux = RoomDemux(now: () => clock);
  });

  group('room demux', () {
    test('admits legacy frames without a room and frames of the active room', () {
      final payload = _frame({'type': 'pong', 'in_reply_to': 'x'});
      expect(demux.admits(null, payload), isTrue);
      expect(demux.admits('main', payload), isTrue); // default room

      demux.setActiveRoom('r1');
      expect(demux.activeRoom, 'r1');
      expect(demux.admits('r1', payload), isTrue);
      // A chat the user left must not bleed into the one they are viewing.
      expect(demux.admits('main', payload), isFalse);
      expect(demux.admits('r2', payload), isFalse);
    });
  });

  group('expectReply (plan 68)', () {
    setUp(() => demux.setActiveRoom('r1'));

    test('admits the one reply to the request, from the room it was sent to', () {
      demux.expectReply('act_1', 'r2');
      final reply = _frame({'type': 'dirs_list', 'in_reply_to': 'act_1'});

      expect(demux.admits('r2', reply), isTrue);
      // One reply per request: a repeat is dropped like any other r2 frame.
      expect(demux.admits('r2', reply), isFalse);
    });

    test('lets nothing else through from that room', () {
      demux.expectReply('act_1', 'r2');

      // Chat traffic of the room (no in_reply_to / another request's reply).
      expect(
        demux.admits('r2', _frame({'type': 'agent_chunk', 'delta': 'hi'})),
        isFalse,
      );
      expect(
        demux.admits('r2', _frame({'type': 'pong', 'in_reply_to': 'act_9'})),
        isFalse,
      );
      // The same id from the wrong room.
      expect(
        demux.admits('r3', _frame({'type': 'pong', 'in_reply_to': 'act_1'})),
        isFalse,
      );
      // Still waiting for the real one.
      expect(
        demux.admits('r2', _frame({'type': 'dirs_list', 'in_reply_to': 'act_1'})),
        isTrue,
      );
    });

    test('several requests can be in flight', () {
      demux.expectReply('act_1', 'r2');
      demux.expectReply('act_2', 'r3');
      expect(demux.admits('r3', _frame({'in_reply_to': 'act_2'})), isTrue);
      expect(demux.admits('r2', _frame({'in_reply_to': 'act_1'})), isTrue);
    });

    test('a request that is cancelled admits nothing', () {
      demux.expectReply('act_1', 'r2');
      demux.cancelReply('act_1');
      expect(demux.admits('r2', _frame({'in_reply_to': 'act_1'})), isFalse);
    });

    test('an expectation expires, so a reply that never came leaves no hole', () {
      demux.expectReply('act_1', 'r2', ttl: const Duration(seconds: 30));
      clock = clock.add(const Duration(seconds: 31));
      expect(demux.admits('r2', _frame({'in_reply_to': 'act_1'})), isFalse);
    });

    test('the active room needs no expectation, and junk is simply dropped', () {
      demux.expectReply('act_1', 'r2');
      expect(demux.admits('r1', _frame({'type': 'agent_chunk'})), isTrue);
      expect(demux.admits('r2', Uint8List.fromList([0xff, 0xfe, 0x00])), isFalse);
      expect(demux.admits('r2', Uint8List.fromList(utf8.encode('[1,2]'))), isFalse);
      expect(demux.admits('r2', Uint8List.fromList(utf8.encode('nope'))), isFalse);
    });
  });
}

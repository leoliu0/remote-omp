// RoomDemux — decides which inbound relay envelopes reach the app.
//
// The relay stamps every envelope with the Pi-side room that sent it, and the
// app addresses ONE room at a time: the chat it has open. Frames from any
// other room are dropped, otherwise the agent chunks of a chat the user just
// left would bleed into the one they are viewing (plan-18 follow-up). Envelopes
// without a room come from legacy Pis and always pass.
//
// Plan 68 adds one narrow exception. A typed request sent to a specific live
// room while the UI stays elsewhere (Home starting a new session has no chat
// open) must still get its reply, which comes from that room. [expectReply]
// admits exactly that frame — identified by its `in_reply_to` — and nothing
// else from the room.

import 'dart:convert';
import 'dart:typed_data';

class RoomDemux {
  RoomDemux({DateTime Function()? now}) : _now = now ?? DateTime.now;

  final DateTime Function() _now;
  String _active = 'main';
  final Map<String, _AwaitedReply> _awaited = {};

  /// The room outbound envelopes are addressed to and inbound frames are
  /// accepted from. 'main' until the app picks one.
  String get activeRoom => _active;

  void setActiveRoom(String room) => _active = room;

  /// Lets the one reply to [requestId] through when it comes from [room], even
  /// though [room] is not the active room. Expires after [ttl] so a reply that
  /// never comes cannot leave the door open.
  void expectReply(
    String requestId,
    String room, {
    Duration ttl = const Duration(seconds: 30),
  }) {
    _awaited[requestId] = _AwaitedReply(room, _now().add(ttl));
  }

  /// The request is over (answered, failed or timed out): stop expecting it.
  void cancelReply(String requestId) => _awaited.remove(requestId);

  /// Whether an envelope from [senderRoom] carrying [payload] (the decoded
  /// inner JSON) should be delivered.
  bool admits(String? senderRoom, Uint8List payload) {
    if (senderRoom == null || senderRoom == _active) return true;
    if (_awaited.isEmpty) return false;
    final now = _now();
    _awaited.removeWhere((_, a) => a.expires.isBefore(now));
    final id = _inReplyTo(payload);
    final awaited = id == null ? null : _awaited[id];
    if (awaited == null || awaited.room != senderRoom) return false;
    _awaited.remove(id); // one reply per request
    return true;
  }

  static String? _inReplyTo(Uint8List payload) {
    try {
      final json = jsonDecode(utf8.decode(payload));
      if (json is Map<String, dynamic>) {
        final id = json['in_reply_to'];
        if (id is String) return id;
      }
    } catch (_) {
      // Not JSON: nothing is awaiting it.
    }
    return null;
  }
}

class _AwaitedReply {
  final String room;
  final DateTime expires;
  const _AwaitedReply(this.room, this.expires);
}

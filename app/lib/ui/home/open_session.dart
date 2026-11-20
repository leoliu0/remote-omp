import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart' show RoomInfo;
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/home/viewmodels/home_viewmodel.dart';
import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

/// Opens [room] of [peer] the way a Home tile tap does: writes the selected
/// (peer, room) so a fresh ChatViewModel binds to it, marks the UI selection
/// (drives the tablet detail pane and the highlighted tile) and, on a phone,
/// goes to the full-screen chat.
///
/// [replace] swaps the chat route the caller is on instead of stacking
/// another one (the session switcher inside a chat), so Back still returns to
/// where the chat was opened from. Tablets only update the selection.
Future<void> openSession(
  BuildContext context,
  HomeViewModel vm,
  PeerRecord peer,
  RoomInfo room, {
  bool replace = false,
}) async {
  // Sets prefs (selectedPeerEpk + room) + switchRoom so a fresh
  // ChatViewModel binds to this session.
  await vm.openSession(peer.remoteEpk, roomId: room.roomId);
  if (!context.mounted) return;
  final title = sessionTitle(peer, room);
  // Plan/32g - the device (Mac) name we already know here. The Chat AppBar's
  // line 2 renders this immediately instead of flickering empty/room-title
  // until the PeerRecord loads async.
  final device = sessionDevice(peer);
  // Plan/32g - the live state of this tile (the green dot). A working
  // agent counts as online too (same rule as the Online tab).
  final online =
      vm.isRoomLive(peer.remoteEpk, room.roomId) ||
      vm.isRoomWorking(peer.remoteEpk, room.roomId);
  // Mark the UI selection - drives the tablet detail pane AND the
  // highlighted tile. Set AFTER openSession so the detail's fresh
  // ChatViewModel reads the already-updated prefs.
  context.read<SessionSelection>().select(
    peer.remoteEpk,
    room.roomId,
    title,
    device,
    online,
  );
  // Phone: full-screen chat (root push -> native back/swipe). Tablet:
  // the detail pane reacts to the selection above - no nav needed.
  if (!isWideLayout(context)) {
    final extra = {'title': title, 'device': device, 'online': online};
    if (replace) {
      context.pushReplacement('/chat', extra: extra);
    } else {
      context.push('/chat', extra: extra);
    }
  }
}

/// Plan/32g - the paired-device label for the Chat AppBar's line 2
/// (nickname -> sessionName -> epk prefix). Mirrors ChatPage's own peer
/// resolution so there's no change when the PeerRecord finishes loading.
String sessionDevice(PeerRecord peer) => (peer.nickname?.isNotEmpty ?? false)
    ? peer.nickname!
    : peer.sessionName.isNotEmpty
    ? peer.sessionName
    : peer.remoteEpk.substring(0, 8);

/// Plan/24-fix-title: the peer/room label we already know here, so the Chat
/// AppBar doesn't show '-' / 'Remote OMP' until the ChatViewModel loads the
/// PeerRecord + the first room_meta_updated arrives. Prefers room.name
/// (per-cwd title) -> cwd tail -> nickname -> sessionName.
String sessionTitle(PeerRecord peer, RoomInfo room) {
  final roomCwdTail = room.cwd
      ?.split('/')
      .where((s) => s.isNotEmpty)
      .lastOrNull;
  return (room.name?.isNotEmpty ?? false)
      ? room.name!
      : (roomCwdTail != null && roomCwdTail.isNotEmpty)
      ? roomCwdTail
      : (peer.nickname?.isNotEmpty ?? false)
      ? peer.nickname!
      : peer.sessionName.isNotEmpty
      ? peer.sessionName
      : peer.remoteEpk.substring(0, 8);
}

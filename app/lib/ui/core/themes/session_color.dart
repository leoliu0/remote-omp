import 'package:flutter/material.dart';

/// Plan/68 - a stable colour per session, so the active session is
/// unmistakable in the chat app bar and on its Home tile.
///
/// The theme has no categorical palette, so the colour is derived: the
/// session identity picks one of [kSessionColorCount] hues spaced evenly
/// around the wheel, drawn at a fixed saturation and a lightness that reads
/// on the active theme's background.
const int kSessionColorCount = 12;

/// Index (`0..kSessionColorCount-1`) of the colour of the session
/// [roomId] on the PC [peerEpk].
///
/// FNV-1a over the identity's UTF-16 code units: unlike `String.hashCode` it
/// never changes between runs, platforms or SDK versions, so a session keeps
/// its colour for good. The PC is part of the identity because the same
/// folder on two PCs is two different sessions.
int sessionColorIndex(String peerEpk, String roomId) {
  var hash = 0x811c9dc5;
  for (final unit in '$peerEpk/$roomId'.codeUnits) {
    hash = ((hash ^ unit) * 0x01000193) & 0xFFFFFFFF;
  }
  return hash % kSessionColorCount;
}

/// The colour of a session on a [brightness] theme.
Color sessionColor(
  String peerEpk,
  String roomId, {
  Brightness brightness = Brightness.dark,
}) {
  final hue =
      (sessionColorIndex(peerEpk, roomId) * 360 / kSessionColorCount + 12) %
      360;
  return HSLColor.fromAHSL(
    1,
    hue,
    0.62,
    brightness == Brightness.dark ? 0.62 : 0.45,
  ).toColor();
}

/// A slim rounded bar in the session's colour. Fixed width, so it never moves
/// the title next to it.
class SessionColorBar extends StatelessWidget {
  const SessionColorBar({
    super.key,
    required this.peerEpk,
    required this.roomId,
    this.height = 32,
  });

  final String peerEpk;
  final String roomId;
  final double height;

  @override
  Widget build(BuildContext context) => Container(
    width: 4,
    height: height,
    decoration: BoxDecoration(
      color: sessionColor(
        peerEpk,
        roomId,
        brightness: Theme.of(context).brightness,
      ),
      borderRadius: BorderRadius.circular(2),
    ),
  );
}

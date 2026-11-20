import 'package:app/pairing/storage.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Per-pairing section header on the Home list (one per Pi). Shows the device
/// label (nickname → sessionName → epk prefix). The old `via <harness>`
/// subtitle was dropped as redundant.
///
/// Plan 68: with [onNewSession] set, the header also carries a "New session"
/// action for this PC. [newSessionEnabled] greys it out while the PC has no
/// live session to send the request through.
class PeerSectionHeader extends StatelessWidget {
  final PeerRecord peer;
  final VoidCallback? onNewSession;
  final bool newSessionEnabled;
  const PeerSectionHeader({
    super.key,
    required this.peer,
    this.onNewSession,
    this.newSessionEnabled = true,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final label = (peer.nickname?.isNotEmpty ?? false)
        ? peer.nickname!
        : peer.sessionName.isNotEmpty
            ? peer.sessionName
            : peer.remoteEpk.substring(0, 8);
    final labelText = Text(
      label.toUpperCase(),
      style: context.typo.mono.copyWith(
        fontSize: 11,
        color: colors.muted,
        fontWeight: FontWeight.w600,
        letterSpacing: 1.0,
      ),
    );
    final action = onNewSession;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 18, action == null ? 20 : 12, 6),
      child: action == null
          ? labelText
          : Row(
              children: [
                Expanded(child: labelText),
                Tooltip(
                  message: newSessionEnabled
                      ? 'Start a new session on this PC'
                      : 'Needs a running session on this PC, and a connection to it',
                  child: TextButton.icon(
                    key: Key('home-new-session-${peer.remoteEpk}'),
                    onPressed: newSessionEnabled ? action : null,
                    icon: const Icon(LucideIcons.plus, size: 14),
                    label: const Text('New session'),
                    style: TextButton.styleFrom(
                      foregroundColor: colors.accent,
                      disabledForegroundColor: colors.muted,
                      minimumSize: const Size(0, 30),
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      visualDensity: VisualDensity.compact,
                      textStyle: context.typo.mono.copyWith(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}

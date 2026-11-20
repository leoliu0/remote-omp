import 'package:app/config/dependencies.dart' show injector;
import 'package:app/pairing/storage.dart' show PeerRecord;
import 'package:app/ui/core/themes/session_color.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/home/open_session.dart';
import 'package:app/ui/home/states/home_state.dart';
import 'package:app/ui/home/viewmodels/home_viewmodel.dart';
import 'package:app/ui/home/widgets/peer_section_header.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Plan/68 - whether a session in the switcher is mid-turn, idle (live and
/// waiting) or offline.
enum SwitcherStatus { working, idle, offline }

class SwitcherEntry {
  final HomeItem item;
  final SwitcherStatus status;
  const SwitcherEntry(this.item, this.status);

  bool get isLive => status != SwitcherStatus.offline;
}

class SwitcherGroup {
  final PeerRecord peer;
  final List<SwitcherEntry> entries;
  const SwitcherGroup(this.peer, this.entries);

  bool get hasLive => entries.any((e) => e.isLive);
}

/// Home's sessions regrouped for the switcher: one group per PC, live
/// sessions before offline ones inside a group, and PCs with a live session
/// before the rest. Name order is kept otherwise (Home already sorts by
/// name); the split is a partition because Dart's `sort` is not stable.
///
/// [isLive] must hold for a working session too.
List<SwitcherGroup> switcherGroups(
  HomeList list, {
  required bool Function(String epk, String roomId) isLive,
  required bool Function(String epk, String roomId) isWorking,
  String Function(String)? normalizeEpk,
}) {
  final peers = <String, PeerRecord>{};
  final byPeer = <String, List<SwitcherEntry>>{};
  for (final item in list.items(normalizeEpk: normalizeEpk)) {
    final epk = item.peer.remoteEpk;
    final roomId = item.room.roomId;
    final status = isWorking(epk, roomId)
        ? SwitcherStatus.working
        : isLive(epk, roomId)
        ? SwitcherStatus.idle
        : SwitcherStatus.offline;
    peers[epk] = item.peer;
    (byPeer[epk] ??= []).add(SwitcherEntry(item, status));
  }
  final groups = <SwitcherGroup>[
    for (final e in byPeer.entries)
      SwitcherGroup(peers[e.key]!, [
        ...e.value.where((x) => x.isLive),
        ...e.value.where((x) => !x.isLive),
      ]),
  ];
  return [
    ...groups.where((g) => g.hasLive),
    ...groups.where((g) => !g.hasLive),
  ];
}

/// Opens the quick session switcher from the chat title. Reuses Home's own
/// view model for the live / working data and switches through the same
/// [openSession] path a Home tile tap takes.
Future<void> showSessionSwitcherSheet(
  BuildContext context, {
  required String currentEpk,
  required String currentRoomId,
}) async {
  final vm = injector.get<HomeViewModel>();
  try {
    final picked = await showModalBottomSheet<HomeItem>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.colors.bg,
      shape: RoundedRectangleBorder(
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
        side: BorderSide(color: context.colors.border),
      ),
      builder: (sheetContext) => ListenableBuilder(
        listenable: vm,
        builder: (_, _) {
          final state = vm.state;
          return SessionSwitcherSheet(
            groups: state is HomeList
                ? switcherGroups(
                    state,
                    isLive: (epk, room) =>
                        vm.isRoomLive(epk, room) || vm.isRoomWorking(epk, room),
                    isWorking: vm.isRoomWorking,
                    normalizeEpk: HomeViewModel.normalizeEpkForLookup,
                  )
                : null,
            currentEpk: currentEpk,
            currentRoomId: currentRoomId,
            onSelect: (item) => Navigator.of(sheetContext).pop(item),
          );
        },
      ),
    );
    if (picked == null || !context.mounted) return;
    // The view model must outlive the switch: it writes the selection.
    await openSession(context, vm, picked.peer, picked.room, replace: true);
  } finally {
    vm.dispose();
  }
}

/// The switcher's content: sessions grouped by PC with a status and colour
/// badge each. The current session is marked and not tappable.
class SessionSwitcherSheet extends StatelessWidget {
  const SessionSwitcherSheet({
    super.key,
    required this.groups,
    required this.currentEpk,
    required this.currentRoomId,
    required this.onSelect,
  });

  /// Null while Home's data is still loading.
  final List<SwitcherGroup>? groups;
  final String currentEpk;
  final String currentRoomId;
  final void Function(HomeItem item) onSelect;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final groups = this.groups;
    return SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Center(
            child: Container(
              margin: const EdgeInsets.only(top: 10, bottom: 6),
              width: 36,
              height: 4,
              decoration: BoxDecoration(
                color: colors.border,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 4),
            child: Text(
              'Switch session',
              style: context.typo.mono.copyWith(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: colors.text,
              ),
            ),
          ),
          if (groups == null)
            const Padding(
              padding: EdgeInsets.all(32),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else if (groups.isEmpty)
            Padding(
              padding: const EdgeInsets.all(32),
              child: Center(
                child: Text(
                  'No sessions yet',
                  style: context.typo.mono.copyWith(
                    fontSize: 13,
                    color: colors.muted,
                  ),
                ),
              ),
            )
          else
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 12),
                children: [
                  for (final group in groups) ...[
                    PeerSectionHeader(peer: group.peer),
                    for (final entry in group.entries)
                      _SwitcherRow(
                        entry: entry,
                        isCurrent:
                            entry.item.peer.remoteEpk == currentEpk &&
                            entry.item.room.roomId == currentRoomId,
                        onTap: () => onSelect(entry.item),
                      ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _SwitcherRow extends StatelessWidget {
  const _SwitcherRow({
    required this.entry,
    required this.isCurrent,
    required this.onTap,
  });

  final SwitcherEntry entry;
  final bool isCurrent;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final item = entry.item;
    final epk = item.peer.remoteEpk;
    final roomId = item.room.roomId;
    final (statusColor, statusLabel) = switch (entry.status) {
      SwitcherStatus.working => (colors.working, 'working'),
      SwitcherStatus.idle => (colors.success, 'idle'),
      SwitcherStatus.offline => (colors.muted, 'offline'),
    };
    final cwd = item.room.cwd;
    return InkWell(
      key: ValueKey('switcher_row_${epk}_$roomId'),
      onTap: isCurrent ? null : onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
        child: Row(
          children: [
            SessionColorBar(peerEpk: epk, roomId: roomId, height: 30),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: colors.text,
                      fontSize: 15,
                      fontWeight: isCurrent ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                  if (cwd != null && cwd.isNotEmpty)
                    Text(
                      cwd,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.typo.mono.copyWith(
                        fontSize: 11.5,
                        color: colors.muted,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: statusColor,
              ),
            ),
            const SizedBox(width: 5),
            Text(
              statusLabel,
              style: context.typo.mono.copyWith(
                fontSize: 11.5,
                color: statusColor,
              ),
            ),
            if (isCurrent) ...[
              const SizedBox(width: 8),
              Icon(
                LucideIcons.check,
                key: const Key('switcher_current'),
                size: 14,
                color: colors.accent,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The chat app bar's title area: a slim bar in the session's colour (always
/// in the same slot, so the title never shifts) and a tap target that opens
/// the switcher. [child] is the title block.
class SessionTitleButton extends StatelessWidget {
  const SessionTitleButton({
    super.key,
    required this.peerEpk,
    required this.roomId,
    required this.onTap,
    required this.child,
  });

  final String peerEpk;
  final String roomId;
  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(8),
    child: Row(
      children: [
        SessionColorBar(peerEpk: peerEpk, roomId: roomId, height: 32),
        const SizedBox(width: 8),
        Expanded(child: child),
        Icon(LucideIcons.chevronsUpDown, size: 14, color: context.colors.muted2),
        const SizedBox(width: 4),
      ],
    ),
  );
}

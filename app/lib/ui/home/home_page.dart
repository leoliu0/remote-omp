import 'package:app/data/actions/new_session_repository.dart' show NewSessionFailure;
import 'package:app/data/transport/epk_encoding.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart' show RoomInfo;
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/home/states/home_state.dart';
import 'package:app/ui/settings/settings_sheet.dart';
import 'package:app/ui/home/viewmodels/home_viewmodel.dart';
import 'package:app/ui/home/open_session.dart';
import 'package:app/ui/home/widgets/new_session_sheet.dart';
import 'package:app/ui/home/widgets/widgets.dart';
import 'package:app/ui/update/widgets/update_banner.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Plan-18 follow-up — iOS-style large title that collapses into a
/// compact bar when scrolled. Built with `SliverAppBar +
/// FlexibleSpaceBar`. Subtitle shows the first paired Mac + relay
/// status. Body is sectioned by pairing always (single peer also
/// gets the pairing header, per the mock).
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final vm = context.watch<HomeViewModel>();
    final state = vm.state;

    // Plan/tablet — tell the adaptive shell whether Home has anything to
    // list. On a zero-state (no Pi paired / empty list) the shell drops
    // the two-pane split and shows this page full-width + centered. Done
    // post-frame so we never notify mid-build.
    final isZeroState = switch (state) {
      HomeLoading() => false,
      HomeNoPeer() => true,
      HomeList() => state.items(normalizeEpk: toStandardB64).isEmpty,
    };
    final shell = context.read<ShellLayout>();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      shell.setZeroState(isZeroState);
    });

    return Scaffold(
      backgroundColor: colors.bg,
      body: SafeArea(
        child: CustomScrollView(
          slivers: [
            _buildLargeTitleBar(context, vm, state),
            // Plan 44 — Android-only update notice. Sits at the top of the
            // scroll content (below the title, above the list); shrinks to
            // zero height when there's nothing to announce, so it's invisible
            // on iOS and when no newer version exists.
            const SliverToBoxAdapter(child: UpdateBanner()),
            switch (state) {
              HomeLoading() => SliverFillRemaining(
                hasScrollBody: false,
                child: Center(
                  child: CircularProgressIndicator(color: colors.accent),
                ),
              ),
              HomeNoPeer() => const SliverFillRemaining(
                hasScrollBody: false,
                child: _EmptyState(),
              ),
              HomeList() => _buildListSlivers(context, vm, state),
            },
          ],
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Large title (iOS-style)
  // ---------------------------------------------------------------------------

  Widget _buildLargeTitleBar(
    BuildContext context,
    HomeViewModel vm,
    HomeState state,
  ) {
    final colors = context.colors;
    final subtitle = _subtitleFor(context, vm, state);
    const maxExpanded = 124.0;
    return SliverAppBar(
      backgroundColor: colors.bg,
      surfaceTintColor: colors.bg,
      elevation: 0,
      scrolledUnderElevation: 0,
      pinned: true,
      stretch: false,
      expandedHeight: maxExpanded,
      collapsedHeight: 56,
      toolbarHeight: 56,
      automaticallyImplyLeading: false,
      actions: [
        IconButton(
          tooltip: 'Settings',
          icon: Icon(LucideIcons.settings, color: colors.muted2),
          // Tablet → bottom sheet (keeps the chat in context); phone →
          // full-screen push. See openSettings.
          onPressed: () => openSettings(context),
        ),
        const SizedBox(width: 4),
      ],
      // Title rendering happens entirely inside flexibleSpace so we
      // can cross-fade between the large form (expanded) and the
      // compact form (collapsed). Using `SliverAppBar.title` here
      // would overlay the compact title on top of the large one
      // while expanded — that was the "two app bars" bug.
      flexibleSpace: LayoutBuilder(
        builder: (ctx, constraints) {
          final maxH = constraints.maxHeight;
          const minH = 56.0;
          // t=1 → fully expanded; t=0 → fully collapsed.
          final t = ((maxH - minH) / (maxExpanded - minH)).clamp(0.0, 1.0);
          return Stack(
            fit: StackFit.expand,
            children: [
              Container(color: colors.bg),
              // Large title block — fades OUT as we collapse.
              Positioned(
                left: 20,
                right: 20,
                bottom: 8,
                child: IgnorePointer(
                  ignoring: t < 0.05,
                  child: Opacity(
                    opacity: t,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Remote OMP',
                          style: brandTextStyle(
                            fontSize: 32,
                            fontWeight: FontWeight.w700,
                            color: colors.text,
                            letterSpacing: -0.5,
                            height: 1.05,
                          ),
                        ),
                        const SizedBox(height: 6),
                        subtitle,
                      ],
                    ),
                  ),
                ),
              ),
              // Compact title — fades IN as we collapse.
              Positioned(
                left: 20,
                right: 64, // leave space for the actions icon
                top: 0,
                height: 56,
                child: IgnorePointer(
                  ignoring: t > 0.95,
                  child: Opacity(
                    opacity: 1 - t,
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        'Remote OMP',
                        style: brandTextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: colors.text,
                          letterSpacing: -0.2,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              // Bottom divider — only shows once collapsed.
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: Opacity(
                  opacity: 1 - t,
                  child: Divider(color: colors.border, height: 1, thickness: 1),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  /// Subtitle line under "Remote OMP": ● Relay · [Connected|Awaiting pairing|Offline].
  /// Reflects the app→relay WS state (not per-Pi presence) so the
  /// user always knows whether the app itself is reachable.
  ///
  /// `HomeNoPeer` is the special case where no peer is paired yet —
  /// the WS is never opened (its URL embeds the destination peer's
  /// pubkey), so `isRelayConnected` is false but that doesn't mean
  /// the relay is down. Render a neutral "Awaiting pairing" instead
  /// of the alarming amber "Offline".
  Widget _subtitleFor(BuildContext context, HomeViewModel vm, HomeState state) {
    final colors = context.colors;
    final connected = vm.isRelayConnected;
    final awaitingPairing = state is HomeNoPeer;
    final Color dotColor;
    final String statusLabel;
    final Color statusColor;
    if (connected) {
      dotColor = colors.success;
      statusLabel = 'Connected';
      statusColor = colors.muted;
    } else if (awaitingPairing) {
      dotColor = colors.muted;
      statusLabel = 'Awaiting pairing';
      statusColor = colors.muted;
    } else {
      dotColor = colors.warning;
      statusLabel = 'Offline';
      statusColor = colors.warning;
    }
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(shape: BoxShape.circle, color: dotColor),
        ),
        const SizedBox(width: 8),
        Text(
          'Relay',
          style: context.typo.mono.copyWith(
            color: colors.text,
            fontSize: 13,
          ),
        ),
        const SizedBox(width: 6),
        Text(
          '·',
          style: context.typo.mono.copyWith(
            color: colors.muted,
            fontSize: 13,
          ),
        ),
        const SizedBox(width: 6),
        Text(
          statusLabel,
          style: context.typo.mono.copyWith(
            color: statusColor,
            fontSize: 13,
          ),
        ),
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // List body
  // ---------------------------------------------------------------------------

  Widget _buildListSlivers(
    BuildContext context,
    HomeViewModel vm,
    HomeList state,
  ) {
    final colors = context.colors;
    final counts = vm.counts;
    final pendingOnline = vm.onlineListPending;
    // Globally empty (paired Pi, no rooms at all): keep the original lonely
    // state and DON'T show the tabs — there's nothing to filter. While the
    // first rooms snapshot is still in flight, show a spinner so Online
    // cannot flash "No sessions online".
    if (counts.all == 0) {
      if (pendingOnline) {
        return SliverFillRemaining(
          hasScrollBody: false,
          child: Center(
            child: CircularProgressIndicator(color: colors.accent),
          ),
        );
      }
      return const SliverFillRemaining(
        hasScrollBody: false,
        child: _LonelyEmptyState(),
      );
    }

    // Plan-38 Fase 3 — presence filter at the top of the list. Pure view:
    // tapping a tab only swaps `state.filter` → `vm.visibleItems` re-derives.
    final tabs = SliverToBoxAdapter(
      child: HomeFilterTabs(
        filter: state.filter,
        counts: counts,
        onSelected: vm.setFilter,
      ),
    );

    final visible = vm.visibleItems;
    if (visible.isEmpty) {
      if (pendingOnline) {
        return SliverMainAxisGroup(
          slivers: [
            tabs,
            SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: CircularProgressIndicator(color: colors.accent),
              ),
            ),
          ],
        );
      }
      // Items exist, but none match this tab → per-tab empty state beneath
      // the tabs (which stay visible so the user can switch back).
      return SliverMainAxisGroup(
        slivers: [
          tabs,
          SliverFillRemaining(
            hasScrollBody: false,
            child: HomeFilterEmptyState(filter: state.filter),
          ),
        ],
      );
    }

    // Build the per-peer groups over the VISIBLE items: each group is
    // [header, tile, tile, …]. Plan-18 follow-up — always include a header
    // even when there's a single Mac, per the mock. A peer with no visible
    // item in this filter contributes no header (the `lastEpk` cursor only
    // advances on rows we actually render).
    final children = <Widget>[];
    String? lastEpk;
    for (final it in visible) {
      if (it.peer.remoteEpk != lastEpk) {
        children.add(
          PeerSectionHeader(
            peer: it.peer,
            onNewSession: () => _startNewSession(context, vm, it.peer),
            newSessionEnabled: vm.canStartSession(it.peer.remoteEpk),
          ),
        );
        lastEpk = it.peer.remoteEpk;
      }
      children.add(_buildItemRowAt(context, vm, state, it));
    }
    return SliverMainAxisGroup(
      slivers: [
        tabs,
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(0, 0, 0, 24),
          sliver: SliverList(
            delegate: SliverChildBuilderDelegate(
              (ctx, i) => children[i],
              childCount: children.length,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildItemRowAt(
    BuildContext context,
    HomeViewModel vm,
    HomeList state,
    HomeItem it,
  ) {
    final colors = context.colors;
    final isLive = vm.isRoomLive(it.peer.remoteEpk, it.room.roomId);
    final isReconnecting = !vm.isRelayConnected;
    final isWorking = vm.isRoomWorking(it.peer.remoteEpk, it.room.roomId);
    final isFinishedUnread = vm.isRoomFinishedUnread(it.peer.remoteEpk, it.room.roomId);
    // Plan/tablet — highlight the open session, but only in the two-pane
    // layout (on phone the list is covered by the pushed chat, so a
    // persistent highlight would be meaningless).
    final isSelected =
        isWideLayout(context) &&
        context.watch<SessionSelection>().matches(
          it.peer.remoteEpk,
          it.room.roomId,
        );
    final canRevive = vm.canReviveSession(it.peer.remoteEpk, it.room);
    final isReviving = vm.isReviving(it.peer.remoteEpk, it.room.roomId);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SessionTile(
          peer: it.peer,
          isLive: isLive,
          isReconnecting: isReconnecting,
          isWorking: isWorking,
          isFinishedUnread: isFinishedUnread,
          isSelected: isSelected,
          room: it.room,
          onOpen: () => _open(context, vm, it.peer, it.room),
          onLongPress: () => _showSessionMenu(context, vm, it),
          onRestart: (isLive || isWorking)
              ? () => _confirmRestart(context, vm, it)
              : null,
          onRevive: canRevive ? () => _reviveSession(context, vm, it) : null,
          isReviving: isReviving,
          onDelete: () => _confirmDelete(context, vm, it),
        ),
        Divider(color: colors.border, height: 1),
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // Long-press menu (preserved from prior plan-17 wiring)
  // ---------------------------------------------------------------------------

  void _showSessionMenu(
    BuildContext context,
    HomeViewModel vm,
    HomeItem it,
  ) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: context.colors.bg,
      builder: (sheetCtx) {
        final colors = sheetCtx.colors;
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (vm.isRoomLive(it.peer.remoteEpk, it.room.roomId) ||
                  vm.isRoomWorking(it.peer.remoteEpk, it.room.roomId))
                ListTile(
                  leading: Icon(LucideIcons.rotateCw, color: colors.accent),
                  title: Text(
                    'Restart session',
                    style: TextStyle(color: colors.text),
                  ),
                  onTap: () {
                    Navigator.of(sheetCtx).pop();
                    _confirmRestart(context, vm, it);
                  },
                )
              else if (vm.canReviveSession(it.peer.remoteEpk, it.room))
                ListTile(
                  leading: Icon(LucideIcons.play, color: colors.accent),
                  title: Text(
                    'Revive session',
                    style: TextStyle(color: colors.text),
                  ),
                  onTap: () {
                    Navigator.of(sheetCtx).pop();
                    _reviveSession(context, vm, it);
                  },
                ),
              ListTile(
                leading: Icon(LucideIcons.pencil, color: colors.accent),
                title: Text(
                  'Rename session',
                  style: TextStyle(color: colors.text),
                ),
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  _promptRename(context, vm, it);
                },
              ),
              ListTile(
                leading: Icon(LucideIcons.trash2, color: colors.error),
                title: Text(
                  'Delete session (local only)',
                  style: TextStyle(color: colors.text),
                ),
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  _confirmDelete(context, vm, it);
                },
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _promptRename(
    BuildContext context,
    HomeViewModel vm,
    HomeItem it,
  ) async {
    final controller = TextEditingController(text: it.room.name ?? '');
    final result = await showDialog<String?>(
      context: context,
      builder: (dCtx) {
        final colors = dCtx.colors;
        return AlertDialog(
          backgroundColor: colors.bg,
          title: Text(
            'Rename session',
            style: dCtx.typo.mono.copyWith(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: colors.text,
            ),
          ),
          content: TextField(
            controller: controller,
            autofocus: true,
            style: dCtx.typo.mono.copyWith(color: colors.text),
            decoration: InputDecoration(
              hintText: it.room.cwd ?? 'Session',
              hintStyle: dCtx.typo.mono.copyWith(color: colors.muted),
              enabledBorder: OutlineInputBorder(
                borderSide: BorderSide(color: colors.border),
              ),
              focusedBorder: OutlineInputBorder(
                borderSide: BorderSide(color: colors.accent),
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dCtx).pop(null),
              child: Text('Cancel', style: TextStyle(color: colors.muted)),
            ),
            TextButton(
              onPressed: () => Navigator.of(dCtx).pop(controller.text.trim()),
              child: Text('Save', style: TextStyle(color: colors.accent)),
            ),
          ],
        );
      },
    );
    if (result == null) return;
    await vm.renameRoom(it.peer.remoteEpk, it.room.roomId, result);
  }

  Future<void> _confirmRestart(
    BuildContext context,
    HomeViewModel vm,
    HomeItem it,
  ) async {
    final live =
        vm.isRoomLive(it.peer.remoteEpk, it.room.roomId) ||
        vm.isRoomWorking(it.peer.remoteEpk, it.room.roomId);
    if (!live) return;
    final working = vm.isRoomWorking(it.peer.remoteEpk, it.room.roomId);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dCtx) {
        final colors = dCtx.colors;
        return AlertDialog(
          backgroundColor: colors.bg,
          title: Text(
            'Restart session?',
            style: TextStyle(color: colors.text),
          ),
          content: Text(
            'Sends /restart to this agent on your Mac — omp restarts with '
            'the same launch flags, resuming this session.'
            '${working ? ' A turn is running and will be interrupted.' : ''}',
            style: TextStyle(color: colors.muted, fontSize: 12),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dCtx).pop(false),
              child: Text('Cancel', style: TextStyle(color: colors.muted)),
            ),
            TextButton(
              onPressed: () => Navigator.of(dCtx).pop(true),
              child: Text(
                'Restart',
                style: TextStyle(color: colors.accent),
              ),
            ),
          ],
        );
      },
    );
    if (ok != true) return;
    await vm.restartSession(it.peer.remoteEpk, it.room.roomId);
  }

  Future<void> _confirmDelete(
    BuildContext context,
    HomeViewModel vm,
    HomeItem it,
  ) async {
    final live =
        vm.isRoomLive(it.peer.remoteEpk, it.room.roomId) ||
        vm.isRoomWorking(it.peer.remoteEpk, it.room.roomId);
    final working = vm.isRoomWorking(it.peer.remoteEpk, it.room.roomId);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dCtx) {
        final colors = dCtx.colors;
        return AlertDialog(
          backgroundColor: colors.bg,
          title: Text(
            live ? 'Quit session?' : 'Delete session?',
            style: TextStyle(color: colors.text),
          ),
          content: Text(
            live
                ? 'Sends /exit to this agent on your Mac — the session '
                      'process ends and disappears from this list.'
                      '${working ? ' A turn is running and will be interrupted.' : ''}'
                : 'Removes the session from this list only. If it is still '
                      'running on the PC, it reappears.',
            style: TextStyle(color: colors.muted, fontSize: 12),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dCtx).pop(false),
              child: Text('Cancel', style: TextStyle(color: colors.muted)),
            ),
            TextButton(
              onPressed: () => Navigator.of(dCtx).pop(true),
              child: Text(
                live ? 'Quit' : 'Delete',
                style: TextStyle(color: colors.error),
              ),
            ),
          ],
        );
      },
    );
    if (ok != true) return;
    if (live) {
      await vm.quitSession(it.peer.remoteEpk, it.room.roomId);
    } else {
      await vm.deleteRoom(it.peer.remoteEpk, it.room.roomId);
    }
  }

  static Future<void> _open(
    BuildContext context,
    HomeViewModel vm,
    PeerRecord peer,
    RoomInfo room,
  ) async {
    await openSession(context, vm, peer, room);
  }

  static Future<void> _reviveSession(
    BuildContext context,
    HomeViewModel vm,
    HomeItem it,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final outcome = await vm.reviveSession(it.peer.remoteEpk, it.room);
      if (outcome == null || !context.mounted) return;
      final room = outcome.room;
      if (room == null) {
        messenger
          ..hideCurrentSnackBar()
          ..showSnackBar(
            SnackBar(
              behavior: SnackBarBehavior.floating,
              content: Text(
                'Reviving "${outcome.spawn.name}"… It will appear online shortly.',
              ),
            ),
          );
        return;
      }
      await _open(context, vm, it.peer, room);
    } on NewSessionFailure catch (e) {
      if (!context.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            behavior: SnackBarBehavior.floating,
            content: Text(e.userMessage),
          ),
        );
    }
  }

  /// Plan 68 — "New session" on a PC's section: pick a folder, start an omp
  /// session there, then open it like a tapped tile. A session that does not
  /// show up in time is not an error (the PC may be slow): say so and let the
  /// tile appear in the list when it is online.
  static Future<void> _startNewSession(
    BuildContext context,
    HomeViewModel vm,
    PeerRecord peer,
  ) async {
    final epk = peer.remoteEpk;
    final outcome = await showNewSessionSheet(
      context,
      pcLabel: _deviceFor(peer),
      requester: vm.newSessionRequester(epk),
      liveFolders: vm.liveSessionFolders(epk),
    );
    if (outcome == null || !context.mounted) return;
    final room = outcome.room;
    if (room == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Started "${outcome.spawn.name}". It will appear in the list '
            'as soon as it is online.',
          ),
        ),
      );
      return;
    }
    await _open(context, vm, peer, room);
  }

  /// Plan/32g — the paired-device label for the Chat AppBar's line 2
  /// (nickname → sessionName → epk prefix). Mirrors [ChatPage]'s own peer
  /// resolution so there's no change when the PeerRecord finishes loading.
  static String _deviceFor(PeerRecord peer) => sessionDevice(peer);

}

/// Plan-17 follow-up — soft empty state for paired-but-no-rooms.
class _LonelyEmptyState extends StatelessWidget {
  const _LonelyEmptyState();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: kMaxContentWidth),
        child: Opacity(
          opacity: 0.35,
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(LucideIcons.moon, color: colors.muted, size: 56),
                const SizedBox(height: 18),
                Text(
                  'Nothing here…',
                  style: context.typo.mono.copyWith(
                    color: colors.muted2,
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'Scan a QR from your Mac to start.',
                  textAlign: TextAlign.center,
                  style: context.typo.mono.copyWith(
                    color: colors.muted,
                    fontSize: 11,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: kMaxContentWidth),
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(LucideIcons.scanQrCode, color: colors.muted, size: 48),
              const SizedBox(height: 16),
              Text(
                'No pairings yet',
                style: TextStyle(color: colors.muted2, fontSize: 14),
              ),
              const SizedBox(height: 6),
              Text(
                'Scan a QR from your Mac to start.',
                style: TextStyle(color: colors.muted, fontSize: 12),
              ),
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: () => context.push('/pair'),
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accent,
                  foregroundColor: colors.onAccent,
                ),
                icon: const Icon(LucideIcons.scanQrCode, size: 18),
                label: const Text('Scan QR'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

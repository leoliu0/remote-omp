// New session sheet (plan 68): start an omp session in a folder of a PC.
//
// A folder picker. The target is the folder the browser currently shows; the
// footer's Start button spawns an omp session there and closes the sheet with
// a [NewSessionOutcome] once the session is live. Remote OMP is omp-only, so
// there is no harness or model choice anywhere.
//
// Everything the sheet needs arrives through a [NewSessionRequester]: no
// Provider, GetIt or router, so a widget test can pump it bare.

import 'dart:async';
import 'dart:math' as math;

import 'package:app/data/actions/new_session_repository.dart'
    show NewSessionFailure, NewSessionRequester;
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// What the sheet resolves with: the session that was started and, when it
/// already showed up as a live room, that room.
class NewSessionOutcome {
  /// The extension's reply to the spawn (folder, name, always-on or not).
  final SpawnResult spawn;

  /// The new session as a live room; null when it had not appeared by the time
  /// the wait ended (it is still starting, and will show up on its own).
  final RoomInfo? room;

  const NewSessionOutcome(this.spawn, this.room);
}

/// Opens the New session sheet for one PC. Resolves with the outcome once a
/// session was started, or null when the sheet was dismissed.
///
/// [liveFolders] are the absolute paths that already run a live session on the
/// PC: the sheet refuses to start a second one there.
Future<NewSessionOutcome?> showNewSessionSheet(
  BuildContext context, {
  required String pcLabel,
  required NewSessionRequester requester,
  Set<String> liveFolders = const {},
}) {
  return showModalBottomSheet<NewSessionOutcome>(
    context: context,
    backgroundColor: context.colors.bg,
    isScrollControlled: true,
    showDragHandle: false,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) => Padding(
      // The name field raises the keyboard. Lifting the sheet by its height
      // before applying the height factor keeps the whole sheet (footer and
      // Start button included) above it.
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
      child: FractionallySizedBox(
        heightFactor: 0.9,
        child: NewSessionSheetBody(
          pcLabel: pcLabel,
          requester: requester,
          liveFolders: liveFolders,
        ),
      ),
    ),
  );
}

/// Interactive body of the New session sheet. Public so widget tests can pump
/// it with a fake [NewSessionRequester].
///
/// Closing, by the close button or by a started session, is
/// `Navigator.of(context).pop`.
class NewSessionSheetBody extends StatefulWidget {
  /// Name of the PC, shown under the title.
  final String pcLabel;

  /// How the sheet browses folders and starts the session.
  final NewSessionRequester requester;

  /// Absolute paths that already run a live session on this PC.
  final Set<String> liveFolders;

  /// How long to wait for the started session to appear as a live room.
  final Duration awaitTimeout;

  const NewSessionSheetBody({
    super.key,
    required this.pcLabel,
    required this.requester,
    this.liveFolders = const {},
    this.awaitTimeout = const Duration(seconds: 20),
  });

  @override
  State<NewSessionSheetBody> createState() => _NewSessionSheetBodyState();
}

/// Rows of the Recent section shown before "Show all". The PC sends up to 15;
/// listing them all would push the folder browser off the screen.
const int _kRecentCollapsed = 3;

/// Height kept for the sheet's chrome (handle, header) and a sliver of the
/// folder list. The options footer gets what is left above that and scrolls
/// inside it on a short sheet (small phone with the keyboard up), where it
/// would otherwise overflow and push Start out of reach.
const double _kReservedForList = 120;

const String _kGenericError = 'Something went wrong.';

/// How far a start is: not begun, the spawn request is out, or the session is
/// spawned and we wait for it to appear as a live room.
enum _StartPhase { idle, spawning, waiting }

class _NewSessionSheetBodyState extends State<NewSessionSheetBody> {
  final TextEditingController _nameController = TextEditingController();

  /// The browser header: a finished navigation scrolls back to it.
  final GlobalKey _browserKey = GlobalKey();

  /// [NewSessionSheetBody.liveFolders] without trailing separators.
  late Set<String> _live = _normalized(widget.liveFolders);

  // Browsing. [_listing] is the folder shown: the last listing that
  // succeeded. It stays on screen while another one loads or fails.
  int _listSeq = 0;
  bool _loading = true;

  /// What Retry asks for again (null = the PC's home).
  String? _requestedPath;
  String? _listError;
  DirsListResult? _listing;
  List<WireRecentDir> _recent = const [];
  bool _showAllRecent = false;

  // Options and start.
  bool _persistent = false;
  _StartPhase _phase = _StartPhase.idle;
  String? _startError;

  bool get _busy => _phase != _StartPhase.idle;

  bool _isLive(String path) => _live.contains(_trimSlash(path));

  @override
  void initState() {
    super.initState();
    unawaited(_load(null));
  }

  @override
  void didUpdateWidget(NewSessionSheetBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.liveFolders, widget.liveFolders)) {
      _live = _normalized(widget.liveFolders);
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _load(
    String? path, {
    ScrollPositionAlignmentPolicy reveal =
        ScrollPositionAlignmentPolicy.keepVisibleAtStart,
  }) async {
    final seq = ++_listSeq;
    setState(() {
      _loading = true;
      _requestedPath = path;
      _listError = null;
    });
    final DirsListResult result;
    try {
      result = await widget.requester.listDirs(path: path);
    } on NewSessionFailure catch (e) {
      _loadFailed(seq, e.userMessage);
      return;
    } catch (_) {
      _loadFailed(seq, _kGenericError);
      return;
    }
    // A later request replaced this one: its answer is the stale one.
    if (!mounted || seq != _listSeq) return;
    final moved = _listing != null && _listing!.path != result.path;
    setState(() {
      _listing = result;
      _loading = false;
      if (result.recent.isNotEmpty) _recent = result.recent;
      // A start error belongs to the folder it happened in.
      if (moved) _startError = null;
    });
    if (moved) _revealBrowser(reveal);
  }

  void _loadFailed(int seq, String message) {
    if (!mounted || seq != _listSeq) return;
    setState(() {
      _loading = false;
      _listError = message;
    });
  }

  /// Shows [path]; the folder on screen stays until that listing arrives.
  void _open(String path) => unawaited(_load(path));

  /// A recent is a jump, not a step: bring its folder's listing to the top.
  void _openRecent(String path) => unawaited(
    _load(path, reveal: ScrollPositionAlignmentPolicy.explicit),
  );

  void _retry() => unawaited(_load(_requestedPath));

  /// After moving to another folder, bring its listing back into view. Within
  /// the browser that only matters when a long listing was scrolled far down,
  /// leaving the path header above the list ([policy] keepVisibleAtStart).
  void _revealBrowser(ScrollPositionAlignmentPolicy policy) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = _browserKey.currentContext;
      if (!mounted || target == null) return;
      unawaited(
        Scrollable.ensureVisible(
          target,
          alignmentPolicy: policy,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        ),
      );
    });
  }

  Future<void> _start() async {
    final listing = _listing;
    if (listing == null || _loading || _busy || _isLive(listing.path)) return;
    final name = _nameController.text.trim();
    setState(() {
      _phase = _StartPhase.spawning;
      _startError = null;
    });
    final SpawnResult spawn;
    try {
      spawn = await widget.requester.spawn(
        cwd: listing.path,
        name: name.isEmpty ? null : name,
        persistent: _persistent,
      );
    } on NewSessionFailure catch (e) {
      _startFailed(e.userMessage);
      return;
    } catch (_) {
      _startFailed(_kGenericError);
      return;
    }
    // Dismissed while the request was out: nothing left to do here.
    if (!mounted) return;
    setState(() => _phase = _StartPhase.waiting);
    final room = await _awaitRoom(spawn);
    if (!mounted) return;
    Navigator.of(context).pop(NewSessionOutcome(spawn, room));
  }

  void _startFailed(String message) {
    if (!mounted) return;
    setState(() {
      _phase = _StartPhase.idle;
      _startError = message;
    });
  }

  /// The session is already spawned, so not seeing it come online (or the
  /// wait itself failing) is not a reason to keep the sheet open: the user
  /// could start a second session in the same folder.
  Future<RoomInfo?> _awaitRoom(SpawnResult spawn) async {
    try {
      return await widget.requester.awaitRoom(
        spawn,
        timeout: widget.awaitTimeout,
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return LayoutBuilder(
      builder: (context, box) => Material(
        color: colors.bg,
        clipBehavior: Clip.antiAlias,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            children: [
              const SizedBox(height: 10),
              const _DragHandle(),
              const SizedBox(height: 6),
              _Header(pcLabel: widget.pcLabel),
              Divider(color: colors.border, height: 1, thickness: 1),
              Expanded(child: _buildBrowser(context)),
              Divider(color: colors.border, height: 1, thickness: 1),
              _buildFooter(
                context,
                math.max(0.0, box.maxHeight - _kReservedForList),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBrowser(BuildContext context) {
    final colors = context.colors;
    final listing = _listing;
    if (listing == null) {
      final error = _listError;
      if (error != null) return _ErrorState(message: error, onRetry: _retry);
      return Center(
        child: CircularProgressIndicator(strokeWidth: 2, color: colors.accent),
      );
    }
    final error = _listError;
    return Column(
      children: [
        // Thin progress while another folder loads: the old one stays up.
        SizedBox(
          height: 2,
          child: _loading
              ? LinearProgressIndicator(
                  minHeight: 2,
                  color: colors.accent,
                  backgroundColor: colors.border,
                )
              : null,
        ),
        if (error != null)
          _ErrorBanner(message: error, onRetry: _busy ? null : _retry),
        Expanded(
          child: CustomScrollView(
            slivers: [
              if (_recent.isNotEmpty)
                SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: _recentSection(listing),
                  ),
                ),
              // A single-child sliver stays mounted when scrolled away, so the
              // header can always be scrolled back to; the (possibly 500 row)
              // folder list below it is built lazily.
              SliverToBoxAdapter(
                child: _PathHeader(
                  key: _browserKey,
                  listing: listing,
                  showLabel: _recent.isNotEmpty,
                  enabled: !_busy,
                  onOpen: _open,
                ),
              ),
              if (listing.dirs.isEmpty)
                const SliverToBoxAdapter(child: _Muted('No subfolders'))
              else
                SliverList.builder(
                  itemCount: listing.dirs.length,
                  itemBuilder: (context, i) {
                    final dir = listing.dirs[i];
                    return _DirRow(
                      key: Key('new-session-dir-${dir.path}'),
                      dir: dir,
                      onTap: _busy ? null : () => _open(dir.path),
                    );
                  },
                ),
              if (listing.truncated)
                SliverToBoxAdapter(
                  child: _Muted(
                    'Showing the first ${listing.dirs.length} folders',
                  ),
                ),
              const SliverToBoxAdapter(child: SizedBox(height: 8)),
            ],
          ),
        ),
      ],
    );
  }

  List<Widget> _recentSection(DirsListResult listing) {
    final shown = _showAllRecent
        ? _recent
        : _recent.take(_kRecentCollapsed).toList();
    return [
      const _SectionLabel('Recent'),
      for (final recent in shown)
        _RecentRow(
          key: Key('new-session-recent-${recent.path}'),
          recent: recent,
          home: listing.home,
          running: _isLive(recent.path),
          onTap: _busy ? null : () => _openRecent(recent.path),
        ),
      if (_recent.length > _kRecentCollapsed)
        _ToggleRow(
          key: const Key('new-session-recent-toggle'),
          label: _showAllRecent ? 'Show fewer' : 'Show all ${_recent.length}',
          onTap: () => setState(() => _showAllRecent = !_showAllRecent),
        ),
    ];
  }

  Widget _buildFooter(BuildContext context, double maxHeight) {
    final colors = context.colors;
    final listing = _listing;
    final folder = listing == null ? null : _basename(listing.path);
    final folderIsLive = listing != null && _isLive(listing.path);
    // Starting in a folder other than the one on screen is a trap: wait for
    // an in-flight navigation too.
    final canStart = listing != null && !_loading && !_busy && !folderIsLive;
    final startError = _startError;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: SingleChildScrollView(
        // The folder list is the sheet's primary scroll view.
        primary: false,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              key: const Key('new-session-name'),
              controller: _nameController,
              enabled: !_busy,
              textInputAction: TextInputAction.done,
              style: context.typo.mono.copyWith(
                fontSize: 13.5,
                color: colors.text,
              ),
              decoration: InputDecoration(
                isDense: true,
                labelText: 'Name (optional)',
                labelStyle: context.typo.monoSmall.copyWith(
                  color: colors.muted2,
                ),
                floatingLabelBehavior: FloatingLabelBehavior.always,
                hintText: folder,
              ),
            ),
            const SizedBox(height: 6),
            _PersistentRow(
              value: _persistent,
              enabled: !_busy,
              onChanged: (value) => setState(() => _persistent = value),
            ),
            if (folderIsLive)
              _Note(
                key: const Key('new-session-live-note'),
                icon: LucideIcons.info,
                color: colors.warning,
                text: 'A session is already running in this folder.',
              )
            else if (startError != null)
              _Note(
                key: const Key('new-session-error'),
                icon: LucideIcons.circleAlert,
                color: colors.error,
                text: startError,
              ),
            const SizedBox(height: 10),
            _StartButton(
              phase: _phase,
              folder: folder,
              onPressed: canStart ? () => unawaited(_start()) : null,
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// UI pieces
// ---------------------------------------------------------------------------

class _DragHandle extends StatelessWidget {
  const _DragHandle();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 36,
      height: 4,
      decoration: BoxDecoration(
        color: context.colors.border,
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final String pcLabel;

  const _Header({required this.pcLabel});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 8, 8),
      child: Row(
        children: [
          Icon(LucideIcons.folderPlus, size: 17, color: colors.accent),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'New session',
                  style: context.typo.mono.copyWith(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: colors.text,
                  ),
                ),
                Text(
                  pcLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.typo.monoSmall.copyWith(
                    fontSize: 11.5,
                    color: colors.muted,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            key: const Key('new-session-close'),
            icon: Icon(LucideIcons.x, size: 18, color: colors.muted2),
            tooltip: 'Close',
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;

  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
      child: Text(
        text,
        style: context.typo.monoSmall.copyWith(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.6,
          color: context.colors.muted,
        ),
      ),
    );
  }
}

/// A short muted line inside the list ("No subfolders", the truncation note).
class _Muted extends StatelessWidget {
  final String text;

  const _Muted(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: context.typo.monoSmall.copyWith(color: context.colors.muted),
      ),
    );
  }
}

class _RecentRow extends StatelessWidget {
  final WireRecentDir recent;

  /// The PC's home folder, to shorten the path with `~`.
  final String home;

  /// A session already runs in this folder.
  final bool running;

  final VoidCallback? onTap;

  const _RecentRow({
    super.key,
    required this.recent,
    required this.home,
    required this.running,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final monoSmall = context.typo.monoSmall;
    final name = recent.name.isEmpty ? _basename(recent.path) : recent.name;
    final lastUsed = recent.lastUsed;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        child: Row(
          children: [
            Icon(LucideIcons.history, size: 16, color: colors.muted2),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: context.typo.mono.copyWith(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                            color: colors.text,
                          ),
                        ),
                      ),
                      if (running) ...[
                        const SizedBox(width: 8),
                        const _RunningChip(),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _tilde(recent.path, home),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: monoSmall.copyWith(fontSize: 11, color: colors.muted),
                  ),
                ],
              ),
            ),
            if (lastUsed != null) ...[
              const SizedBox(width: 10),
              Text(
                _relativeTime(lastUsed),
                style: monoSmall.copyWith(fontSize: 11, color: colors.muted),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _RunningChip extends StatelessWidget {
  const _RunningChip();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        color: colors.success.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: colors.success.withValues(alpha: 0.35)),
      ),
      child: Text(
        'running',
        style: context.typo.monoSmall.copyWith(
          fontSize: 10,
          color: colors.success,
        ),
      ),
    );
  }
}

/// "Show all N" / "Show fewer" under the Recent rows.
class _ToggleRow extends StatelessWidget {
  final String label;
  final VoidCallback onTap;

  const _ToggleRow({super.key, required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Text(
          label,
          style: context.typo.monoSmall.copyWith(
            fontSize: 12,
            color: context.colors.accent,
          ),
        ),
      ),
    );
  }
}

/// The path header: "up" and the tappable path of the current folder.
class _PathHeader extends StatelessWidget {
  final DirsListResult listing;

  /// Whether to title the section (only needed under the Recent section).
  final bool showLabel;
  final bool enabled;
  final ValueChanged<String> onOpen;

  const _PathHeader({
    super.key,
    required this.listing,
    required this.showLabel,
    required this.enabled,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final crumbs = _crumbsOf(listing.path, listing.home);
    final parent = listing.parent;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (showLabel) const _SectionLabel('Browse'),
        Divider(color: colors.border, height: 1, thickness: 1),
        Material(
          color: colors.surface,
          child: SizedBox(
            height: 44,
            child: Row(
              children: [
                IconButton(
                  key: const Key('new-session-up'),
                  tooltip: 'Up one folder',
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(LucideIcons.arrowUp, size: 18),
                  color: colors.accent,
                  disabledColor: colors.muted,
                  onPressed: enabled && parent != null
                      ? () => onOpen(parent)
                      : null,
                ),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, box) => SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      // Anchored at its end, so a deep path keeps showing the
                      // current folder; the minimum width keeps a short path
                      // at the start.
                      reverse: true,
                      child: ConstrainedBox(
                        constraints: BoxConstraints(minWidth: box.maxWidth),
                        child: Row(
                          children: [
                            for (var i = 0; i < crumbs.length; i++) ...[
                              if (i > 0)
                                Icon(
                                  LucideIcons.chevronRight,
                                  size: 14,
                                  color: colors.muted,
                                ),
                              _CrumbChip(
                                key: Key('new-session-crumb-$i'),
                                crumb: crumbs[i],
                                current: i == crumbs.length - 1,
                                onTap: enabled && i < crumbs.length - 1
                                    ? () => onOpen(crumbs[i].path)
                                    : null,
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        Divider(color: colors.border, height: 1, thickness: 1),
      ],
    );
  }
}

class _CrumbChip extends StatelessWidget {
  final _Crumb crumb;
  final bool current;
  final VoidCallback? onTap;

  const _CrumbChip({
    super.key,
    required this.crumb,
    required this.current,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        child: Text(
          crumb.label,
          maxLines: 1,
          style: context.typo.mono.copyWith(
            fontSize: 13,
            fontWeight: current ? FontWeight.w600 : FontWeight.w400,
            color: current ? colors.text : colors.accent,
          ),
        ),
      ),
    );
  }
}

class _DirRow extends StatelessWidget {
  final WireDirEntry dir;
  final VoidCallback? onTap;

  const _DirRow({super.key, required this.dir, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Row(
          children: [
            Icon(LucideIcons.folder, size: 18, color: colors.muted2),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                dir.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.typo.mono.copyWith(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w500,
                  color: colors.text,
                ),
              ),
            ),
            if (dir.isGit) ...[const SizedBox(width: 8), const _GitBadge()],
            const SizedBox(width: 8),
            Icon(LucideIcons.chevronRight, size: 16, color: colors.muted),
          ],
        ),
      ),
    );
  }
}

class _GitBadge extends StatelessWidget {
  const _GitBadge();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        color: colors.accent.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: colors.accent.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(LucideIcons.gitBranch, size: 10, color: colors.accent),
          const SizedBox(width: 3),
          Text(
            'git',
            style: context.typo.monoSmall.copyWith(
              fontSize: 10,
              color: colors.accent,
            ),
          ),
        ],
      ),
    );
  }
}

/// The first listing failed: nothing to show yet but the error and Retry.
class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.circleAlert, size: 26, color: colors.error),
            const SizedBox(height: 10),
            Text(
              message,
              textAlign: TextAlign.center,
              style: context.typo.monoSmall.copyWith(color: colors.error),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              key: const Key('new-session-retry'),
              onPressed: onRetry,
              style: OutlinedButton.styleFrom(
                side: BorderSide(color: colors.border),
              ),
              icon: Icon(LucideIcons.refreshCw, size: 14, color: colors.accent),
              label: Text(
                'Retry',
                style: context.typo.monoSmall.copyWith(color: colors.text),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A later listing failed: the last good folder stays below this banner.
class _ErrorBanner extends StatelessWidget {
  final String message;

  /// Null (inert) while a start is in flight.
  final VoidCallback? onRetry;

  const _ErrorBanner({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final monoSmall = context.typo.monoSmall;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
      color: colors.error.withValues(alpha: 0.12),
      child: Row(
        children: [
          Expanded(
            child: Text(message, style: monoSmall.copyWith(color: colors.error)),
          ),
          TextButton(
            key: const Key('new-session-retry'),
            onPressed: onRetry,
            child: Text('Retry', style: monoSmall.copyWith(color: colors.accent)),
          ),
        ],
      ),
    );
  }
}

class _PersistentRow extends StatelessWidget {
  final bool value;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  const _PersistentRow({
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      onTap: enabled ? () => onChanged(!value) : null,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Keep always on',
                    style: context.typo.mono.copyWith(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: colors.text,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    value
                        ? 'Stays running after Quit or a crash, '
                              'until removed on the PC.'
                        : 'The session ends when you quit it.',
                    style: context.typo.monoSmall.copyWith(
                      fontSize: 11,
                      color: colors.muted,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Switch.adaptive(
              key: const Key('new-session-persistent'),
              value: value,
              onChanged: enabled ? onChanged : null,
            ),
          ],
        ),
      ),
    );
  }
}

/// A one-line status above the Start button (a start error, or the reason
/// Start is off).
class _Note extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;

  const _Note({
    super.key,
    required this.icon,
    required this.color,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(icon, size: 14, color: color),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: context.typo.monoSmall.copyWith(
                fontSize: 11.5,
                color: color,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _StartButton extends StatelessWidget {
  final _StartPhase phase;

  /// Name of the folder on screen; null until the first listing arrived.
  final String? folder;

  /// Null = disabled.
  final VoidCallback? onPressed;

  const _StartButton({
    required this.phase,
    required this.folder,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final busy = phase != _StartPhase.idle;
    final label = switch (phase) {
      _StartPhase.idle =>
        folder == null ? 'Start session' : 'Start session in $folder',
      _StartPhase.spawning => 'Starting…',
      _StartPhase.waiting => 'Waiting for the session to come online…',
    };
    return FilledButton(
      key: const Key('new-session-start'),
      onPressed: onPressed,
      style: FilledButton.styleFrom(
        backgroundColor: colors.accent,
        foregroundColor: colors.onAccent,
        // Busy is a working button, not an unavailable one.
        disabledBackgroundColor: busy
            ? colors.accent.withValues(alpha: 0.7)
            : colors.border,
        disabledForegroundColor: busy ? colors.onAccent : colors.muted,
        padding: const EdgeInsets.symmetric(vertical: 14),
        textStyle: context.typo.mono.copyWith(
          fontSize: 13.5,
          fontWeight: FontWeight.w600,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (busy) ...[
            SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: colors.onAccent,
              ),
            ),
            const SizedBox(width: 10),
          ],
          Flexible(
            child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Paths and times
//
// The PC may be Windows: paths come as the PC wrote them (`C:\Users\leo`), so
// nothing here assumes `/`.
// ---------------------------------------------------------------------------

/// One stop of the path header: [label] on screen, [path] to open it.
class _Crumb {
  final String label;
  final String path;

  const _Crumb(this.label, this.path);
}

/// [path] without its trailing separator (a lone root `/` stays).
String _trimSlash(String path) =>
    path.length > 1 && (path.endsWith('/') || path.endsWith(r'\'))
    ? path.substring(0, path.length - 1)
    : path;

Set<String> _normalized(Set<String> paths) => {
  for (final path in paths) _trimSlash(path),
};

/// `\` for a Windows path, `/` otherwise.
String _separatorOf(String path) =>
    !path.startsWith('/') && path.contains(r'\') ? r'\' : '/';

/// Last segment of [path]; the root itself when there is none.
String _basename(String path) {
  final trimmed = _trimSlash(path);
  final cut = trimmed.lastIndexOf(_separatorOf(trimmed));
  final base = cut < 0 ? trimmed : trimmed.substring(cut + 1);
  return base.isEmpty ? trimmed : base;
}

/// [path] with the PC's [home] folder written as `~`.
String _tilde(String path, String home) {
  if (home.isEmpty) return path;
  final p = _trimSlash(path);
  final h = _trimSlash(home);
  if (p == h) return '~';
  if (p.length > h.length &&
      p.startsWith(h) &&
      (p[h.length] == '/' || p[h.length] == r'\')) {
    return '~${p.substring(h.length)}';
  }
  return path;
}

/// The stops from the root down to [path]. Under [home] the path starts at
/// `~` instead, so the usual case is short; "up" still climbs past it.
List<_Crumb> _crumbsOf(String path, String home) {
  final sep = _separatorOf(path);
  final crumbs = <_Crumb>[];
  var walked = '';
  final parts = path.split(sep);
  for (var i = 0; i < parts.length; i++) {
    final part = parts[i];
    if (i == 0) {
      // '' before a leading separator is the POSIX root; otherwise the first
      // part is a drive ('C:') or a relative start.
      walked = part.isEmpty
          ? sep
          : part.endsWith(':')
          ? '$part$sep'
          : part;
      crumbs.add(_Crumb(part.isEmpty ? sep : part, walked));
    } else if (part.isNotEmpty) {
      walked = walked.endsWith(sep) ? '$walked$part' : '$walked$sep$part';
      crumbs.add(_Crumb(part, walked));
    }
  }
  if (home.isEmpty) return crumbs;
  final h = _trimSlash(home);
  final at = crumbs.indexWhere((c) => _trimSlash(c.path) == h);
  if (at < 0) return crumbs;
  return [_Crumb('~', home), ...crumbs.skip(at + 1)];
}

/// "just now", "5m ago", "2h ago", "3d ago", then the date. The same
/// thresholds as the Home tiles' "Last paired", for a timestamp in epoch ms.
String _relativeTime(int epochMs) {
  final then = DateTime.fromMillisecondsSinceEpoch(epochMs);
  final diff = DateTime.now().difference(then);
  // Also covers a PC clock slightly ahead of the phone's.
  if (diff.inSeconds < 60) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  if (diff.inDays < 30) return '${diff.inDays}d ago';
  final month = then.month.toString().padLeft(2, '0');
  final day = then.day.toString().padLeft(2, '0');
  return '${then.year}-$month-$day';
}

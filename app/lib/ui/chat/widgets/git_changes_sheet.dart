import 'dart:async';
import 'dart:math' as math;

import 'package:app/config/dependencies.dart';
import 'package:app/data/actions/actions_repository.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/chat/quick_actions/widgets/dismiss_on_session_change.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Opens the mobile Git Changes & Unified Diff viewer bottom sheet.
Future<void> showGitChangesSheet(BuildContext context) {
  final repo = injector.get<IActionsRepository>();
  final selection = context.read<SessionSelection>();
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.colors.bg,
    barrierColor: Colors.black.withValues(alpha: 0.6),
    isScrollControlled: true,
    showDragHandle: false,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) {
      return DismissOnSessionChange(
        selection: selection,
        child: FractionallySizedBox(
          heightFactor: 0.88,
          child: GitChangesSheetBody(repo: repo),
        ),
      );
    },
  );
}

/// Interactive body for listing changed repository files and inspecting
/// syntax-colored unified diffs.
class GitChangesSheetBody extends StatefulWidget {
  final IActionsRepository repo;

  const GitChangesSheetBody({super.key, required this.repo});

  @override
  State<GitChangesSheetBody> createState() => _GitChangesSheetBodyState();
}

class _GitChangesSheetBodyState extends State<GitChangesSheetBody> {
  int _statusSeq = 0;
  int _diffSeq = 0;

  bool _loadingStatus = true;
  String? _statusError;
  GitStatusResult? _status;

  WireGitFileChange? _selectedFile;
  bool _diffStaged = false;
  bool _loadingDiff = false;
  String? _diffError;
  GitDiffResult? _diffResult;
  bool _copied = false;
  Timer? _copiedTimer;

  @override
  void initState() {
    super.initState();
    unawaited(_loadStatus());
  }

  @override
  void dispose() {
    _copiedTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadStatus() async {
    final seq = ++_statusSeq;
    setState(() {
      _loadingStatus = true;
      _statusError = null;
    });
    try {
      final result = await widget.repo.gitStatus();
      if (!mounted || seq != _statusSeq) return;
      setState(() {
        _status = result;
        _loadingStatus = false;
      });
    } on ActionFailure catch (e) {
      if (!mounted || seq != _statusSeq) return;
      setState(() {
        _statusError = e.message;
        _loadingStatus = false;
      });
    } catch (e) {
      if (!mounted || seq != _statusSeq) return;
      setState(() {
        _statusError = e.toString();
        _loadingStatus = false;
      });
    }
  }

  void _openFile(WireGitFileChange file) {
    final initialStaged = file.staged && !file.unstaged;
    setState(() {
      _selectedFile = file;
      _diffStaged = initialStaged;
      _diffResult = null;
      _diffError = null;
      _copied = false;
    });
    unawaited(_loadDiff(file.path, staged: initialStaged));
  }

  void _backToList() {
    _diffSeq++;
    _copiedTimer?.cancel();
    setState(() {
      _selectedFile = null;
      _diffResult = null;
      _diffError = null;
      _loadingDiff = false;
      _copied = false;
    });
  }

  Future<void> _loadDiff(String path, {required bool staged}) async {
    final seq = ++_diffSeq;
    setState(() {
      _loadingDiff = true;
      _diffError = null;
      _diffStaged = staged;
    });
    try {
      final result = await widget.repo.gitDiff(path, staged: staged);
      if (!mounted || seq != _diffSeq || _selectedFile?.path != path) return;
      setState(() {
        _diffResult = result;
        _loadingDiff = false;
      });
    } on ActionFailure catch (e) {
      if (!mounted || seq != _diffSeq || _selectedFile?.path != path) return;
      setState(() {
        _diffError = e.message;
        _loadingDiff = false;
      });
    } catch (e) {
      if (!mounted || seq != _diffSeq || _selectedFile?.path != path) return;
      setState(() {
        _diffError = e.toString();
        _loadingDiff = false;
      });
    }
  }

  Future<void> _copyDiff() async {
    final text = _diffResult?.diff;
    if (text == null || text.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    _copiedTimer?.cancel();
    setState(() => _copied = true);
    _copiedTimer = Timer(const Duration(seconds: 2), () {
      if (!mounted) return;
      setState(() => _copied = false);
    });
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.showSnackBar(
      SnackBar(
        backgroundColor: context.colors.surface,
        behavior: SnackBarBehavior.floating,
        content: Text(
          'Diff copied',
          style: context.typo.monoSmall.copyWith(color: context.colors.text),
        ),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      decoration: BoxDecoration(
        color: colors.bg,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          children: [
            const SizedBox(height: 10),
            Container(
              width: 36,
              height: 4,
              decoration: BoxDecoration(
                color: colors.border,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(height: 6),
            if (_selectedFile == null) ...[
              _buildListHeader(context),
              Divider(color: colors.border, height: 1, thickness: 1),
              Expanded(child: _buildListBody(context)),
            ] else ...[
              _buildDiffHeader(context, _selectedFile!),
              Divider(color: colors.border, height: 1, thickness: 1),
              Expanded(child: _buildDiffBody(context, _selectedFile!)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildListHeader(BuildContext context) {
    final colors = context.colors;
    final mono = context.typo.mono;
    final monoSmall = context.typo.monoSmall;
    final status = _status;
    final branch = status?.branch;

    var totalAdd = 0;
    var totalDel = 0;
    if (status != null) {
      for (final f in status.files) {
        totalAdd += f.additions ?? 0;
        totalDel += f.deletions ?? 0;
      }
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 8, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(LucideIcons.fileDiff, size: 17, color: colors.accent),
              const SizedBox(width: 8),
              Text(
                'Changes',
                style: mono.copyWith(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: colors.text,
                ),
              ),
              if (branch != null && branch.isNotEmpty) ...[
                const SizedBox(width: 10),
                Flexible(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: colors.surface,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: colors.border),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          LucideIcons.gitBranch,
                          size: 12,
                          color: colors.accent,
                        ),
                        const SizedBox(width: 4),
                        Flexible(
                          child: Text(
                            branch,
                            overflow: TextOverflow.ellipsis,
                            style: monoSmall.copyWith(
                              fontSize: 11,
                              color: colors.text,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
              const Spacer(),
              IconButton(
                key: const Key('git-refresh'),
                icon: Icon(
                  LucideIcons.refreshCw,
                  size: 16,
                  color: _loadingStatus ? colors.accent : colors.muted2,
                ),
                tooltip: 'Refresh',
                onPressed: _loadingStatus ? null : _loadStatus,
              ),
              IconButton(
                icon: Icon(LucideIcons.x, size: 18, color: colors.muted2),
                tooltip: 'Close',
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
          if (status != null && status.isRepo && status.files.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(
                    '${status.files.length} file${status.files.length == 1 ? '' : 's'}',
                    style: monoSmall.copyWith(fontSize: 11.5, color: colors.muted),
                  ),
                  if (totalAdd > 0)
                    Text(
                      '+$totalAdd',
                      style: monoSmall.copyWith(
                        fontSize: 11.5,
                        color: colors.success,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  if (totalDel > 0)
                    Text(
                      '-$totalDel',
                      style: monoSmall.copyWith(
                        fontSize: 11.5,
                        color: colors.error,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  if (status.truncated)
                    Text(
                      '(showing first ${status.files.length})',
                      style: monoSmall.copyWith(
                        fontSize: 11,
                        color: colors.warning,
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildListBody(BuildContext context) {
    final colors = context.colors;
    final monoSmall = context.typo.monoSmall;

    if (_loadingStatus && _status == null) {
      return Center(
        child: CircularProgressIndicator(
          strokeWidth: 2,
          color: colors.accent,
        ),
      );
    }

    if (_statusError != null && _status == null) {
      return _ErrorState(
        message: _statusError!,
        retryKey: const Key('git-retry'),
        onRetry: _loadStatus,
      );
    }

    final status = _status;
    if (status == null) {
      return const SizedBox.shrink();
    }

    if (!status.isRepo) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(LucideIcons.folderGit2, size: 28, color: colors.muted),
              const SizedBox(height: 12),
              Text(
                'Not a git repository',
                style: context.typo.mono.copyWith(
                  fontSize: 14,
                  color: colors.text,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'No git working tree was found for this session directory.',
                textAlign: TextAlign.center,
                style: monoSmall.copyWith(color: colors.muted),
              ),
            ],
          ),
        ),
      );
    }

    if (status.files.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(LucideIcons.check, size: 28, color: colors.success),
              const SizedBox(height: 12),
              Text(
                'Working tree clean',
                style: context.typo.mono.copyWith(
                  fontSize: 14,
                  color: colors.text,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                status.branch != null
                    ? 'No uncommitted changes on ${status.branch}.'
                    : 'No uncommitted changes.',
                textAlign: TextAlign.center,
                style: monoSmall.copyWith(color: colors.muted),
              ),
            ],
          ),
        ),
      );
    }

    return Column(
      children: [
        if (_statusError != null)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            color: colors.error.withValues(alpha: 0.12),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _statusError!,
                    style: monoSmall.copyWith(color: colors.error),
                  ),
                ),
                TextButton(
                  onPressed: _loadStatus,
                  child: Text(
                    'Retry',
                    style: monoSmall.copyWith(color: colors.accent),
                  ),
                ),
              ],
            ),
          ),
        Expanded(
          child: ListView.separated(
            itemCount: status.files.length,
            separatorBuilder: (_, _) =>
                Divider(color: colors.border, height: 1, thickness: 1),
            itemBuilder: (ctx, i) => _FileChangeRow(
              file: status.files[i],
              onTap: () => _openFile(status.files[i]),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildDiffHeader(BuildContext context, WireGitFileChange file) {
    final colors = context.colors;
    final mono = context.typo.mono;
    final monoSmall = context.typo.monoSmall;
    final slash = file.path.lastIndexOf('/');
    final baseName = slash >= 0 ? file.path.substring(slash + 1) : file.path;
    final dirName = slash >= 0 ? file.path.substring(0, slash) : null;

    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 2, 8, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              IconButton(
                key: const Key('git-back'),
                icon: Icon(LucideIcons.chevronLeft, size: 18, color: colors.text),
                tooltip: 'Back',
                onPressed: _backToList,
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      baseName,
                      overflow: TextOverflow.ellipsis,
                      style: mono.copyWith(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: colors.text,
                      ),
                    ),
                    if (dirName != null)
                      Text(
                        dirName,
                        overflow: TextOverflow.ellipsis,
                        style: monoSmall.copyWith(
                          fontSize: 11,
                          color: colors.muted,
                        ),
                      ),
                  ],
                ),
              ),
              if (_diffResult != null && _diffResult!.diff.isNotEmpty)
                IconButton(
                  key: const Key('git-copy-diff'),
                  icon: Icon(
                    _copied ? LucideIcons.check : LucideIcons.copy,
                    size: 16,
                    color: _copied ? colors.success : colors.muted2,
                  ),
                  tooltip: 'Copy diff',
                  onPressed: _copyDiff,
                ),
              IconButton(
                icon: Icon(
                  LucideIcons.refreshCw,
                  size: 16,
                  color: _loadingDiff ? colors.accent : colors.muted2,
                ),
                tooltip: 'Refresh diff',
                onPressed: _loadingDiff
                    ? null
                    : () => _loadDiff(file.path, staged: _diffStaged),
              ),
            ],
          ),
          if (file.staged && file.unstaged)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
              child: Row(
                children: [
                  _ModeChip(
                    key: const Key('git-toggle-unstaged'),
                    label: 'Unstaged',
                    selected: !_diffStaged,
                    onTap: () {
                      if (!_diffStaged) return;
                      unawaited(_loadDiff(file.path, staged: false));
                    },
                  ),
                  const SizedBox(width: 8),
                  _ModeChip(
                    key: const Key('git-toggle-staged'),
                    label: 'Staged',
                    selected: _diffStaged,
                    onTap: () {
                      if (_diffStaged) return;
                      unawaited(_loadDiff(file.path, staged: true));
                    },
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildDiffBody(BuildContext context, WireGitFileChange file) {
    final colors = context.colors;
    final monoSmall = context.typo.monoSmall;

    if (_loadingDiff && _diffResult == null) {
      return Center(
        child: CircularProgressIndicator(
          strokeWidth: 2,
          color: colors.accent,
        ),
      );
    }

    if (_diffError != null && _diffResult == null) {
      return _ErrorState(
        message: _diffError!,
        retryKey: const Key('git-diff-retry'),
        onRetry: () => _loadDiff(file.path, staged: _diffStaged),
      );
    }

    final diffRes = _diffResult;
    if (diffRes == null) {
      return const SizedBox.shrink();
    }

    if (diffRes.binary) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'Binary file — diff not shown',
            style: context.typo.mono.copyWith(fontSize: 13, color: colors.muted),
          ),
        ),
      );
    }

    if (diffRes.diff.trim().isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'No changes in ${_diffStaged ? 'staged' : 'unstaged'} view',
            style: context.typo.mono.copyWith(fontSize: 13, color: colors.muted),
          ),
        ),
      );
    }

    final lines = diffRes.diff.split('\n');
    if (lines.isNotEmpty && lines.last.isEmpty) {
      lines.removeLast();
    }

    final lineStyle = context.typo.mono.copyWith(fontSize: 12.5, height: 1.45);
    final maxCols = lines.fold<int>(0, (m, l) => l.length > m ? l.length : m);
    final approxCharWidth = (lineStyle.fontSize ?? 12.5) * 0.72;

    return Column(
      children: [
        if (diffRes.truncated)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            color: colors.warning.withValues(alpha: 0.14),
            child: Text(
              'Diff truncated at 128 KB',
              style: monoSmall.copyWith(fontSize: 11.5, color: colors.warning),
            ),
          ),
        if (_diffError != null)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            color: colors.error.withValues(alpha: 0.12),
            child: Text(
              _diffError!,
              style: monoSmall.copyWith(fontSize: 11.5, color: colors.error),
            ),
          ),
        Expanded(
          child: Container(
            color: colors.codeBg,
            child: LayoutBuilder(
              builder: (ctx, constraints) {
                final contentWidth = math.max(
                  constraints.maxWidth,
                  maxCols * approxCharWidth + 48,
                );
                return SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: SizedBox(
                    width: contentWidth,
                    height: constraints.maxHeight,
                    child: SelectionArea(
                      child: ListView.builder(
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        itemCount: lines.length,
                        itemBuilder: (_, idx) => _DiffLineTile(
                          line: lines[idx],
                          baseStyle: lineStyle,
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

class _FileChangeRow extends StatelessWidget {
  final WireGitFileChange file;
  final VoidCallback onTap;

  const _FileChangeRow({required this.file, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final monoSmall = context.typo.monoSmall;
    final (letter, badgeColor) = switch (file.status) {
      GitFileStatus.modified => ('M', colors.warning),
      GitFileStatus.added => ('A', colors.success),
      GitFileStatus.deleted => ('D', colors.error),
      GitFileStatus.renamed => ('R', colors.accent),
      GitFileStatus.untracked => ('?', colors.muted2),
      GitFileStatus.conflicted => ('U', colors.error),
    };

    final slash = file.path.lastIndexOf('/');
    final baseName = slash >= 0 ? file.path.substring(slash + 1) : file.path;
    final dirName = slash >= 0 ? file.path.substring(0, slash) : null;

    return InkWell(
      key: Key('git-file-${file.path}'),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Row(
          children: [
            Container(
              width: 24,
              height: 24,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: badgeColor.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: badgeColor.withValues(alpha: 0.4)),
              ),
              child: Text(
                letter,
                style: monoSmall.copyWith(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: badgeColor,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          baseName,
                          overflow: TextOverflow.ellipsis,
                          style: context.typo.mono.copyWith(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                            color: colors.text,
                          ),
                        ),
                      ),
                      if (file.staged) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 1,
                          ),
                          decoration: BoxDecoration(
                            color: colors.success.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(4),
                            border: Border.all(
                              color: colors.success.withValues(alpha: 0.35),
                            ),
                          ),
                          child: Text(
                            'staged',
                            style: monoSmall.copyWith(
                              fontSize: 10,
                              color: colors.success,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  if (dirName != null || file.oldPath != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        file.oldPath != null
                            ? '${dirName != null ? '$dirName · ' : ''}← ${file.oldPath}'
                            : dirName!,
                        overflow: TextOverflow.ellipsis,
                        style: monoSmall.copyWith(
                          fontSize: 11,
                          color: colors.muted,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            if (file.binary)
              Text(
                'bin',
                style: monoSmall.copyWith(fontSize: 11.5, color: colors.muted2),
              )
            else
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if ((file.additions ?? 0) > 0)
                    Text(
                      '+${file.additions}',
                      style: monoSmall.copyWith(
                        fontSize: 12,
                        color: colors.success,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  if ((file.additions ?? 0) > 0 && (file.deletions ?? 0) > 0)
                    const SizedBox(width: 6),
                  if ((file.deletions ?? 0) > 0)
                    Text(
                      '-${file.deletions}',
                      style: monoSmall.copyWith(
                        fontSize: 12,
                        color: colors.error,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _ModeChip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _ModeChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(999),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: selected
              ? colors.accent.withValues(alpha: 0.16)
              : colors.surface,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: selected ? colors.accent : colors.border,
          ),
        ),
        child: Text(
          label,
          style: context.typo.monoSmall.copyWith(
            fontSize: 11.5,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            color: selected ? colors.accent : colors.muted2,
          ),
        ),
      ),
    );
  }
}

class _DiffLineTile extends StatelessWidget {
  final String line;
  final TextStyle baseStyle;

  const _DiffLineTile({required this.line, required this.baseStyle});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (Color? bg, Color fg) = switch (line) {
      _ when line.startsWith('@@') => (
        colors.accent.withValues(alpha: 0.10),
        colors.accent,
      ),
      _
          when line.startsWith('diff --git') ||
              line.startsWith('index ') ||
              line.startsWith('--- ') ||
              line.startsWith('+++ ') =>
        (null, colors.muted),
      _ when line.startsWith('+') => (
        colors.success.withValues(alpha: 0.14),
        colors.success,
      ),
      _ when line.startsWith('-') => (
        colors.error.withValues(alpha: 0.14),
        colors.error,
      ),
      _ => (null, colors.text),
    };

    return Container(
      width: double.infinity,
      color: bg,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 1),
      child: Text(
        line.isEmpty ? ' ' : line,
        softWrap: false,
        style: baseStyle.copyWith(color: fg),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final Key retryKey;
  final VoidCallback onRetry;

  const _ErrorState({
    required this.message,
    required this.retryKey,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: Padding(
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
              key: retryKey,
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

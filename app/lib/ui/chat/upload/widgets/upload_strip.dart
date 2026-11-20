import 'package:app/data/files/file_uploader.dart';
import 'package:app/ui/chat/upload/states/upload_state.dart';
import 'package:app/ui/chat/widgets/file_card.dart' show formatBytes;
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Plan 68 — what the composer shows above the text field for file uploads:
/// one row per upload in flight (name, progress, cancel), a line while the
/// picker copies the chosen file, and how the last uploads ended.
///
/// Renders nothing when there is nothing to show, so the composer keeps its
/// height.
class UploadStrip extends StatelessWidget {
  const UploadStrip({
    super.key,
    required this.state,
    required this.onCancel,
    required this.onDismiss,
  });

  final UploadState state;
  final void Function(String uploadId) onCancel;
  final void Function(String noticeId) onDismiss;

  @override
  Widget build(BuildContext context) {
    if (state.isEmpty) return const SizedBox.shrink();
    return Column(
      key: const Key('upload-strip'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (state.picking) const _PickingRow(),
        for (final u in state.uploads)
          _UploadRow(upload: u, onCancel: () => onCancel(u.id)),
        for (final n in state.notices)
          _NoticeRow(notice: n, onDismiss: () => onDismiss(n.id)),
      ],
    );
  }
}

/// The rounded card every row sits in; [tint] colours its border and fill.
class _RowCard extends StatelessWidget {
  const _RowCard({super.key, required this.tint, required this.child});

  final Color tint;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, right: 4, bottom: 10),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 9, 6, 9),
        decoration: BoxDecoration(
          color: tint.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: tint.withValues(alpha: 0.35)),
        ),
        child: child,
      ),
    );
  }
}

class _PickingRow extends StatelessWidget {
  const _PickingRow();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return _RowCard(
      key: const Key('upload-picking'),
      tint: colors.accent,
      child: Row(
        children: [
          SizedBox(
            width: 15,
            height: 15,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: colors.accent,
            ),
          ),
          const SizedBox(width: 10),
          Text(
            'Opening the file…',
            style: context.typo.mono.copyWith(
              fontSize: 12,
              color: colors.muted,
            ),
          ),
        ],
      ),
    );
  }
}

class _UploadRow extends StatelessWidget {
  const _UploadRow({required this.upload, required this.onCancel});

  final UploadProgress upload;
  final VoidCallback onCancel;

  /// `12.0 MB of 20.0 MB · 60%`, or what the upload is waiting for.
  String _subtitle() {
    if (upload.waiting) return 'Waiting for the connection…';
    return switch (upload.phase) {
      UploadPhase.starting => 'Waiting for the PC…',
      UploadPhase.finishing => 'Finishing on the PC…',
      UploadPhase.sending =>
        '${formatBytes(upload.ackedBytes)} of ${formatBytes(upload.size)}'
            ' · ${((upload.fraction ?? 0) * 100).floor()}%',
    };
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return _RowCard(
      key: Key('upload-row-${upload.id}'),
      tint: colors.accent,
      child: Row(
        children: [
          Icon(LucideIcons.fileUp, size: 16, color: colors.accent),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  upload.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.typo.mono.copyWith(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: colors.text,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  _subtitle(),
                  key: Key('upload-status-${upload.id}'),
                  style: context.typo.mono.copyWith(
                    fontSize: 11,
                    color: colors.muted,
                  ),
                ),
                const SizedBox(height: 7),
                ClipRRect(
                  borderRadius: BorderRadius.circular(2),
                  child: LinearProgressIndicator(
                    key: Key('upload-progress-${upload.id}'),
                    // Null while the size of the progress cannot be told.
                    value: upload.waiting ? null : upload.fraction,
                    minHeight: 3,
                    color: colors.accent,
                    backgroundColor: colors.border,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 2),
          SizedBox(
            width: 32,
            height: 32,
            child: IconButton(
              key: Key('upload-cancel-${upload.id}'),
              padding: EdgeInsets.zero,
              iconSize: 16,
              tooltip: 'Cancel upload',
              icon: Icon(LucideIcons.x, color: colors.muted),
              onPressed: onCancel,
            ),
          ),
        ],
      ),
    );
  }
}

class _NoticeRow extends StatelessWidget {
  const _NoticeRow({required this.notice, required this.onDismiss});

  final UploadNotice notice;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tint = notice.failed ? colors.error : colors.success;
    return _RowCard(
      key: Key('upload-notice-${notice.id}'),
      tint: tint,
      child: Row(
        children: [
          Icon(
            notice.failed ? LucideIcons.circleAlert : LucideIcons.check,
            size: 16,
            color: tint,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (notice.name != null)
                  Text(
                    notice.name!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.typo.mono.copyWith(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: colors.text,
                    ),
                  ),
                Text(
                  notice.message,
                  key: Key('upload-notice-text-${notice.id}'),
                  style: context.typo.mono.copyWith(
                    fontSize: 11,
                    height: 1.3,
                    color: notice.failed ? colors.error : colors.muted,
                  ),
                ),
              ],
            ),
          ),
          SizedBox(
            width: 32,
            height: 32,
            child: IconButton(
              key: Key('upload-notice-dismiss-${notice.id}'),
              padding: EdgeInsets.zero,
              iconSize: 16,
              tooltip: 'Dismiss',
              icon: Icon(LucideIcons.x, color: colors.muted),
              onPressed: onDismiss,
            ),
          ),
        ],
      ),
    );
  }
}

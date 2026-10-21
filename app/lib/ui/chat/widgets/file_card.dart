import 'package:app/domain/entities/received_file.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Plan 65 — a file the agent sent to this phone, shown in the chat.
/// Receiving: progress bar + cancel. Done: Open / Share / Save to Downloads,
/// plus Install for APKs. Every action needs a tap; nothing auto-opens.
class FileCard extends StatelessWidget {
  final ReceivedFile file;
  final bool canSaveToDownloads;
  final bool canInstall;
  final VoidCallback? onOpen;
  final VoidCallback? onShare;
  final VoidCallback? onSave;
  final VoidCallback? onInstall;
  final VoidCallback? onCancel;

  const FileCard({
    super.key,
    required this.file,
    this.canSaveToDownloads = false,
    this.canInstall = false,
    this.onOpen,
    this.onShare,
    this.onSave,
    this.onInstall,
    this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final caption = file.caption?.trim() ?? '';
    final receiving = file.status == ReceivedFileStatus.receiving;
    final done = file.status == ReceivedFileStatus.done;

    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 10, 6, 8),
          decoration: BoxDecoration(
            color: colors.surface,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: colors.border),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    file.isApk ? LucideIcons.package : LucideIcons.file,
                    size: 20,
                    color: done ? colors.accent : colors.muted,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          file.name,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: context.typo.mono.copyWith(
                            fontSize: 13,
                            color: colors.text,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _subtitle(),
                          style: context.typo.mono.copyWith(
                            fontSize: 11.5,
                            color: _failed ? colors.error : colors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (receiving)
                    IconButton(
                      key: const Key('file_card_cancel'),
                      tooltip: 'Cancel',
                      icon: Icon(LucideIcons.x, size: 16, color: colors.muted),
                      onPressed: onCancel,
                    ),
                ],
              ),
              if (caption.isNotEmpty) ...[
                const SizedBox(height: 6),
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Text(
                    caption,
                    style: TextStyle(fontSize: 13.5, color: colors.text),
                  ),
                ),
              ],
              if (receiving) ...[
                const SizedBox(height: 8),
                Padding(
                  padding: const EdgeInsets.only(right: 6, bottom: 4),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(2),
                    child: LinearProgressIndicator(
                      key: const Key('file_card_progress'),
                      value: file.progress,
                      minHeight: 4,
                      color: colors.accent,
                      backgroundColor: colors.border,
                    ),
                  ),
                ),
              ],
              if (done) ...[
                const SizedBox(height: 4),
                Wrap(
                  spacing: 2,
                  children: [
                    _Action(
                      key: const Key('file_card_open'),
                      icon: LucideIcons.externalLink,
                      label: 'Open',
                      onTap: onOpen,
                    ),
                    _Action(
                      key: const Key('file_card_share'),
                      icon: LucideIcons.share2,
                      label: 'Share',
                      onTap: onShare,
                    ),
                    if (canSaveToDownloads)
                      _Action(
                        key: const Key('file_card_save'),
                        icon: LucideIcons.download,
                        label: 'Save to Downloads',
                        onTap: onSave,
                      ),
                    if (canInstall && file.isApk)
                      _Action(
                        key: const Key('file_card_install'),
                        icon: LucideIcons.packagePlus,
                        label: 'Install',
                        onTap: onInstall,
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  bool get _failed =>
      file.status == ReceivedFileStatus.failed ||
      file.status == ReceivedFileStatus.cancelled;

  String _subtitle() => switch (file.status) {
    ReceivedFileStatus.receiving =>
      '${formatBytes(file.receivedBytes)} / ${formatBytes(file.size)}',
    ReceivedFileStatus.done => formatBytes(file.size),
    ReceivedFileStatus.cancelled => 'Cancelled',
    ReceivedFileStatus.failed => switch (file.errorReason) {
      'sha_mismatch' => 'Failed: checksum did not match',
      'no_space' => 'Failed: not enough storage',
      'expired' => 'Failed: transfer interrupted',
      _ => 'Failed',
    },
  };
}

class _Action extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  const _Action({
    super.key,
    required this.icon,
    required this.label,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return TextButton.icon(
      onPressed: onTap,
      style: TextButton.styleFrom(
        foregroundColor: colors.accent,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        minimumSize: const Size(0, 32),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      icon: Icon(icon, size: 15),
      label: Text(label, style: const TextStyle(fontSize: 13)),
    );
  }
}

/// `1023 B`, `512 KB`, `33.0 MB`, `3.0 GB`.
String formatBytes(int bytes) {
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes < kb) return '$bytes B';
  if (bytes < mb) return '${(bytes / kb).round()} KB';
  if (bytes < gb) return '${(bytes / mb).toStringAsFixed(1)} MB';
  return '${(bytes / gb).toStringAsFixed(1)} GB';
}

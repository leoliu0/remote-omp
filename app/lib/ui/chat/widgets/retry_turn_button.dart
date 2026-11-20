import 'dart:async';

import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Plan 68 - "Retry" under a failed turn.
///
/// One tap runs [onRetry]; the button is disabled while it is in flight, so a
/// double tap cannot schedule two retries. [onRetry] resolves true once the
/// extension scheduled the retry - the turn then streams like any other and
/// the transcript drops this button - and false after a refusal the caller
/// already reported (the button is offered again at once).
class RetryTurnButton extends StatefulWidget {
  const RetryTurnButton({super.key, required this.onRetry});

  final Future<bool> Function() onRetry;

  @override
  State<RetryTurnButton> createState() => _RetryTurnButtonState();
}

class _RetryTurnButtonState extends State<RetryTurnButton> {
  /// After a scheduled retry the button stays disabled until the turn shows
  /// up in the transcript; if it never does, Retry is offered again.
  static const _startGrace = Duration(seconds: 6);

  bool _busy = false;
  Timer? _graceTimer;

  @override
  void dispose() {
    _graceTimer?.cancel();
    super.dispose();
  }

  Future<void> _tap() async {
    if (_busy) return;
    setState(() => _busy = true);
    final scheduled = await widget.onRetry();
    if (!mounted) return;
    if (scheduled) {
      _graceTimer = Timer(_startGrace, () {
        if (mounted) setState(() => _busy = false);
      });
    } else {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Align(
      alignment: Alignment.centerLeft,
      child: OutlinedButton.icon(
        key: const Key('retry_turn_button'),
        onPressed: _busy ? null : _tap,
        icon: _busy
            ? SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: colors.accent,
                ),
              )
            : Icon(LucideIcons.rotateCw, size: 14, color: colors.accent),
        label: Text(
          _busy ? 'Retrying…' : 'Retry',
          style: context.typo.mono.copyWith(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: colors.accent,
          ),
        ),
        style: OutlinedButton.styleFrom(
          side: BorderSide(color: colors.accent.withValues(alpha: 0.5)),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          visualDensity: VisualDensity.compact,
        ),
      ),
    );
  }
}

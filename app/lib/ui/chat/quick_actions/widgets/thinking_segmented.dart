import 'package:app/protocol/protocol.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/home/widgets/session_tile.dart' show thinkingLabel;
import 'package:flutter/material.dart';

/// Thinking-level segmented control shared by the Quick Actions sheet and
/// the model picker's Roles tab. Each segment is keyed `<keyPrefix><wire>`.
class ThinkingSegmented extends StatelessWidget {
  final ThinkingLevel? current;
  final bool disabled;
  final ValueChanged<ThinkingLevel> onPick;

  /// Levels the current model supports, in the Pi's order (omp: off, auto,
  /// then the model's efforts). Null/empty = show every level.
  final List<ThinkingLevel>? levels;

  /// Segment key prefix (`qa-thinking-` in the Quick Actions sheet).
  final String keyPrefix;
  const ThinkingSegmented({
    super.key,
    required this.current,
    required this.disabled,
    required this.onPick,
    this.levels,
    this.keyPrefix = 'qa-thinking-',
  });

  @override
  Widget build(BuildContext context) {
    final shown = (levels == null || levels!.isEmpty)
        ? ThinkingLevel.values
        : levels!;
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: context.colors.border),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        children: [
          for (final level in shown)
            Expanded(
              child: _SegButton(
                key: Key('$keyPrefix${level.wire}'),
                label: thinkingLabel(level),
                selected: current == level,
                disabled: disabled,
                onTap: () => onPick(level),
              ),
            ),
        ],
      ),
    );
  }
}

class _SegButton extends StatelessWidget {
  final String label;
  final bool selected;
  final bool disabled;
  final VoidCallback onTap;
  const _SegButton({
    super.key,
    required this.label,
    required this.selected,
    required this.disabled,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return GestureDetector(
      onTap: disabled ? null : onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(
          color: selected
              ? colors.accent.withValues(alpha: 0.15)
              : Colors.transparent,
        ),
        child: Center(
          child: Text(
            label,
            style: TextStyle(
              fontFamily: kMonoFamily,
              fontSize: 11,
              color: disabled
                  ? colors.muted.withValues(alpha: 0.5)
                  : selected
                  ? colors.accent
                  : colors.text,
            ),
          ),
        ),
      ),
    );
  }
}

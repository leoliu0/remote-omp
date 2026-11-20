import 'package:app/data/local/saved_prompts_store.dart';
import 'package:app/routing/adaptive.dart';
import 'package:app/ui/chat/quick_actions/widgets/dismiss_on_session_change.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Opens the saved-prompts sheet. Resolves to the tapped prompt (the sheet
/// closes on tap) or null when dismissed. [currentText] is the composer text
/// that the "Save current text" button stores.
Future<String?> showSavedPromptsSheet(
  BuildContext context, {
  required SavedPromptsStore store,
  required String currentText,
}) {
  final selection = Provider.of<SessionSelection?>(context, listen: false);
  final body = FractionallySizedBox(
    heightFactor: 0.7,
    child: SavedPromptsSheetBody(store: store, currentText: currentText),
  );
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: context.colors.bg,
    barrierColor: Colors.black.withValues(alpha: 0.6),
    isScrollControlled: true,
    showDragHandle: false,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) => selection != null
        ? DismissOnSessionChange(selection: selection, child: body)
        : body,
  );
}

/// Body of the saved-prompts sheet: tap a row to pick it, drag the grip to
/// reorder, swipe left or tap the trash icon to delete.
class SavedPromptsSheetBody extends StatelessWidget {
  const SavedPromptsSheetBody({
    super.key,
    required this.store,
    required this.currentText,
  });

  final SavedPromptsStore store;
  final String currentText;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final typo = context.typo;
    return Container(
      decoration: BoxDecoration(
        color: colors.bg,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
      ),
      child: SafeArea(
        top: false,
        child: ListenableBuilder(
          listenable: store,
          builder: (context, _) {
            final prompts = store.prompts;
            final trimmed = currentText.trim();
            final canSave = trimmed.isNotEmpty && !store.contains(trimmed);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 10),
                Center(
                  child: Container(
                    width: 36,
                    height: 4,
                    decoration: BoxDecoration(
                      color: colors.border,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                  child: Row(
                    children: [
                      Icon(LucideIcons.bookmark, size: 17, color: colors.accent),
                      const SizedBox(width: 8),
                      Text(
                        'Saved prompts',
                        style: typo.mono.copyWith(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: colors.text,
                        ),
                      ),
                    ],
                  ),
                ),
                Divider(color: colors.border, height: 1, thickness: 1),
                Expanded(
                  child: prompts.isEmpty
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text(
                              'No saved prompts yet.\nType a message and tap '
                              '"Save current text".',
                              key: const Key('saved-prompts-empty'),
                              textAlign: TextAlign.center,
                              style: typo.monoSmall.copyWith(
                                color: colors.muted,
                              ),
                            ),
                          ),
                        )
                      : ReorderableListView.builder(
                          buildDefaultDragHandles: false,
                          itemCount: prompts.length,
                          onReorderItem: store.reorder,
                          itemBuilder: (context, index) => _PromptRow(
                            key: ValueKey(prompts[index]),
                            index: index,
                            prompt: prompts[index],
                            onTap: () => Navigator.of(context).pop(prompts[index]),
                            onDelete: () => store.removeAt(index),
                          ),
                        ),
                ),
                Divider(color: colors.border, height: 1, thickness: 1),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
                  child: SizedBox(
                    height: 44,
                    child: OutlinedButton.icon(
                      key: const Key('saved-prompts-save-current'),
                      onPressed: canSave ? () => store.add(trimmed) : null,
                      icon: const Icon(LucideIcons.bookmarkPlus, size: 17),
                      label: Text(
                        trimmed.isEmpty
                            ? 'Save current text'
                            : store.contains(trimmed)
                            ? 'Already saved'
                            : 'Save current text',
                        style: typo.mono.copyWith(fontSize: 13),
                      ),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: colors.accent,
                        disabledForegroundColor:
                            colors.muted.withValues(alpha: 0.5),
                        side: BorderSide(color: colors.border),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _PromptRow extends StatelessWidget {
  const _PromptRow({
    super.key,
    required this.index,
    required this.prompt,
    required this.onTap,
    required this.onDelete,
  });

  final int index;
  final String prompt;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final typo = context.typo;
    return Dismissible(
      key: ValueKey('dismiss:$prompt'),
      direction: DismissDirection.endToStart,
      onDismissed: (_) => onDelete(),
      background: Container(
        color: colors.error.withValues(alpha: 0.2),
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 20),
        child: Icon(LucideIcons.trash2, size: 18, color: colors.error),
      ),
      child: Material(
        color: colors.bg,
        child: InkWell(
          key: Key('saved-prompt-$index'),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.only(left: 16, right: 4),
            child: Row(
              children: [
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      prompt,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: typo.mono.copyWith(
                        fontSize: 13,
                        color: colors.text,
                      ),
                    ),
                  ),
                ),
                IconButton(
                  key: Key('saved-prompt-delete-$index'),
                  tooltip: 'Delete',
                  iconSize: 17,
                  visualDensity: VisualDensity.compact,
                  icon: Icon(LucideIcons.trash2, color: colors.muted),
                  onPressed: onDelete,
                ),
                ReorderableDragStartListener(
                  index: index,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 12,
                    ),
                    child: Icon(
                      LucideIcons.gripVertical,
                      key: Key('saved-prompt-grip-$index'),
                      size: 18,
                      color: colors.muted,
                    ),
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

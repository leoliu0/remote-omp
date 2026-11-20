import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Max suggestions requested and shown for one `@` lookup.
const int kFileMentionLimit = 8;

/// An `@token` being typed in the composer.
///
/// [start] is the index of the `@`, [end] the end of the whole non-whitespace
/// run (so replacing `[start, end)` also swallows text right of the caret),
/// and [query] the text between the `@` and the caret.
class FileMentionToken {
  const FileMentionToken({
    required this.start,
    required this.end,
    required this.query,
  });

  final int start;
  final int end;
  final String query;

  @override
  bool operator ==(Object other) =>
      other is FileMentionToken &&
      other.start == start &&
      other.end == end &&
      other.query == query;

  @override
  int get hashCode => Object.hash(start, end, query);

  @override
  String toString() => 'FileMentionToken($start, $end, "$query")';
}

bool _isSpace(int unit) =>
    unit == 0x20 || (unit >= 0x09 && unit <= 0x0D) || unit == 0xA0;

/// Finds the `@token` ending at [cursor]: a non-whitespace run that starts
/// with `@` at the start of the text or right after whitespace. `a@b.c` is
/// not a mention (the run starts with `a`). Returns null when [cursor] is
/// invalid or the run is not a mention.
FileMentionToken? findFileMentionToken(String text, int cursor) {
  if (cursor < 0 || cursor > text.length) return null;
  var start = cursor;
  while (start > 0 && !_isSpace(text.codeUnitAt(start - 1))) {
    start--;
  }
  if (start >= cursor || text.codeUnitAt(start) != 0x40) return null; // '@'
  final query = text.substring(start + 1, cursor);
  if (query.contains('@')) return null;
  var end = cursor;
  while (end < text.length && !_isSpace(text.codeUnitAt(end))) {
    end++;
  }
  return FileMentionToken(start: start, end: end, query: query);
}

/// Replaces [token] in [value] by `@<path> ` and puts the caret after it.
TextEditingValue applyFileMention(
  TextEditingValue value,
  FileMentionToken token,
  String path,
) {
  final insert = '@$path ';
  // Swallow one separating space already present after the token so
  // completing mid-sentence doesn't leave a double space.
  var end = token.end;
  if (end < value.text.length && value.text.codeUnitAt(end) == 0x20) end++;
  final text = value.text.replaceRange(token.start, end, insert);
  return TextEditingValue(
    text: text,
    selection: TextSelection.collapsed(offset: token.start + insert.length),
  );
}

/// Dropdown of file suggestions above the composer; mirrors the slash-command
/// menu's look. Rows show the basename bold with its directory muted.
class FileMentionMenu extends StatelessWidget {
  const FileMentionMenu({
    super.key,
    required this.files,
    required this.onSelect,
  });

  final List<String> files;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    if (files.isEmpty) return const SizedBox.shrink();
    final colors = context.colors;
    final typo = context.typo;

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      constraints: const BoxConstraints(maxHeight: 220),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.border),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.25),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              color: colors.bg,
              child: Row(
                children: [
                  Icon(LucideIcons.atSign, size: 13, color: colors.accent),
                  const SizedBox(width: 6),
                  Text(
                    'Files',
                    style: typo.mono.copyWith(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: colors.muted,
                    ),
                  ),
                ],
              ),
            ),
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                padding: const EdgeInsets.symmetric(vertical: 4),
                itemCount: files.length,
                separatorBuilder: (_, _) => Divider(
                  color: colors.border.withValues(alpha: 0.5),
                  height: 1,
                ),
                itemBuilder: (context, index) {
                  final path = files[index];
                  final slash = path.lastIndexOf('/');
                  final base = path.substring(slash + 1);
                  final dir = slash < 0 ? '' : path.substring(0, slash);
                  return Material(
                    color: Colors.transparent,
                    child: InkWell(
                      key: Key('file-mention-item-$index'),
                      onTap: () => onSelect(path),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 9,
                        ),
                        child: Row(
                          children: [
                            Icon(
                              LucideIcons.fileText,
                              size: 15,
                              color: colors.muted,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text.rich(
                                TextSpan(
                                  children: [
                                    TextSpan(
                                      text: base,
                                      style: typo.mono.copyWith(
                                        fontSize: 13,
                                        fontWeight: FontWeight.bold,
                                        color: colors.text,
                                      ),
                                    ),
                                    if (dir.isNotEmpty)
                                      TextSpan(
                                        text: '  $dir',
                                        style: typo.mono.copyWith(
                                          fontSize: 11,
                                          color: colors.muted,
                                        ),
                                      ),
                                  ],
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

import 'dart:convert';

import 'package:app/data/local/preference_store.dart';
import 'package:flutter/foundation.dart';

/// App-local list of reusable prompts shown by the composer's bookmark sheet.
///
/// Persisted as one JSON array in the shared `preferences` table. The default
/// prompts are written exactly once (guarded by a separate flag), so a prompt
/// the user deletes never comes back.
class SavedPromptsStore extends ChangeNotifier {
  SavedPromptsStore(this._store) {
    _load();
  }

  static const String promptsKey = 'saved_prompts.items';
  static const String seededKey = 'saved_prompts.seeded';

  static const List<String> defaults = <String>[
    'Run the tests',
    'Summarize what changed',
    'Code review and optimisations',
    'Commit and push',
  ];

  final PreferenceStore _store;
  List<String> _prompts = const <String>[];

  /// Prompts in display order.
  List<String> get prompts => _prompts;

  bool contains(String text) => _prompts.contains(text.trim());

  void _load() {
    if (_store.get(seededKey) == null) {
      _prompts = List<String>.of(defaults);
      _persist();
      _store.put(seededKey, '1');
      return;
    }
    final raw = _store.get(promptsKey);
    if (raw == null) return;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) {
        _prompts = <String>[
          for (final item in decoded)
            if (item is String && item.trim().isNotEmpty) item,
        ];
      }
    } on FormatException {
      _prompts = const <String>[];
    }
  }

  void _persist() => _store.put(promptsKey, jsonEncode(_prompts));

  /// Appends [text] (trimmed). Returns false for blank text or a duplicate.
  bool add(String text) {
    final value = text.trim();
    if (value.isEmpty || _prompts.contains(value)) return false;
    _prompts = <String>[..._prompts, value];
    _persist();
    notifyListeners();
    return true;
  }

  /// Removes the prompt at [index]; out-of-range is a no-op.
  void removeAt(int index) {
    if (index < 0 || index >= _prompts.length) return;
    _prompts = <String>[..._prompts]..removeAt(index);
    _persist();
    notifyListeners();
  }

  /// Moves the prompt at [oldIndex] so it ends up at [newIndex] of the
  /// resulting list ([ReorderableListView.onReorderItem] semantics).
  void reorder(int oldIndex, int newIndex) {
    if (oldIndex < 0 || oldIndex >= _prompts.length) return;
    final target = newIndex.clamp(0, _prompts.length - 1);
    if (target == oldIndex) return;
    final next = <String>[..._prompts];
    next.insert(target, next.removeAt(oldIndex));
    _prompts = next;
    _persist();
    notifyListeners();
  }
}

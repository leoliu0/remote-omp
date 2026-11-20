import 'package:app/data/local/app_database.dart';
import 'package:app/data/local/preference_store.dart';
import 'package:app/data/local/saved_prompts_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase db;
  late PreferenceStore prefs;

  setUp(() {
    db = AppDatabase.memory();
    prefs = PreferenceStore(db);
  });
  tearDown(() => db.dispose());

  test('seeds the defaults on first load', () {
    final store = SavedPromptsStore(prefs);
    expect(store.prompts, SavedPromptsStore.defaults);
    expect(store.prompts, contains('Commit and push'));
  });

  test('a deleted default is never re-added by a later load', () {
    final first = SavedPromptsStore(prefs);
    first.removeAt(0); // "Run the tests"
    final second = SavedPromptsStore(prefs);
    expect(second.prompts, isNot(contains('Run the tests')));
    expect(second.prompts, hasLength(SavedPromptsStore.defaults.length - 1));
  });

  test('deleting everything stays empty after reload', () {
    final first = SavedPromptsStore(prefs);
    while (first.prompts.isNotEmpty) {
      first.removeAt(0);
    }
    expect(SavedPromptsStore(prefs).prompts, isEmpty);
  });

  test('add trims, rejects blanks and duplicates, and persists', () {
    final store = SavedPromptsStore(prefs);
    expect(store.add('  Deploy to staging \n'), isTrue);
    expect(store.add('Deploy to staging'), isFalse);
    expect(store.add('Run the tests'), isFalse);
    expect(store.add('   '), isFalse);
    expect(SavedPromptsStore(prefs).prompts.last, 'Deploy to staging');
  });

  test('reorder moves to the final index and persists', () {
    final store = SavedPromptsStore(prefs);
    store.reorder(0, 2); // first item ends up third
    expect(store.prompts.take(3), [
      'Summarize what changed',
      'Code review and optimisations',
      'Run the tests',
    ]);
    store.reorder(3, 0); // last item to the top
    expect(store.prompts.first, 'Commit and push');
    expect(SavedPromptsStore(prefs).prompts, store.prompts);
  });

  test('notifies listeners on changes only', () {
    final store = SavedPromptsStore(prefs);
    var calls = 0;
    store.addListener(() => calls++);
    store.add('x');
    store.add('x'); // duplicate
    store.removeAt(99); // out of range
    store.removeAt(0);
    expect(calls, 2);
  });
}

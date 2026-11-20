import 'package:app/data/local/app_database.dart';
import 'package:app/data/local/preference_store.dart';
import 'package:app/data/local/saved_prompts_store.dart';
import 'package:app/ui/chat/widgets/input_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase db;
  late SavedPromptsStore store;

  setUp(() {
    db = AppDatabase.memory();
    store = SavedPromptsStore(PreferenceStore(db));
  });
  tearDown(() {
    store.dispose();
    db.dispose();
  });

  Future<void> pumpBar(WidgetTester tester, {String initial = ''}) {
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: InputBar(
              onSend: (_) {},
              savedPrompts: store,
              initialText: initial,
            ),
          ),
        ),
      ),
    );
  }

  Future<void> openSheet(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('input-bar-saved-prompts')));
    await tester.pumpAndSettle();
  }

  String composerText(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).controller!.text;

  testWidgets('bookmark is hidden without a store', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: InputBar(onSend: (_) {}),
          ),
        ),
      ),
    );
    expect(find.byKey(const Key('input-bar-saved-prompts')), findsNothing);
  });

  testWidgets('lists the seeded prompts; tap replaces an empty composer', (
    tester,
  ) async {
    await pumpBar(tester);
    await openSheet(tester);
    for (final p in SavedPromptsStore.defaults) {
      expect(find.text(p), findsOneWidget);
    }
    await tester.tap(find.byKey(const Key('saved-prompt-1')));
    await tester.pumpAndSettle();
    expect(composerText(tester), 'Summarize what changed');
    expect(find.text('Saved prompts'), findsNothing); // sheet closed
  });

  testWidgets('tap appends on a new line when the composer has text', (
    tester,
  ) async {
    await pumpBar(tester, initial: 'fix the bug');
    await openSheet(tester);
    await tester.tap(find.byKey(const Key('saved-prompt-0')));
    await tester.pumpAndSettle();
    expect(composerText(tester), 'fix the bug\nRun the tests');
  });

  testWidgets('Save current text is disabled when empty', (tester) async {
    await pumpBar(tester);
    await openSheet(tester);
    final button = tester.widget<OutlinedButton>(
      find.byKey(const Key('saved-prompts-save-current')),
    );
    expect(button.onPressed, isNull);
  });

  testWidgets('Save current text adds once and then reports duplicate', (
    tester,
  ) async {
    await pumpBar(tester, initial: '  Deploy to staging ');
    await openSheet(tester);
    await tester.tap(find.byKey(const Key('saved-prompts-save-current')));
    await tester.pumpAndSettle();
    expect(store.prompts.last, 'Deploy to staging');
    expect(find.text('Deploy to staging'), findsOneWidget);
    expect(find.text('Already saved'), findsOneWidget);
    expect(
      tester
          .widget<OutlinedButton>(
            find.byKey(const Key('saved-prompts-save-current')),
          )
          .onPressed,
      isNull,
    );
  });

  testWidgets('trash icon deletes a prompt', (tester) async {
    await pumpBar(tester);
    await openSheet(tester);
    await tester.tap(find.byKey(const Key('saved-prompt-delete-0')));
    await tester.pumpAndSettle();
    expect(find.text('Run the tests'), findsNothing);
    expect(store.prompts, isNot(contains('Run the tests')));
  });

  testWidgets('swiping a row left deletes it', (tester) async {
    await pumpBar(tester);
    await openSheet(tester);
    await tester.drag(
      find.byKey(const Key('saved-prompt-0')),
      const Offset(-600, 0),
    );
    await tester.pumpAndSettle();
    expect(store.prompts.first, 'Summarize what changed');
    expect(store.prompts, hasLength(3));
  });

  testWidgets('dragging the grip reorders', (tester) async {
    await pumpBar(tester);
    await openSheet(tester);
    final grip = find.byKey(const Key('saved-prompt-grip-0'));
    final gesture = await tester.startGesture(tester.getCenter(grip));
    await tester.pump(const Duration(milliseconds: 100));
    await gesture.moveBy(const Offset(0, 120));
    await tester.pump();
    await gesture.moveBy(const Offset(0, 60));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    expect(store.prompts.first, 'Summarize what changed');
    expect(store.prompts.indexOf('Run the tests'), greaterThan(0));
    expect(store.prompts, hasLength(4));
  });

  testWidgets('empty state explains how to add prompts', (tester) async {
    while (store.prompts.isNotEmpty) {
      store.removeAt(0);
    }
    await pumpBar(tester);
    await openSheet(tester);
    expect(find.byKey(const Key('saved-prompts-empty')), findsOneWidget);
  });
}

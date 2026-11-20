import 'dart:async';

import 'package:app/ui/chat/widgets/file_mention.dart';
import 'package:app/ui/chat/widgets/input_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

FileMentionToken? _at(String text, [int? cursor]) =>
    findFileMentionToken(text, cursor ?? text.length);

void main() {
  group('findFileMentionToken', () {
    test('detects @token at the start and after whitespace', () {
      expect(_at('@sup'), const FileMentionToken(start: 0, end: 4, query: 'sup'));
      expect(
        _at('look at @src/in'),
        const FileMentionToken(start: 8, end: 15, query: 'src/in'),
      );
      expect(
        _at('a\n@x'),
        const FileMentionToken(start: 2, end: 4, query: 'x'),
      );
      expect(_at('@'), const FileMentionToken(start: 0, end: 1, query: ''));
    });

    test('email addresses and mid-word @ are not mentions', () {
      expect(_at('a@b.c'), isNull);
      expect(_at('mail me at leo@example.com'), isNull);
      expect(_at('foo@'), isNull);
      expect(_at('@@x'), isNull);
    });

    test('ends once the caret leaves the token', () {
      expect(_at('@sup '), isNull);
      expect(_at('@sup\n'), isNull);
      expect(_at('hello'), isNull);
      expect(_at(''), isNull);
      expect(_at('@sup', -1), isNull);
      expect(_at('@sup', 99), isNull);
    });

    test('caret in the middle uses the text before it, run end after it', () {
      expect(
        _at('x @sup y', 5),
        const FileMentionToken(start: 2, end: 6, query: 'su'),
      );
    });
  });

  group('applyFileMention', () {
    test('replaces the token with @path and a trailing space', () {
      const value = TextEditingValue(
        text: 'see @sup',
        selection: TextSelection.collapsed(offset: 8),
      );
      final next = applyFileMention(
        value,
        findFileMentionToken(value.text, 8)!,
        'src/daemon/supervisor.ts',
      );
      expect(next.text, 'see @src/daemon/supervisor.ts ');
      expect(next.selection.baseOffset, next.text.length);
    });

    test('mid-sentence keeps the rest without doubling the space', () {
      const value = TextEditingValue(
        text: '@sup and more',
        selection: TextSelection.collapsed(offset: 4),
      );
      final next = applyFileMention(
        value,
        findFileMentionToken(value.text, 4)!,
        'a/b.ts',
      );
      expect(next.text, '@a/b.ts and more');
      expect(next.selection.baseOffset, '@a/b.ts '.length);
    });
  });

  group('InputBar @ autocomplete', () {
    late List<String> queries;
    late Map<String, Completer<List<String>>> pending;
    late List<String> sent;

    setUp(() {
      queries = [];
      pending = {};
      sent = [];
    });

    Future<List<String>> search(String q) {
      queries.add(q);
      return (pending[q] = Completer<List<String>>()).future;
    }

    Future<void> pumpBar(
      WidgetTester tester, {
      Future<List<String>> Function(String)? onSearch,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: InputBar(
                onSend: sent.add,
                onSearchFiles: onSearch ?? search,
              ),
            ),
          ),
        ),
      );
    }

    final field = find.byType(TextField);
    const menu = Key('file-mention-menu');
    const debounce = Duration(milliseconds: 130);

    testWidgets('debounces, lists basename + dir, tap inserts path', (
      tester,
    ) async {
      await pumpBar(tester);
      await tester.enterText(field, '@s');
      await tester.pump(const Duration(milliseconds: 50));
      await tester.enterText(field, '@sup');
      await tester.pump(debounce);
      expect(queries, ['sup']); // the intermediate "s" was debounced away

      pending['sup']!.complete([
        'omp-extension/src/daemon/supervisor.ts',
        'plan/40-windows-supervisor.md',
      ]);
      await tester.pump();
      expect(find.byKey(menu), findsOneWidget);
      expect(find.textContaining('supervisor.ts'), findsOneWidget);

      await tester.tap(find.byKey(const Key('file-mention-item-0')));
      await tester.pump();
      final input = tester.widget<TextField>(field).controller!;
      expect(input.text, '@omp-extension/src/daemon/supervisor.ts ');
      expect(find.byKey(menu), findsNothing);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    });

    testWidgets('a stale reply is dropped', (tester) async {
      await pumpBar(tester);
      await tester.enterText(field, '@s');
      await tester.pump(debounce);
      await tester.enterText(field, '@su');
      await tester.pump(debounce);
      expect(queries, ['s', 'su']);

      pending['su']!.complete(['new.ts']);
      await tester.pump();
      pending['s']!.complete(['stale.ts']); // arrives late
      await tester.pump();
      expect(find.textContaining('new.ts'), findsOneWidget);
      expect(find.textContaining('stale.ts'), findsNothing);
    });

    testWidgets('a reply for a token the user already left is dropped', (
      tester,
    ) async {
      await pumpBar(tester);
      await tester.enterText(field, '@sup');
      await tester.pump(debounce);
      await tester.enterText(field, '@sup done');
      await tester.pump();
      pending['sup']!.complete(['late.ts']);
      await tester.pump();
      expect(find.byKey(menu), findsNothing);
    });

    testWidgets('emails and plain text never query', (tester) async {
      await pumpBar(tester);
      await tester.enterText(field, 'mail leo@example.com');
      await tester.pump(debounce);
      await tester.enterText(field, 'no mention here');
      await tester.pump(debounce);
      expect(queries, isEmpty);
    });

    testWidgets('shows at most 8 suggestions', (tester) async {
      await pumpBar(
        tester,
        onSearch: (_) async => [for (var i = 0; i < 20; i++) 'f$i.ts'],
      );
      await tester.enterText(field, '@f');
      await tester.pump(debounce);
      await tester.pump();
      await tester.scrollUntilVisible(
        find.byKey(const Key('file-mention-item-7')),
        50,
        scrollable: find.descendant(
          of: find.byKey(menu),
          matching: find.byType(Scrollable),
        ),
      );
      expect(find.byKey(const Key('file-mention-item-7')), findsOneWidget);
      expect(find.byKey(const Key('file-mention-item-8')), findsNothing);
    });

    testWidgets('Escape hides until the token changes', (tester) async {
      await pumpBar(tester);
      await tester.enterText(field, '@sup');
      await tester.pump(debounce);
      pending['sup']!.complete(['a.ts']);
      await tester.pump();
      expect(find.byKey(menu), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byKey(menu), findsNothing);

      await tester.enterText(field, '@supe');
      await tester.pump(debounce);
      expect(queries, ['sup', 'supe']);
      pending['supe']!.complete(['b.ts']);
      await tester.pump();
      expect(find.byKey(menu), findsOneWidget);
    });

    testWidgets('a failing search (old extension) shows nothing, quietly', (
      tester,
    ) async {
      await pumpBar(
        tester,
        onSearch: (_) => Future<List<String>>.error(StateError('timeout')),
      );
      await tester.enterText(field, '@sup');
      await tester.pump(debounce);
      await tester.pump();
      expect(find.byKey(menu), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('without onSearchFiles the feature is off', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: InputBar(onSend: sent.add),
            ),
          ),
        ),
      );
      await tester.enterText(field, '@sup');
      await tester.pump(debounce);
      expect(find.byKey(menu), findsNothing);
    });
  });
}

import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/widgets/input_bar.dart';
import 'package:app/ui/chat/widgets/slash_commands.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('filterSlashCommands', () {
    test('returns empty list when input does not start with slash', () {
      expect(filterSlashCommands('hello'), isEmpty);
      expect(filterSlashCommands(''), isEmpty);
    });

    test('returns all commands when input is single slash', () {
      final all = filterSlashCommands('/');
      expect(all.length, kSlashCommands.length);
      expect(all.any((c) => c.name == 'init'), isTrue);
      expect(all.any((c) => c.name == 'compact'), isTrue);
      expect(all.any((c) => c.name == 'improve-writing'), isTrue);
    });

    test('filters commands by prefix or substring', () {
      final initMatches = filterSlashCommands('/in');
      expect(initMatches.any((c) => c.name == 'init'), isTrue);

      final writingMatches = filterSlashCommands('/writ');
      expect(writingMatches.any((c) => c.name == 'improve-writing'), isTrue);
    });

    test('returns empty when space is typed after command', () {
      expect(filterSlashCommands('/init project'), isEmpty);
      expect(filterSlashCommands('/model '), isEmpty);
    });
  });

  // The extension sends omp's own list in `skills_list.commands`; the menu then
  // lists what that host can run instead of the app's built-in guess.
  group('filterSlashCommands with the host list', () {
    const host = [
      WireCommand(
        name: 'compact',
        description: 'Compact the conversation',
        source: 'builtin',
      ),
      WireCommand(
        name: 'model',
        description: 'Switch model for this session',
        source: 'builtin',
        hint: '[model]',
      ),
      WireCommand(
        name: 'remote-omp',
        description: 'Connect to the phone',
        source: 'extension',
      ),
      WireCommand(name: 'review', description: 'Review a diff', source: 'prompt'),
    ];
    const skills = [
      WireSkill(name: 'skill:audit-paper', description: 'Audit a paper'),
    ];

    test('lists the host commands, then its skills, and nothing else', () {
      final names = filterSlashCommands('/', skills, host).map((c) => c.name);
      expect(names, [
        'compact',
        'model',
        'remote-omp',
        'review',
        'skill:audit-paper',
      ]);
    });

    test('drops hard-coded entries the host does not have', () {
      final all = filterSlashCommands('/', skills, host);
      // `init` and the personal skills are only in the app's built-in list.
      expect(kSlashCommands.any((c) => c.name == 'init'), isTrue);
      expect(all.any((c) => c.name == 'init'), isFalse);
      expect(all.any((c) => c.name == 'improve-writing'), isFalse);
    });

    test('shows the host wording on a command the app also knows', () {
      final compact = filterSlashCommands('/', skills, host).first;
      final builtIn = kSlashCommands.firstWhere((c) => c.name == 'compact');
      expect(compact.description, 'Compact the conversation');
      expect(compact.description, isNot(builtIn.description));
      expect(compact.icon, builtIn.icon);
    });

    test('a host command without a description keeps the built-in wording', () {
      final items = filterSlashCommands('/comp', null, const [
        WireCommand(name: 'compact', description: '', source: 'builtin'),
      ]);
      expect(items.single.description, isNotEmpty);
      expect(
        items.single.description,
        kSlashCommands.firstWhere((c) => c.name == 'compact').description,
      );
    });

    test('labels each entry by where it comes from', () {
      final categories = filterSlashCommands('/', skills, host)
          .map((c) => c.category);
      expect(categories, ['Command', 'Command', 'Extension', 'Prompt', 'Skill']);
    });

    test('filters by name or description like the built-in list', () {
      expect(
        filterSlashCommands('/aud', skills, host).map((c) => c.name),
        ['skill:audit-paper'],
      );
      expect(
        filterSlashCommands('/diff', skills, host).map((c) => c.name),
        ['review'],
      );
      expect(filterSlashCommands('/model ', skills, host), isEmpty);
      expect(filterSlashCommands('hello', skills, host), isEmpty);
    });

    test('a name the host repeats is listed once', () {
      final items = filterSlashCommands('/', const [
        WireSkill(name: 'review', description: 'same name as a command'),
      ], host);
      expect(items.where((c) => c.name == 'review'), hasLength(1));
      expect(items.firstWhere((c) => c.name == 'review').category, 'Prompt');
    });

    test('without host commands the built-in list and skills stay as before', () {
      for (final none in <List<WireCommand>?>[null, const <WireCommand>[]]) {
        final all = filterSlashCommands('/', skills, none);
        expect(all.length, kSlashCommands.length + 1);
        expect(all.any((c) => c.name == 'init'), isTrue);
        expect(all.last.name, 'skill:audit-paper');
        expect(all.last.category, 'Skill');
      }
    });
  });

  group('SlashCommandMenu widget', () {
    testWidgets('renders command list and triggers onSelect', (tester) async {
      SlashCommandItem? selected;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SlashCommandMenu(
              items: const [
                SlashCommandItem(
                  name: 'init',
                  description: 'Initialize project configuration',
                ),
                SlashCommandItem(
                  name: 'compact',
                  description: 'Compact history',
                ),
              ],
              onSelect: (item) => selected = item,
            ),
          ),
        ),
      );

      expect(find.text('/init'), findsOneWidget);
      expect(find.text('/compact'), findsOneWidget);
      expect(find.text('Initialize project configuration'), findsOneWidget);

      await tester.tap(find.text('/init'));
      await tester.pump();

      expect(selected?.name, 'init');
    });
  });

  group('InputBar slash menu', () {
    Future<void> pumpBar(
      WidgetTester tester, {
      List<WireCommand>? hostCommands,
      List<WireSkill> skills = const [],
    }) {
      return tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: InputBar(
              disabled: false,
              streaming: false,
              onSend: (_) {},
              onCancel: () {},
              dynamicSkills: skills,
              hostCommands: hostCommands,
            ),
          ),
        ),
      );
    }

    testWidgets('typing / lists the host commands and selecting one fills the composer', (
      tester,
    ) async {
      await pumpBar(
        tester,
        hostCommands: const [
          WireCommand(
            name: 'compact',
            description: 'Compact the conversation',
            source: 'builtin',
          ),
          WireCommand(
            name: 'remote-omp',
            description: 'Connect to the phone',
            source: 'extension',
          ),
        ],
        skills: const [
          WireSkill(name: 'skill:audit-paper', description: 'Audit a paper'),
        ],
      );

      await tester.enterText(find.byType(TextField), '/');
      await tester.pump();

      expect(find.text('/compact'), findsOneWidget);
      expect(find.text('/remote-omp'), findsOneWidget);
      expect(find.text('/skill:audit-paper'), findsOneWidget);
      expect(find.text('Compact the conversation'), findsOneWidget);
      expect(find.text('/init'), findsNothing); // built-in only

      await tester.tap(find.text('/remote-omp'));
      await tester.pump();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller?.text,
        '/remote-omp ',
      );
    });

    testWidgets('an older extension (no host list) keeps the built-in menu', (
      tester,
    ) async {
      await pumpBar(
        tester,
        skills: const [WireSkill(name: 'my-skill', description: 'Mine')],
      );

      await tester.enterText(find.byType(TextField), '/');
      await tester.pump();

      expect(find.text('/init'), findsOneWidget);
    });
  });
}

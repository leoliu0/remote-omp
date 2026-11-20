import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('skills_list', () {
    test('carries omp\'s command list when the extension sends one', () {
      final msg =
          ServerMessage.fromJson({
                'type': 'skills_list',
                'in_reply_to': 'sync-1',
                'skills': [
                  {'name': 'skill:audit-paper', 'description': 'Audit a paper'},
                ],
                'commands': [
                  {
                    'name': 'compact',
                    'description': 'Compact the conversation',
                    'source': 'builtin',
                  },
                  {
                    'name': 'model',
                    'description': 'Switch model',
                    'source': 'builtin',
                    'hint': '[model]',
                  },
                  {
                    'name': 'review',
                    'description': 'Review a diff',
                    'source': 'prompt',
                  },
                ],
              })
              as SkillsList;

      expect(msg.inReplyTo, 'sync-1');
      expect(msg.skills.single.name, 'skill:audit-paper');
      final commands = msg.commands!;
      expect(commands.map((c) => c.name), ['compact', 'model', 'review']);
      expect(commands.map((c) => c.source), ['builtin', 'builtin', 'prompt']);
      expect(commands[1].hint, '[model]');
      expect(commands[0].hint, isNull);
      expect(commands[2].description, 'Review a diff');
    });

    test('an older extension omits the field: commands is null, not empty', () {
      final msg =
          ServerMessage.fromJson({
                'type': 'skills_list',
                'in_reply_to': 'sync-1',
                'skills': [
                  {'name': 'audit-paper', 'description': 'Audit a paper'},
                ],
              })
              as SkillsList;

      expect(msg.skills.single.name, 'audit-paper');
      expect(msg.commands, isNull);
    });

    test('an empty list stays an empty list', () {
      final msg =
          ServerMessage.fromJson({
                'type': 'skills_list',
                'skills': <Object>[],
                'commands': <Object>[],
              })
              as SkillsList;

      expect(msg.commands, isEmpty);
    });

    test('skips entries that are not objects or have no name', () {
      final msg =
          ServerMessage.fromJson({
                'type': 'skills_list',
                'skills': <Object>[],
                'commands': [
                  'compact',
                  {'description': 'nameless'},
                  {'name': '', 'description': 'blank'},
                  {'name': 'new'},
                ],
              })
              as SkillsList;

      expect(msg.commands!.map((c) => c.name), ['new']);
      // missing description / source decode to empty strings, hint to null
      expect(msg.commands!.single.description, '');
      expect(msg.commands!.single.source, '');
      expect(msg.commands!.single.hint, isNull);
    });
  });
}

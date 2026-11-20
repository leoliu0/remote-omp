// Plan 68 — wire shapes of the new-session messages. The server-side samples
// below are what omp-extension/src/actions/sessions.ts emits.

import 'dart:convert';

import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('new session ClientMessage serialization', () {
    test('ListDirsRequest omits the path when asking for home', () {
      expect(ListDirsRequest(id: 'act_1').toJson(), {
        'type': 'list_dirs',
        'id': 'act_1',
      });
      expect(ListDirsRequest(id: 'act_2', path: '/home/leo/work').toJson(), {
        'type': 'list_dirs',
        'id': 'act_2',
        'path': '/home/leo/work',
      });
    });

    test('SpawnSessionRequest sends only what was chosen', () {
      expect(SpawnSessionRequest(id: 'act_3', cwd: '/w/app').toJson(), {
        'type': 'spawn_session',
        'id': 'act_3',
        'cwd': '/w/app',
      });
      expect(
        SpawnSessionRequest(
          id: 'act_4',
          cwd: '/w/app',
          name: 'My app',
          persistent: true,
        ).toJson(),
        {
          'type': 'spawn_session',
          'id': 'act_4',
          'cwd': '/w/app',
          'name': 'My app',
          'persistent': true,
        },
      );
      // A blank name means "let the PC pick": it is left out, never sent empty.
      expect(
        SpawnSessionRequest(id: 'act_5', cwd: '/w/app', name: '').toJson(),
        isNot(contains('name')),
      );
    });

    test('there is no harness on the wire: new sessions are always omp', () {
      final json = SpawnSessionRequest(
        id: 'act_6',
        cwd: '/w/app',
        persistent: true,
      ).toJson();
      expect(json, isNot(contains('harness')));
    });
  });

  group('new session ServerMessage parsing', () {
    test('dirs_list parses folders, git flags, recents and the parent', () {
      final msg = ServerMessage.fromJson(
        jsonDecode(
              jsonEncode({
                'type': 'dirs_list',
                'in_reply_to': 'act_1',
                'path': '/home/leo/work',
                'parent': '/home/leo',
                'home': '/home/leo',
                'dirs': [
                  {'name': 'alpha', 'path': '/home/leo/work/alpha', 'is_git': false},
                  {'name': 'proj', 'path': '/home/leo/work/proj', 'is_git': true},
                ],
                'recent': [
                  {
                    'path': '/home/leo/work/proj',
                    'name': 'proj',
                    'last_used': 1763600000000,
                  },
                  {'path': '/srv/door', 'name': 'Door'},
                ],
                'truncated': true,
              }),
            )
            as Map<String, dynamic>,
      );

      expect(msg, isA<DirsListResult>());
      final r = msg as DirsListResult;
      expect(r.inReplyTo, 'act_1');
      expect(r.path, '/home/leo/work');
      expect(r.parent, '/home/leo');
      expect(r.home, '/home/leo');
      expect(r.truncated, isTrue);
      expect(r.dirs, const [
        WireDirEntry(name: 'alpha', path: '/home/leo/work/alpha'),
        WireDirEntry(name: 'proj', path: '/home/leo/work/proj', isGit: true),
      ]);
      expect(r.recent, const [
        WireRecentDir(
          path: '/home/leo/work/proj',
          name: 'proj',
          lastUsed: 1763600000000,
        ),
        WireRecentDir(path: '/srv/door', name: 'Door'),
      ]);
    });

    test('dirs_list at the filesystem root has no parent', () {
      final r =
          ServerMessage.fromJson({
                'type': 'dirs_list',
                'in_reply_to': 'act_2',
                'path': '/',
                'parent': null,
                'home': '/home/leo',
                'dirs': <dynamic>[],
                'recent': <dynamic>[],
                'truncated': false,
              })
              as DirsListResult;
      expect(r.parent, isNull);
      expect(r.dirs, isEmpty);
      expect(r.truncated, isFalse);
    });

    test('dirs_list tolerates missing optional fields and junk entries', () {
      final r =
          ServerMessage.fromJson({
                'type': 'dirs_list',
                'in_reply_to': 'act_3',
                'path': '/x',
                'home': '/home/leo',
                'dirs': [
                  {'name': 'ok', 'path': '/x/ok'},
                  'not-a-map',
                  42,
                ],
              })
              as DirsListResult;
      expect(r.dirs, const [WireDirEntry(name: 'ok', path: '/x/ok')]);
      expect(r.recent, isEmpty);
      expect(r.parent, isNull);
      expect(r.truncated, isFalse);
    });

    test('spawn_result parses', () {
      final r =
          ServerMessage.fromJson({
                'type': 'spawn_result',
                'in_reply_to': 'act_4',
                'cwd': '/w/app',
                'name': 'app',
                'persistent': true,
                'daemon_id': 'ab12cd34',
              })
              as SpawnResult;
      expect(
        r,
        const SpawnResult(
          inReplyTo: 'act_4',
          cwd: '/w/app',
          name: 'app',
          persistent: true,
          daemonId: 'ab12cd34',
        ),
      );
    });

    test('an extension error carries the code the sheet maps to a message', () {
      final e =
          ServerMessage.fromJson({
                'type': 'error',
                'in_reply_to': 'act_5',
                'code': 'cwd_busy',
                'message': 'A session is already running in that folder',
              })
              as ErrorMessage;
      expect(e.inReplyTo, 'act_5');
      expect(e.code, 'cwd_busy');
    });

    test('equality and hashing follow the fields', () {
      const a = DirsListResult(
        inReplyTo: 'r',
        path: '/a',
        home: '/h',
        dirs: [WireDirEntry(name: 'x', path: '/a/x')],
      );
      const b = DirsListResult(
        inReplyTo: 'r',
        path: '/a',
        home: '/h',
        dirs: [WireDirEntry(name: 'x', path: '/a/x')],
      );
      const c = DirsListResult(
        inReplyTo: 'r',
        path: '/a',
        home: '/h',
        dirs: [WireDirEntry(name: 'y', path: '/a/y')],
      );
      expect(a, b);
      expect(a.hashCode, b.hashCode);
      expect(a, isNot(c));
    });
  });
}

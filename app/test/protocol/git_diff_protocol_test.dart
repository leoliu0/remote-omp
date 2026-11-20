import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Git diff ClientMessage serialization', () {
    test('GitStatusRequest encodes as git_status', () {
      expect(GitStatusRequest(id: 'act_1').toJson(), {
        'type': 'git_status',
        'id': 'act_1',
      });
    });

    test('GitDiffRequest omits staged when false and includes when true', () {
      expect(GitDiffRequest(id: 'act_2', path: 'lib/a.dart').toJson(), {
        'type': 'git_diff',
        'id': 'act_2',
        'path': 'lib/a.dart',
      });
      expect(
        GitDiffRequest(id: 'act_3', path: 'lib/a.dart', staged: true).toJson(),
        {
          'type': 'git_diff',
          'id': 'act_3',
          'path': 'lib/a.dart',
          'staged': true,
        },
      );
    });
  });

  group('Git diff ServerMessage parsing', () {
    test('git_status_result parses full change entries and flags', () {
      final msg =
          ServerMessage.fromJson({
                'type': 'git_status_result',
                'in_reply_to': 'act_1',
                'is_repo': true,
                'branch': 'main',
                'repo_root': '/repo',
                'truncated': true,
                'files': [
                  {
                    'path': 'lib/new.dart',
                    'old_path': 'lib/old.dart',
                    'status': 'renamed',
                    'staged': true,
                    'unstaged': true,
                    'additions': 12,
                    'deletions': 4,
                  },
                  {
                    'path': 'assets/logo.png',
                    'status': 'untracked',
                    'staged': false,
                    'unstaged': true,
                    'binary': true,
                  },
                  {
                    'path': 'future.txt',
                    'status': 'unknown_future_code',
                    'staged': false,
                    'unstaged': true,
                  },
                ],
              })
              as GitStatusResult;

      expect(msg.inReplyTo, 'act_1');
      expect(msg.isRepo, isTrue);
      expect(msg.branch, 'main');
      expect(msg.repoRoot, '/repo');
      expect(msg.truncated, isTrue);
      expect(msg.files, hasLength(3));
      expect(msg.files[0].status, GitFileStatus.renamed);
      expect(msg.files[0].oldPath, 'lib/old.dart');
      expect(msg.files[0].additions, 12);
      expect(msg.files[0].deletions, 4);
      expect(msg.files[1].status, GitFileStatus.untracked);
      expect(msg.files[1].binary, isTrue);
      // Forward-compat fallback
      expect(msg.files[2].status, GitFileStatus.modified);
    });

    test('git_diff_result parses diff payload and flags', () {
      final msg =
          ServerMessage.fromJson({
                'type': 'git_diff_result',
                'in_reply_to': 'act_2',
                'path': 'lib/a.dart',
                'staged': true,
                'diff': '@@ -1 +1 @@\n-a\n+b\n',
                'binary': false,
                'truncated': true,
                'additions': 1,
                'deletions': 1,
              })
              as GitDiffResult;

      expect(msg.inReplyTo, 'act_2');
      expect(msg.path, 'lib/a.dart');
      expect(msg.staged, isTrue);
      expect(msg.diff, contains('+b'));
      expect(msg.binary, isFalse);
      expect(msg.truncated, isTrue);
      expect(msg.additions, 1);
      expect(msg.deletions, 1);
    });
  });
}

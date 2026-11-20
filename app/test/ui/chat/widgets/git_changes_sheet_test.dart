import 'package:app/data/actions/actions_repository.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/widgets/git_changes_sheet.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeGitActions implements IActionsRepository {
  final List<({String path, bool staged})> diffCalls = [];
  int statusCalls = 0;

  Future<GitStatusResult> Function()? onStatus;
  Future<GitDiffResult> Function(String path, bool staged)? onDiff;

  @override
  Future<GitStatusResult> gitStatus() {
    statusCalls++;
    final fn = onStatus;
    if (fn != null) return fn();
    return Future.value(
      const GitStatusResult(
        inReplyTo: 'g1',
        isRepo: true,
        branch: 'main',
        files: [],
      ),
    );
  }

  @override
  Future<GitDiffResult> gitDiff(String path, {bool staged = false}) {
    diffCalls.add((path: path, staged: staged));
    final fn = onDiff;
    if (fn != null) return fn(path, staged);
    return Future.value(
      GitDiffResult(inReplyTo: 'g2', path: path, staged: staged, diff: ''),
    );
  }

  @override
  void dispose() {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> _pumpSheet(WidgetTester tester, _FakeGitActions repo) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildDarkTheme(),
      home: Scaffold(
        body: SizedBox(
          height: 700,
          child: GitChangesSheetBody(repo: repo),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders changed files, opens unified diff, and toggles staged/unstaged', (
    tester,
  ) async {
    final repo = _FakeGitActions()
      ..onStatus = (() async => const GitStatusResult(
        inReplyTo: 's1',
        isRepo: true,
        branch: 'feat/diff',
        files: [
          WireGitFileChange(
            path: 'lib/src/app.dart',
            status: GitFileStatus.modified,
            staged: true,
            unstaged: true,
            additions: 5,
            deletions: 2,
          ),
          WireGitFileChange(
            path: 'README.md',
            status: GitFileStatus.untracked,
            staged: false,
            unstaged: true,
            additions: 3,
            deletions: 0,
          ),
        ],
      ))
      ..onDiff = ((path, staged) async => GitDiffResult(
        inReplyTo: 'd1',
        path: path,
        staged: staged,
        diff: staged
            ? '--- a/$path\n+++ b/$path\n@@ -1 +1 @@\n-old\n+staged line\n'
            : '--- a/$path\n+++ b/$path\n@@ -1 +1 @@\n-old\n+unstaged line\n',
        additions: 1,
        deletions: 1,
      ));

    await _pumpSheet(tester, repo);

    expect(find.text('Changes'), findsOneWidget);
    expect(find.text('feat/diff'), findsOneWidget);
    expect(find.text('app.dart'), findsOneWidget);
    expect(find.text('lib/src'), findsOneWidget);
    expect(find.text('README.md'), findsOneWidget);
    expect(find.text('staged'), findsOneWidget);

    await tester.tap(find.byKey(const Key('git-file-lib/src/app.dart')));
    await tester.pumpAndSettle();

    expect(repo.diffCalls.single, (path: 'lib/src/app.dart', staged: false));
    expect(find.text('+unstaged line'), findsOneWidget);

    await tester.tap(find.byKey(const Key('git-toggle-staged')));
    await tester.pumpAndSettle();

    expect(repo.diffCalls.last, (path: 'lib/src/app.dart', staged: true));
    expect(find.text('+staged line'), findsOneWidget);

    String? copiedText;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copiedText = (call.arguments as Map)['text'] as String?;
        }
        return null;
      },
    );
    await tester.tap(find.byKey(const Key('git-copy-diff')));
    await tester.pumpAndSettle();
    expect(copiedText, contains('+staged line'));

    await tester.tap(find.byKey(const Key('git-back')));
    await tester.pumpAndSettle();
    expect(find.text('README.md'), findsOneWidget);
  });

  testWidgets('renders clean working tree state', (tester) async {
    final cleanRepo = _FakeGitActions()
      ..onStatus = (() async => const GitStatusResult(
        inReplyTo: 's1',
        isRepo: true,
        branch: 'main',
        files: [],
      ));
    await _pumpSheet(tester, cleanRepo);
    expect(find.text('Working tree clean'), findsOneWidget);
  });

  testWidgets('renders non-repo state', (tester) async {
    final nonRepo = _FakeGitActions()
      ..onStatus = (() async => const GitStatusResult(
        inReplyTo: 's2',
        isRepo: false,
        files: [],
      ));
    await _pumpSheet(tester, nonRepo);
    expect(find.text('Not a git repository'), findsOneWidget);
  });

  testWidgets('error state retries cleanly on tap', (tester) async {
    var attempts = 0;
    final repo = _FakeGitActions()
      ..onStatus = (() async {
        attempts++;
        if (attempts == 1) {
          throw const ActionFailure('timeout');
        }
        return const GitStatusResult(
          inReplyTo: 's1',
          isRepo: true,
          branch: 'main',
          files: [],
        );
      });

    await _pumpSheet(tester, repo);
    expect(find.text('timeout'), findsOneWidget);

    await tester.tap(find.byKey(const Key('git-retry')));
    await tester.pumpAndSettle();
    expect(attempts, 2);
    expect(find.text('Working tree clean'), findsOneWidget);
  });
}

// New session sheet (plan 68): browse a PC's folders and start an omp session
// in one. Driven through a fake NewSessionRequester whose answers are
// Completers or closures the test controls; nothing waits on a real timer.

import 'dart:async';

import 'package:app/data/actions/new_session_repository.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/home/widgets/new_session_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _home = '/home/leo';
const _alpha = '/home/leo/alpha';
const _beta = '/home/leo/beta';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

WireDirEntry _entry(String path, {bool git = false}) => WireDirEntry(
  name: path.substring(path.lastIndexOf('/') + 1),
  path: path,
  isGit: git,
);

DirsListResult _listing(
  String path, {
  String? parent,
  List<WireDirEntry> dirs = const [],
  List<WireRecentDir> recent = const [],
  bool truncated = false,
  String home = _home,
}) => DirsListResult(
  inReplyTo: 'r-$path',
  path: path,
  parent: parent,
  home: home,
  dirs: dirs,
  recent: recent,
  truncated: truncated,
);

int _ago(Duration age) => DateTime.now().subtract(age).millisecondsSinceEpoch;

/// A small POSIX PC: the home folder (with two recents, one outside home),
/// two folders in it, and the way up to the root.
Map<String, DirsListResult> _world() => {
  _home: _listing(
    _home,
    parent: '/home',
    dirs: [_entry(_alpha, git: true), _entry(_beta)],
    recent: [
      WireRecentDir(
        path: _alpha,
        name: 'alpha',
        lastUsed: _ago(const Duration(hours: 2, minutes: 5)),
      ),
      const WireRecentDir(path: '/srv/www', name: 'www'),
    ],
  ),
  _alpha: _listing(_alpha, parent: _home, dirs: [_entry('$_alpha/src')]),
  '$_alpha/src': _listing('$_alpha/src', parent: _alpha),
  _beta: _listing(_beta, parent: _home),
  '/home': _listing('/home', parent: '/', dirs: [_entry(_home)]),
  '/': _listing('/', dirs: [_entry('/home'), _entry('/srv')]),
  '/srv/www': _listing('/srv/www', parent: '/srv'),
};

SpawnResult _spawned(String cwd, String? name, bool persistent) => SpawnResult(
  inReplyTo: 's1',
  cwd: cwd,
  name: name ?? 'agent',
  persistent: persistent,
  daemonId: 'd1',
);

class _FakeRequester implements NewSessionRequester {
  _FakeRequester({Map<String, DirsListResult>? world, this.home = _home})
    : world = world ?? _world();

  /// The PC's folders by path. A request without a path gets [home].
  final Map<String, DirsListResult> world;
  final String home;

  final List<String?> listCalls = [];
  final List<({String cwd, String? name, bool persistent})> spawnCalls = [];
  final List<({SpawnResult result, Duration timeout})> awaitCalls = [];

  late Future<DirsListResult> Function(String? path) onList = (path) async {
    final hit = world[path ?? home];
    if (hit == null) throw const NewSessionFailure('not_found');
    return hit;
  };
  Future<SpawnResult> Function(String cwd, String? name, bool persistent)?
  onSpawn;
  Future<RoomInfo?> Function(SpawnResult result, Duration timeout)? onAwait;

  @override
  Future<DirsListResult> listDirs({String? path}) {
    listCalls.add(path);
    return onList(path);
  }

  @override
  Future<SpawnResult> spawn({
    required String cwd,
    String? name,
    bool persistent = false,
    bool resume = false,
    String? roomId,
  }) {
    spawnCalls.add((cwd: cwd, name: name, persistent: persistent));
    final handler = onSpawn;
    if (handler != null) return handler(cwd, name, persistent);
    return Future.value(_spawned(cwd, name, persistent));
  }

  @override
  Future<RoomInfo?> awaitRoom(
    SpawnResult result, {
    Duration timeout = const Duration(seconds: 20),
    String? expectedRoomId,
  }) {
    awaitCalls.add((result: result, timeout: timeout));
    final handler = onAwait;
    if (handler != null) return handler(result, timeout);
    return Future.value(
      RoomInfo(
        roomId: 'room-1',
        startedAt: 1,
        name: result.name,
        cwd: result.cwd,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

void _phoneSurface(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(412, 915);
  addTearDown(tester.view.reset);
}

/// Pumps the body bare, like the git sheet test. [settle] false leaves a
/// pending first listing alone: its spinner would never let pumpAndSettle end.
Future<void> _pumpBody(
  WidgetTester tester,
  _FakeRequester requester, {
  Set<String> live = const {},
  Duration awaitTimeout = const Duration(seconds: 20),
  bool settle = true,
}) async {
  _phoneSurface(tester);
  await tester.pumpWidget(
    MaterialApp(
      theme: buildDarkTheme(),
      home: Scaffold(
        body: SizedBox(
          height: 800,
          child: NewSessionSheetBody(
            pcLabel: 'Leo PC',
            requester: requester,
            liveFolders: live,
            awaitTimeout: awaitTimeout,
          ),
        ),
      ),
    ),
  );
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
  }
}

/// What the page that opened the sheet saw come back.
class _Host {
  bool resolved = false;
  NewSessionOutcome? outcome;
}

/// Opens the sheet with [showNewSessionSheet] from a button, so a started
/// session's pop (and a dismissal) can be observed.
Future<_Host> _openSheet(
  WidgetTester tester,
  _FakeRequester requester, {
  Set<String> live = const {},
  double keyboard = 0,
}) async {
  _phoneSurface(tester);
  if (keyboard > 0) {
    tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
  }
  final host = _Host();
  await tester.pumpWidget(
    MaterialApp(
      theme: buildDarkTheme(),
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(
              key: const Key('open-sheet'),
              onPressed: () async {
                host.outcome = await showNewSessionSheet(
                  context,
                  pcLabel: 'Leo PC',
                  requester: requester,
                  liveFolders: live,
                );
                host.resolved = true;
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(const Key('open-sheet')));
  await tester.pumpAndSettle();
  return host;
}

Finder _byKey(String key) => find.byKey(Key(key));
Finder _dirRow(String path) => _byKey('new-session-dir-$path');
Finder _recentRow(String path) => _byKey('new-session-recent-$path');
Finder _crumb(int index) => _byKey('new-session-crumb-$index');
Finder _within(Finder of, String text) =>
    find.descendant(of: of, matching: find.text(text));

final Finder _up = _byKey('new-session-up');
final Finder _start = _byKey('new-session-start');
final Finder _retry = _byKey('new-session-retry');
final Finder _error = _byKey('new-session-error');
final Finder _name = _byKey('new-session-name');
final Finder _persistent = _byKey('new-session-persistent');

bool _canStart(WidgetTester tester) =>
    tester.widget<FilledButton>(_start).onPressed != null;

/// The tap handler of a path crumb; null when it is not a link.
VoidCallback? _crumbTap(WidgetTester tester, int index) => tester
    .widget<InkWell>(
      find.descendant(of: _crumb(index), matching: find.byType(InkWell)),
    )
    .onTap;

/// Opens [path] from the root: ancestors first, one tap each.
Future<void> _tapDown(WidgetTester tester, List<String> paths) async {
  for (final path in paths) {
    await tester.tap(_dirRow(path));
    await tester.pumpAndSettle();
  }
}

void main() {
  group('browsing', () {
    testWidgets('opens at the home folder: spinner, then recents and folders', (
      tester,
    ) async {
      final first = Completer<DirsListResult>();
      final requester = _FakeRequester()..onList = (_) => first.future;
      await _pumpBody(tester, requester, settle: false);

      // No path asked: the PC answers with its home.
      expect(requester.listCalls, [null]);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Start session'), findsOneWidget);
      expect(_canStart(tester), isFalse);

      first.complete(requester.world[_home]!);
      await tester.pumpAndSettle();

      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('New session'), findsOneWidget);
      expect(find.text('Leo PC'), findsOneWidget);
      expect(find.text('Recent'), findsOneWidget);
      expect(find.text('Browse'), findsOneWidget);
      // A recent: name, path shortened with ~, how long ago.
      final alphaRecent = _recentRow(_alpha);
      expect(_within(alphaRecent, 'alpha'), findsOneWidget);
      expect(_within(alphaRecent, '~/alpha'), findsOneWidget);
      expect(_within(alphaRecent, '2h ago'), findsOneWidget);
      // Outside home the path stays whole; no last-used time, no label.
      final wwwRecent = _recentRow('/srv/www');
      expect(_within(wwwRecent, '/srv/www'), findsOneWidget);
      expect(
        find.descendant(of: wwwRecent, matching: find.textContaining('ago')),
        findsNothing,
      );
      // Folders, with the git badge on the repository only.
      expect(_within(_dirRow(_alpha), 'git'), findsOneWidget);
      expect(_within(_dirRow(_beta), 'git'), findsNothing);
      expect(_within(_crumb(0), '~'), findsOneWidget);
      expect(find.text('Start session in leo'), findsOneWidget);
      expect(_canStart(tester), isTrue);
    });

    testWidgets('tapping a folder asks for it and shows its listing', (
      tester,
    ) async {
      final requester = _FakeRequester();
      await _pumpBody(tester, requester);

      await tester.tap(_dirRow(_alpha));
      await tester.pumpAndSettle();

      expect(requester.listCalls, [null, _alpha]);
      expect(_dirRow('$_alpha/src'), findsOneWidget);
      expect(_dirRow(_beta), findsNothing);
      // ~ › alpha
      expect(_within(_crumb(0), '~'), findsOneWidget);
      expect(_within(_crumb(1), 'alpha'), findsOneWidget);
      expect(find.text('Start session in alpha'), findsOneWidget);
    });

    testWidgets('up opens the parent and is off at the filesystem root', (
      tester,
    ) async {
      final requester = _FakeRequester();
      await _pumpBody(tester, requester);
      expect(tester.widget<IconButton>(_up).onPressed, isNotNull);

      await tester.tap(_up);
      await tester.pumpAndSettle();
      // Above home the path starts at the root: / › home
      expect(_within(_crumb(0), '/'), findsOneWidget);
      expect(_within(_crumb(1), 'home'), findsOneWidget);

      await tester.tap(_up);
      await tester.pumpAndSettle();
      expect(requester.listCalls, [null, '/home', '/']);
      expect(tester.widget<IconButton>(_up).onPressed, isNull);
    });

    testWidgets('path segments open the folders above; the last is no link', (
      tester,
    ) async {
      final requester = _FakeRequester();
      await _pumpBody(tester, requester);
      await _tapDown(tester, [_alpha, '$_alpha/src']);
      // ~ › alpha › src
      expect(_within(_crumb(2), 'src'), findsOneWidget);
      expect(_crumbTap(tester, 2), isNull);
      expect(_crumbTap(tester, 1), isNotNull);

      await tester.tap(_crumb(1));
      await tester.pumpAndSettle();
      expect(requester.listCalls.last, _alpha);
      expect(_crumb(2), findsNothing);

      await tester.tap(_crumb(0));
      await tester.pumpAndSettle();
      expect(requester.listCalls.last, _home);
      expect(find.text('Start session in leo'), findsOneWidget);
    });

    testWidgets('tapping a recent opens that folder', (tester) async {
      final requester = _FakeRequester();
      await _pumpBody(tester, requester);

      await tester.tap(_recentRow('/srv/www'));
      await tester.pumpAndSettle();

      expect(requester.listCalls, [null, '/srv/www']);
      // Outside home: / › srv › www
      expect(_within(_crumb(0), '/'), findsOneWidget);
      expect(_within(_crumb(1), 'srv'), findsOneWidget);
      expect(_within(_crumb(2), 'www'), findsOneWidget);
      expect(find.text('Start session in www'), findsOneWidget);
    });

    testWidgets('a stale listing does not overwrite a newer one', (
      tester,
    ) async {
      final slow = Completer<DirsListResult>();
      final fast = Completer<DirsListResult>();
      final requester = _FakeRequester();
      final world = requester.world;
      requester.onList = (path) => switch (path) {
        _alpha => slow.future,
        _beta => fast.future,
        _ => Future.value(world[path ?? _home]!),
      };
      await _pumpBody(tester, requester);

      // Two quick taps: alpha is asked first, beta second.
      await tester.tap(_dirRow(_alpha));
      await tester.pump();
      await tester.tap(_dirRow(_beta));
      await tester.pump();
      expect(requester.listCalls, [null, _alpha, _beta]);

      fast.complete(world[_beta]!);
      await tester.pump();
      expect(_within(_crumb(1), 'beta'), findsOneWidget);

      // alpha answers last and must not replace beta.
      slow.complete(world[_alpha]!);
      await tester.pumpAndSettle();
      expect(_within(_crumb(1), 'beta'), findsOneWidget);
      expect(_dirRow('$_alpha/src'), findsNothing);
      expect(find.text('Start session in beta'), findsOneWidget);
    });

    testWidgets('while another folder loads the old one stays, with progress', (
      tester,
    ) async {
      final pending = Completer<DirsListResult>();
      final requester = _FakeRequester();
      final world = requester.world;
      requester.onList = (path) =>
          path == _alpha ? pending.future : Future.value(world[path ?? _home]!);
      await _pumpBody(tester, requester);
      expect(find.byType(LinearProgressIndicator), findsNothing);

      await tester.tap(_dirRow(_alpha));
      await tester.pump();

      expect(find.byType(LinearProgressIndicator), findsOneWidget);
      expect(_dirRow(_beta), findsOneWidget);
      expect(_within(_crumb(0), '~'), findsOneWidget);
      // The folder on screen is about to change: not the moment to start in it.
      expect(_canStart(tester), isFalse);

      pending.complete(world[_alpha]!);
      await tester.pumpAndSettle();
      expect(find.byType(LinearProgressIndicator), findsNothing);
      expect(_canStart(tester), isTrue);
    });

    testWidgets('a failing first listing shows the message; Retry asks again', (
      tester,
    ) async {
      final requester = _FakeRequester();
      final world = requester.world;
      var attempt = 0;
      requester.onList = (path) async {
        if (++attempt == 1) throw const NewSessionFailure('timeout');
        return world[path ?? _home]!;
      };
      await _pumpBody(tester, requester);

      expect(
        find.text(const NewSessionFailure('timeout').userMessage),
        findsOneWidget,
      );
      expect(_retry, findsOneWidget);
      expect(_canStart(tester), isFalse);
      expect(_dirRow(_alpha), findsNothing);

      await tester.tap(_retry);
      await tester.pumpAndSettle();

      expect(requester.listCalls, [null, null]);
      expect(_retry, findsNothing);
      expect(_dirRow(_alpha), findsOneWidget);
      expect(_canStart(tester), isTrue);
    });

    testWidgets('a failing navigation keeps the last good folder', (
      tester,
    ) async {
      final requester = _FakeRequester();
      final world = requester.world;
      var failing = true;
      requester.onList = (path) async {
        if (path == _alpha && failing) {
          throw const NewSessionFailure('permission_denied');
        }
        return world[path ?? _home]!;
      };
      await _pumpBody(tester, requester);

      await tester.tap(_dirRow(_alpha));
      await tester.pumpAndSettle();

      expect(
        find.text(const NewSessionFailure('permission_denied').userMessage),
        findsOneWidget,
      );
      expect(_retry, findsOneWidget);
      // Still in the home folder, and it can still be started.
      expect(_crumb(1), findsNothing);
      expect(_dirRow(_beta), findsOneWidget);
      expect(find.text('Start session in leo'), findsOneWidget);
      expect(_canStart(tester), isTrue);

      failing = false;
      await tester.tap(_retry);
      await tester.pumpAndSettle();

      expect(requester.listCalls, [null, _alpha, _alpha]);
      expect(_retry, findsNothing);
      expect(_within(_crumb(1), 'alpha'), findsOneWidget);
      expect(find.text('Start session in alpha'), findsOneWidget);
    });

    testWidgets('an empty folder and a truncated listing say so', (
      tester,
    ) async {
      final requester = _FakeRequester();
      requester.world[_alpha] = _listing(
        _alpha,
        parent: _home,
        dirs: [_entry('$_alpha/a'), _entry('$_alpha/b')],
        truncated: true,
      );
      await _pumpBody(tester, requester);
      expect(find.text('No subfolders'), findsNothing);
      expect(find.textContaining('Showing the first'), findsNothing);

      await tester.tap(_dirRow(_beta));
      await tester.pumpAndSettle();
      expect(find.text('No subfolders'), findsOneWidget);

      await tester.tap(_crumb(0));
      await tester.pumpAndSettle();
      await tester.tap(_dirRow(_alpha));
      await tester.pumpAndSettle();
      expect(find.text('Showing the first 2 folders'), findsOneWidget);
      expect(find.text('No subfolders'), findsNothing);
    });

    testWidgets('recents come from the first listing, and only a non-empty '
        'one replaces them', (tester) async {
      final requester = _FakeRequester();
      requester.world[_alpha] = _listing(
        _alpha,
        parent: _home,
        recent: const [WireRecentDir(path: '/tmp/gamma', name: 'gamma')],
      );
      await _pumpBody(tester, requester);
      expect(_recentRow('/srv/www'), findsOneWidget);

      // beta's listing carries no recents: the earlier ones stay.
      await tester.tap(_dirRow(_beta));
      await tester.pumpAndSettle();
      expect(_recentRow(_alpha), findsOneWidget);
      expect(_recentRow('/srv/www'), findsOneWidget);

      // alpha's listing carries a new list: it replaces them.
      await tester.tap(_crumb(0));
      await tester.pumpAndSettle();
      await tester.tap(_dirRow(_alpha));
      await tester.pumpAndSettle();
      expect(_recentRow('/tmp/gamma'), findsOneWidget);
      expect(_recentRow('/srv/www'), findsNothing);
    });

    testWidgets('a long Recent list shows a few rows and "Show all"', (
      tester,
    ) async {
      final requester = _FakeRequester();
      requester.world[_home] = _listing(
        _home,
        parent: '/home',
        dirs: [_entry(_alpha), _entry(_beta)],
        recent: [
          for (var i = 0; i < 5; i++)
            WireRecentDir(path: '/r/p$i', name: 'p$i'),
        ],
      );
      await _pumpBody(tester, requester);

      final toggle = _byKey('new-session-recent-toggle');
      expect(_recentRow('/r/p2'), findsOneWidget);
      expect(_recentRow('/r/p3'), findsNothing);
      expect(find.text('Show all 5'), findsOneWidget);

      await tester.tap(toggle);
      await tester.pump();
      expect(_recentRow('/r/p3'), findsOneWidget);
      expect(_recentRow('/r/p4'), findsOneWidget);
      expect(find.text('Show fewer'), findsOneWidget);

      await tester.tap(toggle);
      await tester.pump();
      expect(_recentRow('/r/p3'), findsNothing);
    });

    testWidgets('recent rows say how long ago, and are bare when unknown', (
      tester,
    ) async {
      final requester = _FakeRequester();
      requester.world[_home] = _listing(
        _home,
        parent: '/home',
        recent: [
          WireRecentDir(
            path: '/r/now',
            name: 'now',
            lastUsed: _ago(const Duration(seconds: 10)),
          ),
          WireRecentDir(
            path: '/r/min',
            name: 'min',
            lastUsed: _ago(const Duration(minutes: 5, seconds: 30)),
          ),
          WireRecentDir(
            path: '/r/hours',
            name: 'hours',
            lastUsed: _ago(const Duration(hours: 2, minutes: 5)),
          ),
          WireRecentDir(
            path: '/r/days',
            name: 'days',
            lastUsed: _ago(const Duration(days: 3, hours: 1)),
          ),
          WireRecentDir(
            path: '/r/old',
            name: 'old',
            lastUsed: _ago(const Duration(days: 45)),
          ),
          const WireRecentDir(path: '/r/never', name: 'never'),
        ],
      );
      await _pumpBody(tester, requester);
      await tester.tap(_byKey('new-session-recent-toggle'));
      await tester.pump();

      expect(_within(_recentRow('/r/now'), 'just now'), findsOneWidget);
      expect(_within(_recentRow('/r/min'), '5m ago'), findsOneWidget);
      expect(_within(_recentRow('/r/hours'), '2h ago'), findsOneWidget);
      expect(_within(_recentRow('/r/days'), '3d ago'), findsOneWidget);
      // A month and more: the date.
      expect(
        find.descendant(
          of: _recentRow('/r/old'),
          matching: find.byWidgetPredicate(
            (w) =>
                w is Text &&
                RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(w.data ?? ''),
          ),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: _recentRow('/r/never'),
          matching: find.textContaining('ago'),
        ),
        findsNothing,
      );
    });

    testWidgets('a recent in a folder that already runs a session is marked', (
      tester,
    ) async {
      // A trailing separator on the live path makes no difference.
      await _pumpBody(tester, _FakeRequester(), live: {'$_alpha/'});

      expect(_within(_recentRow(_alpha), 'running'), findsOneWidget);
      expect(_within(_recentRow('/srv/www'), 'running'), findsNothing);
    });

    testWidgets('works with the paths of a Windows PC', (tester) async {
      const home = r'C:\Users\leo';
      final requester = _FakeRequester(
        home: home,
        world: {
          home: _listing(
            home,
            parent: r'C:\Users',
            home: home,
            dirs: const [WireDirEntry(name: 'app', path: r'C:\Users\leo\app')],
            recent: const [
              WireRecentDir(path: r'C:\Users\leo\app', name: 'app'),
              WireRecentDir(path: r'C:\Work\site', name: 'site'),
            ],
          ),
          r'C:\Work\site': _listing(
            r'C:\Work\site',
            parent: r'C:\Work',
            home: home,
          ),
          r'C:\Work': _listing(r'C:\Work', parent: r'C:\', home: home),
          r'C:\': _listing(r'C:\', home: home),
        },
      );
      await _pumpBody(tester, requester);

      // ~\app inside the home folder, the whole path outside it.
      expect(_within(_recentRow(r'C:\Users\leo\app'), r'~\app'), findsOneWidget);
      expect(
        _within(_recentRow(r'C:\Work\site'), r'C:\Work\site'),
        findsOneWidget,
      );

      await tester.tap(_recentRow(r'C:\Work\site'));
      await tester.pumpAndSettle();
      // C: › Work › site
      expect(_within(_crumb(0), 'C:'), findsOneWidget);
      expect(_within(_crumb(1), 'Work'), findsOneWidget);
      expect(_within(_crumb(2), 'site'), findsOneWidget);
      expect(find.text('Start session in site'), findsOneWidget);

      await tester.tap(_crumb(1));
      await tester.pumpAndSettle();
      expect(requester.listCalls.last, r'C:\Work');

      await tester.tap(_crumb(0));
      await tester.pumpAndSettle();
      expect(requester.listCalls.last, r'C:\');
    });

    testWidgets('a deep path keeps the current folder in view; a short one '
        'starts at the left', (tester) async {
      const deep = '/data/projects/clients/acme/services/billing/backend/src';
      final requester = _FakeRequester();
      requester.world[_home] = _listing(
        _home,
        parent: '/home',
        dirs: [_entry(deep)],
      );
      requester.world[deep] = _listing(deep, parent: '/data/projects');
      await _pumpBody(tester, requester);
      Rect bar() => tester.getRect(
        find.ancestor(
          of: _crumb(0),
          matching: find.byType(SingleChildScrollView),
        ),
      );

      // ~ alone sits at the start of the bar.
      expect(tester.getRect(_crumb(0)).left, closeTo(bar().left, 1));

      await tester.tap(_dirRow(deep));
      await tester.pumpAndSettle();

      // / › data › … › src is wider than the bar: the end of it shows.
      expect(_within(_crumb(8), 'src'), findsOneWidget);
      expect(tester.getRect(_crumb(8)).right, closeTo(bar().right, 1));
      expect(tester.getRect(_crumb(8)).left, greaterThanOrEqualTo(bar().left));
      expect(tester.getRect(_crumb(0)).right, lessThan(bar().left));
    });

    testWidgets('moving on from a long list scrolled far down shows the new '
        'listing from its start', (tester) async {
      final requester = _FakeRequester();
      List<WireDirEntry> many(String parent) => [
        for (var i = 0; i < 40; i++) _entry('$parent/d$i'),
      ];
      requester.world[_home] = _listing(
        _home,
        parent: '/home',
        dirs: many(_home),
      );
      requester.world['$_home/d39'] = _listing(
        '$_home/d39',
        parent: _home,
        dirs: many('$_home/d39'),
      );
      await _pumpBody(tester, requester);
      final list = tester.getRect(find.byType(CustomScrollView));

      // Down to the bottom of the home listing: its path header is far above
      // (offstage for finders, but still mounted).
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -4000));
      await tester.pumpAndSettle();
      final firstCrumb = find.byKey(
        const Key('new-session-crumb-0'),
        skipOffstage: false,
      );
      expect(tester.getRect(firstCrumb).bottom, lessThan(list.top));
      await tester.tap(_dirRow('$_home/d39'));
      await tester.pumpAndSettle();

      // The new listing is as long, yet its path header is back in view.
      final header = tester.getRect(_crumb(1));
      expect(header.top, greaterThanOrEqualTo(list.top));
      expect(header.bottom, lessThanOrEqualTo(list.bottom));
    });

    testWidgets('a recent jumps to its listing; a step leaves the list be', (
      tester,
    ) async {
      final requester = _FakeRequester();
      List<WireDirEntry> many(String parent) => [
        for (var i = 0; i < 40; i++) _entry('$parent/d$i'),
      ];
      requester.world[_alpha] = _listing(
        _alpha,
        parent: _home,
        dirs: many(_alpha),
      );
      requester.world['/srv/www'] = _listing(
        '/srv/www',
        parent: '/srv',
        dirs: many('/srv/www'),
      );
      await _pumpBody(tester, requester);
      final list = tester.getRect(find.byType(CustomScrollView));
      double browseOffset() => tester.getRect(find.text('Browse')).top - list.top;
      // The browser starts below the Recent rows.
      final below = browseOffset();
      expect(below, greaterThan(100));

      // A step into a folder from the unscrolled list does not move it.
      await tester.tap(_dirRow(_alpha));
      await tester.pumpAndSettle();
      expect(browseOffset(), below);

      // A recent is a jump: its folder's path header goes to the top.
      await tester.tap(_recentRow('/srv/www'));
      await tester.pumpAndSettle();
      expect(browseOffset(), lessThan(30));
    });
  });

  group('starting', () {
    testWidgets('spawns in the folder on screen with the trimmed name and the '
        'always-on flag', (tester) async {
      final requester = _FakeRequester();
      final host = await _openSheet(tester, requester);
      await tester.tap(_dirRow(_alpha));
      await tester.pumpAndSettle();

      await tester.enterText(_name, '  review bot  ');
      expect(tester.widget<Switch>(_persistent).value, isFalse);
      await tester.tap(_persistent);
      await tester.pump();
      expect(tester.widget<Switch>(_persistent).value, isTrue);
      await tester.tap(_start);
      await tester.pumpAndSettle();

      expect(requester.spawnCalls.single, (
        cwd: _alpha,
        name: 'review bot',
        persistent: true,
      ));
      expect(host.resolved, isTrue);
    });

    testWidgets('a blank name goes as null and the session is not always on', (
      tester,
    ) async {
      final requester = _FakeRequester();
      await _openSheet(tester, requester);

      await tester.enterText(_name, '   ');
      await tester.tap(_start);
      await tester.pumpAndSettle();

      expect(requester.spawnCalls.single, (
        cwd: _home,
        name: null,
        persistent: false,
      ));
    });

    testWidgets('shows Starting… then Waiting…, then closes with the room', (
      tester,
    ) async {
      final spawned = Completer<SpawnResult>();
      final online = Completer<RoomInfo?>();
      final requester = _FakeRequester()
        ..onSpawn = ((_, _, _) => spawned.future)
        ..onAwait = ((_, _) => online.future);
      final host = await _openSheet(tester, requester);
      expect(find.text('Start session in leo'), findsOneWidget);

      await tester.tap(_start);
      await tester.pump();
      expect(find.text('Starting…'), findsOneWidget);
      expect(find.text('Start session in leo'), findsNothing);
      expect(_canStart(tester), isFalse);
      expect(requester.awaitCalls, isEmpty);

      const result = SpawnResult(
        inReplyTo: 's1',
        cwd: _home,
        name: 'leo',
        daemonId: 'd1',
      );
      spawned.complete(result);
      await tester.pump();
      expect(find.text('Starting…'), findsNothing);
      expect(
        find.text('Waiting for the session to come online…'),
        findsOneWidget,
      );
      expect(requester.awaitCalls.single.result, result);
      expect(requester.awaitCalls.single.timeout, const Duration(seconds: 20));
      expect(host.resolved, isFalse);

      online.complete(
        const RoomInfo(roomId: 'room-9', startedAt: 1, name: 'leo', cwd: _home),
      );
      await tester.pumpAndSettle();

      expect(host.resolved, isTrue);
      expect(host.outcome!.spawn, result);
      expect(host.outcome!.room!.roomId, 'room-9');
      expect(find.byType(NewSessionSheetBody), findsNothing);
    });

    testWidgets('closes with room null when the session never appears', (
      tester,
    ) async {
      final requester = _FakeRequester()..onAwait = ((_, _) async => null);
      final host = await _openSheet(tester, requester);

      await tester.tap(_start);
      await tester.pumpAndSettle();

      expect(host.resolved, isTrue);
      expect(host.outcome, isNotNull);
      expect(host.outcome!.spawn.cwd, _home);
      expect(host.outcome!.room, isNull);
    });

    testWidgets('a wait that fails still closes: the session was started', (
      tester,
    ) async {
      final requester = _FakeRequester()
        ..onAwait = ((_, _) async => throw const NewSessionFailure('offline'));
      final host = await _openSheet(tester, requester);

      await tester.tap(_start);
      await tester.pumpAndSettle();

      expect(host.resolved, isTrue);
      expect(host.outcome!.room, isNull);
      expect(requester.spawnCalls, hasLength(1));
    });

    testWidgets('hands its wait timeout to awaitRoom', (tester) async {
      final requester = _FakeRequester()
        ..onAwait = ((_, _) => Completer<RoomInfo?>().future);
      await _pumpBody(
        tester,
        requester,
        awaitTimeout: const Duration(seconds: 7),
      );

      await tester.tap(_start);
      await tester.pump();

      expect(requester.awaitCalls.single.timeout, const Duration(seconds: 7));
    });

    testWidgets('the rest of the sheet is inert while the start is in flight', (
      tester,
    ) async {
      final requester = _FakeRequester()
        ..onSpawn = ((_, _, _) => Completer<SpawnResult>().future);
      await _pumpBody(tester, requester);

      await tester.tap(_start);
      await tester.pump();

      await tester.tap(_dirRow(_alpha));
      await tester.tap(_recentRow('/srv/www'));
      await tester.tap(_up);
      await tester.pump();
      expect(requester.listCalls, [null]);
      expect(tester.widget<IconButton>(_up).onPressed, isNull);
      expect(tester.widget<TextField>(_name).enabled, isFalse);
      expect(tester.widget<Switch>(_persistent).onChanged, isNull);
      expect(find.byKey(const Key('new-session-close')), findsOneWidget);
    });

    testWidgets('a failed navigation\'s Retry is inert while a start is in '
        'flight', (tester) async {
      final requester = _FakeRequester()
        ..onSpawn = ((_, _, _) => Completer<SpawnResult>().future);
      final world = requester.world;
      requester.onList = (path) async {
        if (path == _alpha) throw const NewSessionFailure('not_found');
        return world[path ?? _home]!;
      };
      await _pumpBody(tester, requester);
      await tester.tap(_dirRow(_alpha));
      await tester.pumpAndSettle();
      expect(_retry, findsOneWidget);
      expect(tester.widget<TextButton>(_retry).onPressed, isNotNull);

      await tester.tap(_start);
      await tester.pump();

      expect(tester.widget<TextButton>(_retry).onPressed, isNull);
      await tester.tap(_retry, warnIfMissed: false);
      await tester.pump();
      expect(requester.listCalls, [null, _alpha]);
    });

    testWidgets('dismissing the sheet mid-start does nothing further', (
      tester,
    ) async {
      final spawned = Completer<SpawnResult>();
      final requester = _FakeRequester()
        ..onSpawn = ((_, _, _) => spawned.future);
      final host = await _openSheet(tester, requester);

      await tester.tap(_start);
      await tester.pump();
      await tester.tap(_byKey('new-session-close'));
      await tester.pumpAndSettle();
      expect(host.resolved, isTrue);
      expect(host.outcome, isNull);

      spawned.complete(_spawned(_home, null, false));
      await tester.pumpAndSettle();

      expect(requester.awaitCalls, isEmpty);
      expect(host.outcome, isNull);
    });

    testWidgets('the close button dismisses with null', (tester) async {
      final host = await _openSheet(tester, _FakeRequester());

      await tester.tap(_byKey('new-session-close'));
      await tester.pumpAndSettle();

      expect(host.resolved, isTrue);
      expect(host.outcome, isNull);
      expect(find.byType(NewSessionSheetBody), findsNothing);
    });
  });

  group('errors and limits', () {
    for (final code in ['cwd_busy', 'supervisor_offline', 'timeout']) {
      testWidgets('a "$code" failure shows its message inline and re-enables '
          'Start', (tester) async {
        final failure = NewSessionFailure(code);
        final requester = _FakeRequester()
          ..onSpawn = ((_, _, _) async => throw failure);
        await _pumpBody(tester, requester);

        await tester.tap(_start);
        await tester.pumpAndSettle();

        expect(
          find.descendant(
            of: _error,
            matching: find.text(failure.userMessage),
          ),
          findsOneWidget,
        );
        expect(_canStart(tester), isTrue);
        expect(find.text('Start session in leo'), findsOneWidget);
        expect(requester.awaitCalls, isEmpty);

        // And the user can try again.
        await tester.tap(_start);
        await tester.pumpAndSettle();
        expect(requester.spawnCalls, hasLength(2));
      });
    }

    testWidgets('any other exception reads "Something went wrong."', (
      tester,
    ) async {
      final requester = _FakeRequester()
        ..onSpawn = ((_, _, _) async => throw StateError('boom'));
      await _pumpBody(tester, requester);

      await tester.tap(_start);
      await tester.pumpAndSettle();

      expect(
        find.descendant(of: _error, matching: find.text('Something went wrong.')),
        findsOneWidget,
      );
      expect(_canStart(tester), isTrue);
    });

    testWidgets('a start error goes away once the user picks another folder', (
      tester,
    ) async {
      final requester = _FakeRequester()
        ..onSpawn = ((_, _, _) async => throw const NewSessionFailure('cwd_busy'));
      await _pumpBody(tester, requester);
      await tester.tap(_start);
      await tester.pumpAndSettle();
      expect(_error, findsOneWidget);

      await tester.tap(_dirRow(_beta));
      await tester.pumpAndSettle();

      expect(_error, findsNothing);
      expect(_canStart(tester), isTrue);
    });

    testWidgets('a folder that already runs a session cannot be started', (
      tester,
    ) async {
      final requester = _FakeRequester();
      await _pumpBody(tester, requester, live: {_home});

      expect(
        find.text('A session is already running in this folder.'),
        findsOneWidget,
      );
      expect(_error, findsNothing);
      expect(_canStart(tester), isFalse);
      await tester.tap(_start, warnIfMissed: false);
      await tester.pump();
      expect(requester.spawnCalls, isEmpty);

      // Another folder is fine.
      await tester.tap(_dirRow(_beta));
      await tester.pumpAndSettle();
      expect(
        find.text('A session is already running in this folder.'),
        findsNothing,
      );
      expect(_canStart(tester), isTrue);
    });

    testWidgets('the always-on switch explains both of its states', (
      tester,
    ) async {
      await _pumpBody(tester, _FakeRequester());
      const on = 'Stays running after Quit or a crash, until removed on the PC.';
      const off = 'The session ends when you quit it.';

      expect(find.text('Keep always on'), findsOneWidget);
      expect(find.text(off), findsOneWidget);
      expect(find.text(on), findsNothing);

      await tester.tap(_persistent);
      await tester.pump();
      expect(find.text(on), findsOneWidget);
      expect(find.text(off), findsNothing);

      await tester.tap(_persistent);
      await tester.pump();
      expect(find.text(off), findsOneWidget);
    });

    testWidgets('the name field hints the folder and does not take focus', (
      tester,
    ) async {
      await _pumpBody(tester, _FakeRequester());

      expect(find.text('Name (optional)'), findsOneWidget);
      expect(tester.widget<TextField>(_name).decoration!.hintText, 'leo');
      // Autofocus would raise the keyboard over the folder list.
      expect(tester.testTextInput.isVisible, isFalse);

      await tester.tap(_dirRow(_alpha));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(_name).decoration!.hintText, 'alpha');
    });

    testWidgets('the whole sheet lifts above the keyboard', (tester) async {
      final host = await _openSheet(
        tester,
        _FakeRequester(),
        keyboard: 300,
      );

      expect(find.byType(NewSessionSheetBody), findsOneWidget);
      // 915 high, 300 of it keyboard: Start must sit above that.
      expect(tester.getBottomLeft(_start).dy, lessThanOrEqualTo(915 - 300));
      expect(tester.getTopLeft(_byKey('new-session-close')).dy, greaterThan(0));
      expect(tester.testTextInput.isVisible, isFalse);
      expect(host.resolved, isFalse);
    });

    testWidgets('on a very short sheet the options scroll and Start stays '
        'reachable', (tester) async {
      final requester = _FakeRequester();
      // 915 high with 640 of it keyboard: the sheet is about 250 high, less
      // than its header and options need (about 270).
      final host = await _openSheet(tester, requester, keyboard: 640);
      // (A RenderFlex overflow would fail the test on its own.)

      await tester.ensureVisible(_start);
      await tester.pump();
      expect(tester.getBottomLeft(_start).dy, lessThanOrEqualTo(915 - 640));
      await tester.tap(_start);
      await tester.pumpAndSettle();

      expect(requester.spawnCalls.single.cwd, _home);
      expect(host.resolved, isTrue);
      expect(host.outcome, isNotNull);
    });
  });
}

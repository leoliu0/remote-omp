// Plan 68 - the quick session switcher: sessions grouped by PC, live first,
// with a status each; the current one is marked and not tappable.

import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/widgets/session_switcher_sheet.dart';
import 'package:app/ui/home/states/home_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _laptop = PeerRecord(
  remoteEpk: 'epk_L',
  sessionName: 'Laptop',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);
const _desktop = PeerRecord(
  remoteEpk: 'epk_D',
  sessionName: 'Desktop',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);
const _alpha = RoomInfo(roomId: 'alpha', startedAt: 1, cwd: '/work/alpha');
const _beta = RoomInfo(roomId: 'beta', startedAt: 1, cwd: '/work/beta');
const _gamma = RoomInfo(roomId: 'gamma', startedAt: 1, cwd: '/srv/gamma');

const _list = HomeList(
  peers: [_laptop, _desktop],
  roomsByPeer: {
    'epk_L': [_alpha, _beta],
    'epk_D': [_gamma],
  },
);

List<SwitcherGroup> _groups({
  Set<String> live = const {'beta', 'gamma'},
  Set<String> working = const {'gamma'},
}) => switcherGroups(
  _list,
  isLive: (_, room) => live.contains(room) || working.contains(room),
  isWorking: (_, room) => working.contains(room),
);

void main() {
  group('switcherGroups', () {
    test('groups by PC, live sessions before offline ones', () {
      final groups = _groups();
      expect(groups.map((g) => g.peer.sessionName), ['Desktop', 'Laptop']);
      expect(groups[0].entries.single.status, SwitcherStatus.working);
      // alpha sorts before beta by name, but beta is live.
      expect(groups[1].entries.map((e) => e.item.room.roomId), [
        'beta',
        'alpha',
      ]);
      expect(groups[1].entries.map((e) => e.status), [
        SwitcherStatus.idle,
        SwitcherStatus.offline,
      ]);
    });

    test('a PC with nothing live goes after the PCs that have live sessions', () {
      final groups = _groups(live: {'beta'}, working: {});
      expect(groups.map((g) => g.peer.sessionName), ['Laptop', 'Desktop']);
    });
  });

  testWidgets('lists sessions with a status, marks the current one and switches on tap', (
    tester,
  ) async {
    final picked = <HomeItem>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SessionSwitcherSheet(
            groups: _groups(),
            currentEpk: 'epk_L',
            currentRoomId: 'beta',
            onSelect: picked.add,
          ),
        ),
      ),
    );

    expect(find.text('DESKTOP'), findsOneWidget);
    expect(find.text('LAPTOP'), findsOneWidget);
    expect(find.text('working'), findsOneWidget);
    expect(find.text('idle'), findsOneWidget);
    expect(find.text('offline'), findsOneWidget);
    expect(find.byKey(const Key('switcher_current')), findsOneWidget);

    // The current session is not tappable.
    await tester.tap(find.byKey(const ValueKey('switcher_row_epk_L_beta')));
    expect(picked, isEmpty);

    // Any other one - offline ones too - hands the item back to the caller.
    await tester.tap(find.byKey(const ValueKey('switcher_row_epk_D_gamma')));
    expect(picked.single.room.roomId, 'gamma');
    await tester.tap(find.byKey(const ValueKey('switcher_row_epk_L_alpha')));
    expect(picked.last.room.roomId, 'alpha');
  });

  testWidgets('shows a spinner while Home is loading and a note when empty', (
    tester,
  ) async {
    Widget sheet(List<SwitcherGroup>? groups) => MaterialApp(
      home: Scaffold(
        body: SessionSwitcherSheet(
          groups: groups,
          currentEpk: 'epk_L',
          currentRoomId: 'beta',
          onSelect: (_) {},
        ),
      ),
    );
    await tester.pumpWidget(sheet(null));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.pumpWidget(sheet(const []));
    expect(find.text('No sessions yet'), findsOneWidget);
  });
}

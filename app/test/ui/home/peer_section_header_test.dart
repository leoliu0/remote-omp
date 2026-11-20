// PeerSectionHeader — device label only. The "via <harness>" subtitle was
// removed as redundant.

import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart' show PiHarness;
import 'package:app/ui/home/widgets/peer_section_header.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

PeerRecord _peer({
  String? nickname,
  String sessionName = 'Pi',
  PiHarness? harness,
}) =>
    PeerRecord(
      remoteEpk: 'pk1',
      sessionName: sessionName,
      relayUrl: 'ws://x',
      pairedAt: '2026-01-01T00:00:00Z',
      nickname: nickname,
      harness: harness,
    );

Future<void> _pump(
  WidgetTester tester,
  PeerRecord peer, {
  VoidCallback? onNewSession,
  bool newSessionEnabled = true,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: PeerSectionHeader(
          peer: peer,
          onNewSession: onNewSession,
          newSessionEnabled: newSessionEnabled,
        ),
      ),
    ),
  );
}

void main() {
  group('PeerSectionHeader', () {
    testWidgets('shows nickname uppercase and NO harness subtitle',
        (tester) async {
      await _pump(
        tester,
        _peer(
          nickname: 'Macbook',
          harness: const PiHarness(name: 'omp coding agent', version: '0.4.2'),
        ),
      );

      expect(find.text('MACBOOK'), findsOneWidget);
      // The redundant "via …" subtitle is gone.
      expect(find.textContaining('via '), findsNothing);
    });

    testWidgets('falls back to sessionName when no nickname is set',
        (tester) async {
      await _pump(tester, _peer(sessionName: 'remote_pi · main'));
      expect(find.text('REMOTE_PI · MAIN'), findsOneWidget);
      expect(find.textContaining('via '), findsNothing);
    });
  });

  // Plan 68 - Home's entry point for starting a session on this PC.
  group('PeerSectionHeader New session action', () {
    final action = find.byKey(const Key('home-new-session-pk1'));

    testWidgets('is absent unless Home wires it', (tester) async {
      await _pump(tester, _peer(nickname: 'Macbook'));
      expect(action, findsNothing);
      expect(find.text('MACBOOK'), findsOneWidget);
    });

    testWidgets('fires when the PC can take a request', (tester) async {
      var taps = 0;
      await _pump(
        tester,
        _peer(nickname: 'Macbook'),
        onNewSession: () => taps++,
      );
      expect(find.text('MACBOOK'), findsOneWidget);
      expect(find.text('New session'), findsOneWidget);

      await tester.tap(action);
      expect(taps, 1);
    });

    testWidgets('stays visible but disabled while the PC has no live session',
        (tester) async {
      var taps = 0;
      await _pump(
        tester,
        _peer(nickname: 'Macbook'),
        onNewSession: () => taps++,
        newSessionEnabled: false,
      );
      expect(action, findsOneWidget);
      expect(tester.widget<TextButton>(action).onPressed, isNull);

      await tester.tap(action, warnIfMissed: false);
      expect(taps, 0);
    });
  });
}

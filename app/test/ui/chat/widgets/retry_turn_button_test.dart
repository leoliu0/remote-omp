import 'dart:async';

import 'package:app/ui/chat/widgets/retry_turn_button.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _app(Widget child) =>
    MaterialApp(home: Scaffold(body: Center(child: child)));

void main() {
  final button = find.byKey(const Key('retry_turn_button'));

  testWidgets('tap runs onRetry once; further taps are ignored while in flight', (
    tester,
  ) async {
    var calls = 0;
    final reply = Completer<bool>();
    await tester.pumpWidget(
      _app(
        RetryTurnButton(
          onRetry: () {
            calls++;
            return reply.future;
          },
        ),
      ),
    );
    expect(find.text('Retry'), findsOneWidget);

    await tester.tap(button);
    await tester.pump();
    expect(calls, 1);
    expect(find.text('Retrying…'), findsOneWidget);

    await tester.tap(button, warnIfMissed: false);
    await tester.pump();
    expect(calls, 1);

    // A refusal (already reported by the caller) offers Retry again at once.
    reply.complete(false);
    await tester.pump();
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('after a scheduled retry it stays disabled, then offers Retry again', (
    tester,
  ) async {
    await tester.pumpWidget(_app(RetryTurnButton(onRetry: () async => true)));

    await tester.tap(button);
    await tester.pump();
    expect(find.text('Retrying…'), findsOneWidget);

    // The turn never showed up: Retry comes back after the grace period.
    await tester.pump(const Duration(seconds: 7));
    expect(find.text('Retry'), findsOneWidget);
  });
}

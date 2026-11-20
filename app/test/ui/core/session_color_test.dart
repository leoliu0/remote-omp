import 'package:app/ui/core/themes/session_color.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a session keeps its colour: same identity, same index', () {
    expect(
      sessionColorIndex('epk_A', 'room-1'),
      sessionColorIndex('epk_A', 'room-1'),
    );
    expect(
      sessionColor('epk_A', 'room-1'),
      sessionColor('epk_A', 'room-1'),
    );
  });

  test('the index stays in range and spreads over the palette', () {
    final seen = <int>{};
    for (var i = 0; i < 60; i++) {
      final index = sessionColorIndex('epk_A', 'room-$i');
      expect(index, inInclusiveRange(0, kSessionColorCount - 1));
      seen.add(index);
    }
    expect(seen.length, greaterThanOrEqualTo(8));
  });

  test('the PC is part of the identity', () {
    final ids = {
      for (final epk in ['epk_A', 'epk_B', 'epk_C', 'epk_D', 'epk_E'])
        sessionColorIndex(epk, 'same-folder'),
    };
    expect(ids.length, greaterThan(1));
  });

  test('lightness follows the theme, hue does not', () {
    final dark = HSLColor.fromColor(sessionColor('epk_A', 'r'));
    final light = HSLColor.fromColor(
      sessionColor('epk_A', 'r', brightness: Brightness.light),
    );
    expect(dark.hue, closeTo(light.hue, 1));
    expect(dark.lightness, greaterThan(light.lightness));
  });

  testWidgets('SessionColorBar paints the session colour', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: SessionColorBar(peerEpk: 'e', roomId: 'r')),
      ),
    );
    final box =
        tester
                .widget<Container>(
                  find.descendant(
                    of: find.byType(SessionColorBar),
                    matching: find.byType(Container),
                  ),
                )
                .decoration!
            as BoxDecoration;
    // MaterialApp's default theme is light.
    expect(box.color, sessionColor('e', 'r', brightness: Brightness.light));
  });
}

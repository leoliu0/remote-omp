// The detail branch is preloaded on phones but never shown. With a session
// selected it must not build a second, invisible chat: its view models took
// events meant for the visible chat (an upload's path went into the hidden
// composer after a switch with the session switcher).

import 'package:app/routing/adaptive.dart';
import 'package:app/routing/app_router.dart';
import 'package:app/ui/chat/chat_page.dart';
import 'package:app/ui/chat/widgets/detail_placeholder.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

void main() {
  testWidgets('a phone with a session selected builds no hidden chat', (
    tester,
  ) async {
    final selection = SessionSelection()..select('epk', 'room', 'walk');
    addTearDown(selection.dispose);

    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(size: Size(412, 915)),
        child: ChangeNotifierProvider<SessionSelection>.value(
          value: selection,
          child: const MaterialApp(home: DetailPane()),
        ),
      ),
    );

    expect(find.byType(ChatPage), findsNothing);
    expect(find.byType(DetailPlaceholder), findsOneWidget);
  });
}

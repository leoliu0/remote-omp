// Plan 68 - the attach sheet offers "File" next to Camera / Photo Library, and
// hides the photo sources when images cannot be attached.

import 'package:app/routing/adaptive.dart';
import 'package:app/ui/chat/widgets/attach_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

void main() {
  late SessionSelection selection;
  late BuildContext pageContext;

  setUp(() => selection = SessionSelection());
  tearDown(() => selection.dispose());

  Future<void> pumpPage(WidgetTester tester) => tester.pumpWidget(
    MaterialApp(
      home: ChangeNotifierProvider<SessionSelection>.value(
        value: selection,
        child: Builder(
          builder: (context) {
            pageContext = context;
            return const Scaffold(body: SizedBox());
          },
        ),
      ),
    ),
  );

  testWidgets('offers camera, photo library and file by default', (
    tester,
  ) async {
    await pumpPage(tester);
    // ignore: unawaited_futures
    showAttachSheet(pageContext);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('attach-camera')), findsOneWidget);
    expect(find.byKey(const Key('attach-gallery')), findsOneWidget);
    expect(find.byKey(const Key('attach-file')), findsOneWidget);
    expect(find.text('File'), findsOneWidget);
  });

  testWidgets('images: false leaves only File (text-only model)', (
    tester,
  ) async {
    await pumpPage(tester);
    // ignore: unawaited_futures
    showAttachSheet(pageContext, images: false);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('attach-camera')), findsNothing);
    expect(find.byKey(const Key('attach-gallery')), findsNothing);
    expect(find.byKey(const Key('attach-file')), findsOneWidget);
  });

  testWidgets('file: false leaves only the photo sources', (tester) async {
    await pumpPage(tester);
    // ignore: unawaited_futures
    showAttachSheet(pageContext, file: false);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('attach-camera')), findsOneWidget);
    expect(find.byKey(const Key('attach-gallery')), findsOneWidget);
    expect(find.byKey(const Key('attach-file')), findsNothing);
  });

  testWidgets('tapping File returns AttachSource.file', (tester) async {
    await pumpPage(tester);
    final result = showAttachSheet(pageContext);
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('attach-file')));
    await tester.pumpAndSettle();

    expect(await result, AttachSource.file);
    expect(find.byKey(const Key('attach-file')), findsNothing);
  });
}

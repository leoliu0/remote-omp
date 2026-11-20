// Plan/57 — ExtensionUiSheet behavior around submit enablement, rejection
// retry, and system back. Covers the riskiest interactive logic of the
// ask_user modal (the protocol surface is covered by
// test/protocol/extension_ui_test.dart).

import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/widgets/extension_ui_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

ExtensionUiRequest _richRequest({String id = 'tool:tc_1'}) =>
    ExtensionUiRequest(
      id: id,
      method: ExtensionUiMethod.select,
      title: 'Direction',
      options: const ['Alpha', 'Beta'],
      ask: AskEnrichmentWire(
        flowId: id,
        toolCallId: 'tc_1',
        source: 'tool',
        title: 'Direction',
        questions: const [
          AskQuestionWire(
            id: 'goal',
            label: 'Goal',
            prompt: "What's the goal?",
            type: AskQuestionWireType.single,
            required: true,
            options: [
              AskOptionWire(value: 'a', label: 'Alpha'),
              AskOptionWire(value: 'b', label: 'Beta'),
            ],
          ),
        ],
      ),
    );

ExtensionUiRequest _degradedInput() => const ExtensionUiRequest(
  id: 'flow:input',
  method: ExtensionUiMethod.input,
  title: 'Describe',
  placeholder: 'Describe the goal',
);

ExtensionUiRequest _threeQuestions({
  String id = 'tool:tc_3',
  List<bool> required = const [true, true, true],
}) =>
    ExtensionUiRequest(
      id: id,
      method: ExtensionUiMethod.select,
      title: 'Plan',
      options: const ['Alpha', 'Beta'],
      ask: AskEnrichmentWire(
        flowId: id,
        toolCallId: 'tc_3',
        source: 'tool',
        title: 'Plan',
        questions: [
          AskQuestionWire(
            id: 'q1',
            label: 'First',
            prompt: 'Pick the first?',
            type: AskQuestionWireType.single,
            required: required[0],
            options: [
              AskOptionWire(value: 'a', label: 'Alpha'),
              AskOptionWire(value: 'b', label: 'Beta'),
            ],
          ),
          AskQuestionWire(
            id: 'q2',
            label: 'Second',
            prompt: 'Pick the seconds?',
            type: AskQuestionWireType.multi,
            required: required[1],
            options: [
              AskOptionWire(value: 'x', label: 'Xray'),
              AskOptionWire(value: 'y', label: 'Yankee'),
            ],
          ),
          AskQuestionWire(
            id: 'q3',
            label: 'Third',
            prompt: 'Pick the third?',
            type: AskQuestionWireType.single,
            required: required[2],
            options: [
              AskOptionWire(value: 'c', label: 'Charlie'),
              AskOptionWire(value: 'd', label: 'Delta'),
            ],
          ),
        ],
      ),
    );

void main() {
  Future<void> pumpSheet(
    WidgetTester tester, {
    required ExtensionUiRequest request,
    String? error,
    Future<void> Function(ExtensionUiResponse)? onRespond,
  }) {
    return tester.pumpWidget(
      MaterialApp(
        home: ExtensionUiSheet(
          key: ValueKey(request.id),
          request: request,
          error: error,
          onRespond: onRespond ?? (_) async {},
        ),
      ),
    );
  }

  Finder submitButton() => find.widgetWithText(FilledButton, 'Submit');

  bool submitEnabled(WidgetTester tester) =>
      tester.widget<FilledButton>(submitButton()).onPressed != null;

  testWidgets('typing custom text alone enables Submit (rich flow)', (
    tester,
  ) async {
    await pumpSheet(tester, request: _richRequest());
    expect(submitEnabled(tester), isFalse, reason: 'nothing answered yet');

    await tester.enterText(find.byType(TextField).first, 'my own answer');
    await tester.pump();

    expect(
      submitEnabled(tester),
      isTrue,
      reason: 'custom text counts as an answer without any option selected',
    );
  });

  testWidgets('typing enables Submit on the degraded input method', (
    tester,
  ) async {
    await pumpSheet(tester, request: _degradedInput());
    expect(submitEnabled(tester), isFalse);

    await tester.enterText(find.byType(TextField), 'free text');
    await tester.pump();

    expect(submitEnabled(tester), isTrue);
  });

  testWidgets('selecting an option enables Submit and submit sends answers', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _richRequest(),
      onRespond: (r) async => sent.add(r),
    );

    await tester.tap(find.text('Beta'));
    await tester.pump();
    expect(submitEnabled(tester), isTrue);

    await tester.tap(submitButton());
    await tester.pump();

    expect(sent, hasLength(1));
    final ask = sent.single.ask!;
    expect(ask.flowId, 'tool:tc_1');
    expect(ask.isCancel, isFalse);
    expect(ask.answers['goal']!.values, ['b']);
    // Modal does NOT close optimistically: it spins until completed/error.
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets(
    'rejection stops the spinner for retry; clearing the error mid-retry '
    'does not un-spin the in-flight submit',
    (tester) async {
      final sent = <ExtensionUiResponse>[];
      Future<void> onRespond(ExtensionUiResponse r) async => sent.add(r);

      await pumpSheet(tester, request: _richRequest(), onRespond: onRespond);
      await tester.tap(find.text('Alpha'));
      await tester.pump();
      await tester.tap(submitButton());
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      // pi-ask rejected → error arrives → spinner off, message shown.
      await pumpSheet(
        tester,
        request: _richRequest(),
        error: 'Unknown option value.',
        onRespond: onRespond,
      );
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('Unknown option value.'), findsOneWidget);
      expect(submitEnabled(tester), isTrue, reason: 'retry possible');

      // Retry → viewmodel clears the error (non-null → null). The submit is
      // in flight again; the cleared error must NOT reset the spinner (that
      // would re-enable the buttons and allow a double submit).
      await tester.tap(submitButton());
      await tester.pump();
      await pumpSheet(tester, request: _richRequest(), onRespond: onRespond);
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(sent, hasLength(2));
    },
  );

  testWidgets('system back cancels the flow instead of popping the route', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _richRequest(),
      onRespond: (r) async => sent.add(r),
    );

    final popped = await tester.binding.handlePopRoute();
    await tester.pump();

    expect(popped, isTrue, reason: 'PopScope intercepted the back gesture');
    expect(sent, hasLength(1));
    expect(sent.single.cancelled, isTrue);
    expect(sent.single.ask?.isCancel, isTrue);
  });

  testWidgets('required question renders the advisory chip', (tester) async {
    await pumpSheet(tester, request: _richRequest());
    expect(find.text('required'), findsOneWidget);
  });

  testWidgets('defensive degraded notify renders its message once', (
    tester,
  ) async {
    await pumpSheet(
      tester,
      request: const ExtensionUiRequest(
        id: 'notify:1',
        method: ExtensionUiMethod.notify,
        message: 'Clarification resolved.',
      ),
    );

    expect(find.text('Clarification resolved.'), findsOneWidget);
  });

  // ── Multi-question stepper ────────────────────────────────────────────────

  Finder nextButton() => find.byKey(const ValueKey('ask-next'));
  Finder backButton() => find.byKey(const ValueKey('ask-back'));
  Finder stepLabel() => find.byKey(const ValueKey('ask-step'));
  Finder skipButton() => find.byKey(const ValueKey('ask-skip'));
  Finder discardDialog() => find.text('Discard answers?');

  bool nextEnabled(WidgetTester tester) =>
      tester.widget<FilledButton>(nextButton()).onPressed != null;

  /// Submit is either absent (not on the last page) or disabled.
  bool submittable(WidgetTester tester) {
    final f = submitButton();
    if (f.evaluate().isEmpty) return false;
    return tester.widget<FilledButton>(f).onPressed != null;
  }

  Future<void> settleAdvance(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();
  }

  testWidgets('REGRESSION: answering only question 1 of 3 cannot submit', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _threeQuestions(),
      onRespond: (r) async => sent.add(r),
    );

    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);

    expect(submittable(tester), isFalse);
    expect(sent, isEmpty);
  });

  testWidgets('multi-question ask shows one question at a time with progress', (
    tester,
  ) async {
    await pumpSheet(tester, request: _threeQuestions());

    expect(stepLabel(), findsOneWidget);
    expect(find.text('1/3'), findsOneWidget);
    expect(find.byKey(const ValueKey('ask-progress')), findsOneWidget);
    expect(find.text('Pick the first?'), findsOneWidget);
    expect(find.text('Pick the seconds?'), findsNothing);
    expect(find.text('Pick the third?'), findsNothing);
    expect(backButton(), findsNothing, reason: 'no Back on the first page');
    expect(nextButton(), findsOneWidget);
    expect(nextEnabled(tester), isFalse, reason: 'nothing answered yet');
    expect(submitButton(), findsNothing);
  });

  testWidgets('Next enables with a selection or custom text', (tester) async {
    await pumpSheet(tester, request: _threeQuestions());
    expect(nextEnabled(tester), isFalse);

    await tester.enterText(find.byType(TextField).first, 'my own');
    await tester.pump();
    expect(nextEnabled(tester), isTrue);

    await tester.tap(nextButton());
    await tester.pump();
    expect(find.text('2/3'), findsOneWidget);
    expect(find.text('Pick the seconds?'), findsOneWidget);
  });

  testWidgets('single-choice selection auto-advances after a short beat', (
    tester,
  ) async {
    await pumpSheet(tester, request: _threeQuestions());

    await tester.tap(find.text('Beta'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('1/3'), findsOneWidget, reason: 'not before the beat');

    await settleAdvance(tester);
    expect(find.text('2/3'), findsOneWidget);
    expect(find.text('Pick the seconds?'), findsOneWidget);
    expect(backButton(), findsOneWidget);
  });

  testWidgets('multi-choice never auto-advances', (tester) async {
    await pumpSheet(tester, request: _threeQuestions());
    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);
    expect(find.text('2/3'), findsOneWidget);

    await tester.tap(find.text('Xray'));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('2/3'), findsOneWidget);
    expect(nextEnabled(tester), isTrue);

    await tester.tap(nextButton());
    await tester.pump();
    expect(find.text('3/3'), findsOneWidget);
  });

  testWidgets('last question waits for Submit; Submit needs every answer', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _threeQuestions(),
      onRespond: (r) async => sent.add(r),
    );

    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);
    await tester.tap(find.text('Xray'));
    await tester.tap(find.text('Yankee'));
    await tester.pump();
    await tester.tap(nextButton());
    await tester.pump();
    expect(find.text('3/3'), findsOneWidget);
    expect(nextButton(), findsNothing, reason: 'last page shows Submit');
    expect(submittable(tester), isFalse, reason: 'q3 unanswered');

    await tester.tap(find.text('Delta'));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('3/3'), findsOneWidget, reason: 'no auto-advance on last');
    expect(submittable(tester), isTrue);

    await tester.tap(submitButton());
    await tester.pump();
    expect(sent, hasLength(1));
    final answers = sent.single.ask!.answers;
    expect(answers['q1']!.values, ['a']);
    expect(answers['q2']!.values.toSet(), {'x', 'y'});
    expect(answers['q3']!.values, ['d']);
    expect(sent.single.ask!.mode, 'submit');
  });

  testWidgets('Back keeps earlier answers and forward restores them', (
    tester,
  ) async {
    await pumpSheet(tester, request: _threeQuestions());

    await tester.tap(find.text('Beta'));
    await settleAdvance(tester);
    await tester.tap(find.text('Yankee'));
    await tester.pump();

    await tester.tap(backButton());
    await tester.pump();
    expect(find.text('1/3'), findsOneWidget);
    expect(nextEnabled(tester), isTrue, reason: 'q1 still answered');
    expect(
      find.byIcon(Icons.radio_button_checked),
      findsOneWidget,
      reason: 'Beta is still selected',
    );

    await tester.tap(nextButton());
    await tester.pump();
    expect(find.text('2/3'), findsOneWidget);
    expect(find.byIcon(Icons.check_box), findsOneWidget);
    expect(nextEnabled(tester), isTrue, reason: 'q2 still answered');
  });

  testWidgets('system back steps to the previous question; first page cancels', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _threeQuestions(),
      onRespond: (r) async => sent.add(r),
    );

    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);
    expect(find.text('2/3'), findsOneWidget);

    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pump();
    expect(find.text('1/3'), findsOneWidget);
    expect(sent, isEmpty, reason: 'went back instead of cancelling');

    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pumpAndSettle();
    expect(discardDialog(), findsOneWidget, reason: 'q1 holds an answer');
    expect(sent, isEmpty);
    await tester.tap(find.byKey(const ValueKey('ask-discard-confirm')));
    await tester.pumpAndSettle();
    expect(sent, hasLength(1));
    expect(sent.single.cancelled, isTrue);
    expect(sent.single.ask?.isCancel, isTrue);
  });

  testWidgets('close button cancels from a later page', (tester) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _threeQuestions(),
      onRespond: (r) async => sent.add(r),
    );
    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);

    await tester.tap(find.byTooltip('Cancel'));
    await tester.pumpAndSettle();
    expect(discardDialog(), findsOneWidget, reason: 'q1 holds an answer');
    await tester.tap(find.byKey(const ValueKey('ask-discard-confirm')));
    await tester.pumpAndSettle();
    expect(sent.single.ask?.isCancel, isTrue);
  });

  testWidgets('single-question ask keeps one page and requires an answer', (
    tester,
  ) async {
    await pumpSheet(tester, request: _richRequest());
    expect(stepLabel(), findsNothing);
    expect(nextButton(), findsNothing);
    expect(backButton(), findsNothing);
    expect(submitEnabled(tester), isFalse);

    await tester.tap(find.text('Alpha'));
    await tester.pump(const Duration(seconds: 1));
    expect(submitEnabled(tester), isTrue, reason: 'no auto-advance/submit');
  });

  testWidgets('degraded select still enables Submit on choice', (tester) async {
    await pumpSheet(
      tester,
      request: const ExtensionUiRequest(
        id: 'flow:select',
        method: ExtensionUiMethod.select,
        title: 'Pick',
        options: ['One', 'Two'],
      ),
    );
    expect(submitEnabled(tester), isFalse);
    await tester.tap(find.text('Two'));
    await tester.pump();
    expect(submitEnabled(tester), isTrue);
    expect(stepLabel(), findsNothing);
  });

  testWidgets('degraded confirm still shows Yes/No', (tester) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: const ExtensionUiRequest(
        id: 'flow:confirm',
        method: ExtensionUiMethod.confirm,
        title: 'Sure?',
      ),
      onRespond: (r) async => sent.add(r),
    );
    expect(find.widgetWithText(FilledButton, 'Yes'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, 'No'));
    await tester.pump();
    expect(sent.single.confirmed, isFalse);
  });

  // ── Skip, single-choice exclusivity, discard confirm ─────────────────────

  testWidgets('required questions have no Skip; non-required ones do', (
    tester,
  ) async {
    await pumpSheet(
      tester,
      request: _threeQuestions(required: const [true, false, true]),
    );
    expect(skipButton(), findsNothing);
    expect(nextEnabled(tester), isFalse);

    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);
    expect(find.text('2/3'), findsOneWidget);
    expect(skipButton(), findsOneWidget);
  });

  testWidgets('Skip advances, is recorded as unanswered, and Back shows it', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _threeQuestions(required: const [true, false, true]),
      onRespond: (r) async => sent.add(r),
    );
    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);

    await tester.tap(skipButton());
    await tester.pump();
    expect(find.text('3/3'), findsOneWidget);
    expect(submittable(tester), isFalse, reason: 'q3 is still required');

    await tester.tap(find.text('Delta'));
    await tester.pump();
    expect(submittable(tester), isTrue);
    await tester.tap(submitButton());
    await tester.pump();

    final answers = sent.single.ask!.answers;
    expect(answers.keys.toSet(), {'q1', 'q3'}, reason: 'q2 skipped');
  });

  testWidgets('Skip on the last non-required question enables Submit', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _threeQuestions(required: const [true, true, false]),
      onRespond: (r) async => sent.add(r),
    );
    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);
    await tester.tap(find.text('Xray'));
    await tester.pump();
    await tester.tap(nextButton());
    await tester.pump();
    expect(submittable(tester), isFalse);

    await tester.tap(skipButton());
    await tester.pump();
    expect(find.text('3/3'), findsOneWidget, reason: 'nowhere to advance');
    expect(submittable(tester), isTrue);

    await tester.tap(submitButton());
    await tester.pump();
    expect(sent.single.ask!.answers.keys.toSet(), {'q1', 'q2'});
  });

  testWidgets('answering a skipped question drops the skip mark', (
    tester,
  ) async {
    await pumpSheet(
      tester,
      request: _threeQuestions(required: const [true, false, true]),
    );
    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);
    await tester.tap(skipButton());
    await tester.pump();
    await tester.tap(backButton());
    await tester.pump();
    expect(find.text('2/3'), findsOneWidget);
    expect(nextEnabled(tester), isTrue, reason: 'skip still recorded');

    await tester.tap(find.text('Xray'));
    await tester.pump();
    expect(skipButton(), findsNothing, reason: 'answered, nothing to skip');
    expect(nextEnabled(tester), isTrue);
  });

  testWidgets('single-choice: tapping an option clears custom text', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _richRequest(),
      onRespond: (r) async => sent.add(r),
    );
    await tester.enterText(find.byType(TextField).first, 'my own');
    await tester.pump();
    await tester.tap(find.text('Beta'));
    await tester.pump();

    expect(
      tester.widget<TextField>(find.byType(TextField).first).controller!.text,
      isEmpty,
    );
    await tester.tap(submitButton());
    await tester.pump();
    final a = sent.single.ask!.answers['goal']!;
    expect(a.values, ['b']);
    expect(a.customText, isNull);
  });

  testWidgets('single-choice: typing custom text clears the selection', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _richRequest(),
      onRespond: (r) async => sent.add(r),
    );
    await tester.tap(find.text('Beta'));
    await tester.pump();
    expect(find.byIcon(Icons.radio_button_checked), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'my own');
    await tester.pump();
    expect(find.byIcon(Icons.radio_button_checked), findsNothing);

    await tester.tap(submitButton());
    await tester.pump();
    final a = sent.single.ask!.answers['goal']!;
    expect(a.values, isEmpty);
    expect(a.customText, 'my own');
  });

  testWidgets('multi-choice keeps selection and custom text together', (
    tester,
  ) async {
    await pumpSheet(tester, request: _threeQuestions());
    await tester.tap(find.text('Alpha'));
    await settleAdvance(tester);
    await tester.tap(find.text('Xray'));
    await tester.pump();
    await tester.enterText(find.byType(TextField).first, 'extra');
    await tester.pump();
    expect(find.byIcon(Icons.check_box), findsOneWidget);
    await tester.tap(find.text('Yankee'));
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField).first).controller!.text,
      'extra',
    );
  });

  testWidgets('close with an answer asks to discard; Cancel keeps going', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _richRequest(),
      onRespond: (r) async => sent.add(r),
    );
    await tester.tap(find.text('Alpha'));
    await tester.pump();

    await tester.tap(find.byTooltip('Cancel'));
    await tester.pumpAndSettle();
    expect(discardDialog(), findsOneWidget);
    expect(sent, isEmpty);

    await tester.tap(find.byKey(const ValueKey('ask-discard-cancel')));
    await tester.pumpAndSettle();
    expect(discardDialog(), findsNothing);
    expect(sent, isEmpty);
    expect(submitEnabled(tester), isTrue, reason: 'answer kept');
  });

  testWidgets('Discard cancels the flow (close button and system back)', (
    tester,
  ) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _richRequest(),
      onRespond: (r) async => sent.add(r),
    );
    await tester.enterText(find.byType(TextField).first, 'typed');
    await tester.pump();

    expect(await tester.binding.handlePopRoute(), isTrue);
    await tester.pumpAndSettle();
    expect(discardDialog(), findsOneWidget);
    expect(sent, isEmpty);

    await tester.tap(find.byKey(const ValueKey('ask-discard-confirm')));
    await tester.pumpAndSettle();
    expect(sent, hasLength(1));
    expect(sent.single.cancelled, isTrue);
    expect(sent.single.ask?.isCancel, isTrue);
  });

  testWidgets('close with no answers cancels immediately', (tester) async {
    final sent = <ExtensionUiResponse>[];
    await pumpSheet(
      tester,
      request: _threeQuestions(),
      onRespond: (r) async => sent.add(r),
    );
    await tester.tap(find.byTooltip('Cancel'));
    await tester.pump();
    expect(discardDialog(), findsNothing);
    expect(sent.single.ask?.isCancel, isTrue);
  });
}

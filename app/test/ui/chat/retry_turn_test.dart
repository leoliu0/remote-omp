// Plan 68 - which transcript item gets the Retry button, and what a refused
// retry tells the user.

import 'package:app/domain/session_state.dart';
import 'package:app/ui/chat/viewmodels/chat_viewmodel.dart';
import 'package:flutter_test/flutter_test.dart';

const _failed = AssistantMsg(
  id: 'err_3',
  text: '⚠ provider_error: overloaded',
  errorCode: kProviderErrorCode,
);

void main() {
  group('retryTargetId', () {
    test('offers Retry under a trailing failed turn when it can act', () {
      final messages = <ChatMessage>[
        const UserMsg(id: 'u1', text: 'hi'),
        _failed,
      ];
      expect(retryTargetId(messages, canRetry: true), 'err_3');
    });

    test('never while the agent is busy or the PC is unreachable', () {
      expect(retryTargetId([_failed], canRetry: false), isNull);
    });

    test('only the newest item: anything after the failure removes it', () {
      expect(
        retryTargetId([
          _failed,
          const UserMsg(id: 'u2', text: 'again'),
        ], canRetry: true),
        isNull,
      );
      expect(
        retryTargetId([
          _failed,
          const AssistantMsg(id: 'a1', text: 'done'),
        ], canRetry: true),
        isNull,
      );
    });

    test('other error rows and plain answers are not failed turns', () {
      expect(
        retryTargetId([
          const AssistantMsg(
            id: 'err_4',
            text: '⚠ internal_error: boom',
            errorCode: 'internal_error',
          ),
        ], canRetry: true),
        isNull,
      );
      expect(
        retryTargetId([
          const AssistantMsg(id: 'a1', text: 'ok'),
        ], canRetry: true),
        isNull,
      );
      expect(retryTargetId(const [], canRetry: true), isNull);
    });
  });

  group('retryFailureMessage', () {
    test('an extension too old for retry_turn (no answer) says to update it', () {
      expect(retryFailureMessage('timeout'), contains('Update Remote OMP'));
    });

    test('a lost connection is reported as such', () {
      for (final reason in ['offline', 'disconnected', 'disposed']) {
        expect(retryFailureMessage(reason), 'Not connected to the PC.');
      }
    });

    test("the extension's own refusal text is shown as is", () {
      expect(
        retryFailureMessage('Nothing to retry.'),
        'Nothing to retry.',
      );
    });
  });
}

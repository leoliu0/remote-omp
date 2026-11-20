// Plan 68 - wire shapes for Retry: the request, its ack, and the replayed
// failed turn the app offers Retry under.

import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('RetryTurnRequest serialises as retry_turn', () {
    expect(RetryTurnRequest(id: 'act_1').toJson(), {
      'type': 'retry_turn',
      'id': 'act_1',
    });
  });

  test('action_ok for retry_turn resolves to ActionName.retryTurn', () {
    final ok = ActionOk.fromJson({
      'type': 'action_ok',
      'in_reply_to': 'act_1',
      'action': 'retry_turn',
    });
    expect(ok.action, ActionName.retryTurn);
    expect(ok.inReplyTo, 'act_1');
  });

  test('a replayed failed turn carries its error code', () {
    final evt = SessionHistoryEvent.fromJson({
      'ts': 5,
      'type': 'agent_message',
      'in_reply_to': 'u1',
      'text': '⚠ provider_error: overloaded',
      'error_code': 'provider_error',
    });
    expect((evt as AgentMessageEvt).errorCode, 'provider_error');
  });

  test('an ordinary agent_message has no error code (older extensions too)', () {
    final evt = SessionHistoryEvent.fromJson({
      'ts': 5,
      'type': 'agent_message',
      'in_reply_to': 'u1',
      'text': 'hello',
    });
    expect((evt as AgentMessageEvt).errorCode, isNull);
  });
}

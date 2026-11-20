// Plan 68 - ActionsRepository.retryTurn correlates its request with the
// extension's reply.

import 'dart:async';

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeChannel implements IChannel, IControlLink {
  final _ctrl = StreamController<ServerMessage>.broadcast();
  final _controlCtrl = StreamController<ControlInbound>.broadcast();
  final List<ClientMessage> sent = [];

  @override
  Stream<ServerMessage> get serverMessages => _ctrl.stream;

  @override
  Stream<ControlInbound> get controlFrames => _controlCtrl.stream;

  @override
  Future<void> send(ClientMessage msg) async {
    sent.add(msg);
  }

  @override
  void sendControl(Map<String, dynamic> json) {}

  @override
  Future<void> close() async {
    await _ctrl.close();
    await _controlCtrl.close();
  }

  void push(ServerMessage m) => _ctrl.add(m);
}

class _FakeStorage extends PairingStorage {
  _FakeStorage() : super(_database);
  @override
  Future<List<PeerRecord>> listPeers() async => const [];
}

late AppDatabase _database;

Future<({ActionsRepository repo, ConnectionManager cm, _FakeChannel ch})>
_setup() async {
  final ch = _FakeChannel();
  final cm = ConnectionManager(
    factory: (_, _) async => ch,
    storage: _FakeStorage(),
    emitDebounce: Duration.zero,
  );
  final repo = ActionsRepository(cm, timeout: const Duration(seconds: 5));
  cm.adopt(
    ch,
    const PeerRecord(
      remoteEpk: 'epk_retry',
      sessionName: 'pi',
      relayUrl: 'ws://localhost',
      pairedAt: '2026-01-01T00:00:00Z',
    ),
  );
  await Future<void>.delayed(const Duration(milliseconds: 5));
  return (repo: repo, cm: cm, ch: ch);
}

void main() {
  setUpAll(() {
    _database = AppDatabase.memory();
  });
  tearDownAll(() {
    _database.dispose();
  });

  test('retryTurn() sends retry_turn and resolves on the matching action_ok', () async {
    final s = await _setup();
    final future = s.repo.retryTurn();
    await Future<void>.delayed(const Duration(milliseconds: 1));
    final sent = s.ch.sent.single as RetryTurnRequest;
    s.ch.push(
      ActionOk(
        inReplyTo: sent.id,
        action: ActionName.retryTurn,
        rawAction: 'retry_turn',
      ),
    );
    await future;
    s.cm.dispose();
  });

  test("retryTurn() fails with the extension's text when it refuses", () async {
    final s = await _setup();
    final future = s.repo.retryTurn();
    await Future<void>.delayed(const Duration(milliseconds: 1));
    final sent = s.ch.sent.single as RetryTurnRequest;
    s.ch.push(
      ErrorMessage(
        inReplyTo: sent.id,
        code: 'nothing_to_retry',
        message: 'Nothing to retry.',
      ),
    );
    await expectLater(
      future,
      throwsA(
        isA<ActionFailure>().having(
          (e) => e.message,
          'message',
          'Nothing to retry.',
        ),
      ),
    );
    s.cm.dispose();
  });
}

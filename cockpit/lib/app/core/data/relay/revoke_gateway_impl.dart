import 'dart:async';
import 'dart:convert';

import 'package:cockpit/app/core/env.dart';
import 'package:cockpit/app/core/data/relay/ephemeral_omp_rpc.dart';
import 'package:cockpit/app/core/domain/contracts/revoke_gateway.dart';
import 'package:cockpit/app/core/domain/exceptions/relay_error.dart';
import 'package:cockpit/app/core/domain/result.dart';

/// Factory de [RevokeGateway]: cada `create()` sobe um `pi --mode rpc` novo.
class RevokeGatewayFactoryImpl implements RevokeGatewayFactory {
  RevokeGatewayFactoryImpl(this._config);

  final OmpSpawnConfig _config;

  @override
  RevokeGateway create() => RevokeGatewayImpl(_config);
}

/// Implementação do [RevokeGateway] sobre uma sessão [EphemeralOmpRpc].
///
/// Comando one-shot: manda `/remote-omp revoke <shortId>` e espera o `notify` de
/// confirmação. O remote-omp não emite custom event no revoke (diferente do
/// pair) — sinaliza por `extension_ui_request`/`notify`:
/// - sucesso → `[remote-omp] Revoked: <name> …` (info)
/// - falha   → warning (`No peer matching`, `Revoke requires the relay`, …)
class RevokeGatewayImpl implements RevokeGateway {
  RevokeGatewayImpl(this._config);

  final OmpSpawnConfig _config;

  @override
  Future<Result<void, RelayError>> revoke(
    String shortId, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final rpc = EphemeralOmpRpc(_config);
    final completer = Completer<Result<void, RelayError>>();

    void finish(Result<void, RelayError> result) {
      if (!completer.isCompleted) completer.complete(result);
    }

    try {
      final command = jsonEncode(<String, dynamic>{
        'type': 'prompt',
        'message': '/remote-omp revoke $shortId',
      });
      await rpc.start(
        prompt: command,
        onLine: (json) => _onLine(json, finish),
        onExit: (code) => finish(
          Failure(
            RelayError('The process exited before confirming (code=$code).'),
          ),
        ),
      );
    } catch (error, stackTrace) {
      await rpc.dispose();
      return Failure(
        RelayError(
          'Failed to revoke: $error',
          cause: error,
          stackTrace: stackTrace,
        ),
      );
    }

    final timer = Timer(
      timeout,
      () => finish(
        const Failure(
          RelayError('Timed out revoking. Check the connection to the relay.'),
        ),
      ),
    );

    final result = await completer.future;
    timer.cancel();
    await rpc.dispose();
    return result;
  }

  void _onLine(
    Map<String, dynamic> json,
    void Function(Result<void, RelayError>) finish,
  ) {
    if (json['type'] != 'extension_ui_request' || json['method'] != 'notify') {
      return;
    }
    final message = (json['message'] as String?) ?? '';
    if (message.contains('Revoked:')) {
      finish(const Success(null));
      return;
    }
    // Warnings do remote-omp durante o revoke = falha (peer inexistente, relay
    // off, shortid ambíguo, setup pendente…).
    if (json['notifyType'] == 'warning' && message.contains('remote-omp')) {
      finish(Failure(RelayError(_clean(message))));
    }
  }

  String _clean(String message) =>
      message.replaceFirst('[remote-omp] ', '').trim();
}

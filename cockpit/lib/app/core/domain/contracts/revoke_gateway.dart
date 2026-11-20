import 'package:cockpit/app/core/domain/exceptions/relay_error.dart';
import 'package:cockpit/app/core/domain/result.dart';

/// Revoga um aparelho pareado via `omp --mode rpc` (não pelo CLI `remote-omp`).
///
/// Sobe um omp efêmero (com a extensão remote-omp) e manda
/// `/remote-omp revoke <shortId>` — que **auto-liga o relay** e remove o peer
/// (manda `bye` pro aparelho). Sucesso é detectado pelo `notify` `Revoked: …`;
/// warnings viram [RelayError]. Contrato no domínio; a impl (Process) em `data/`.
abstract class RevokeGateway {
  Future<Result<void, RelayError>> revoke(String shortId, {Duration timeout});
}

/// Cria uma [RevokeGateway] **nova por chamada** (cada revoke sobe seu próprio
/// `pi --mode rpc`). Tipo nomeado (não `RevokeGateway Function()`) para ser
/// auto-injetável via `.new` no `ConnectivityViewModel`.
abstract class RevokeGatewayFactory {
  RevokeGateway create();
}

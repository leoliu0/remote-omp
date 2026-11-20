/// Eventos de uma sessão de pareamento (`/remote-omp pair`), já tipados a partir
/// das mensagens custom do remote-omp no stream do `omp --mode rpc`.
///
/// O wire é uma mensagem `role: "custom"` (em `message_start`/`message_end`) com
/// `customType` + `details` — traduzida em `data/` para estes tipos. A `ui/`
/// nunca vê `Map<String,dynamic>` cru.
sealed class PairEvent {
  const PairEvent();
}

/// `remote-omp:pair-code` — o código de pareamento (re)gerado. A [uri] é o que
/// vira QR Code; os demais campos servem pro botão "copiar dados". Reemitido
/// periodicamente (o código se renova) — basta atualizar o QR.
final class PairCodeReady extends PairEvent {
  const PairCodeReady({
    required this.uri,
    this.token,
    this.expiresAt,
    this.roomId,
    this.name,
  });

  final String uri;
  final String? token;
  final String? expiresAt;
  final String? roomId;
  final String? name;
}

/// `remote-omp:paired` — um aparelho leu o QR e pareou. Encerra o fluxo.
final class PairDevicePaired extends PairEvent {
  const PairDevicePaired({this.name});
  final String? name;
}

/// Falha ao iniciar/conduzir o pareamento (spawn, timeout, extensão ausente…).
final class PairFailed extends PairEvent {
  const PairFailed(this.message);
  final String message;
}

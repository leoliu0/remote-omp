/// Um aparelho pareado com o relay, lido de `~/.omp/remote/peers.json`.
///
/// O Cockpit só **lista e revoga** — o pareamento em si (gerar QR) acontece do
/// lado do app/agente, não aqui (não há comando `remote-omp pair`).
class PairedDevice {
  const PairedDevice({required this.shortId, required this.label});

  /// Identificador curto usado para revogar (`remote-omp revoke <shortId>`).
  /// Pode conter caracteres base64 (`+`, `/`) — sempre passe como arg único.
  final String shortId;

  /// Rótulo legível reportado pelo relay (ex.: `iPhone`, `Android device`).
  final String label;

  @override
  bool operator ==(Object other) =>
      other is PairedDevice && other.shortId == shortId && other.label == label;

  @override
  int get hashCode => Object.hash(shortId, label);
}

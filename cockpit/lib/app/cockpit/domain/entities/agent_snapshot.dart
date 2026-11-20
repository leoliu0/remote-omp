import 'package:cockpit/app/cockpit/domain/entities/omp_model.dart';
import 'package:cockpit/app/cockpit/domain/entities/thinking_level.dart';

/// Recorte do estado do agente vivo — de `get_state`. O Cockpit usa para
/// preencher a seleção atual dos seletores (modelo + effort) ao bootar.
class AgentSnapshot {
  const AgentSnapshot({
    required this.model,
    required this.thinkingLevel,
    required this.isStreaming,
  });

  final OmpModel? model;
  final ThinkingLevel thinkingLevel;
  final bool isStreaming;
}

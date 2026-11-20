import 'package:cockpit/app/core/utils/executable_resolver.dart';

/// Configuração de como o Cockpit spawna o `omp --mode rpc`.
///
/// **Revisita a decisão B (plano 37)** — o plano precisa registrar as duas
/// mudanças abaixo (tarefa do orquestrador; o agente cockpit só edita `cockpit/`):
/// - `noSession = false`: o omp **persiste** a sessão em
///   `~/.omp/agent/sessions/<cwd>/`, e o Cockpit reanexa via `switch_session`.
/// - `noExtensions = false`: o omp **carrega as extensions** do usuário — sem
///   isso `get_commands` vem vazio (todo slash command vem de extension). A
///   malha/relay **não** inicia sozinha; só se você invocar `/remote-omp`.
///
/// Provider/model e o path do binário são resolvidos no boot e podem ser
/// sobrescritos por `--dart-define` (compile-time):
///
/// ```bash
/// flutter run -d macos \
///   --dart-define=COCKPIT_OMP_PROVIDER=deepseek \
///   --dart-define=COCKPIT_OMP_MODEL=deepseek-chat
/// ```
///
/// Sem overrides, o omp usa o provider/model padrão do `~/.omp/agent/config.yml`.
class OmpSpawnConfig {
  const OmpSpawnConfig({
    required this.executable,
    this.provider,
    this.model,
    this.noSession = false,
    this.noExtensions = false,
  });

  /// Caminho absoluto (ou nome no PATH) do binário `omp`.
  final String executable;

  /// `--provider` (vazio = usa o default do omp).
  final String? provider;

  /// `--model` (vazio = usa o default do omp).
  final String? model;

  /// `--no-session` — quando `true`, não persiste a sessão. Padrão `false`:
  /// deixamos o omp gravar a sessão pra poder restaurá-la depois.
  final bool noSession;

  /// `--no-extensions` — quando `true`, não carrega extensions. Padrão `false`:
  /// carregamos as extensions pra ter os slash commands (`get_commands`).
  final bool noExtensions;

  /// [sessionId] é o ID (basename sem `.jsonl`) da sessão a restaurar. Quando
  /// presente, o omp inicia já carregado naquela sessão — evita o ciclo extra de
  /// `switch_session` que causa re-avaliação dupla do módulo da extensão.
  List<String> spawnArgs({String? sessionId}) => <String>[
    '--mode',
    'rpc',
    if (sessionId != null) ...['--session', sessionId],
    if (noSession) '--no-session',
    if (noExtensions) '--no-extensions',
    if (provider != null && provider!.isNotEmpty) ...['--provider', provider!],
    if (model != null && model!.isNotEmpty) ...['--model', model!],
  ];

  /// Resolve a config no boot. Lê os `--dart-define` e localiza o binário.
  static Future<OmpSpawnConfig> resolve() async {
    const provider = String.fromEnvironment('COCKPIT_OMP_PROVIDER');
    const model = String.fromEnvironment('COCKPIT_OMP_MODEL');
    const pathOverride = String.fromEnvironment('COCKPIT_OMP_PATH');

    return OmpSpawnConfig(
      executable: await _resolveExecutable(pathOverride),
      provider: provider.isEmpty ? null : provider,
      model: model.isEmpty ? null : model,
    );
  }

  /// App macOS não herda o PATH do shell, então procuramos o binário em
  /// caminhos conhecidos. Override explícito vence; 'omp' (PATH) é o último recurso.
  static Future<String> _resolveExecutable(String override) async {
    if (override.isNotEmpty) return override;
    return resolveExecutable(
      'omp',
      unixCandidates: const ['/opt/homebrew/bin/omp', '/usr/local/bin/omp'],
      unixHomeRelative: const ['.bun/bin/omp', '.local/bin/omp'],
    );
  }
}

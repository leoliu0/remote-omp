/// Verifica o que está instalado no ambiente do usuário pro onboarding:
/// o binário do omp, a extensão remote-omp registrada no omp, e o supervisor
/// (serviço do SO). Contrato no domínio; a impl (Process/filesystem) em `data/`.
abstract class EnvironmentProbe {
  /// O binário `omp` está instalado/acessível?
  Future<bool> ompInstalled();

  /// A extensão `remote-omp` está instalada no omp (plugin em
  /// `~/.omp/plugins/node_modules/remote-omp`)?
  Future<bool> extensionInstalled();

  /// O supervisor (`remote-omp-supervisord`) está instalado como serviço do SO?
  Future<bool> supervisorInstalled();
}

import 'package:cockpit/app/cockpit/domain/entities/install_result.dart';

/// Executa as instalações oferecidas no onboarding: a extensão `remote-omp` no
/// omp e o supervisor (serviço do SO). Contrato no domínio; a impl (Process) em
/// `data/`. Tudo best-effort: falha de IO vira [InstallResult.failure].
abstract class EnvironmentInstaller {
  /// `omp plugin install remote-omp` — instala a extensão no omp.
  Future<InstallResult> installExtension();

  /// `node <remote-omp>/dist/index.js install` — instala o serviço do supervisor.
  /// Pré-requisito: a extensão já instalada (é de lá que vem o `index.js`).
  Future<InstallResult> installSupervisor();
}

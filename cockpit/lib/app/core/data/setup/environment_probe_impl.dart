import 'dart:io';

import 'package:cockpit/app/core/env.dart';
import 'package:cockpit/app/core/data/setup/remote_omp_resolver.dart';
import 'package:cockpit/app/core/domain/contracts/environment_probe.dart';

/// Detecta o que está instalado lendo o disco e (no máximo) rodando `omp
/// --version`. Tudo é best-effort: qualquer falha de IO vira "não instalado".
class EnvironmentProbeImpl implements EnvironmentProbe {
  EnvironmentProbeImpl(this._config);

  final OmpSpawnConfig _config;

  // Windows não seta HOME; o equivalente é USERPROFILE.
  String? get _home =>
      Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'];

  @override
  Future<bool> ompInstalled() async {
    final exe = _config.executable;
    // Caminho (não um nome solto no PATH) resolvido no boot → basta existir.
    // Detecta separador Unix (`/`) e Windows (`\`).
    if (exe.contains('/') || exe.contains(r'\')) {
      if (await File(exe).exists()) return true;
    }
    // 'omp' solto (PATH): tenta rodar. App macOS não herda o PATH do shell, então
    // isto pode falhar mesmo instalado — mas aí os caminhos-candidato do boot já
    // teriam achado. `runInShell` deixa o Windows resolver shims `.cmd`/`.bat`
    // via PATHEXT; o bun vai na PATH porque o shim do omp usa `env bun`. Best-effort.
    try {
      final result = await Process.run(
        exe,
        const ['--version'],
        runInShell: true,
        environment: await envWithNodeOnPath(),
      );
      return result.exitCode == 0;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> extensionInstalled() async {
    // `omp plugin install remote-omp` / `omp plugin link <omp-extension>`
    // materializam o pacote em `~/.omp/plugins/node_modules/remote-omp`.
    return await resolveRemoteOmpPackageRoot() != null;
  }

  @override
  Future<bool> supervisorInstalled() async {
    final home = _home;
    if (home == null) return false;
    try {
      // Sinal primário: o serviço foi instalado por `remote-omp install`.
      if (Platform.isMacOS) {
        final plist = File(
          '$home/Library/LaunchAgents/dev.remoteomp.supervisord.plist',
        );
        if (await plist.exists()) return true;
      } else if (Platform.isLinux) {
        final unit = File(
          '$home/.config/systemd/user/remote-omp-supervisord.service',
        );
        if (await unit.exists()) return true;
      } else if (Platform.isWindows) {
        // Windows: o supervisor roda como uma Scheduled Task
        // (`RemoteOmpSupervisor`) criada por `remote-omp install`. A task é a
        // fonte de verdade — sobrevive a reboot e ao uninstall do .vbs.
        // Query não precisa de elevação; só o /Create precisava.
        try {
          final task = await Process.run('schtasks', const [
            '/Query',
            '/TN',
            'RemoteOmpSupervisor',
          ], runInShell: true);
          if (task.exitCode == 0) return true;
        } catch (_) {
          // schtasks indisponível → cai pro check de arquivo abaixo.
        }
        // Secundário: o launcher VBS escrito no install (em ~/.omp/remote/).
        final vbs = File('$home/.omp/remote/RemoteOmpSupervisorLauncher.vbs');
        return vbs.exists();
      }
      // Fallback: o binário existe em algum prefixo de usuário conhecido.
      const candidates = <String>[
        '/opt/homebrew/bin/remote-omp-supervisord',
        '/usr/local/bin/remote-omp-supervisord',
      ];
      for (final candidate in candidates) {
        if (await File(candidate).exists()) return true;
      }
      final local = '$home/.local/bin/remote-omp-supervisord';
      return File(local).exists();
    } catch (_) {
      return false;
    }
  }
}

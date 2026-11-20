import 'dart:io';

import 'package:cockpit/app/core/utils/executable_resolver.dart';
import 'package:flutter/foundation.dart' show kDebugMode;

/// Helpers de resolução do `remote-omp` — compartilhados entre o instalador do
/// supervisor e o gateway de relay/pareamento.
///
/// No POSIX o `remote-omp` é um binário no PATH/prefixos conhecidos. No Windows
/// **não** está no PATH: invocamos `node <dist/index.js>` da extensão, resolvido
/// a partir do plugin instalado em `~/.omp/plugins/node_modules/remote-omp`
/// (`omp plugin install remote-omp` ou `omp plugin link <omp-extension>`).

/// `~/` do usuário: Windows não seta `HOME`, o equivalente é `USERPROFILE`.
String? remoteOmpHome() =>
    Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'];

/// Onde a **CLI interna** (`cockpit`) é materializada, e o único diretório que o
/// app prefixa no PATH das suas abas.
///
/// Namespaceado por debug/release pela mesma razão do `status.sock`: `~/.cockpit`
/// é o HOME real (não é isolado por bundle id como o Hive), então uma build de
/// dev e a instalada disputariam o mesmo arquivo — quem bootasse por último
/// sobrescreveria a CLI da outra. Como o PATH é injetado por app, cada um aponta
/// pro seu diretório e o comando continua se chamando `cockpit` nos dois.
///
/// O `cockpit-hook` **não** segue este namespace: o caminho dele vai gravado no
/// `~/.claude/settings.json` (global, um só), e apontar pra uma pasta de build de
/// dev quebraria o hook no dia em que essa build sumisse.
String? cockpitCliDir() {
  final home = remoteOmpHome();
  if (home == null) return null;
  return '$home/.cockpit/bin${kDebugMode ? '-debug' : ''}';
}

/// Diretório estável do helper de hooks, compartilhado entre builds.
String? cockpitHookDir() {
  final home = remoteOmpHome();
  if (home == null) return null;
  return '$home/.cockpit/bin';
}

/// Raiz do plugin `remote-omp` instalado no omp: `omp plugin install` e
/// `omp plugin link` materializam (cópia ou symlink) em
/// `~/.omp/plugins/node_modules/remote-omp`. `null` se não estiver instalado.
Future<String?> resolveRemoteOmpPackageRoot() async {
  final home = remoteOmpHome();
  if (home == null) return null;
  final root = '$home/.omp/plugins/node_modules/remote-omp';
  return await File('$root/package.json').exists() ? root : null;
}

/// Caminho absoluto do `dist/index.js` da extensão remote-omp (plugin do omp),
/// ou `null` se não der pra achar.
Future<String?> resolveRemoteOmpIndexJs() async {
  final root = await resolveRemoteOmpPackageRoot();
  if (root == null) return null;
  final indexJs = File('$root/dist/index.js');
  return await indexJs.exists() ? indexJs.path : null;
}

/// Resolve o `node` em caminhos conhecidos (mesma estratégia do `omp`).
/// Cacheado por processo: a resolução via `which` num shell de login pode
/// levar segundos (carrega o `.zshrc`) e o resultado é estável.
Future<String> resolveNode() => _cachedNode ??= resolveExecutable(
  'node',
  unixCandidates: const ['/opt/homebrew/bin/node', '/usr/local/bin/node'],
  unixHomeRelative: const ['.local/bin/node'],
  windowsExtraDirs: const [r'C:\Program Files\nodejs'],
);

Future<String>? _cachedNode;

/// Resolve o `bun` (runtime do `omp`, cujo shim tem shebang `#!/usr/bin/env bun`).
/// Cacheado por processo, pela mesma razão do [resolveNode].
Future<String> resolveBun() => _cachedBun ??= resolveExecutable(
  'bun',
  unixCandidates: const ['/opt/homebrew/bin/bun', '/usr/local/bin/bun'],
  unixHomeRelative: const ['.bun/bin/bun'],
  windowsExtraDirs: const [r'C:\Program Files\bun'],
);

Future<String>? _cachedBun;

/// Diretório onde o executável resolvido [exe] mora. `null` se [exe] é só um
/// nome (não resolveu pra um caminho).
String? _binDirOf(String exe) {
  final idx = exe.lastIndexOf(RegExp(r'[/\\]'));
  return idx > 0 ? exe.substring(0, idx) : null;
}

/// Diretório onde o `node` resolvido mora (geralmente o mesmo bin do `npm`/
/// `remote-omp`). `null` se o node não foi resolvido pra um caminho.
Future<String?> resolveNodeBinDir() async => _binDirOf(await resolveNode());

/// Environment do processo com o bin do `node` e do `bun` **prefixados** na
/// PATH. Necessário pra rodar os shims `omp`/`remote-omp`, cujo shebang
/// (`#!/usr/bin/env bun` / `node`) precisa achar o runtime — que em setups
/// nvm/Homebrew/`~/.bun/bin` não está na PATH herdada pelo app GUI (erro
/// `/usr/bin/env: 'bun': No such file or directory`).
Future<Map<String, String>> envWithNodeOnPath() async {
  final env = Map<String, String>.of(Platform.environment);
  final dirs = <String>[
    ?await resolveNodeBinDir(),
    ?_binDirOf(await resolveBun()),
  ];
  final sep = Platform.isWindows ? ';' : ':';
  // Windows usa 'Path'; POSIX usa 'PATH'.
  final key = env.containsKey('Path') && !env.containsKey('PATH')
      ? 'Path'
      : 'PATH';
  final cur = env[key] ?? '';
  final present = cur.split(sep).toSet();
  for (final dir in dirs.reversed) {
    if (present.add(dir)) {
      final current = env[key] ?? '';
      env[key] = current.isEmpty ? dir : '$dir$sep$current';
    }
  }
  return env;
}

/// Como invocar o `remote-omp`: o executável + os args de prefixo. No POSIX é o
/// binário `remote-omp` (prefixo vazio); no Windows é `node <index.js>`. Devolve
/// `null` se o Windows não conseguir localizar o `index.js` da extensão.
Future<({String exe, List<String> prefixArgs})?>
resolveRemoteOmpCommand() async {
  if (Platform.isWindows) {
    final indexJs = await resolveRemoteOmpIndexJs();
    if (indexJs == null) return null;
    final node = await resolveNode();
    return (exe: node, prefixArgs: <String>[indexJs]);
  }
  final exe = await resolveExecutable(
    'remote-omp',
    unixCandidates: const [
      '/opt/homebrew/bin/remote-omp',
      '/usr/local/bin/remote-omp',
    ],
    unixHomeRelative: const ['.local/bin/remote-omp', '.bun/bin/remote-omp'],
  );
  return (exe: exe, prefixArgs: const <String>[]);
}

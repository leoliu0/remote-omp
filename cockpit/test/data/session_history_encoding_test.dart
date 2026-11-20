import 'package:cockpit/app/cockpit/data/filesystem/session_history_impl.dart';
import 'package:flutter_test/flutter_test.dart';

/// O omp agrupa as sessões em `~/.omp/agent/sessions/<cwd-codificado>/`; o
/// histórico do Cockpit só acha as sessões se codificar o cwd do mesmo jeito.
void main() {
  String encode(String cwd) => SessionHistoryImpl.encodeSessionDirName(
    cwd,
    home: '/home/leo',
    tmp: '/tmp',
  );

  test('cwd sob o HOME vira -<relativo>', () {
    expect(encode('/home/leo/Documents/project'), '-Documents-project');
  });

  test('cwd sob o tmp vira -tmp-<relativo>', () {
    expect(encode('/tmp/scratch/app'), '-tmp-scratch-app');
  });

  test('cwd fora do HOME e do tmp usa o formato legado --<absoluto>--', () {
    expect(encode('/srv/app'), '--srv-app--');
  });

  test('o próprio HOME vira só "-"', () {
    expect(encode('/home/leo'), '-');
  });
}

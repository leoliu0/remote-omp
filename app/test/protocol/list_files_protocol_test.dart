import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('ListFilesRequest omits limit when null', () {
    expect(ListFilesRequest(id: 'a', query: 'sup').toJson(), {
      'type': 'list_files',
      'id': 'a',
      'query': 'sup',
    });
    expect(ListFilesRequest(id: 'a', query: '', limit: 8).toJson(), {
      'type': 'list_files',
      'id': 'a',
      'query': '',
      'limit': 8,
    });
  });

  test('files_list parses, ignoring non-string entries', () {
    final msg = ServerMessage.fromJson({
      'type': 'files_list',
      'in_reply_to': 'a',
      'root': '/repo',
      'files': ['src/a.ts', 3, 'README.md'],
      'truncated': true,
    });
    expect(
      msg,
      const FilesListResult(
        inReplyTo: 'a',
        root: '/repo',
        files: ['src/a.ts', 'README.md'],
        truncated: true,
      ),
    );
  });
}

// Plan 65 — received files appear in the chat timeline as FileMsg, in
// arrival order, and card actions go through the FileActions contract.

import 'dart:async';

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/data/local/app_database.dart';
import 'package:app/data/local/records/message_record.dart';
import 'package:app/data/local/session_store.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/repositories/session_read_repository.dart';
import 'package:app/data/sync/sync_service.dart';
import 'package:app/data/transport/channel.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/domain/contracts/file_actions.dart';
import 'package:app/domain/entities/received_file.dart';
import 'package:app/domain/repositories/received_files_repository.dart';
import 'package:app/domain/session_state.dart';
import 'package:app/pairing/storage.dart';
import 'package:app/ui/chat/states/chat_state.dart';
import 'package:app/ui/chat/viewmodels/chat_viewmodel.dart';
import 'package:flutter_test/flutter_test.dart';

const _peer = PeerRecord(
  remoteEpk: 'epk_files_chat',
  sessionName: 'Pi',
  relayUrl: 'ws://localhost',
  pairedAt: '2026-01-01T00:00:00Z',
);

class _FakeStorage extends PairingStorage {
  _FakeStorage(super.db);
  @override
  Future<List<PeerRecord>> listPeers() async => const [_peer];
  @override
  Future<PeerRecord?> loadPeer(String epk) async =>
      epk == _peer.remoteEpk ? _peer : null;
}

class _FakeFiles implements ReceivedFilesRepository {
  final ctrl = StreamController<List<ReceivedFile>>.broadcast();
  final cancelled = <String>[];
  (String, String)? watched;

  @override
  Stream<List<ReceivedFile>> watchSession(String epk, String roomId) {
    watched = (epk, roomId);
    return ctrl.stream;
  }

  @override
  Future<void> cancel(String fileId) async => cancelled.add(fileId);
  @override
  Future<void> clearAll() async {}
  @override
  Future<int> diskUsage() async => 0;
}

class _FakeActions implements FileActions {
  final calls = <String>[];
  @override
  bool get canSaveToDownloads => true;
  @override
  bool get canInstall => true;
  @override
  Future<FileActionResult> open(ReceivedFile f) async {
    calls.add('open:${f.fileId}');
    return const FileActionFailed('No app can open this file');
  }

  @override
  Future<FileActionResult> share(ReceivedFile f) async {
    calls.add('share:${f.fileId}');
    return const FileActionOk();
  }

  @override
  Future<FileActionResult> saveToDownloads(ReceivedFile f) async {
    calls.add('save:${f.fileId}');
    return const FileActionOk();
  }

  @override
  Future<FileActionResult> install(ReceivedFile f) async {
    calls.add('install:${f.fileId}');
    return const FileActionOk();
  }
}

MessageRecord _msg(String id, int seq, DateTime ts) =>
    MessageRecord(id: id, seq: seq, role: MsgRole.assistant, text: id, ts: ts);

ReceivedFile _file(String id, DateTime at) => ReceivedFile(
  fileId: id,
  epk: _peer.remoteEpk,
  roomId: 'main',
  name: '$id.pdf',
  mime: 'application/pdf',
  size: 1,
  sha256: 'ab' * 32,
  status: ReceivedFileStatus.done,
  path: '/x/$id.pdf',
  createdAt: at,
  updatedAt: at,
);

void main() {
  final t0 = DateTime(2026, 10, 20, 12);

  group('mergeFilesIntoTimeline', () {
    test('places each file after the messages that came before it', () {
      final rows = [
        _msg('a', 0, t0),
        _msg('b', 1, t0.add(const Duration(minutes: 2))),
        _msg('c', 2, t0.add(const Duration(minutes: 4))),
      ];
      final files = [
        _file('f1', t0.add(const Duration(minutes: 3))),
        _file('f0', t0.subtract(const Duration(minutes: 1))),
        _file('f2', t0.add(const Duration(minutes: 9))),
      ];
      final ids = mergeFilesIntoTimeline(rows, files).map((m) => m.id);
      expect(ids, ['file_f0', 'a', 'b', 'file_f1', 'c', 'file_f2']);
    });

    test('no files → the message projection unchanged', () {
      final rows = [_msg('a', 0, t0)];
      final merged = mergeFilesIntoTimeline(rows, const []);
      expect(merged.single, isA<AssistantMsg>());
    });
  });

  test('ChatViewModel shows session files and forwards card actions', () async {
    final db = AppDatabase.memory();
    final store = SessionStore(db);
    final storage = _FakeStorage(db);
    final conn = ConnectionManager(
      factory: (_, _) => Completer<IChannel>().future,
      storage: storage,
    );
    final sync = SyncService(conn, store);
    final prefs = Preferences(db);
    await prefs.setSelectedPeerEpk(_peer.remoteEpk);
    await prefs.setSelectedRoom(epk: _peer.remoteEpk, roomId: 'main');
    store.upsertMessage(_peer.remoteEpk, 'main', _msg('hello', 0, t0));
    final files = _FakeFiles();
    final actions = _FakeActions();

    final vm = ChatViewModel(
      SessionReadRepository(store),
      sync,
      conn,
      prefs,
      storage,
      ActionsRepository(conn),
      files: files,
      fileActions: actions,
    );
    addTearDown(() {
      vm.dispose();
      sync.dispose();
      conn.dispose();
      store.dispose();
      db.dispose();
    });
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(files.watched, (_peer.remoteEpk, 'main'));

    final f = _file('apk1', t0.add(const Duration(minutes: 1)));
    files.ctrl.add([f]);
    await Future<void>.delayed(Duration.zero);

    final messages = (vm.state as ChatReady).messages;
    expect(messages.map((m) => m.id), ['hello', 'file_apk1']);
    expect((messages.last as FileMsg).file, f);
    expect(vm.canSaveFilesToDownloads, isTrue);
    expect(vm.canInstallFiles, isTrue);

    expect(await vm.openFile(f), isA<FileActionFailed>());
    await vm.shareFile(f);
    await vm.saveFile(f);
    await vm.installFile(f);
    await vm.cancelFile('apk1');
    expect(actions.calls, [
      'open:apk1',
      'share:apk1',
      'save:apk1',
      'install:apk1',
    ]);
    expect(files.cancelled, ['apk1']);
  });
}

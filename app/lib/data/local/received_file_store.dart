import 'dart:async';

import 'package:app/data/local/app_database.dart';
import 'package:app/domain/entities/received_file.dart';
import 'package:sqlite3/sqlite3.dart' show Row;

/// Plan 65 — typed SQLite boundary for files received from the agent.
/// Owns its own table on the shared [AppDatabase]. Stores metadata and the
/// on-disk path only; the bytes stay in the app files dir.
class ReceivedFileStore {
  ReceivedFileStore(this._database) {
    _createSchema();
  }

  final AppDatabase _database;
  final StreamController<_SessionKey> _changes =
      StreamController<_SessionKey>.broadcast(sync: true);
  bool _disposed = false;

  void _createSchema() {
    _database.transaction<void>(() {
      _database.db.execute('''
        CREATE TABLE IF NOT EXISTS received_files (
          file_id TEXT PRIMARY KEY NOT NULL,
          peer_epk TEXT NOT NULL,
          room_id TEXT NOT NULL,
          name TEXT NOT NULL,
          mime TEXT NOT NULL,
          size INTEGER NOT NULL CHECK(size >= 0),
          sha256 TEXT NOT NULL,
          caption TEXT,
          turn_id TEXT,
          status TEXT NOT NULL CHECK(
            status IN ('receiving', 'done', 'failed', 'cancelled')
          ),
          next_seq INTEGER NOT NULL DEFAULT 0,
          received_bytes INTEGER NOT NULL DEFAULT 0,
          path TEXT NOT NULL,
          error_reason TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        )
      ''');
      _database.db.execute('''
        CREATE INDEX IF NOT EXISTS received_files_session
        ON received_files(peer_epk, room_id, created_at_ms)
      ''');
    });
  }

  ReceivedFile? get(String fileId) {
    _ensureOpen();
    final rows = _database.db.select(
      'SELECT * FROM received_files WHERE file_id = ?',
      <Object?>[fileId],
    );
    return rows.isEmpty ? null : _fromRow(rows.single);
  }

  List<ReceivedFile> all() {
    _ensureOpen();
    return [
      for (final row in _database.db.select(
        'SELECT * FROM received_files ORDER BY created_at_ms, file_id',
      ))
        _fromRow(row),
    ];
  }

  List<ReceivedFile> forSession(String epk, String roomId) {
    _ensureOpen();
    return [
      for (final row in _database.db.select(
        '''
        SELECT * FROM received_files
        WHERE peer_epk = ? AND room_id = ?
        ORDER BY created_at_ms, file_id
        ''',
        <Object?>[epk, roomId],
      ))
        _fromRow(row),
    ];
  }

  /// Inserts or replaces one record. An identical write is a no-op.
  bool upsert(ReceivedFile f) {
    _ensureOpen();
    final before = get(f.fileId);
    if (before == f) return false;
    _database.transaction<void>(() {
      _database.db.execute(
        '''
        INSERT INTO received_files(
          file_id, peer_epk, room_id, name, mime, size, sha256, caption,
          turn_id, status, next_seq, received_bytes, path, error_reason,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET
          peer_epk = excluded.peer_epk,
          room_id = excluded.room_id,
          name = excluded.name,
          mime = excluded.mime,
          size = excluded.size,
          sha256 = excluded.sha256,
          caption = excluded.caption,
          turn_id = excluded.turn_id,
          status = excluded.status,
          next_seq = excluded.next_seq,
          received_bytes = excluded.received_bytes,
          path = excluded.path,
          error_reason = excluded.error_reason,
          created_at_ms = excluded.created_at_ms,
          updated_at_ms = excluded.updated_at_ms
        ''',
        <Object?>[
          f.fileId,
          f.epk,
          f.roomId,
          f.name,
          f.mime,
          f.size,
          f.sha256,
          f.caption,
          f.turnId,
          f.status.name,
          f.nextSeq,
          f.receivedBytes,
          f.path,
          f.errorReason,
          f.createdAt.millisecondsSinceEpoch,
          f.updatedAt.millisecondsSinceEpoch,
        ],
      );
      _notifyAfterCommit(_SessionKey(f.epk, f.roomId));
      if (before != null &&
          (before.epk != f.epk || before.roomId != f.roomId)) {
        _notifyAfterCommit(_SessionKey(before.epk, before.roomId));
      }
    });
    return true;
  }

  /// Deletes every record (Settings → Storage → Clear received files).
  void deleteAll() {
    _ensureOpen();
    final sessions = {for (final f in all()) _SessionKey(f.epk, f.roomId)};
    if (sessions.isEmpty) return;
    _database.transaction<void>(() {
      _database.db.execute('DELETE FROM received_files');
      for (final key in sessions) {
        _notifyAfterCommit(key);
      }
    });
  }

  Stream<List<ReceivedFile>> watchSession(String epk, String roomId) {
    _ensureOpen();
    final key = _SessionKey(epk, roomId);
    StreamSubscription<_SessionKey>? subscription;
    late final StreamController<List<ReceivedFile>> controller;
    controller = StreamController<List<ReceivedFile>>(
      onListen: () {
        subscription = _changes.stream
            .where((changed) => changed == key)
            .listen(
              (_) {
                if (!controller.isClosed) {
                  controller.add(forSession(epk, roomId));
                }
              },
              onDone: () {
                if (!controller.isClosed) controller.close();
              },
            );
        if (!controller.isClosed) controller.add(forSession(epk, roomId));
      },
      onCancel: () => subscription?.cancel(),
    );
    return controller.stream;
  }

  void _notifyAfterCommit(_SessionKey key) {
    _database.afterCommit(() {
      if (!_changes.isClosed) _changes.add(key);
    });
  }

  static ReceivedFile _fromRow(Row row) => ReceivedFile(
    fileId: row['file_id'] as String,
    epk: row['peer_epk'] as String,
    roomId: row['room_id'] as String,
    name: row['name'] as String,
    mime: row['mime'] as String,
    size: row['size'] as int,
    sha256: row['sha256'] as String,
    caption: row['caption'] as String?,
    turnId: row['turn_id'] as String?,
    status: ReceivedFileStatus.values.firstWhere(
      (s) => s.name == row['status'],
      orElse: () => ReceivedFileStatus.failed,
    ),
    nextSeq: row['next_seq'] as int,
    receivedBytes: row['received_bytes'] as int,
    path: row['path'] as String,
    errorReason: row['error_reason'] as String?,
    createdAt: DateTime.fromMillisecondsSinceEpoch(row['created_at_ms'] as int),
    updatedAt: DateTime.fromMillisecondsSinceEpoch(row['updated_at_ms'] as int),
  );

  void _ensureOpen() {
    if (_disposed) throw StateError('ReceivedFileStore has been disposed.');
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _changes.close();
  }
}

class _SessionKey {
  const _SessionKey(this.epk, this.roomId);

  final String epk;
  final String roomId;

  @override
  bool operator ==(Object other) =>
      other is _SessionKey && other.epk == epk && other.roomId == roomId;

  @override
  int get hashCode => Object.hash(epk, roomId);
}

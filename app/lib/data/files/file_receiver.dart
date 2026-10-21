// Plan 65 — receives files the agent sends to the phone.
//
// ext → app: file_offer, file_chunk*, file_end (+ file_cancel).
// app → ext: file_ack {next_seq} after every chunk (cumulative), then
// file_done once the SHA-256 matches, or file_error {reason}.
//
// Chunks stream into `<files dir>/received/<file_id>/<name>.part`; the file
// is renamed to `<name>` after the hash check. SQLite holds metadata and the
// path only. On reconnect, unfinished transfers younger than [resumeWindow]
// re-send `file_ack` with their `next_seq` so the sender resumes; older ones
// (and stale `.part` files found at startup) are dropped.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app/data/local/received_file_store.dart';
import 'package:app/data/transport/connection_manager.dart';
import 'package:app/domain/contracts/service.dart';
import 'package:app/domain/entities/received_file.dart';
import 'package:app/domain/repositories/received_files_repository.dart';
import 'package:app/protocol/protocol.dart';
import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

/// Disk writes for `.part` files. Tests substitute a failing sink to
/// simulate a full disk.
abstract class ChunkSink {
  /// Creates (or empties) [path], creating parent directories.
  Future<void> create(String path);
  Future<void> append(String path, List<int> bytes);

  /// Shrinks [path] to [length] bytes (drops a write the record never saw).
  Future<void> truncate(String path, int length);
}

class IoChunkSink implements ChunkSink {
  @override
  Future<void> create(String path) async {
    final f = File(path);
    await f.parent.create(recursive: true);
    await f.writeAsBytes(const <int>[], flush: true);
  }

  @override
  Future<void> append(String path, List<int> bytes) async {
    final raf = await File(path).open(mode: FileMode.append);
    try {
      await raf.writeFrom(bytes);
    } finally {
      await raf.close();
    }
  }

  @override
  Future<void> truncate(String path, int length) async {
    final raf = await File(path).open(mode: FileMode.append);
    try {
      await raf.truncate(length);
    } finally {
      await raf.close();
    }
  }
}

class FileReceiver extends Service implements ReceivedFilesRepository {
  FileReceiver(
    this._conn,
    this._store, {
    Future<Directory> Function()? rootDir,
    ChunkSink? sink,
    DateTime Function()? now,
    this.resumeWindow = const Duration(minutes: 10),
  }) : _rootDir = rootDir ?? getApplicationSupportDirectory,
       _sink = sink ?? IoChunkSink(),
       _now = now ?? DateTime.now {
    ready = _enqueue(_startupCleanup);
    _statusSub = _conn.statusStream.listen(_onStatus);
    _roomsSub = _conn.roomsStream.listen((_) => _onRoomMaybeChanged());
    _onStatus(_conn.status);
  }

  static const String receivedDirName = 'received';
  static const String partSuffix = '.part';

  /// Out-of-order chunks held in memory while a gap is open.
  static const int _maxAhead = 32;

  final ConnectionManager _conn;
  final ReceivedFileStore _store;
  final Future<Directory> Function() _rootDir;
  final ChunkSink _sink;
  final DateTime Function() _now;
  final Duration resumeWindow;

  /// Completes once stale `.part` files from a previous run are gone.
  late final Future<void> ready;

  StreamSubscription<ConnectionStatus>? _statusSub;
  StreamSubscription<Map<String, List<RoomInfo>>>? _roomsSub;
  StreamSubscription<ServerMessage>? _msgSub;
  String? _resumedKey;
  bool _disposed = false;

  final Map<String, _Transfer> _transfers = {};
  Future<void> _chain = Future<void>.value();
  Directory? _root;

  /// Completes when every queued frame/command has been processed.
  @visibleForTesting
  Future<void> get idle => _chain;

  // ---------------------------------------------------------------------------
  // ReceivedFilesRepository
  // ---------------------------------------------------------------------------

  @override
  Stream<List<ReceivedFile>> watchSession(String epk, String roomId) =>
      _store.watchSession(epk, roomId);

  @override
  Future<void> cancel(String fileId) => _enqueue(() async {
    final rec = _store.get(fileId);
    if (rec == null || rec.status != ReceivedFileStatus.receiving) return;
    await _send(FileCancel(fileId: fileId));
    await _drop(rec, ReceivedFileStatus.cancelled);
  });

  @override
  Future<void> clearAll() => _enqueue(() async {
    for (final rec in _store.all()) {
      if (rec.status == ReceivedFileStatus.receiving) {
        await _send(FileCancel(fileId: rec.fileId));
      }
    }
    _transfers.clear();
    final dir = await _receivedDir();
    try {
      if (await dir.exists()) await dir.delete(recursive: true);
    } on FileSystemException catch (e) {
      debugPrint('[files] clear failed: $e');
    }
    _store.deleteAll();
  });

  @override
  Future<int> diskUsage() async {
    final dir = await _receivedDir();
    if (!await dir.exists()) return 0;
    var total = 0;
    await for (final e in dir.list(recursive: true, followLinks: false)) {
      if (e is File) {
        try {
          total += await e.length();
        } on FileSystemException {
          // Raced with a delete.
        }
      }
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // Connection wiring
  // ---------------------------------------------------------------------------

  void _onStatus(ConnectionStatus s) {
    if (_disposed) return;
    _msgSub?.cancel();
    _msgSub = null;
    // In-flight chunks of a dropped socket are gone; the sender resends from
    // the next ack.
    for (final t in _transfers.values) {
      t.ahead.clear();
    }
    if (s is! StatusOnline) {
      _resumedKey = null;
      return;
    }
    _msgSub = s.channel.serverMessages.listen((msg) {
      if (msg is FileOffer ||
          msg is FileChunk ||
          msg is FileEnd ||
          msg is FileCancel) {
        // ignore: discarded_futures
        _enqueue(() => _onFrame(msg));
      }
    }, onError: (Object _, StackTrace _) {});
    _resumedKey = _activeKey();
    // ignore: discarded_futures
    _enqueue(_resume);
  }

  /// A same-socket switch to another Pi room: transfers of that room resume.
  void _onRoomMaybeChanged() {
    if (_disposed || _conn.status is! StatusOnline) return;
    final key = _activeKey();
    if (key == null || key == _resumedKey) return;
    _resumedKey = key;
    // ignore: discarded_futures
    _enqueue(_resume);
  }

  String? _activeKey() {
    final epk = _conn.activePeer?.remoteEpk;
    return epk == null ? null : '$epk\u0000${_conn.activeRoomId}';
  }

  Future<void> _send(ClientMessage msg) async {
    final ch = _conn.channel;
    if (ch == null) return;
    try {
      await ch.send(msg);
    } catch (e) {
      debugPrint('[files] send ${msg.runtimeType} failed: $e');
    }
  }

  // ---------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------

  Future<void> _onFrame(ServerMessage msg) async {
    switch (msg) {
      case FileOffer():
        await _onOffer(msg);
      case FileChunk():
        await _onChunk(msg);
      case FileEnd(:final fileId, :final chunks):
        final t = _transfers[fileId] ?? await _reattach(fileId);
        if (t == null) return;
        t.endChunks = chunks;
        if (t.rec.nextSeq >= chunks) {
          await _finalize(t);
        } else {
          await _send(FileAck(fileId: fileId, nextSeq: t.rec.nextSeq));
        }
      case FileCancel(:final fileId):
        final rec = _store.get(fileId);
        if (rec == null || rec.status != ReceivedFileStatus.receiving) return;
        await _drop(rec, ReceivedFileStatus.cancelled);
      default:
        return;
    }
  }

  Future<void> _onOffer(FileOffer o) async {
    if (!isValidFileId(o.fileId)) {
      debugPrint('[files] ignored offer with unsafe file_id');
      return;
    }
    final epk = _conn.activePeer?.remoteEpk;
    if (epk == null) return;
    final existing = _store.get(o.fileId);
    if (existing != null) {
      if (existing.epk != epk) return; // Another peer's id: never overwrite.
      switch (existing.status) {
        case ReceivedFileStatus.done:
          await _send(FileDone(fileId: o.fileId));
          return;
        case ReceivedFileStatus.receiving:
          final t = await _attach(existing);
          if (t != null) {
            await _send(FileAck(fileId: o.fileId, nextSeq: t.rec.nextSeq));
          }
          return;
        case ReceivedFileStatus.failed:
        case ReceivedFileStatus.cancelled:
          break; // A fresh attempt under the same id starts over.
      }
    }
    final name = sanitizeFileName(o.name);
    final dir = await _fileDir(o.fileId);
    final partPath = '${dir.path}/$name$partSuffix';
    final now = _now();
    final rec = ReceivedFile(
      fileId: o.fileId,
      epk: epk,
      roomId: _conn.activeRoomId,
      name: name,
      mime: o.mime,
      size: o.size,
      sha256: o.sha256,
      caption: o.caption,
      turnId: o.turnId,
      status: ReceivedFileStatus.receiving,
      path: partPath,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    );
    try {
      if (await dir.exists()) await dir.delete(recursive: true);
      await _sink.create(partPath);
    } on FileSystemException catch (e) {
      debugPrint('[files] cannot create ${o.fileId}: $e');
      await _fail(rec, FileErrorReason.noSpace);
      return;
    }
    _store.upsert(rec);
    _transfers[o.fileId] = _Transfer(rec);
    await _send(FileAck(fileId: o.fileId, nextSeq: 0));
  }

  Future<void> _onChunk(FileChunk c) async {
    final t = _transfers[c.fileId] ?? await _reattach(c.fileId);
    if (t == null) return;
    final next = t.rec.nextSeq;
    if (c.seq < next) {
      await _send(FileAck(fileId: c.fileId, nextSeq: next)); // Duplicate.
      return;
    }
    final Uint8List bytes;
    try {
      bytes = base64Decode(c.data);
    } on FormatException {
      await _send(FileAck(fileId: c.fileId, nextSeq: next));
      return;
    }
    if (c.seq > next) {
      if (t.ahead.length < _maxAhead || t.ahead.containsKey(c.seq)) {
        t.ahead[c.seq] = bytes;
      }
      await _send(FileAck(fileId: c.fileId, nextSeq: next));
      return;
    }
    // In order: write it, then everything buffered right behind it.
    var rec = t.rec;
    var pending = bytes;
    while (true) {
      if (rec.receivedBytes + pending.length > rec.size) {
        // More data than offered: the hash cannot match.
        await _fail(rec, FileErrorReason.shaMismatch);
        return;
      }
      try {
        await _sink.append(rec.path, pending);
      } on FileSystemException catch (e) {
        debugPrint('[files] write failed for ${rec.fileId}: $e');
        await _fail(rec, FileErrorReason.noSpace);
        return;
      }
      rec = rec.copyWith(
        nextSeq: rec.nextSeq + 1,
        receivedBytes: rec.receivedBytes + pending.length,
        updatedAt: _now(),
      );
      final buffered = t.ahead.remove(rec.nextSeq);
      if (buffered == null) break;
      pending = buffered;
    }
    t.rec = rec;
    _store.upsert(rec);
    await _send(FileAck(fileId: c.fileId, nextSeq: rec.nextSeq));
    final end = t.endChunks;
    if (end != null && rec.nextSeq >= end) await _finalize(t);
  }

  /// A frame for a transfer with no in-memory state. The sender probes with
  /// its first unacked chunk when acks stop, so a transfer that already
  /// ended answers its outcome again (the first answer may have been lost);
  /// an unfinished one from before a restart is re-attached.
  Future<_Transfer?> _reattach(String fileId) async {
    final rec = _store.get(fileId);
    if (rec == null || rec.epk != _conn.activePeer?.remoteEpk) return null;
    switch (rec.status) {
      case ReceivedFileStatus.receiving:
        if (_isStale(rec)) {
          await _drop(rec, ReceivedFileStatus.failed, reason: 'expired');
          await _send(FileError(fileId: fileId));
          return null;
        }
        return _attach(rec);
      case ReceivedFileStatus.done:
        await _send(FileDone(fileId: fileId));
      case ReceivedFileStatus.failed:
        await _send(
          FileError(
            fileId: fileId,
            reason: FileErrorReason.fromWire(rec.errorReason),
          ),
        );
      case ReceivedFileStatus.cancelled:
        await _send(FileCancel(fileId: fileId));
    }
    return null;
  }

  Future<void> _finalize(_Transfer t) async {
    final rec = t.rec;
    _transfers.remove(rec.fileId);
    final part = File(rec.path);
    String digest;
    try {
      digest = (await crypto.sha256.bind(part.openRead()).first).toString();
    } on FileSystemException catch (e) {
      debugPrint('[files] cannot read ${rec.fileId}: $e');
      await _fail(rec, FileErrorReason.noSpace);
      return;
    }
    if (digest != rec.sha256.trim().toLowerCase()) {
      await _fail(rec, FileErrorReason.shaMismatch);
      return;
    }
    final finalPath = '${part.parent.path}/${rec.name}';
    try {
      await part.rename(finalPath);
    } on FileSystemException catch (e) {
      debugPrint('[files] rename failed for ${rec.fileId}: $e');
      await _fail(rec, FileErrorReason.noSpace);
      return;
    }
    _store.upsert(
      rec.copyWith(
        status: ReceivedFileStatus.done,
        path: finalPath,
        updatedAt: _now(),
      ),
    );
    await _send(FileDone(fileId: rec.fileId));
  }

  // ---------------------------------------------------------------------------
  // Resume + cleanup
  // ---------------------------------------------------------------------------

  /// Re-acks unfinished transfers of the active session so the sender
  /// continues from `next_seq`; drops those past the resume window.
  Future<void> _resume() async {
    final epk = _conn.activePeer?.remoteEpk;
    if (epk == null) return;
    final room = _conn.activeRoomId;
    for (final rec in _store.forSession(epk, room)) {
      if (rec.status != ReceivedFileStatus.receiving) continue;
      if (_isStale(rec)) {
        await _drop(rec, ReceivedFileStatus.failed, reason: 'expired');
        continue;
      }
      final t = await _attach(rec);
      if (t == null) continue;
      await _send(FileAck(fileId: rec.fileId, nextSeq: t.rec.nextSeq));
    }
  }

  /// Binds an unfinished record to an in-memory transfer and makes the
  /// `.part` file agree with the recorded progress.
  Future<_Transfer?> _attach(ReceivedFile rec) async {
    final t = _transfers[rec.fileId] ?? _Transfer(rec);
    t.ahead.clear();
    var current = t.rec;
    final part = File(current.path);
    try {
      final len = await part.exists() ? await part.length() : -1;
      if (len < current.receivedBytes) {
        // Bytes the record counts are missing: start over.
        await _sink.create(current.path);
        current = current.copyWith(nextSeq: 0, receivedBytes: 0);
      } else if (len > current.receivedBytes) {
        await _sink.truncate(current.path, current.receivedBytes);
      }
    } on FileSystemException catch (e) {
      debugPrint('[files] cannot resume ${rec.fileId}: $e');
      await _fail(current, FileErrorReason.noSpace);
      return null;
    }
    t.rec = current;
    _store.upsert(current);
    _transfers[rec.fileId] = t;
    return t;
  }

  Future<void> _startupCleanup() async {
    for (final rec in _store.all()) {
      if (rec.status == ReceivedFileStatus.receiving && _isStale(rec)) {
        await _drop(rec, ReceivedFileStatus.failed, reason: 'expired');
      }
    }
    final dir = await _receivedDir();
    if (!await dir.exists()) return;
    final cutoff = _now().subtract(resumeWindow);
    await for (final sub in dir.list(followLinks: false)) {
      if (sub is! Directory) continue;
      final id = sub.uri.pathSegments.where((s) => s.isNotEmpty).last;
      final rec = _store.get(id);
      final keepPart = rec?.status == ReceivedFileStatus.receiving;
      try {
        await for (final f in sub.list(followLinks: false)) {
          if (f is! File || !f.path.endsWith(partSuffix)) continue;
          if (keepPart && f.path == rec!.path) continue;
          if ((await f.lastModified()).isBefore(cutoff)) await f.delete();
        }
        if (await sub.list().isEmpty) await sub.delete();
      } on FileSystemException catch (e) {
        debugPrint('[files] cleanup of $id failed: $e');
      }
    }
  }

  bool _isStale(ReceivedFile rec) =>
      _now().difference(rec.updatedAt) > resumeWindow;

  /// Deletes the transfer's files and records a failure reported to the
  /// sender as `file_error`.
  Future<void> _fail(ReceivedFile rec, FileErrorReason reason) async {
    await _drop(rec, ReceivedFileStatus.failed, reason: reason.wire);
    await _send(FileError(fileId: rec.fileId, reason: reason));
  }

  Future<void> _drop(
    ReceivedFile rec,
    ReceivedFileStatus status, {
    String? reason,
  }) async {
    _transfers.remove(rec.fileId);
    try {
      final dir = await _fileDir(rec.fileId);
      if (await dir.exists()) await dir.delete(recursive: true);
    } on FileSystemException catch (e) {
      debugPrint('[files] delete of ${rec.fileId} failed: $e');
    }
    _store.upsert(
      rec.copyWith(status: status, errorReason: reason, updatedAt: _now()),
    );
  }

  Future<Directory> _receivedDir() async {
    final root = _root ??= await _rootDir();
    return Directory('${root.path}/$receivedDirName');
  }

  Future<Directory> _fileDir(String fileId) async =>
      Directory('${(await _receivedDir()).path}/$fileId');

  Future<void> _enqueue(Future<void> Function() op) {
    final next = _chain.then((_) {
      if (_disposed) return null;
      return op();
    });
    _chain = next.catchError((Object e, StackTrace _) {
      debugPrint('[files] $e');
    });
    return _chain;
  }

  @override
  void dispose() {
    _disposed = true;
    _statusSub?.cancel();
    _roomsSub?.cancel();
    _msgSub?.cancel();
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  static final RegExp _fileIdPattern = RegExp(
    r'^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$',
  );

  /// `file_id` becomes a directory name: no separators, no `..`.
  static bool isValidFileId(String id) =>
      _fileIdPattern.hasMatch(id) && !id.contains('..');

  /// Last path segment of [raw] without control characters; never empty,
  /// `.` or `..`, at most 120 characters (the extension is kept).
  static String sanitizeFileName(String raw) {
    var name = raw.split(RegExp(r'[/\\]')).last;
    name = name.replaceAll(RegExp(r'[\x00-\x1f\x7f]'), '').trim();
    if (name.isEmpty || name == '.' || name == '..') return 'file';
    if (name.length > 120) {
      final dot = name.lastIndexOf('.');
      final ext = dot > 0 && name.length - dot <= 16 ? name.substring(dot) : '';
      name = name.substring(0, 120 - ext.length) + ext;
    }
    return name;
  }
}

class _Transfer {
  _Transfer(this.rec);

  ReceivedFile rec;
  final Map<int, Uint8List> ahead = {};
  int? endChunks;
}

import 'package:app/domain/entities/received_file.dart';

/// Plan 65 — files the agent sent to this phone, scoped per chat session.
abstract class ReceivedFilesRepository {
  /// Files of one (peer, room) session, oldest first. Emits on every change
  /// (progress included).
  Stream<List<ReceivedFile>> watchSession(String epk, String roomId);

  /// User cancel of an in-flight transfer: tells the sender and drops the
  /// partial file.
  Future<void> cancel(String fileId);

  /// Settings → Storage: delete every received file and its record.
  Future<void> clearAll();

  /// Bytes used by received files on disk.
  Future<int> diskUsage();
}

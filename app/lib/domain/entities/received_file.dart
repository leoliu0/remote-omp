// Plan 65 — a file the agent sent to this phone. Metadata only: the bytes
// live on disk at [path]; SQLite never holds them.

enum ReceivedFileStatus { receiving, done, failed, cancelled }

class ReceivedFile {
  static const String apkMime = 'application/vnd.android.package-archive';

  final String fileId;

  /// Session (peer + Pi room) the file arrived on; the chat shows it there.
  final String epk;
  final String roomId;

  /// Sanitized display/file name (no directory parts).
  final String name;
  final String mime;

  /// Declared total size in bytes.
  final int size;

  /// Declared hex SHA-256.
  final String sha256;
  final String? caption;
  final String? turnId;
  final ReceivedFileStatus status;

  /// Next chunk the receiver expects (cumulative ack value).
  final int nextSeq;
  final int receivedBytes;

  /// `.part` path while receiving; final path once [status] is done.
  final String path;

  /// Wire reason for a failure (`sha_mismatch`, `no_space`, …) or a local
  /// one (`expired`).
  final String? errorReason;
  final DateTime createdAt;

  /// Last chunk/state change; drives the 10-minute resume window.
  final DateTime updatedAt;

  const ReceivedFile({
    required this.fileId,
    required this.epk,
    required this.roomId,
    required this.name,
    required this.mime,
    required this.size,
    required this.sha256,
    this.caption,
    this.turnId,
    required this.status,
    this.nextSeq = 0,
    this.receivedBytes = 0,
    required this.path,
    this.errorReason,
    required this.createdAt,
    required this.updatedAt,
  });

  bool get isApk => mime == apkMime || name.toLowerCase().endsWith('.apk');

  /// 0..1 while receiving; 1 once done.
  double get progress {
    if (status == ReceivedFileStatus.done) return 1;
    if (size <= 0) return 0;
    return (receivedBytes / size).clamp(0, 1).toDouble();
  }

  ReceivedFile copyWith({
    ReceivedFileStatus? status,
    int? nextSeq,
    int? receivedBytes,
    String? path,
    String? errorReason,
    DateTime? updatedAt,
  }) => ReceivedFile(
    fileId: fileId,
    epk: epk,
    roomId: roomId,
    name: name,
    mime: mime,
    size: size,
    sha256: sha256,
    caption: caption,
    turnId: turnId,
    status: status ?? this.status,
    nextSeq: nextSeq ?? this.nextSeq,
    receivedBytes: receivedBytes ?? this.receivedBytes,
    path: path ?? this.path,
    errorReason: errorReason ?? this.errorReason,
    createdAt: createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );

  @override
  bool operator ==(Object other) =>
      other is ReceivedFile &&
      other.fileId == fileId &&
      other.epk == epk &&
      other.roomId == roomId &&
      other.name == name &&
      other.mime == mime &&
      other.size == size &&
      other.sha256 == sha256 &&
      other.caption == caption &&
      other.turnId == turnId &&
      other.status == status &&
      other.nextSeq == nextSeq &&
      other.receivedBytes == receivedBytes &&
      other.path == path &&
      other.errorReason == errorReason &&
      other.createdAt == createdAt &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(
    fileId,
    epk,
    roomId,
    name,
    mime,
    size,
    sha256,
    caption,
    turnId,
    status,
    nextSeq,
    receivedBytes,
    path,
    errorReason,
    createdAt,
    updatedAt,
  );
}

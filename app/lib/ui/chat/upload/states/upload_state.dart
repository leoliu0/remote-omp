import 'package:app/data/files/file_uploader.dart';
import 'package:flutter/foundation.dart';

/// A line the upload strip shows once an upload (or a pick) ended: a short
/// confirmation that fades by itself, or the reason it failed until dismissed.
@immutable
class UploadNotice {
  const UploadNotice({
    required this.id,
    required this.message,
    this.name,
    this.failed = false,
    this.epk,
    this.roomId,
  });

  final String id;

  /// The file the message is about; null when no file was chosen.
  final String? name;
  final String message;
  final bool failed;

  /// The session it belongs to; null shows it in whichever chat is open.
  final String? epk;
  final String? roomId;

  @override
  bool operator ==(Object other) =>
      other is UploadNotice &&
      other.id == id &&
      other.name == name &&
      other.message == message &&
      other.failed == failed &&
      other.epk == epk &&
      other.roomId == roomId;

  @override
  int get hashCode => Object.hash(id, name, message, failed, epk, roomId);
}

/// What the composer shows above the text field for file uploads: the picker
/// working on a file, this chat's uploads in flight, and how the last ones
/// ended.
@immutable
class UploadState {
  const UploadState({
    this.uploads = const [],
    this.notices = const [],
    this.picking = false,
  });

  /// Uploads of the open session, oldest first.
  final List<UploadProgress> uploads;
  final List<UploadNotice> notices;

  /// The picker is open or still copying the chosen file.
  final bool picking;

  bool get isEmpty => uploads.isEmpty && notices.isEmpty && !picking;

  @override
  bool operator ==(Object other) =>
      other is UploadState &&
      other.picking == picking &&
      listEquals(other.uploads, uploads) &&
      listEquals(other.notices, notices);

  @override
  int get hashCode =>
      Object.hash(picking, Object.hashAll(uploads), Object.hashAll(notices));
}

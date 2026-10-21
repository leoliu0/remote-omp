import 'package:app/domain/entities/received_file.dart';

/// Outcome of a user action on a received file.
sealed class FileActionResult {
  const FileActionResult();
}

class FileActionOk extends FileActionResult {
  const FileActionOk();
}

class FileActionFailed extends FileActionResult {
  final String message;
  const FileActionFailed(this.message);
}

/// Plan 65 — platform hand-offs for a finished file. Nothing here runs
/// without a user tap; APK install always goes through Android's prompt.
abstract class FileActions {
  /// Whether "Save to Downloads" / "Install" exist on this platform.
  bool get canSaveToDownloads;
  bool get canInstall;

  Future<FileActionResult> open(ReceivedFile file);
  Future<FileActionResult> share(ReceivedFile file);
  Future<FileActionResult> saveToDownloads(ReceivedFile file);
  Future<FileActionResult> install(ReceivedFile file);
}

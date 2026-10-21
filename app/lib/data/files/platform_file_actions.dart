import 'dart:io';

import 'package:app/domain/contracts/file_actions.dart';
import 'package:app/domain/entities/received_file.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:open_filex/open_filex.dart';
import 'package:share_plus/share_plus.dart';

/// Plan 65 — hands a received file to the platform. Open goes through
/// open_filex (its FileProvider), Share through share_plus. Save to
/// Downloads (MediaStore, no permission on API 29+) and APK install
/// (ACTION_VIEW through the app's FileProvider; Android shows its own
/// install prompt) go through `MainActivity`'s `remote_pi/files` channel.
class PlatformFileActions implements FileActions {
  PlatformFileActions({MethodChannel? channel, bool? isAndroid})
    : _channel = channel ?? const MethodChannel('remote_pi/files'),
      _isAndroid = isAndroid ?? Platform.isAndroid;

  final MethodChannel _channel;
  final bool _isAndroid;

  @override
  bool get canSaveToDownloads => _isAndroid;

  @override
  bool get canInstall => _isAndroid;

  @override
  Future<FileActionResult> open(ReceivedFile file) async {
    if (!File(file.path).existsSync()) return _missing;
    try {
      final r = await OpenFilex.open(file.path, type: file.mime);
      return switch (r.type) {
        ResultType.done => const FileActionOk(),
        ResultType.noAppToOpen => const FileActionFailed(
          'No app can open this file',
        ),
        ResultType.fileNotFound => _missing,
        _ => FileActionFailed('Could not open: ${r.message}'),
      };
    } catch (e) {
      debugPrint('[files] open failed: $e');
      return const FileActionFailed('Could not open the file');
    }
  }

  @override
  Future<FileActionResult> share(ReceivedFile file) async {
    if (!File(file.path).existsSync()) return _missing;
    try {
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path, mimeType: file.mime, name: file.name)],
          text: file.caption,
        ),
      );
      return const FileActionOk();
    } catch (e) {
      debugPrint('[files] share failed: $e');
      return const FileActionFailed('Could not share the file');
    }
  }

  @override
  Future<FileActionResult> saveToDownloads(ReceivedFile file) async {
    if (!_isAndroid) return const FileActionFailed('Not available here');
    if (!File(file.path).existsSync()) return _missing;
    try {
      await _channel.invokeMethod<String>('saveToDownloads', {
        'path': file.path,
        'name': file.name,
        'mime': file.mime,
      });
      return const FileActionOk();
    } on PlatformException catch (e) {
      debugPrint('[files] save failed: ${e.code} ${e.message}');
      return const FileActionFailed('Could not save to Downloads');
    }
  }

  @override
  Future<FileActionResult> install(ReceivedFile file) async {
    if (!_isAndroid || !file.isApk) {
      return const FileActionFailed('Not an installable package');
    }
    if (!File(file.path).existsSync()) return _missing;
    try {
      await _channel.invokeMethod<void>('installApk', {'path': file.path});
      return const FileActionOk();
    } on PlatformException catch (e) {
      debugPrint('[files] install failed: ${e.code} ${e.message}');
      return const FileActionFailed('Could not start the installer');
    }
  }

  static const _missing = FileActionFailed(
    'The file is no longer on this phone',
  );
}

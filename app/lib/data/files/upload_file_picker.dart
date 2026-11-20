// Plan 68 — lets the user pick the file to upload.
//
// Android shows the system document picker (Storage Access Framework), which
// needs no storage permission; `file_picker` copies the pick into the app's
// cache (`cache/file_picker/<millis>/<name>`) and returns that path, so the
// upload reads it as a plain file, a chunk at a time. On iOS the plugin
// instead moves the import to `NSTemporaryDirectory()/<name>`, where a second
// pick of the same name would replace the file the first upload is still
// reading. Either way the copy is the app's own: it is moved to a directory
// made for this upload (`<cache>/rp_uploads/<id>/<name>`), which is deleted
// with the file once the upload ends. Where the picker hands back the original
// (desktop, tests) it is used in place and never deleted.
import 'dart:async';
import 'dart:io';

import 'package:app/data/files/file_uploader.dart';
import 'package:app/protocol/uuid7.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:path_provider/path_provider.dart';

abstract class IUploadFilePicker {
  /// Opens the system picker. Null when the user cancels; throws
  /// [UploadFailure] when the pick cannot be read.
  Future<UploadSource?> pick();
}

/// A picked file on disk, read with `File.openRead(start, end)`.
class FileUploadSource extends UploadSource {
  FileUploadSource(
    this.file, {
    required this.name,
    required this.size,
    this.ownedDir,
  });

  final File file;

  @override
  final String name;

  @override
  final int size;

  /// A directory made for this upload (holding [file]): [release] deletes it.
  /// Null when [file] is somebody's original.
  final Directory? ownedDir;

  @override
  Stream<List<int>> openRead([int? start, int? end]) =>
      file.openRead(start, end);

  @override
  Future<void> release() async {
    final dir = ownedDir;
    if (dir == null) return;
    try {
      await dir.delete(recursive: true);
    } on FileSystemException {
      // Already gone.
    }
  }
}

class PlatformUploadFilePicker implements IUploadFilePicker {
  PlatformUploadFilePicker({
    Future<FilePickerResult?> Function()? pickFiles,
    Future<Directory> Function()? tempDir,
    Directory? systemTempDir,
    bool? isIOS,
    String Function()? newId,
  }) : _pickFiles = pickFiles ?? _pickAnyFile,
       _tempDir = tempDir ?? getTemporaryDirectory,
       _systemTemp = systemTempDir ?? Directory.systemTemp,
       _isIOS = isIOS ?? Platform.isIOS,
       _newId = newId ?? uuid7;

  final Future<FilePickerResult?> Function() _pickFiles;
  final Future<Directory> Function() _tempDir;
  final Directory _systemTemp;
  final bool _isIOS;
  final String Function() _newId;

  static Future<FilePickerResult?> _pickAnyFile() =>
      FilePicker.platform.pickFiles(
        type: FileType.any,
        allowMultiple: false,
        allowCompression: false,
        withData: false,
        withReadStream: false,
      );

  @override
  Future<UploadSource?> pick() async {
    final FilePickerResult? result;
    try {
      result = await _pickFiles();
    } on PlatformException catch (e) {
      throw UploadFailure(
        'pick_failed',
        "Couldn't open the file picker (${e.message ?? e.code}).",
      );
    }
    final picked = result == null || result.files.isEmpty
        ? null
        : result.files.first;
    if (picked == null) return null; // The user backed out.
    final path = picked.path;
    if (path == null) {
      throw const UploadFailure('unreadable', "Couldn't read that file.");
    }
    var file = File(path);
    final int size;
    try {
      size = await file.length();
    } on FileSystemException {
      throw const UploadFailure('unreadable', "Couldn't read that file.");
    }
    final cache = await _tempDir();
    Directory? ownedDir;
    if (_isPickerCopy(path, cache)) {
      // The plugin's copy is ours: give it a directory of its own, so nothing
      // that is picked later can replace it, and delete it when done.
      final moved = await _claim(file, cache);
      if (moved != null) {
        file = moved;
        ownedDir = moved.parent;
      }
    }
    return FileUploadSource(
      file,
      name: picked.name,
      size: size,
      ownedDir: ownedDir,
    );
  }

  /// The pick lies where the plugin makes its copies: the app's cache (Android)
  /// or, on iOS, the temp directory.
  bool _isPickerCopy(String path, Directory cache) =>
      _isUnder(path, cache) || (_isIOS && _isUnder(path, _systemTemp));

  /// Moves [file] to `<cache>/rp_uploads/<id>/<name>`; null when that fails
  /// (the file is then used where it is and left alone).
  Future<File?> _claim(File file, Directory cache) async {
    final dir = Directory(
      '${cache.path}${Platform.pathSeparator}rp_uploads'
      '${Platform.pathSeparator}${_newId()}',
    );
    final oldDir = file.parent;
    final target = File(
      '${dir.path}${Platform.pathSeparator}'
      '${file.uri.pathSegments.last}',
    );
    try {
      await dir.create(recursive: true);
      try {
        await file.rename(target.path);
      } on FileSystemException {
        // Another volume: copy, then drop the original.
        await file.copy(target.path);
        await file.delete();
      }
    } on FileSystemException {
      await dir.delete(recursive: true).catchError((Object _) => dir);
      return null;
    }
    await _dropPickerDir(oldDir);
    return target;
  }

  /// `file_picker` keeps each pick in `cache/file_picker/<millis>/`: remove
  /// that folder once the file has left it (only when it is empty).
  Future<void> _dropPickerDir(Directory dir) async {
    final parent = dir.parent.uri.pathSegments.where((s) => s.isNotEmpty);
    if (parent.isEmpty || parent.last != 'file_picker') return;
    try {
      await dir.delete(); // Not recursive: only an empty folder goes.
    } on FileSystemException {
      // Not empty, or already gone.
    }
  }

  static bool _isUnder(String path, Directory dir) {
    String resolved(String p, bool isDir) {
      try {
        return isDir
            ? Directory(p).resolveSymbolicLinksSync()
            : File(p).resolveSymbolicLinksSync();
      } on FileSystemException {
        return p;
      }
    }

    final root = resolved(dir.path, true);
    final full = resolved(path, false);
    return full.startsWith('$root${Platform.pathSeparator}');
  }
}

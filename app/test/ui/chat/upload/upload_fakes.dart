// Plan 68 - fakes shared by the upload view-model and composer tests.

import 'dart:async';

import 'package:app/data/files/file_uploader.dart';
import 'package:app/data/files/upload_file_picker.dart';

/// A picked file that only records whether it was released.
class FakeUploadSource extends UploadSource {
  FakeUploadSource({this.name = 'report.pdf', this.size = 20 * 1024 * 1024});

  @override
  final String name;

  @override
  final int size;

  bool released = false;

  @override
  Stream<List<int>> openRead([int? start, int? end]) => const Stream.empty();

  @override
  Future<void> release() async {
    released = true;
  }
}

/// A scripted [IFileUploader]: tests start uploads through the view model and
/// then finish, fail or advance them by hand.
class FakeUploader implements IFileUploader {
  FakeUploader({
    this.epk = 'epk1',
    this.roomId = 'main',
    void Function(UploadResult result)? onUnhandledResult,
  }) : router = UploadOutcomeRouter(onUnhandledResult: onUnhandledResult);

  /// The router the real uploader uses: who takes an outcome, and what becomes
  /// of one nobody takes.
  final UploadOutcomeRouter router;

  /// The session new uploads belong to.
  String epk;
  String roomId;

  /// When set, [start] throws it (e.g. the offline failure).
  UploadFailure? failStart;

  final _controller = StreamController<List<UploadProgress>>.broadcast();
  final Map<String, UploadProgress> _uploads = {};
  final Map<String, Completer<UploadResult>> _results = {};
  final Map<String, UploadSource> sources = {};
  final List<String> cancelled = [];

  @override
  List<UploadProgress> get uploads => _uploads.values.toList();

  @override
  Stream<List<UploadProgress>> get uploadsStream => _controller.stream;

  @override
  void Function() addOutcomeHandler(UploadOutcomeHandler handler) =>
      router.add(handler);

  @override
  List<UploadFailed> takeUnseenFailures(String epk, String roomId) =>
      router.takeUnseen(epk, roomId);

  @override
  UploadHandle start(UploadSource source) {
    final failure = failStart;
    if (failure != null) throw failure;
    final id = 'u${sources.length + 1}';
    final done = Completer<UploadResult>();
    done.future.ignore();
    sources[id] = source;
    _results[id] = done;
    _uploads[id] = UploadProgress(
      id: id,
      name: source.name,
      size: source.size,
      ackedBytes: 0,
      phase: UploadPhase.sending,
      epk: epk,
      roomId: roomId,
    );
    _controller.add(uploads);
    return UploadHandle(id: id, result: done.future, cancel: () => cancel(id));
  }

  @override
  void cancel(String id) {
    cancelled.add(id);
    fail(id, const UploadFailure('cancelled', 'Upload cancelled.'));
  }

  void progress(String id, int ackedBytes) {
    final u = _uploads[id]!;
    _uploads[id] = UploadProgress(
      id: id,
      name: u.name,
      size: u.size,
      ackedBytes: ackedBytes,
      phase: UploadPhase.sending,
      epk: u.epk,
      roomId: u.roomId,
      waiting: u.waiting,
    );
    _controller.add(uploads);
  }

  void finish(
    String id, {
    String path = '/home/leo/.omp/remote/uploads/2026-11-20/report.pdf',
  }) {
    final u = _uploads.remove(id)!;
    _controller.add(uploads);
    final result = UploadResult(
      id: id,
      name: u.name,
      path: path,
      size: u.size,
      epk: u.epk,
      roomId: u.roomId,
    );
    _results[id]!.complete(result);
    router.dispatch(result);
  }

  void fail(String id, UploadFailure failure) {
    final u = _uploads.remove(id);
    if (u == null) return;
    _controller.add(uploads);
    _results[id]!.completeError(failure);
    router.dispatch(
      UploadFailed(
        id: id,
        name: u.name,
        failure: failure,
        epk: u.epk,
        roomId: u.roomId,
      ),
    );
  }

  Future<void> dispose() => _controller.close();
}

/// A scripted [IUploadFilePicker].
class FakeUploadPicker implements IUploadFilePicker {
  /// What the next [pick] returns; null = the user backed out.
  UploadSource? next;

  /// When set, the next [pick] throws it.
  Object? error;

  /// When set, [pick] waits for it (the picker "stays open").
  Completer<void>? gate;

  int picks = 0;

  @override
  Future<UploadSource?> pick() async {
    picks++;
    await gate?.future;
    final e = error;
    if (e != null) throw e;
    return next;
  }
}

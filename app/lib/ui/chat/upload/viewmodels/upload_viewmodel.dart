import 'dart:async';

import 'package:app/data/files/file_uploader.dart';
import 'package:app/data/files/upload_file_picker.dart';
import 'package:app/data/preferences/preferences.dart';
import 'package:app/data/transport/epk_encoding.dart';
import 'package:app/protocol/uuid7.dart';
import 'package:app/ui/chat/upload/states/upload_state.dart';
import 'package:app/ui/core/viewmodel/viewmodel.dart';

/// [text] appended to the composer text [current] and followed by a space so
/// typing can go on: separated from [current] by one space (none when
/// [current] is empty or already ends in whitespace).
String appendToComposerText(String current, String text) {
  final glue = current.isEmpty || RegExp(r'\s$').hasMatch(current) ? '' : ' ';
  return '$current$glue$text ';
}

/// Keeps the path of a finished upload in the saved draft of its session, for
/// when no composer of that session is on screen to take it.
void keepUploadedPathInDraft(Preferences prefs, UploadResult result) {
  prefs.setDraft(
    result.epk,
    result.roomId,
    appendToComposerText(
      prefs.getDraft(result.epk, result.roomId),
      result.path,
    ),
  );
}

/// Plan 68 — drives "Attach › File" for the composer.
///
/// Picks a file, hands it to the app-wide uploader, and tells the chat about
/// it: progress rows for the open session, a line when an upload ends, and,
/// once the PC has stored the file, its absolute path for the composer.
///
/// Route scoped like the attachment ViewModel, so the instance that started an
/// upload may be gone when it ends (back to Home and in again, another chat and
/// back). The uploads outlive it: every live instance takes the outcomes of the
/// session it shows, through [IFileUploader.addOutcomeHandler], whoever started
/// them. A path no composer is there to take lands in that session's saved
/// draft (see [keepUploadedPathInDraft]).
class UploadViewModel extends ViewModel<UploadState> {
  UploadViewModel(
    this._uploader,
    this._picker,
    this._prefs, {
    this.doneNoticeDuration = const Duration(seconds: 5),
  }) : super(const UploadState()) {
    _uploadsSub = _uploader.uploadsStream.listen((_) => _refresh());
    _removeHandler = _uploader.addOutcomeHandler(_onOutcome);
    _prefs.addListener(_onSelectionChanged);
    _adoptUnseenFailures();
    _refresh();
  }

  final IFileUploader _uploader;
  final IUploadFilePicker _picker;
  final Preferences _prefs;

  /// How long the "uploaded" confirmation stays; failures stay until dismissed.
  final Duration doneNoticeDuration;

  late final StreamSubscription<List<UploadProgress>> _uploadsSub;
  late final void Function() _removeHandler;
  final List<UploadNotice> _notices = [];
  final Map<String, Timer> _noticeTimers = {};
  final _insertions = StreamController<String>.broadcast();
  bool _picking = false;
  bool _disposed = false;

  /// Text for the composer to append (a finished upload's absolute path). The
  /// composer keeps its own draft, so this only reaches a composer on screen.
  Stream<String> get insertions => _insertions.stream;

  String? get _epk => _prefs.selectedPeerEpk;
  String get _roomId => _prefs.selectedRoomId ?? 'main';

  /// [epk]/[roomId] is the session whose chat is open (stores keep base64url
  /// epks, the relay speaks standard base64: compare them alike).
  bool _isOpenSession(String epk, String roomId) {
    final open = _epk;
    return open != null &&
        roomId == _roomId &&
        toStandardB64(epk) == toStandardB64(open);
  }

  /// Opens the system picker and uploads what the user chooses.
  Future<void> pickAndUpload() async {
    if (_picking || _disposed) return;
    _picking = true;
    _refresh();
    UploadSource? source;
    try {
      source = await _picker.pick();
    } on UploadFailure catch (e) {
      _addNotice(message: e.message, failed: true);
    } catch (_) {
      _addNotice(message: "Couldn't open the file picker.", failed: true);
    } finally {
      _picking = false;
      _refresh();
    }
    if (source == null) return;
    if (_disposed) {
      // The chat closed while the picker was open: nothing would show it.
      await source.release();
      return;
    }
    try {
      // How it ends reaches every chat showing this session, this one included
      // (see _onOutcome): nothing to await here.
      _uploader.start(source);
      _refresh(); // The row shows now, not on the stream's next turn.
    } on UploadFailure catch (e) {
      await source.release();
      _addNotice(
        name: source.name,
        message: e.message,
        failed: true,
        epk: _epk,
        roomId: _roomId,
      );
    }
  }

  void cancel(String id) => _uploader.cancel(id);

  void dismissNotice(String id) {
    _noticeTimers.remove(id)?.cancel();
    if (_notices.any((n) => n.id == id)) {
      _notices.removeWhere((n) => n.id == id);
      _refresh();
    }
  }

  /// How an upload ended. Takes it (true) when this view model shows that
  /// session: a failure always, a path only when a composer is there for it.
  bool _onOutcome(UploadOutcome outcome) {
    if (_disposed || !_isOpenSession(outcome.epk, outcome.roomId)) {
      return false;
    }
    switch (outcome) {
      case UploadResult():
        if (!_insertions.hasListener) return false;
        _insertions.add(outcome.path);
        _addNotice(
          name: outcome.name,
          message: 'Uploaded — path added to your message',
          epk: outcome.epk,
          roomId: outcome.roomId,
        );
      case UploadFailed(:final failure):
        if (!failure.cancelled) {
          _addNotice(
            name: outcome.name,
            message: failure.message,
            failed: true,
            epk: outcome.epk,
            roomId: outcome.roomId,
          );
        }
    }
    return true;
  }

  /// Failures that happened while no chat showed their session.
  void _adoptUnseenFailures() {
    final epk = _epk;
    if (epk == null) return;
    for (final f in _uploader.takeUnseenFailures(epk, _roomId)) {
      _addNotice(
        name: f.name,
        message: f.failure.message,
        failed: true,
        epk: f.epk,
        roomId: f.roomId,
      );
    }
  }

  void _onSelectionChanged() {
    _adoptUnseenFailures();
    _refresh();
  }

  void _addNotice({
    required String message,
    String? name,
    bool failed = false,
    String? epk,
    String? roomId,
  }) {
    if (_disposed) return;
    final notice = UploadNotice(
      id: uuid7(),
      name: name,
      message: message,
      failed: failed,
      // A failure belongs to the chat that was open when the file was picked.
      epk: epk ?? (failed ? _epk : null),
      roomId: roomId ?? (failed ? _roomId : null),
    );
    _notices.add(notice);
    // At most a few lines above the composer: the oldest make room.
    while (_notices.length > 3) {
      _noticeTimers.remove(_notices.removeAt(0).id)?.cancel();
    }
    if (!failed) {
      _noticeTimers[notice.id] = Timer(
        doneNoticeDuration,
        () => dismissNotice(notice.id),
      );
    }
    _refresh();
  }

  void _refresh() {
    if (_disposed) return;
    emit(
      UploadState(
        uploads: [
          for (final u in _uploader.uploads)
            if (_isOpenSession(u.epk, u.roomId)) u,
        ],
        notices: [
          for (final n in _notices)
            if (n.epk == null || _isOpenSession(n.epk!, n.roomId ?? 'main')) n,
        ],
        picking: _picking,
      ),
    );
  }

  @override
  void dispose() {
    _disposed = true;
    _removeHandler();
    _prefs.removeListener(_onSelectionChanged);
    _uploadsSub.cancel();
    for (final t in _noticeTimers.values) {
      t.cancel();
    }
    _noticeTimers.clear();
    _insertions.close();
    super.dispose();
  }
}

// Plan 68 — uploads files from the phone to the PC the active session runs on.
//
// app → ext: upload_start, upload_chunk*, upload_end {sha256} (+ upload_cancel).
// ext → app: upload_ack {seq, in_reply_to} after every chunk, then upload_done
// {path} or upload_error {code, message}.
//
// The reverse of plan 65's send_to_phone. Chunks are 256 KiB (a frame is about
// 470 KB on the wire, far below the relay's 4 MiB cap, and an uplink of
// 250 kbit/s still delivers one inside the ack timeout and the PC's 60 s idle
// limit), at most 4 in flight beyond the last ack (the relay has no
// backpressure). `upload_ack.seq` is cumulative: the first chunk the PC still
// needs. The file is read from disk one chunk at a time
// (`UploadSource.openRead(start, end)`), so nothing but the chunk in hand is in
// memory and any chunk can be sent again.
//
// `upload_start` leaves at once, so a refusal (too large, no space, too many
// uploads) arrives before a single byte is read. The SHA-256 is computed from
// the same chunk reads, in order, while sending, and goes to the PC with
// `upload_end`.
//
// Loss versus a slow link. The socket is ordered and reliable and there is no
// backpressure, so a slow uplink only delays acks: sending a chunk again would
// only queue more bytes behind the ones still in the socket. When acks stop
// for `ackTimeout` (doubling up to `maxAckTimeout`) the uploader probes: it
// sends `upload_start` again with a fresh request id, which the PC echoes in
// `upload_ack.in_reply_to`, and sends no chunk until that answer arrives. Frames
// are processed in order, so the answer is the PC's position after every
// earlier frame that reached it: chunks it lacks were lost (a relay blip, a new
// socket) and go out again from there. Only an advance of the cumulative ack
// counts as progress, so a PC that keeps answering probes without advancing
// still ends in `stalled`. An ack without an echo (a PC that predates it) is
// taken as the answer to the open probe.
//
// Frames go out only while the connection is online AND on the session the
// upload started in (the transport addresses one room at a time); otherwise
// the upload pauses and resumes with a probe. A PC that never answers
// `upload_start` is most likely running an old Remote OMP, and the error says
// so.
//
// How an upload ends is published to [IFileUploader.addOutcomeHandler]: the
// chat showing that session takes it, whichever view model started the upload.
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:app/data/transport/connection_manager.dart';
import 'package:app/data/transport/epk_encoding.dart';
import 'package:app/domain/contracts/service.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/protocol/uuid7.dart';
import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter/foundation.dart';

/// Raw bytes per `upload_chunk` (base64 inflates the frame by a third, twice).
const int kUploadChunkBytes = 256 * 1024;

/// Chunks sent beyond the last cumulative ack.
const int kUploadWindow = 4;

/// Probes (repeated `upload_start`) the PC may leave unanswered at once.
const int _kMaxOpenProbes = 4;

/// Failures nobody was showing, kept for the chat of their session.
const int kMaxUnseenFailures = 5;

/// What the user picked, readable any number of times.
abstract class UploadSource {
  String get name;
  int get size;

  /// Content type when the picker knows it; the PC does not need it.
  String? get mime => null;

  /// Streams the bytes `[start, end)`, the whole file when omitted.
  Stream<List<int>> openRead([int? start, int? end]);

  /// Frees what picking created (a cached copy). Best effort, called once.
  Future<void> release() async {}
}

/// Why an upload did not finish. [code] is machine-readable (`cancelled`,
/// `offline`, `no_response`, `stalled`, `connection_lost`, `unreadable`,
/// `unsupported`, or the PC's `upload_error` code); [message] is for the user.
class UploadFailure implements Exception {
  const UploadFailure(this.code, this.message);

  final String code;
  final String message;

  bool get cancelled => code == 'cancelled';

  @override
  String toString() => 'UploadFailure($code): $message';
}

enum UploadPhase {
  /// `upload_start` sent, waiting for the PC's first ack.
  starting,

  /// Chunks flowing.
  sending,

  /// Every chunk acked; waiting for `upload_done`.
  finishing,
}

/// One upload in flight, as the UI shows it.
class UploadProgress {
  const UploadProgress({
    required this.id,
    required this.name,
    required this.size,
    required this.ackedBytes,
    required this.phase,
    required this.epk,
    required this.roomId,
    this.waiting = false,
  });

  final String id;
  final String name;
  final int size;

  /// Bytes the PC has confirmed.
  final int ackedBytes;
  final UploadPhase phase;

  /// The session the upload belongs to (peer key + room).
  final String epk;
  final String roomId;

  /// Paused: offline, or the app is on another session.
  final bool waiting;

  /// 0..1, or null while it cannot be told (waiting for the PC's first answer).
  double? get fraction => switch (phase) {
    UploadPhase.starting => null,
    _ => size == 0 ? 1.0 : (ackedBytes / size).clamp(0.0, 1.0),
  };

  @override
  bool operator ==(Object other) =>
      other is UploadProgress &&
      other.id == id &&
      other.name == name &&
      other.size == size &&
      other.ackedBytes == ackedBytes &&
      other.phase == phase &&
      other.epk == epk &&
      other.roomId == roomId &&
      other.waiting == waiting;

  @override
  int get hashCode =>
      Object.hash(id, name, size, ackedBytes, phase, epk, roomId, waiting);
}

/// How an upload ended, for whoever shows the session it belongs to.
sealed class UploadOutcome {
  const UploadOutcome({
    required this.id,
    required this.name,
    required this.epk,
    required this.roomId,
  });

  final String id;
  final String name;
  final String epk;
  final String roomId;
}

/// A finished upload: [path] is absolute, on the PC.
class UploadResult extends UploadOutcome {
  const UploadResult({
    required super.id,
    required super.name,
    required this.path,
    required this.size,
    required super.epk,
    required super.roomId,
  });

  final String path;
  final int size;
}

/// An upload that did not finish (the user cancelling is one too).
class UploadFailed extends UploadOutcome {
  const UploadFailed({
    required super.id,
    required super.name,
    required this.failure,
    required super.epk,
    required super.roomId,
  });

  final UploadFailure failure;
}

/// Takes an upload outcome (true) or leaves it to the next handler (false).
typedef UploadOutcomeHandler = bool Function(UploadOutcome outcome);

/// Hands every upload outcome to whoever shows its session.
///
/// Handlers are offered each outcome newest first and the first to return true
/// takes it. A result nobody takes goes to [onUnhandledResult] (the app keeps
/// its path in that chat's draft); a failure nobody takes is kept (a few, once)
/// for the chat of that session to show when it opens.
class UploadOutcomeRouter {
  UploadOutcomeRouter({this.onUnhandledResult});

  final void Function(UploadResult result)? onUnhandledResult;
  final List<UploadOutcomeHandler> _handlers = [];
  final List<UploadFailed> _unseen = [];

  /// Registers [handler]; the returned function removes it.
  void Function() add(UploadOutcomeHandler handler) {
    _handlers.add(handler);
    return () => _handlers.remove(handler);
  }

  void dispatch(UploadOutcome outcome) {
    for (final handler in _handlers.reversed.toList()) {
      if (handler(outcome)) return;
    }
    switch (outcome) {
      case UploadResult():
        onUnhandledResult?.call(outcome);
      case UploadFailed(:final failure):
        if (failure.cancelled) return;
        _unseen.add(outcome);
        if (_unseen.length > kMaxUnseenFailures) _unseen.removeAt(0);
    }
  }

  /// The failures nobody showed for the session [epk]/[roomId], removed from
  /// the list as they are returned.
  List<UploadFailed> takeUnseen(String epk, String roomId) {
    final key = toStandardB64(epk);
    final mine = [
      for (final f in _unseen)
        if (f.roomId == roomId && toStandardB64(f.epk) == key) f,
    ];
    _unseen.removeWhere(mine.contains);
    return mine;
  }
}

class UploadHandle {
  const UploadHandle({
    required this.id,
    required this.result,
    required this.cancel,
  });

  final String id;

  /// Completes with the result, or fails with an [UploadFailure] (also when
  /// cancelled).
  final Future<UploadResult> result;
  final void Function() cancel;
}

abstract class IFileUploader {
  /// Uploads in flight, oldest first.
  List<UploadProgress> get uploads;

  /// A snapshot of [uploads] after every change.
  Stream<List<UploadProgress>> get uploadsStream;

  /// Starts uploading [source] to the PC of the active session. Throws
  /// [UploadFailure] (`offline`) when there is no open connection.
  UploadHandle start(UploadSource source);

  /// Cancels an upload and tells the PC to drop its partial file.
  void cancel(String id);

  /// Offers [handler] how uploads end (see [UploadOutcomeRouter]). Returns the
  /// function that removes it.
  void Function() addOutcomeHandler(UploadOutcomeHandler handler);

  /// Failures no handler took for the session [epk]/[roomId]; each is
  /// returned once.
  List<UploadFailed> takeUnseenFailures(String epk, String roomId);
}

const _kOfflineMessage = 'Not connected to the PC.';
const _kNoResponseMessage =
    "The PC didn't answer the upload. If Remote OMP on the PC is out of date, "
    'update it and try again.';
const _kUnsupportedMessage =
    'Remote OMP on the PC is too old to receive files. Update it on the PC and '
    'try again.';

final String _emptySha256 = crypto.sha256.convert(const <int>[]).toString();

class FileUploader extends Service implements IFileUploader {
  FileUploader(
    this._conn, {
    this.chunkBytes = kUploadChunkBytes,
    this.window = kUploadWindow,
    this.startAckTimeout = const Duration(seconds: 10),
    this.startAttempts = 3,
    this.ackTimeout = const Duration(seconds: 15),
    this.maxAckTimeout = const Duration(seconds: 30),
    this.stallTimeout = const Duration(seconds: 90),
    this.pauseGrace = const Duration(seconds: 60),
    this.maxRestarts = 2,
    void Function(UploadResult result)? onUnhandledResult,
    String Function()? newId,
    DateTime Function()? now,
  }) : _router = UploadOutcomeRouter(onUnhandledResult: onUnhandledResult),
       _newId = newId ?? uuid7,
       _now = now ?? DateTime.now {
    _statusSub = _conn.statusStream.listen(_onStatus);
    _roomsSub = _conn.roomsStream.listen((_) => _onConnectionChanged());
    _onStatus(_conn.status);
  }

  final ConnectionManager _conn;
  final int chunkBytes;
  final int window;

  /// How long the PC gets to answer `upload_start` before it is sent again;
  /// after [startAttempts] tries the upload fails with `no_response`.
  final Duration startAckTimeout;
  final int startAttempts;

  /// No ack for this long: probe. Doubles per probe up to [maxAckTimeout].
  final Duration ackTimeout;
  final Duration maxAckTimeout;

  /// The cumulative ack has not advanced for this long, while connected: the
  /// upload fails. Answers to probes do not count as progress.
  final Duration stallTimeout;

  /// Offline (or on another session) for this long fails the upload; the PC
  /// drops an idle upload after 60 s anyway.
  final Duration pauseGrace;

  /// Times an upload the PC lost is started over.
  final int maxRestarts;
  final UploadOutcomeRouter _router;
  final String Function() _newId;
  final DateTime Function() _now;

  final Map<String, _Upload> _uploads = {};
  final _controller = StreamController<List<UploadProgress>>.broadcast();
  StreamSubscription<ConnectionStatus>? _statusSub;
  StreamSubscription<Map<String, List<RoomInfo>>>? _roomsSub;
  StreamSubscription<ServerMessage>? _msgSub;
  bool _disposed = false;

  @override
  List<UploadProgress> get uploads => [
    for (final u in _uploads.values) _progressOf(u),
  ];

  @override
  Stream<List<UploadProgress>> get uploadsStream => _controller.stream;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  @override
  UploadHandle start(UploadSource source) {
    final peer = _conn.activePeer;
    if (_disposed || _conn.channel == null || peer == null) {
      throw const UploadFailure('offline', _kOfflineMessage);
    }
    final u = _Upload(
      id: _newId(),
      source: source,
      epk: peer.remoteEpk,
      roomId: _conn.activeRoomId,
      totalChunks: (source.size + chunkBytes - 1) ~/ chunkBytes,
      rto: ackTimeout,
      lastProgress: _now(),
    );
    // Callers listen through the handle; this only keeps a cancelled upload
    // nobody awaits from reporting an unhandled error.
    u.completer.future.ignore();
    // An empty file has no chunk to hash: its digest is known already.
    if (u.totalChunks == 0) u.sha256 = _emptySha256;
    _uploads[u.id] = u;
    _emit();
    unawaited(_announce(u));
    return UploadHandle(
      id: u.id,
      result: u.completer.future,
      cancel: () => cancel(u.id),
    );
  }

  @override
  void cancel(String id) {
    final u = _uploads[id];
    if (u == null) return;
    _fail(u, const UploadFailure('cancelled', 'Upload cancelled.'));
  }

  @override
  void Function() addOutcomeHandler(UploadOutcomeHandler handler) =>
      _router.add(handler);

  @override
  List<UploadFailed> takeUnseenFailures(String epk, String roomId) =>
      _router.takeUnseen(epk, roomId);

  @override
  void dispose() {
    _disposed = true;
    _statusSub?.cancel();
    _roomsSub?.cancel();
    _msgSub?.cancel();
    for (final u in _uploads.values.toList()) {
      _finish(u);
      u.completer.completeError(
        const UploadFailure('disposed', 'The app is closing.'),
      );
      unawaited(u.source.release());
    }
    _controller.close();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  void _onStatus(ConnectionStatus s) {
    if (_disposed) return;
    _msgSub?.cancel();
    _msgSub = null;
    if (s is StatusOnline) {
      _msgSub = s.channel.serverMessages.listen(
        _onServerMessage,
        onError: (Object _, StackTrace _) {},
      );
    }
    _onConnectionChanged();
  }

  /// Online and addressing the session [u] belongs to: the only time frames
  /// for it can reach the right session.
  bool _isOnSession(_Upload u) =>
      _conn.status is StatusOnline &&
      _conn.activePeer?.remoteEpk == u.epk &&
      _conn.activeRoomId == u.roomId;

  void _onConnectionChanged() {
    if (_disposed) return;
    for (final u in _uploads.values.toList()) {
      if (u.done) continue;
      if (!_isOnSession(u)) {
        _pause(u);
      } else if (u.paused) {
        _resume(u);
      } else if (u.channel != null && !identical(u.channel, _conn.channel)) {
        // A new socket without a visible gap: what was in flight is gone.
        unawaited(_reprobe(u));
      }
    }
  }

  void _pause(_Upload u) {
    if (u.done || u.paused) return;
    u.paused = true;
    _cancelRto(u);
    u.pauseTimer = Timer(pauseGrace, () {
      u.pauseTimer = null;
      _fail(
        u,
        const UploadFailure(
          'connection_lost',
          'The connection to the PC was lost during the upload.',
        ),
      );
    });
    _emit();
  }

  void _resume(_Upload u) {
    if (u.done || !u.paused) return;
    u.paused = false;
    u.pauseTimer?.cancel();
    u.pauseTimer = null;
    u.rto = ackTimeout;
    // The time spent away is not time the PC failed to answer.
    u.lastProgress = _now();
    _emit();
    unawaited(_reprobe(u));
  }

  // ---------------------------------------------------------------------------
  // Flow
  // ---------------------------------------------------------------------------

  /// The first frame: announces the upload. Nothing is read from the file yet.
  Future<void> _announce(_Upload u) async {
    await _sendStart(u);
    if (!u.done) _armRto(u);
  }

  /// A new socket, or a session that is open again: nothing sent before can be
  /// assumed to have arrived, and answers to earlier probes are void. Asks the
  /// PC where it stands; no chunk goes out until it answers.
  Future<void> _reprobe(_Upload u) async {
    if (u.done || u.paused) return;
    _cancelRto(u);
    u.openProbes.clear();
    await _sendStart(u);
    if (!u.done) _armRto(u);
  }

  /// Announces the upload, or (repeated) asks where the PC stands. Every start
  /// has its own request id; the PC echoes it in the ack that answers it.
  Future<void> _sendStart(_Upload u) async {
    final rid = _rid(u, 's${++u.starts}');
    u.openProbes.add(rid);
    while (u.openProbes.length > _kMaxOpenProbes) {
      u.openProbes.remove(u.openProbes.first);
    }
    final sent = await _send(
      u,
      UploadStart(
        id: rid,
        uploadId: u.id,
        name: u.source.name,
        size: u.source.size,
        mime: u.source.mime,
      ),
    );
    if (!sent) u.openProbes.remove(rid);
  }

  /// Sends chunks while the window has room, then `upload_end`. Idle while a
  /// probe is unanswered: the PC's position decides what is sent next.
  Future<void> _pump(_Upload u) async {
    if (u.pumping || u.done || u.paused || u.openProbes.isNotEmpty) return;
    u.pumping = true;
    try {
      while (!u.done &&
          !u.paused &&
          u.openProbes.isEmpty &&
          _isOnSession(u)) {
        if (u.nextToSend < u.totalChunks && u.nextToSend - u.acked < window) {
          final seq = u.nextToSend++;
          final String data;
          try {
            data = await _readChunk(u, seq);
          } catch (e) {
            debugPrint('[upload] cannot read ${u.source.name}: $e');
            _fail(
              u,
              const UploadFailure('unreadable', "Couldn't read that file."),
            );
            return;
          }
          if (u.done) return;
          final sent =
              !u.paused &&
              u.openProbes.isEmpty &&
              await _send(
                u,
                UploadChunk(
                  id: _rid(u, 'c$seq'),
                  uploadId: u.id,
                  seq: seq,
                  data: data,
                ),
              );
          if (!sent) {
            // The connection went away, or a probe went out, while the chunk
            // was being read: it goes out again once the PC has answered.
            if (u.nextToSend > seq) u.nextToSend = math.max(seq, u.acked);
            return;
          }
          _armRto(u);
          continue;
        }
        if (u.acked >= u.totalChunks && !u.endSent) {
          u.endSent = true;
          u.phase = UploadPhase.finishing;
          _emit();
          final sent = await _send(
            u,
            UploadEnd(id: _rid(u, 'e'), uploadId: u.id, sha256: u.sha256),
          );
          if (!sent) {
            u.endSent = false;
            return;
          }
          _armRto(u);
        }
        return;
      }
    } finally {
      u.pumping = false;
    }
  }

  /// Chunk [seq] as base64. The digest takes every chunk once, in order, from
  /// these reads: a chunk sent again is not hashed again.
  Future<String> _readChunk(_Upload u, int seq) async {
    // Normally nothing: the chunks before this one were read when first sent.
    while (u.hashedChunks < seq) {
      _hashChunk(u, await _readBytes(u, u.hashedChunks));
      if (u.done) return '';
    }
    final bytes = await _readBytes(u, seq);
    if (seq == u.hashedChunks) _hashChunk(u, bytes);
    return base64Encode(bytes);
  }

  Future<Uint8List> _readBytes(_Upload u, int seq) async {
    final start = seq * chunkBytes;
    final end = math.min(start + chunkBytes, u.source.size);
    final builder = BytesBuilder(copy: false);
    await for (final part in u.source.openRead(start, end)) {
      builder.add(part);
    }
    final bytes = builder.takeBytes();
    if (bytes.length != end - start) {
      throw StateError('read ${bytes.length} of ${end - start} bytes');
    }
    return bytes;
  }

  void _hashChunk(_Upload u, Uint8List bytes) {
    u.hashIn.add(bytes);
    u.hashedChunks += 1;
    if (u.hashedChunks == u.totalChunks) {
      u.hashIn.close();
      u.sha256 = u.hashOut.digest.toString();
    }
  }

  /// Sends one frame; false when it could not leave (offline, other session,
  /// socket closed). The next probe repairs whatever was lost.
  Future<bool> _send(_Upload u, ClientMessage msg) async {
    final ch = _conn.channel;
    if (ch == null || !_isOnSession(u)) return false;
    u.channel = ch;
    try {
      await ch.send(msg);
      return true;
    } catch (e) {
      debugPrint('[upload] send ${msg.runtimeType} failed: $e');
      return false;
    }
  }

  /// Request ids carry the action prefix so SyncService keeps an `error`
  /// answering them out of the chat, and the upload they belong to.
  String _rid(_Upload u, String frame) =>
      '$kActionRequestIdPrefix${_requestPrefix(u.id)}$frame';

  static String _requestPrefix(String uploadId) => 'up_${uploadId}_';

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  void _armRto(_Upload u) {
    _cancelRto(u);
    if (u.done || u.paused) return;
    u.rtoTimer = Timer(
      u.startAcked ? u.rto : startAckTimeout,
      () => unawaited(_onRto(u)),
    );
  }

  void _cancelRto(_Upload u) {
    u.rtoTimer?.cancel();
    u.rtoTimer = null;
  }

  Future<void> _onRto(_Upload u) async {
    u.rtoTimer = null;
    if (u.done || u.paused) return;
    if (!u.startAcked) {
      u.startAttempts += 1;
      if (u.startAttempts >= startAttempts) {
        _fail(u, const UploadFailure('no_response', _kNoResponseMessage));
        return;
      }
      await _sendStart(u);
      if (!u.done) _armRto(u);
      return;
    }
    if (_now().difference(u.lastProgress) >= stallTimeout) {
      _fail(
        u,
        const UploadFailure(
          'stalled',
          'The upload stalled: the PC stopped responding.',
        ),
      );
      return;
    }
    u.rto = Duration(
      microseconds: math.min(
        u.rto.inMicroseconds * 2,
        maxAckTimeout.inMicroseconds,
      ),
    );
    // Only a question: whatever is still in the socket is on its way, and
    // sending it again would queue it twice.
    await _sendStart(u);
    if (!u.done) _armRto(u);
  }

  // ---------------------------------------------------------------------------
  // Frames from the PC
  // ---------------------------------------------------------------------------

  void _onServerMessage(ServerMessage msg) {
    switch (msg) {
      case UploadAck():
        _onAck(msg);
      case UploadDone():
        _onDone(msg);
      case UploadError():
        _onError(msg);
      case ErrorMessage(:final inReplyTo?, :final code, :final message):
        _onRequestError(inReplyTo, code, message);
      default:
        break;
    }
  }

  void _onAck(UploadAck ack) {
    final u = _uploads[ack.uploadId];
    if (u == null || u.done) return;
    final next = math.max(0, math.min(ack.seq, u.totalChunks));
    final first = !u.startAcked;
    final echo = ack.inReplyTo;
    final answersProbe = echo != null
        ? u.openProbes.contains(echo)
        : u.openProbes.isNotEmpty;
    if (first || answersProbe) {
      // The PC's position after every frame that reached it before the probe:
      // whatever lies beyond it was lost (or never sent) and goes out again
      // from here, `upload_end` included. Probes still open are void.
      final advanced = next > u.acked;
      u.startAcked = true;
      u.openProbes.clear();
      u.acked = next;
      u.nextToSend = next;
      u.endSent = false;
      if (first || advanced) {
        u.lastProgress = _now();
        u.rto = ackTimeout;
      }
    } else if (next > u.acked) {
      u.acked = next;
      if (u.nextToSend < next) u.nextToSend = next;
      u.lastProgress = _now();
      u.rto = ackTimeout;
    } else {
      return; // Duplicate or stale ack: nothing moved.
    }
    u.phase = u.endSent ? UploadPhase.finishing : UploadPhase.sending;
    _armRto(u);
    _emit();
    unawaited(_pump(u));
  }

  void _onDone(UploadDone done) {
    final u = _uploads[done.uploadId];
    if (u == null || u.done) return;
    _finish(u);
    final result = UploadResult(
      id: u.id,
      name: u.source.name,
      path: done.path,
      size: done.size,
      epk: u.epk,
      roomId: u.roomId,
    );
    u.completer.complete(result);
    unawaited(u.source.release());
    _router.dispatch(result);
  }

  void _onError(UploadError err) {
    final u = _uploads[err.uploadId];
    if (u == null || u.done) return;
    if (err.code == 'unknown_upload' || err.code == 'timeout') {
      // The PC lost the upload (idle timeout, Remote OMP restarted). Frames
      // already in flight draw more of these: only the first starts it over.
      if (!u.startAcked) return;
      if (u.restarts < maxRestarts) {
        _restart(u);
        return;
      }
    }
    _fail(u, UploadFailure(err.code, err.message), notifyPc: false);
  }

  /// `error` frames answer a request by id. A PC that predates uploads does
  /// not know the frame types, so this is how "too old" can show up.
  void _onRequestError(String inReplyTo, String code, String message) {
    if (!inReplyTo.startsWith(kActionRequestIdPrefix)) return;
    final rest = inReplyTo.substring(kActionRequestIdPrefix.length);
    for (final u in _uploads.values.toList()) {
      if (!rest.startsWith(_requestPrefix(u.id))) continue;
      final old = code == 'unsupported_type' || code == 'invalid_message';
      _fail(
        u,
        old
            ? const UploadFailure('unsupported', _kUnsupportedMessage)
            : UploadFailure(code, message.isEmpty ? code : message),
        notifyPc: false,
      );
      return;
    }
  }

  /// The PC lost the upload: forget its position and announce it afresh.
  void _restart(_Upload u) {
    u.restarts += 1;
    u.startAcked = false;
    u.startAttempts = 0;
    u.acked = 0;
    u.nextToSend = 0;
    u.endSent = false;
    u.openProbes.clear();
    u.phase = UploadPhase.starting;
    u.rto = ackTimeout;
    u.lastProgress = _now();
    _cancelRto(u);
    _emit();
    unawaited(_announce(u));
  }

  // ---------------------------------------------------------------------------
  // Ending
  // ---------------------------------------------------------------------------

  /// Marks [u] over: no timers, out of the list.
  void _finish(_Upload u) {
    u.done = true;
    _cancelRto(u);
    u.pauseTimer?.cancel();
    u.pauseTimer = null;
    _uploads.remove(u.id);
    _emit();
  }

  void _fail(_Upload u, UploadFailure failure, {bool notifyPc = true}) {
    if (u.done) return;
    final canTell = _isOnSession(u);
    _finish(u);
    // Frees the PC's partial file now instead of after its idle timeout.
    if (notifyPc && canTell) {
      unawaited(
        _conn.channel
                ?.send(UploadCancel(id: _rid(u, 'x'), uploadId: u.id))
                .catchError((Object _) {}) ??
            Future<void>.value(),
      );
    }
    u.completer.completeError(failure);
    unawaited(u.source.release());
    _router.dispatch(
      UploadFailed(
        id: u.id,
        name: u.source.name,
        failure: failure,
        epk: u.epk,
        roomId: u.roomId,
      ),
    );
  }

  UploadProgress _progressOf(_Upload u) => UploadProgress(
    id: u.id,
    name: u.source.name,
    size: u.source.size,
    ackedBytes: math.min(u.acked * chunkBytes, u.source.size),
    phase: u.phase,
    epk: u.epk,
    roomId: u.roomId,
    waiting: u.paused,
  );

  void _emit() {
    if (!_controller.isClosed) _controller.add(uploads);
  }
}

/// Keeps the digest `package:crypto` produces when the chunked hash closes.
class _DigestSink implements Sink<crypto.Digest> {
  crypto.Digest? digest;

  @override
  void add(crypto.Digest data) => digest = data;

  @override
  void close() {}
}

class _Upload {
  _Upload({
    required this.id,
    required this.source,
    required this.epk,
    required this.roomId,
    required this.totalChunks,
    required this.rto,
    required this.lastProgress,
  });

  final String id;
  final UploadSource source;
  final String epk;
  final String roomId;
  final int totalChunks;
  final Completer<UploadResult> completer = Completer<UploadResult>();

  UploadPhase phase = UploadPhase.starting;

  /// The PC has answered `upload_start` (any `upload_ack`).
  bool startAcked = false;

  /// Request ids of the `upload_start` frames the PC has not answered: the
  /// first one and the probes. While any is open no chunk is sent.
  final Set<String> openProbes = {};
  int starts = 0;

  /// Chunks below this are on the PC's disk, in order.
  int acked = 0;
  int nextToSend = 0;
  bool endSent = false;
  bool paused = false;
  bool pumping = false;
  bool done = false;
  int startAttempts = 0;
  int restarts = 0;
  Duration rto;

  /// The last time the cumulative ack advanced (or the PC first answered).
  DateTime lastProgress;
  Timer? rtoTimer;
  Timer? pauseTimer;

  /// The channel of the last frame sent; a different one means a reconnect.
  Object? channel;

  /// The digest of the file, fed by the chunk reads in order.
  final _DigestSink hashOut = _DigestSink();
  late final ByteConversionSink hashIn = crypto.sha256.startChunkedConversion(
    hashOut,
  );
  int hashedChunks = 0;

  /// Complete once every chunk has been read: it goes with `upload_end`.
  String? sha256;
}

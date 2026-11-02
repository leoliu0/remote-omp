// Plan 29 — VoiceInputViewModel state machine: recording / transcribe / cancel
// / cap / permission, against a fake SpeechService.

import 'dart:async';

import 'package:app/data/voice/speech_service.dart';
import 'package:app/ui/chat/voice/states/voice_input_state.dart';
import 'package:app/ui/chat/voice/viewmodels/voice_input_viewmodel.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeSpeechService implements SpeechService {
  SpeechAvailability availability = const SpeechReady('en_US');
  String transcript = 'hello world';
  @override
  String? lastError;
  Object? startError;

  final StreamController<double> _level = StreamController<double>.broadcast();
  int startCalls = 0;
  int stopCalls = 0;
  int cancelCalls = 0;
  String? startedLocale;
  Duration? startedMax;

  @override
  Future<SpeechAvailability> init({String? preferredLocaleId}) async =>
      availability;

  @override
  Stream<double> get soundLevel => _level.stream;

  @override
  Future<void> start({
    required String localeId,
    required Duration maxDuration,
  }) async {
    startCalls++;
    startedLocale = localeId;
    startedMax = maxDuration;
    if (startError != null) throw startError!;
  }

  @override
  Future<String> stop() async {
    stopCalls++;
    return transcript;
  }

  @override
  Future<void> cancel() async => cancelCalls++;

  @override
  void dispose() => _level.close();

  void emitLevel(double level) => _level.add(level);
}

void main() {
  // A failing recognizer (no network, no offline model) used to end as an
  // empty transcript, so the mic silently did nothing.
  group('recognizer failures', () {
    Future<List<String>> run(_FakeSpeechService svc) async {
      final vm = VoiceInputViewModel(svc);
      final failures = <String>[];
      final sub = vm.failures.listen(failures.add);
      await vm.startRecording();
      await vm.stopAndTranscribe();
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();
      expect(vm.state, const VoiceIdle());
      vm.dispose();
      return failures;
    }

    test('an error with no transcript is reported', () async {
      final svc = _FakeSpeechService()
        ..transcript = ''
        ..lastError = 'error_network';
      expect(await run(svc), ['error_network']);
    });

    test(
      'silence (no_match / speech_timeout) stays a quiet no-op (#12)',
      () async {
        for (final code in ['error_no_match', 'error_speech_timeout']) {
          final svc = _FakeSpeechService()
            ..transcript = ''
            ..lastError = code;
          expect(await run(svc), isEmpty);
        }
      },
    );

    test('an error after some text keeps the text, no report', () async {
      final svc = _FakeSpeechService()..lastError = 'error_client';
      expect(await run(svc), isEmpty);
    });

    test('a listen that throws is reported and leaves the mic idle', () async {
      final svc = _FakeSpeechService()..startError = Exception('busy');
      final vm = VoiceInputViewModel(svc);
      final failures = <String>[];
      final sub = vm.failures.listen(failures.add);
      await vm.startRecording();
      await Future<void>.delayed(Duration.zero);
      expect(vm.state, const VoiceIdle());
      expect(failures, ['listen_failed']);
      await sub.cancel();
      vm.dispose();
    });
  });

  group('startRecording', () {
    test('start → VoiceRecording, with the resolved locale + cap', () async {
      final svc = _FakeSpeechService();
      final vm = VoiceInputViewModel(
        svc,
        maxDuration: const Duration(seconds: 30),
      );
      await vm.startRecording();
      expect(vm.state, isA<VoiceRecording>());
      expect(svc.startCalls, 1);
      expect(svc.startedLocale, 'en_US');
      expect(svc.startedMax, const Duration(seconds: 30));
      vm.dispose();
    });

    test('sound level updates flow into VoiceRecording.level', () async {
      final svc = _FakeSpeechService();
      final vm = VoiceInputViewModel(svc);
      await vm.startRecording();
      svc.emitLevel(0.7);
      await Future<void>.delayed(Duration.zero);
      expect((vm.state as VoiceRecording).level, 0.7);
      vm.dispose();
    });

    test(
      'permission denied → VoiceUnavailable(permissionDenied), no capture',
      () async {
        final svc = _FakeSpeechService()
          ..availability = const SpeechPermissionDenied();
        final vm = VoiceInputViewModel(svc);
        await vm.startRecording();
        expect(
          vm.state,
          const VoiceUnavailable(VoiceUnavailableReason.permissionDenied),
        );
        expect(svc.startCalls, 0);
        vm.dispose();
      },
    );

    test('unsupported → VoiceUnavailable(unsupported)', () async {
      final svc = _FakeSpeechService()
        ..availability = const SpeechUnsupported();
      final vm = VoiceInputViewModel(svc);
      await vm.startRecording();
      expect(
        vm.state,
        const VoiceUnavailable(VoiceUnavailableReason.unsupported),
      );
      vm.dispose();
    });
  });

  group('stop / cancel', () {
    test(
      'stop → VoiceTranscribing → idle, transcript on stream + returned',
      () async {
        final svc = _FakeSpeechService()..transcript = 'ship it';
        final vm = VoiceInputViewModel(svc);
        final transitions = <VoiceInputState>[];
        vm.addListener(() => transitions.add(vm.state));
        final got = <String>[];
        final sub = vm.transcripts.listen(got.add);

        await vm.startRecording();
        final text = await vm.stopAndTranscribe();
        await Future<void>.delayed(Duration.zero);

        expect(text, 'ship it');
        expect(got, ['ship it']);
        expect(transitions.whereType<VoiceTranscribing>(), isNotEmpty);
        expect(vm.state, isA<VoiceIdle>());
        expect(svc.stopCalls, 1);
        await sub.cancel();
        vm.dispose();
      },
    );

    test('cancel → idle, no transcript, no stop', () async {
      final svc = _FakeSpeechService();
      final vm = VoiceInputViewModel(svc);
      final got = <String>[];
      final sub = vm.transcripts.listen(got.add);

      await vm.startRecording();
      await vm.cancel();
      await Future<void>.delayed(Duration.zero);

      expect(vm.state, isA<VoiceIdle>());
      expect(svc.cancelCalls, 1);
      expect(svc.stopCalls, 0);
      expect(got, isEmpty);
      await sub.cancel();
      vm.dispose();
    });

    test('stopAndTranscribe is a no-op when not recording', () async {
      final svc = _FakeSpeechService();
      final vm = VoiceInputViewModel(svc);
      expect(await vm.stopAndTranscribe(), isEmpty);
      expect(svc.stopCalls, 0);
      vm.dispose();
    });
  });

  group('60s cap (#5)', () {
    test('reaching maxDuration auto-stops and delivers the transcript', () {
      fakeAsync((async) {
        final svc = _FakeSpeechService()..transcript = 'capped text';
        final vm = VoiceInputViewModel(
          svc,
          maxDuration: const Duration(milliseconds: 600),
          tickInterval: const Duration(milliseconds: 200),
        );
        final got = <String>[];
        vm.transcripts.listen(got.add);

        // ignore: discarded_futures
        vm.startRecording();
        async.flushMicrotasks();
        expect(vm.state, isA<VoiceRecording>());

        // Two ticks — still recording, elapsed advancing.
        async.elapse(const Duration(milliseconds: 400));
        expect(vm.state, isA<VoiceRecording>());
        expect(
          (vm.state as VoiceRecording).elapsed,
          const Duration(milliseconds: 400),
        );

        // Third tick hits the cap → auto stop → idle + transcript.
        async.elapse(const Duration(milliseconds: 200));
        async.flushMicrotasks();
        expect(svc.stopCalls, 1);
        expect(got, ['capped text']);
        expect(vm.state, isA<VoiceIdle>());
        vm.dispose();
      });
    });
  });
}

import 'package:app/data/platform/keyboard_inset_guard.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

// A Samsung phone kept the keyboard's bottom inset after the keyboard closed
// (Flutter's IME animation never got its onEnd), leaving a black band under
// the input bar until restart. The guard asks the platform to re-apply the
// real insets once a bottom inset has settled.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('remote_pi/window');
  late List<String> calls;

  setUp(() {
    calls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return true;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  KeyboardInsetGuard guard(double Function() bottom) =>
      KeyboardInsetGuard(channel: channel, bottomInset: bottom, isAndroid: true);

  test('a bottom inset that settles triggers one resync after the delay', () {
    fakeAsync((async) {
      final g = guard(() => 780);
      g.didChangeMetrics();
      async.elapse(const Duration(milliseconds: 600));
      expect(calls, isEmpty);
      async.elapse(const Duration(milliseconds: 200));
      expect(calls, ['resyncInsets']);
    });
  });

  test('no bottom inset → no resync', () {
    fakeAsync((async) {
      final g = guard(() => 0);
      g.didChangeMetrics();
      async.elapse(const Duration(seconds: 2));
      expect(calls, isEmpty);
    });
  });

  test('a burst of metric changes (keyboard animation) resyncs once, after the last', () {
    fakeAsync((async) {
      final g = guard(() => 780);
      for (var i = 0; i < 20; i++) {
        g.didChangeMetrics();
        async.elapse(const Duration(milliseconds: 16));
      }
      expect(calls, isEmpty);
      async.elapse(const Duration(seconds: 1));
      expect(calls, ['resyncInsets']);
    });
  });

  test('resuming with a stuck inset resyncs', () {
    fakeAsync((async) {
      final g = guard(() => 780);
      g.didChangeAppLifecycleState(AppLifecycleState.resumed);
      async.elapse(const Duration(seconds: 1));
      expect(calls, ['resyncInsets']);
    });
  });

  test('a missing platform handler is ignored', () {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    fakeAsync((async) {
      final g = guard(() => 780);
      g.didChangeMetrics();
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();
    });
  });

  // While the IME animation is stuck, Flutter also swallows the insets of a
  // rotation: back in portrait the page kept landscape's top padding, so the
  // top bar sat under the status bar. A rotation resyncs with no bottom inset.
  test('a rotation resyncs even with no bottom inset', () {
    fakeAsync((async) {
      var landscape = true;
      final g = KeyboardInsetGuard(
        channel: channel,
        bottomInset: () => 0,
        landscape: () => landscape,
        isAndroid: true,
      );
      landscape = false;
      g.didChangeMetrics();
      async.elapse(const Duration(seconds: 1));
      expect(calls, ['resyncInsets']);
      // Same orientation again: nothing to resync.
      g.didChangeMetrics();
      async.elapse(const Duration(seconds: 1));
      expect(calls, ['resyncInsets']);
    });
  });

  test('does nothing off Android', () {
    fakeAsync((async) {
      final g = KeyboardInsetGuard(channel: channel, bottomInset: () => 780, isAndroid: false);
      g.didChangeMetrics();
      async.elapse(const Duration(seconds: 1));
      expect(calls, isEmpty);
    });
  });
}

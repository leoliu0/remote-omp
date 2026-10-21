import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Works around a stuck keyboard inset on Android.
///
/// Flutter's engine holds IME insets back while the keyboard animates and
/// applies the final value in the animation's `onEnd`. When Android never
/// delivers `onEnd` (seen on Samsung), the keyboard's height stays as the
/// bottom inset after the keyboard closes: a black band under the input bar
/// until restart. Once a bottom inset has settled (or the app resumes with
/// one), this asks `MainActivity` to re-apply the real window insets; it does
/// nothing there while the keyboard is actually visible.
class KeyboardInsetGuard with WidgetsBindingObserver {
  KeyboardInsetGuard({
    MethodChannel? channel,
    double Function()? bottomInset,
    bool? isAndroid,
    this.delay = const Duration(milliseconds: 700),
  }) : _channel = channel ?? const MethodChannel('remote_pi/window'),
       _bottomInset = bottomInset ?? _currentBottomInset,
       _isAndroid = isAndroid ?? Platform.isAndroid;

  final MethodChannel _channel;
  final double Function() _bottomInset;
  final bool _isAndroid;
  final Duration delay;
  Timer? _timer;

  static double _currentBottomInset() {
    final views = WidgetsBinding.instance.platformDispatcher.views;
    return views.isEmpty ? 0 : views.first.viewInsets.bottom;
  }

  void start() {
    if (_isAndroid) WidgetsBinding.instance.addObserver(this);
  }

  void stop() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
  }

  @override
  void didChangeMetrics() => _schedule();

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _schedule();
  }

  void _schedule() {
    if (!_isAndroid) return;
    _timer?.cancel();
    _timer = Timer(delay, _check);
  }

  Future<void> _check() async {
    if (_bottomInset() <= 0) return;
    try {
      await _channel.invokeMethod<bool>('resyncInsets');
    } on MissingPluginException {
      // Older native side or a test host: nothing to resync.
    } on PlatformException {
      // Best effort; a later metrics change retries.
    }
  }
}

import 'dart:async';

import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/widgets/agent_markdown.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';

/// Plan/57 — full-screen modal rendering an interactive `extension_ui_request`
/// (ask_user via pi-ask).
///
/// Drives the rich `ask` envelope when present (single/multi/preview options +
/// custom text per question), else falls back to the plain SDK method
/// (select/input/confirm). Submits an [ExtensionUiResponse] via [onRespond];
/// the [ChatViewModel] clears the pending request (removing this sheet from the
/// tree) and relays the answer to pi-ask through the bridge.
///
/// Validation follows pi-ask's rules: for non-multi questions a custom text and
/// a selected value can't be combined, so custom text wins when present.
class ExtensionUiSheet extends StatefulWidget {
  final ExtensionUiRequest request;

  /// Plan/57 — submit-result rejection message for [request] (null when none /
  /// resolved). Surfaced so the user can retry instead of hitting a dead end
  /// when pi-ask rejects an answer.
  final String? error;
  final Future<void> Function(ExtensionUiResponse) onRespond;

  const ExtensionUiSheet({
    super.key,
    required this.request,
    this.error,
    required this.onRespond,
  });

  @override
  State<ExtensionUiSheet> createState() => _ExtensionUiSheetState();
}

class _ExtensionUiSheetState extends State<ExtensionUiSheet> {
  // Rich (ask) state: question id → selected option values.
  final Map<String, Set<String>> _selected = {};
  // Rich: question id → custom text controller (lazily created, disposed).
  final Map<String, TextEditingController> _custom = {};
  // Rich: question id → note controller (pi-ask `note`), created on demand
  // when the user taps "Add note".
  final Map<String, TextEditingController> _notes = {};
  // Degraded (no ask envelope) state.
  String? _singleValue;
  // Editor requests open with their `prefill` (the SDK contract), editable.
  late final TextEditingController _textController = TextEditingController(
    text: widget.request.method == ExtensionUiMethod.editor
        ? (widget.request.prefill ?? '')
        : '',
  );
  bool _submitting = false;
  // Plan/57 — backstop so a submit/cancel that never gets a `completed`/error
  // (relay drop, pi-ask gone) doesn't strand the user on a spinner forever.
  Timer? _submitTimeout;
  bool _awaitHint = false;
  // Multi-question asks: index of the question currently shown, and the
  // pending single-choice auto-advance.
  int _page = 0;
  Timer? _advanceTimer;
  // Non-required questions the user deliberately skipped (stepper only).
  final Set<String> _skipped = {};

  AskEnrichmentWire? get _ask => widget.request.ask;

  bool get _isConfirm =>
      _ask == null && widget.request.method == ExtensionUiMethod.confirm;

  @override
  void didUpdateWidget(covariant ExtensionUiSheet oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Either a different request replaced this one, or a rejection arrived for
    // the same request — in both cases stop spinning so the user can act. An
    // error being CLEARED (non-null → null) must not reset: that's the
    // viewmodel wiping the old message at the start of a retry, and stopping
    // there would re-enable the buttons mid-flight (double submit).
    // NB: chat_page keys this sheet by ValueKey(request.id), so a different
    // request id never reaches didUpdateWidget (a fresh State is created
    // instead) — the id check below is defensive only; the live transition is
    // "error arrived for the same request".
    final errorArrived =
        widget.error != oldWidget.error && widget.error != null;
    if (widget.request.id != oldWidget.request.id || errorArrived) {
      _submitTimeout?.cancel();
      setState(() {
        _submitting = false;
        _awaitHint = false;
      });
    }
  }

  void _armSubmitTimeout() {
    _submitTimeout?.cancel();
    _submitTimeout = Timer(const Duration(seconds: 10), () {
      if (!mounted || !_submitting) return;
      setState(() {
        _submitting = false;
        _awaitHint = true;
      });
    });
  }

  @override
  void dispose() {
    _advanceTimer?.cancel();
    _submitTimeout?.cancel();
    for (final c in _custom.values) {
      c.dispose();
    }
    for (final c in _notes.values) {
      c.dispose();
    }
    _textController.dispose();
    super.dispose();
  }

  TextEditingController _customFor(String qid) =>
      _custom.putIfAbsent(qid, TextEditingController.new);

  /// pi-ask: `presentedType` is what the TUI actually shows after a live
  /// toggle / policy, so it wins over the requested `type`.
  bool _isMulti(AskQuestionWire q) =>
      (q.presentedType ?? q.type) == AskQuestionWireType.multi;

  /// Multi-question asks are answered one page at a time; a single question
  /// keeps the one-page layout.
  bool get _isStepper => (_ask?.questions.length ?? 0) > 1;

  bool get _isLastPage => _page >= (_ask?.questions.length ?? 1) - 1;

  bool _isAnswered(AskQuestionWire q) =>
      (_selected[q.id]?.isNotEmpty ?? false) ||
      _customFor(q.id).text.trim().isNotEmpty;

  /// Answered, or deliberately skipped (non-required questions only).
  bool _isDone(AskQuestionWire q) =>
      _isAnswered(q) || _skipped.contains(q.id);

  /// Skip is offered only inside a multi-question ask, on a question the
  /// agent did not mark `required`, while it is still unanswered.
  bool _canSkip(AskQuestionWire q) =>
      _isStepper && !q.required && !_isAnswered(q);

  bool get _currentDone {
    final ask = _ask;
    return ask != null && _isDone(ask.questions[_page]);
  }

  bool get _currentAnswered {
    final ask = _ask;
    return ask != null && _isAnswered(ask.questions[_page]);
  }

  bool get _hasAnyAnswer =>
      _skipped.isNotEmpty ||
      _selected.values.any((s) => s.isNotEmpty) ||
      _custom.values.any((c) => c.text.trim().isNotEmpty) ||
      _notes.values.any((c) => c.text.trim().isNotEmpty);

  bool get _canSubmit {
    final ask = _ask;
    if (ask != null) {
      // Every question needs an answer (or a deliberate Skip on a
      // non-required one): a partial submit silently skipped the rest on the
      // phone.
      return ask.questions.isNotEmpty && ask.questions.every(_isDone);
    }
    return switch (widget.request.method) {
      ExtensionUiMethod.select => _singleValue != null,
      ExtensionUiMethod.input ||
      ExtensionUiMethod.editor => _textController.text.trim().isNotEmpty,
      ExtensionUiMethod.confirm => true,
      ExtensionUiMethod.notify => false,
    };
  }

  Future<void> _submit() async {
    if (!_canSubmit || _submitting) return;
    await _send(_buildResponse());
  }

  /// SDK confirm: Yes → `confirmed: true`, No → `confirmed: false` (a "no" is
  /// an answer, not a cancel; the close button still cancels).
  Future<void> _confirm(bool confirmed) async {
    if (_submitting) return;
    await _send(
      ExtensionUiResponse(id: widget.request.id, confirmed: confirmed),
    );
  }

  Future<void> _send(ExtensionUiResponse response) async {
    setState(() {
      _submitting = true;
      _awaitHint = false;
    });
    _armSubmitTimeout();
    await widget.onRespond(response);
    // The modal stays open until the ChatViewModel clears the pending request
    // on the `completed` dismiss notify (or surfaces an error for retry).
  }

  /// Close / Android back on the first page: with answers on hand, confirm
  /// before throwing them away; otherwise cancel straight away.
  Future<void> _requestCancel() async {
    if (_submitting) return;
    if (_ask != null && _hasAnyAnswer) {
      final discard = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Discard answers?'),
          content: const Text('Your answers so far will be lost.'),
          actions: [
            TextButton(
              key: const ValueKey('ask-discard-cancel'),
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const ValueKey('ask-discard-confirm'),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Discard'),
            ),
          ],
        ),
      );
      if (discard != true || !mounted) return;
    }
    await _cancel();
  }

  Future<void> _cancel() async {
    if (_submitting) return;
    final ask = _ask;
    await _send(
      ExtensionUiResponse(
        id: widget.request.id,
        cancelled: true,
        ask: ask != null
            ? AskResponseEnrichmentWire(flowId: ask.flowId, isCancel: true)
            : null,
      ),
    );
  }

  ExtensionUiResponse _buildResponse() {
    final id = widget.request.id;
    final ask = _ask;
    if (ask != null) {
      final answers = <String, AskAnswerWire>{};
      for (final q in ask.questions) {
        final selected =
            _selected[q.id]?.toList(growable: false) ?? const <String>[];
        final custom = _customFor(q.id).text.trim();
        final note = _notes[q.id]?.text.trim() ?? '';
        final multi = _isMulti(q);

        // pi-ask forbids combining value + customText on non-multi questions.
        final values = multi
            ? selected
            : (custom.isNotEmpty ? const <String>[] : selected);
        final customText = custom.isEmpty ? null : custom;
        if (values.isEmpty && customText == null && note.isEmpty) continue;
        answers[q.id] = AskAnswerWire(
          values: values,
          customText: customText,
          note: note.isEmpty ? null : note,
        );
      }
      return ExtensionUiResponse(
        id: id,
        ask: AskResponseEnrichmentWire(
          flowId: ask.flowId,
          mode: 'submit',
          answers: answers,
        ),
      );
    }
    // Degraded: plain SDK response shape. The bridge maps the select label back
    // to the option value via its per-request table.
    return switch (widget.request.method) {
      ExtensionUiMethod.select => ExtensionUiResponse(
        id: id,
        value: _singleValue ?? '',
      ),
      ExtensionUiMethod.input || ExtensionUiMethod.editor =>
        ExtensionUiResponse(id: id, value: _textController.text),
      ExtensionUiMethod.confirm => ExtensionUiResponse(
        id: id,
        confirmed: true,
      ),
      ExtensionUiMethod.notify => ExtensionUiResponse(id: id, cancelled: true),
    };
  }

  void _toggle(String qid, String value, bool multi) {
    setState(() {
      final set = _selected.putIfAbsent(qid, () => <String>{});
      if (multi) {
        if (set.contains(value)) {
          set.remove(value);
        } else {
          set.add(value);
        }
      } else {
        set
          ..clear()
          ..add(value);
        // Single-choice: a picked option and custom text can't be combined.
        _customFor(qid).clear();
      }
      _skipped.remove(qid);
    });
    // Single-choice picks move on by themselves after a short beat so the
    // selection is visible; the last page waits for an explicit Submit and
    // multi-choice never advances (more picks may follow).
    if (!multi && _isStepper && !_isLastPage) {
      final from = _page;
      _advanceTimer?.cancel();
      _advanceTimer = Timer(const Duration(milliseconds: 250), () {
        if (!mounted || _submitting || _page != from || !_currentAnswered) {
          return;
        }
        _goNext();
      });
    }
  }

  void _goNext() {
    _advanceTimer?.cancel();
    if (_submitting || _isLastPage || !_currentDone) return;
    setState(() => _page++);
  }

  /// Deliberate "Skip" on a non-required question: recorded as unanswered
  /// (absent from the response) but lets Next/Submit proceed.
  void _skipCurrent() {
    final ask = _ask;
    if (ask == null || _submitting) return;
    setState(() => _skipped.add(ask.questions[_page].id));
    _goNext();
  }

  Widget _buildSkip(AskQuestionWire q) {
    final colors = context.colors;
    if (_skipped.contains(q.id)) {
      return Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Row(
          children: [
            Text(
              'Skipped',
              style: TextStyle(color: colors.muted, fontSize: 13),
            ),
            const SizedBox(width: 8),
            TextButton(
              key: const ValueKey('ask-unskip'),
              onPressed: _submitting
                  ? null
                  : () => setState(() => _skipped.remove(q.id)),
              child: const Text('Undo'),
            ),
          ],
        ),
      );
    }
    if (!_canSkip(q)) return const SizedBox.shrink();
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton(
        key: const ValueKey('ask-skip'),
        onPressed: _submitting ? null : _skipCurrent,
        child: const Text('Skip this question'),
      ),
    );
  }

  void _goBack() {
    _advanceTimer?.cancel();
    if (_submitting || _page == 0) return;
    setState(() => _page--);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final ask = _ask;
    final title = widget.request.title ?? ask?.title ?? 'Clarification needed';

    // System back (Android) mirrors the close button: cancel the flow instead
    // of popping the chat route underneath while the modal is still overlaid.
    // On a later page of a multi-question ask it steps back one question.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || _submitting) return;
        if (_isStepper && _page > 0) {
          _goBack();
        } else {
          _requestCancel();
        }
      },
      child: Material(
        color: colors.bg,
        child: SafeArea(
          child: Scaffold(
            backgroundColor: colors.bg,
            resizeToAvoidBottomInset: true,
            appBar: AppBar(
              backgroundColor: colors.bg,
              elevation: 0,
              scrolledUnderElevation: 0,
              leading: IconButton(
                icon: const Icon(Icons.close),
                tooltip: 'Cancel',
                onPressed: _submitting ? null : _requestCancel,
              ),
              title: Text(title),
            ),
            body: ask != null
                ? _buildRich(context, ask)
                : _buildDegraded(context),
            bottomNavigationBar: _buildActions(context),
          ),
        ),
      ),
    );
  }

  Widget _buildRich(BuildContext context, AskEnrichmentWire ask) {
    if (!_isStepper) {
      return ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        itemCount: ask.questions.length,
        separatorBuilder: (_, _) => const SizedBox(height: 24),
        itemBuilder: (context, i) => _buildQuestion(context, ask.questions[i]),
      );
    }
    // One question per page; the keyed ListView resets the scroll offset on
    // every step. Answers live in the per-question maps/controllers, so Back
    // and Next never lose them.
    final q = ask.questions[_page];
    final total = ask.questions.length;
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                '${_page + 1}/$total',
                key: const ValueKey('ask-step'),
                style: Theme.of(
                  context,
                ).textTheme.labelLarge?.copyWith(color: colors.muted),
              ),
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(2),
                child: LinearProgressIndicator(
                  key: const ValueKey('ask-progress'),
                  value: (_page + 1) / total,
                  minHeight: 3,
                  color: colors.accent,
                  backgroundColor: colors.border,
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            key: ValueKey('ask-page-${q.id}'),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
            children: [_buildQuestion(context, q), _buildSkip(q)],
          ),
        ),
      ],
    );
  }

  Widget _buildQuestion(BuildContext context, AskQuestionWire q) {
    final colors = context.colors;
    final text = Theme.of(context).textTheme;
    final multi = _isMulti(q);
    final sel = _selected[q.id] ?? <String>{};

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: Text(q.prompt, style: text.titleMedium)),
            // pi-ask marks `required` as advisory only (never blocks
            // submission), so it renders as a hint, not a validation gate.
            if (q.required)
              Padding(
                padding: const EdgeInsets.only(left: 8, top: 4),
                child: Text(
                  'required',
                  style: text.labelSmall?.copyWith(color: colors.accent),
                ),
              ),
            if (multi)
              Padding(
                padding: const EdgeInsets.only(left: 8, top: 4),
                child: Text(
                  'multi',
                  style: text.labelSmall?.copyWith(color: colors.muted),
                ),
              ),
          ],
        ),
        // The label is a short header chip (ask tool `header`); when the
        // question has none it equals the prompt — don't print it twice.
        if (q.label.isNotEmpty && q.label != q.prompt) ...[
          const SizedBox(height: 2),
          Text(q.label, style: text.labelSmall?.copyWith(color: colors.muted)),
        ],
        const SizedBox(height: 12),
        for (final o in q.options) ...[
          _optionTile(context, q, o, multi, sel),
          const SizedBox(height: 8),
        ],
        TextField(
          controller: _customFor(q.id),
          enabled: !_submitting,
          // _canSubmit reads this text; without a rebuild per keystroke the
          // Submit button would stay stale for text-only answers. On a
          // single-choice question typed text replaces the selection (they
          // can't be combined), so what is shown is what is sent.
          onChanged: (v) => setState(() {
            if (v.trim().isEmpty) return;
            _skipped.remove(q.id);
            if (!multi) _selected[q.id]?.clear();
          }),
          decoration: InputDecoration(
            hintText: 'Type your own…',
            isDense: true,
            border: const OutlineInputBorder(),
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 12,
              vertical: 12,
            ),
          ),
        ),
        _buildNote(context, q),
      ],
    );
  }

  /// pi-ask `note`: optional context attached to a question's answer. Hidden
  /// behind "Add note" so the common single-tap answer stays uncluttered.
  Widget _buildNote(BuildContext context, AskQuestionWire q) {
    final note = _notes[q.id];
    if (note == null) {
      return Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed: _submitting
              ? null
              : () => setState(() => _notes[q.id] = TextEditingController()),
          icon: const Icon(Icons.sticky_note_2_outlined, size: 18),
          label: const Text('Add note'),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: TextField(
        controller: note,
        enabled: !_submitting,
        autofocus: note.text.isEmpty,
        decoration: const InputDecoration(
          hintText: 'Note (optional)',
          isDense: true,
          border: OutlineInputBorder(),
          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        ),
      ),
    );
  }

  Widget _optionTile(
    BuildContext context,
    AskQuestionWire q,
    AskOptionWire o,
    bool multi,
    Set<String> sel,
  ) {
    final colors = context.colors;
    final text = Theme.of(context).textTheme;
    final selected = sel.contains(o.value);
    // Previews ride on any option that carries one: the ask tool sends them
    // on single/multi questions, pi-ask on `preview` questions.
    final hasPreview = o.preview != null && o.preview!.isNotEmpty;

    return InkWell(
      onTap: _submitting ? null : () => _toggle(q.id, o.value, multi),
      borderRadius: BorderRadius.circular(10),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: selected
              ? colors.accent.withValues(alpha: 0.10)
              : colors.surface,
          border: Border.all(
            color: selected ? colors.accent : colors.border,
            width: selected ? 1.6 : 1,
          ),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  multi
                      ? (selected
                            ? Icons.check_box
                            : Icons.check_box_outline_blank)
                      : (selected
                            ? Icons.radio_button_checked
                            : Icons.radio_button_unchecked),
                  size: 20,
                  color: selected ? colors.accent : colors.muted,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    o.label,
                    style: text.bodyLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            if (o.description != null && o.description!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Padding(
                padding: const EdgeInsets.only(left: 30),
                child: Text(
                  o.description!,
                  style: text.bodyMedium?.copyWith(color: colors.muted),
                ),
              ),
            ],
            if (hasPreview) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: colors.codeBg,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: colors.border),
                ),
                child: Text(
                  o.preview!,
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    fontSize: 12,
                    color: colors.text,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildDegraded(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final message = widget.request.message ?? widget.request.title ?? '';
    // Scrolls: a message can be long (TeX Guard sends its whole diff). It is
    // markdown, like the chat, so a ```diff block renders as code.
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (message.isNotEmpty) ...[
            AgentMarkdown(message, selectable: true),
            const SizedBox(height: 16),
          ],
          switch (widget.request.method) {
            ExtensionUiMethod.select => RadioGroup<String>(
              groupValue: _singleValue,
              onChanged: (v) => setState(() => _singleValue = v),
              child: Column(
                children: [
                  for (final opt in widget.request.options)
                    RadioListTile<String>(
                      value: opt,
                      title: Text(opt),
                      enabled: !_submitting,
                    ),
                ],
              ),
            ),
            ExtensionUiMethod.input || ExtensionUiMethod.editor => TextField(
              controller: _textController,
              maxLines: 5,
              enabled: !_submitting,
              // _canSubmit reads this text; rebuild per keystroke or the
              // Submit button never enables.
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                hintText: widget.request.placeholder ?? '',
                border: const OutlineInputBorder(),
              ),
            ),
            ExtensionUiMethod.confirm => Text(
              'Please confirm.',
              style: text.titleMedium,
            ),
            // ChatViewModel consumes notify requests without opening this
            // sheet. Keep the defensive enum branch empty; [message] above
            // already renders it once if this path ever becomes reachable.
            ExtensionUiMethod.notify => const SizedBox.shrink(),
          },
        ],
      ),
    );
  }

  Widget _buildActions(BuildContext context) {
    final colors = context.colors;
    final showError = widget.error != null && widget.error!.isNotEmpty;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (showError)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  widget.error!,
                  style: TextStyle(color: colors.error, fontSize: 13),
                ),
              )
            else if (_awaitHint)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  'Still waiting for desktop agent to confirm receipt. You can retry or cancel.',
                  style: TextStyle(color: colors.warning, fontSize: 13),
                ),
              ),
            Row(
              children: [
                Expanded(
                  child: _isStepper && _page > 0
                      ? OutlinedButton(
                          key: const ValueKey('ask-back'),
                          onPressed: _submitting ? null : _goBack,
                          child: const Text('Back'),
                        )
                      : OutlinedButton(
                          onPressed: _submitting
                              ? null
                              : (_isConfirm
                                    ? () => _confirm(false)
                                    : _requestCancel),
                          child: Text(_isConfirm ? 'No' : 'Cancel'),
                        ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _isStepper && !_isLastPage
                      ? FilledButton(
                          key: const ValueKey('ask-next'),
                          onPressed: _submitting || !_currentDone
                              ? null
                              : _goNext,
                          child: const Text('Next'),
                        )
                      : FilledButton(
                          key: const ValueKey('ask-submit'),
                          onPressed: _submitting
                              ? null
                              : (_isConfirm
                                    ? () => _confirm(true)
                                    : (_canSubmit ? _submit : null)),
                          child: _submitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : Text(_isConfirm ? 'Yes' : 'Submit'),
                        ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

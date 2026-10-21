// Plan 66 — Roles tab of the model picker sheet. Drives the real
// `showModelPickerSheet` with fake repositories: role list rows, the
// role → model → thinking flow sending `model_role_set`, Reset, the
// inline action_error message, candidate filtering and broadcasts.

import 'dart:async';

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/quick_actions/viewmodels/model_roles_viewmodel.dart';
import 'package:app/ui/chat/quick_actions/viewmodels/quick_actions_viewmodel.dart';
import 'package:app/ui/chat/quick_actions/widgets/model_picker_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'model_roles_fakes.dart';

const _opus = WireModel(
  id: 'claude-opus-4-7',
  name: 'Claude Opus 4.7',
  provider: 'anthropic',
  reasoning: true,
  contextWindow: 200000,
  thinkingLevels: [ThinkingLevel.off, ThinkingLevel.low, ThinkingLevel.high],
);

const _gpt = WireModel(
  id: 'gpt-5',
  name: 'GPT-5',
  provider: 'openai',
  reasoning: true,
  contextWindow: 400000,
);

const _haiku = WireModel(
  id: 'claude-haiku-4-5',
  name: 'Claude Haiku 4.5',
  provider: 'anthropic',
  reasoning: false,
  contextWindow: 200000,
);

const _default = WireModelRole(
  role: 'default',
  name: 'Default',
  description: 'Main model',
  model: _opus,
  thinking: ThinkingLevel.high,
  source: 'global',
);

const _plan = WireModelRole(
  role: 'plan',
  name: 'Plan',
  description: 'Planning model',
  model: _gpt,
  source: 'global',
);

const _smol = WireModelRole(
  role: 'smol',
  name: 'Smol',
  description: 'Fast, cheap model',
  source: 'project',
);

Future<FakeRolesRepo> _open(
  WidgetTester tester, {
  List<WireModelRole> roles = const [_default, _plan, _smol],
}) async {
  final repo = FakeRolesRepo(
    roles: roles,
    catalogue: const ModelsCatalogue(models: [_opus, _gpt, _haiku]),
  );
  final qa = QuickActionsViewModel(repo);
  final rolesVm = ModelRolesViewModel(repo);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (ctx) => ElevatedButton(
            onPressed: () =>
                showModelPickerSheet(ctx, vm: qa, rolesVm: rolesVm),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('model-picker-tab-roles')));
  await tester.pumpAndSettle();
  return repo;
}

void main() {
  testWidgets('Roles tab refreshes on open and lists each role row', (
    tester,
  ) async {
    final repo = await _open(tester);
    expect(repo.listRolesCalls, 1);
    expect(find.byKey(const Key('role-row-default')), findsOneWidget);
    expect(find.text('Default'), findsOneWidget);
    expect(find.text('Claude Opus 4.7 · high'), findsOneWidget);
    expect(find.text('Main model'), findsOneWidget);
    // `default` applies to new sessions.
    expect(find.text('new sessions'), findsOneWidget);
    expect(find.text('Plan'), findsOneWidget);
    expect(find.text('GPT-5'), findsOneWidget);
    expect(find.text('Planning model'), findsOneWidget);
    // Source shown only when not global.
    expect(find.text('project'), findsOneWidget);
    expect(find.text('global'), findsNothing);
    expect(find.text('not set'), findsOneWidget);
  });

  testWidgets('pick flow: role → full model list → thinking → model_role_set', (
    tester,
  ) async {
    final repo = await _open(tester);
    await tester.tap(find.byKey(const Key('role-row-default')));
    await tester.pumpAndSettle();
    // No candidate list in the frame → the whole models_list shows.
    expect(find.text('Claude Opus 4.7'), findsOneWidget);
    expect(find.text('GPT-5'), findsOneWidget);
    expect(find.text('Claude Haiku 4.5'), findsOneWidget);
    await tester.tap(find.text('Claude Opus 4.7'));
    await tester.pumpAndSettle();
    // Thinking step shows only the model's levels.
    expect(find.byKey(const Key('role-thinking-high')), findsOneWidget);
    expect(find.byKey(const Key('role-thinking-medium')), findsNothing);
    await tester.tap(find.byKey(const Key('role-thinking-low')));
    await tester.pumpAndSettle();
    final call = repo.setCalls.single;
    expect(call.role, 'default');
    expect(call.provider, 'anthropic');
    expect(call.modelId, 'claude-opus-4-7');
    expect(call.thinking, ThinkingLevel.low);
    // Back on the role list.
    expect(find.byKey(const Key('role-row-plan')), findsOneWidget);
  });

  testWidgets('a non-reasoning model skips the thinking step', (tester) async {
    final repo = await _open(tester);
    await tester.tap(find.byKey(const Key('role-row-plan')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Claude Haiku 4.5'));
    await tester.pumpAndSettle();
    final call = repo.setCalls.single;
    expect(call.role, 'plan');
    expect(call.modelId, 'claude-haiku-4-5');
    expect(call.thinking, isNull);
  });

  testWidgets('tapping a role sends list_model_roles {role}, with a loading '
      'state until the reply', (tester) async {
    final repo = await _open(tester);
    repo.scopedGate = Completer<void>();
    await tester.tap(find.byKey(const Key('role-row-plan')));
    await tester.pump();
    expect(repo.listRolesArgs.last, 'plan');
    expect(find.byKey(const Key('role-candidates-loading')), findsOneWidget);
    expect(find.text('Claude Haiku 4.5'), findsNothing);
    repo.scopedGate!.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('role-candidates-loading')), findsNothing);
    expect(find.text('Claude Haiku 4.5'), findsOneWidget);
  });

  testWidgets('the scoped reply filters the model list and keeps other rows', (
    tester,
  ) async {
    final repo = await _open(tester);
    repo.scopedReplies['plan'] = const WireModelRole(
      role: 'plan',
      name: 'Plan',
      description: 'Planning model',
      model: _gpt,
      source: 'global',
      candidates: [WireModelRef(provider: 'openai', modelId: 'gpt-5')],
    );
    await tester.tap(find.byKey(const Key('role-row-plan')));
    await tester.pumpAndSettle();
    expect(find.text('GPT-5'), findsOneWidget);
    expect(find.text('Claude Opus 4.7'), findsNothing);
    expect(find.text('Claude Haiku 4.5'), findsNothing);
    // Back to the list: the other rows are still there.
    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('role-row-default')), findsOneWidget);
    expect(find.byKey(const Key('role-row-plan')), findsOneWidget);
    expect(find.byKey(const Key('role-row-smol')), findsOneWidget);
  });

  testWidgets('a failed scoped request ends loading and shows the error on '
      'that row', (tester) async {
    final repo = await _open(tester);
    repo.listRolesError = const ActionFailure('unknown model role: plan');
    await tester.tap(find.byKey(const Key('role-row-plan')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('role-candidates-loading')), findsNothing);
    // Back on the role list, error inside the plan row, no banner.
    expect(find.byKey(const Key('role-row-default')), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('role-row-plan')),
        matching: find.text('unknown model role: plan'),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('model-roles-error')), findsNothing);
  });

  testWidgets('a scoped reply without candidates shows the full list', (
    tester,
  ) async {
    final repo = await _open(tester);
    await tester.tap(find.byKey(const Key('role-row-plan')));
    await tester.pumpAndSettle();
    expect(repo.listRolesArgs, [null, 'plan']);
    expect(find.text('GPT-5'), findsOneWidget);
    expect(find.text('Claude Opus 4.7'), findsOneWidget);
    expect(find.text('Claude Haiku 4.5'), findsOneWidget);
  });

  testWidgets('Reset sends model_role_set without provider / model id', (
    tester,
  ) async {
    final repo = await _open(tester);
    // Only globally set roles can be reset; the project role cannot.
    expect(find.byKey(const Key('role-reset-smol')), findsNothing);
    await tester.tap(find.byKey(const Key('role-reset-plan')));
    await tester.pumpAndSettle();
    final call = repo.setCalls.single;
    expect(call.role, 'plan');
    expect(call.provider, isNull);
    expect(call.modelId, isNull);
  });

  testWidgets('action_error text shows inline on the Roles tab', (
    tester,
  ) async {
    final repo = await _open(tester);
    repo.setRoleError = const ActionFailure('model not eligible for role plan');
    await tester.tap(find.byKey(const Key('role-reset-plan')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('model-roles-error')), findsOneWidget);
    expect(find.text('model not eligible for role plan'), findsOneWidget);
  });

  testWidgets('a model_roles broadcast updates the rows', (tester) async {
    final repo = await _open(tester);
    expect(find.text('GPT-5'), findsOneWidget);
    repo.broadcast(const [
      _default,
      WireModelRole(
        role: 'plan',
        name: 'Plan',
        description: 'Planning model',
        model: _haiku,
        source: 'global',
      ),
      _smol,
    ]);
    await tester.pumpAndSettle();
    expect(find.text('GPT-5'), findsNothing);
    expect(find.text('Claude Haiku 4.5'), findsOneWidget);
  });

  testWidgets('a project-scoped role is not editable from the app', (
    tester,
  ) async {
    final repo = await _open(tester);
    await tester.tap(find.byKey(const Key('role-row-smol')));
    await tester.pumpAndSettle();
    // Still on the role list, no model step.
    expect(find.byKey(const Key('role-row-default')), findsOneWidget);
    expect(repo.setCalls, isEmpty);
  });
}

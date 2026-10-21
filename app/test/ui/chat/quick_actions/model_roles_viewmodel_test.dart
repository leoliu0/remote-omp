// Plan 66 — ModelRolesViewModel: role list, set, reset, action_error and
// model_roles broadcasts.

import 'dart:async';

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/quick_actions/states/model_roles_state.dart';
import 'package:app/ui/chat/quick_actions/viewmodels/model_roles_viewmodel.dart';
import 'package:flutter_test/flutter_test.dart';

import 'model_roles_fakes.dart';

const _opus = WireModel(
  id: 'claude-opus-4-7',
  name: 'Claude Opus 4.7',
  provider: 'anthropic',
  reasoning: true,
  contextWindow: 200000,
);

const _plan = WireModelRole(
  role: 'plan',
  name: 'Plan',
  description: 'Planning',
  source: 'global',
);

const _task = WireModelRole(
  role: 'task',
  name: 'Task',
  description: 'Subagents',
  model: _opus,
  thinking: ThinkingLevel.low,
  source: 'global',
);

void main() {
  test(
    'starts loading, refresh() sends list_model_roles and lands on ready',
    () async {
      final repo = FakeRolesRepo(roles: const [_plan, _task]);
      final vm = ModelRolesViewModel(repo);
      expect(vm.state, isA<ModelRolesLoading>());
      await vm.refresh();
      expect(repo.listRolesCalls, 1);
      final s = vm.state as ModelRolesReady;
      expect(s.roles, [_plan, _task]);
      expect(s.error, isNull);
      vm.dispose();
    },
  );

  test(
    'refresh() failure with no rows yet → failed state with message',
    () async {
      final repo = FakeRolesRepo()
        ..listRolesError = const ActionFailure('timeout');
      final vm = ModelRolesViewModel(repo);
      await vm.refresh();
      expect(vm.state, isA<ModelRolesFailed>());
      expect((vm.state as ModelRolesFailed).message, 'timeout');
      vm.dispose();
    },
  );

  test(
    'refresh() failure after rows loaded keeps rows and sets the error',
    () async {
      final repo = FakeRolesRepo(roles: const [_plan]);
      final vm = ModelRolesViewModel(repo);
      await vm.refresh();
      repo.listRolesError = const ActionFailure('offline');
      await vm.refresh();
      final s = vm.state as ModelRolesReady;
      expect(s.roles, [_plan]);
      expect(s.error, 'offline');
      vm.dispose();
    },
  );

  test(
    'setRole sends provider, model id and thinking; busy while in flight',
    () async {
      final repo = FakeRolesRepo(roles: const [_plan]);
      final vm = ModelRolesViewModel(repo);
      await vm.refresh();
      repo.setRoleGate = Completer<void>();
      final future = vm.setRole('plan', _opus, thinking: ThinkingLevel.high);
      expect((vm.state as ModelRolesReady).busyRole, 'plan');
      repo.setRoleGate!.complete();
      expect(await future, isTrue);
      final call = repo.setCalls.single;
      expect(call.role, 'plan');
      expect(call.provider, 'anthropic');
      expect(call.modelId, 'claude-opus-4-7');
      expect(call.thinking, ThinkingLevel.high);
      expect((vm.state as ModelRolesReady).busyRole, isNull);
      vm.dispose();
    },
  );

  test('resetRole sends model_role_set without provider / model id', () async {
    final repo = FakeRolesRepo(roles: const [_task]);
    final vm = ModelRolesViewModel(repo);
    await vm.refresh();
    expect(await vm.resetRole('task'), isTrue);
    final call = repo.setCalls.single;
    expect(call.role, 'task');
    expect(call.provider, isNull);
    expect(call.modelId, isNull);
    expect(call.thinking, isNull);
    vm.dispose();
  });

  test(
    'action_error text lands on the ready state; clearError drops it',
    () async {
      final repo = FakeRolesRepo(
        roles: const [_plan],
      )..setRoleError = const ActionFailure('model not eligible for role plan');
      final vm = ModelRolesViewModel(repo);
      await vm.refresh();
      expect(await vm.setRole('plan', _opus), isFalse);
      final s = vm.state as ModelRolesReady;
      expect(s.error, 'model not eligible for role plan');
      expect(s.busyRole, isNull);
      expect(s.roles, [_plan]);
      vm.clearError();
      expect((vm.state as ModelRolesReady).error, isNull);
      vm.dispose();
    },
  );

  test(
    'a model_roles broadcast replaces the rows (even before a refresh)',
    () async {
      final repo = FakeRolesRepo(roles: const [_plan]);
      final vm = ModelRolesViewModel(repo);
      repo.broadcast(const [_task]);
      await Future<void>.delayed(Duration.zero);
      expect((vm.state as ModelRolesReady).roles, [_task]);
      vm.dispose();
    },
  );

  test(
    'loadRole sends a role-scoped request and updates only that row',
    () async {
      final repo = FakeRolesRepo(roles: const [_plan, _task]);
      final vm = ModelRolesViewModel(repo);
      await vm.refresh();
      const scoped = WireModelRole(
        role: 'plan',
        name: 'Plan',
        description: 'Planning',
        model: _opus,
        source: 'global',
        candidates: [
          WireModelRef(provider: 'anthropic', modelId: 'claude-opus-4-7'),
        ],
      );
      repo.scopedReplies['plan'] = scoped;
      final got = await vm.loadRole('plan');
      expect(repo.listRolesArgs.last, 'plan');
      expect(got, scoped);
      // Only the plan row changed; task stays, order kept.
      expect(vm.state.roles, [scoped, _task]);
      vm.dispose();
    },
  );

  test('loadRole failure returns null and shows the error inline', () async {
    final repo = FakeRolesRepo(roles: const [_plan]);
    final vm = ModelRolesViewModel(repo);
    await vm.refresh();
    repo.listRolesError = const ActionFailure('timeout');
    expect(await vm.loadRole('plan'), isNull);
    final s = vm.state as ModelRolesReady;
    expect(s.roles, [_plan]);
    expect(s.error, 'timeout');
    // The failure belongs to the plan row, not the tab-wide banner.
    expect(s.errorRole, 'plan');
    vm.clearError();
    expect((vm.state as ModelRolesReady).errorRole, isNull);
    vm.dispose();
  });
}

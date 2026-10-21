import 'dart:async';

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/chat/quick_actions/states/model_roles_state.dart';
import 'package:app/ui/core/viewmodel/viewmodel.dart';

/// Plan 66 — drives the model picker's Roles tab: omp's model roles, set
/// and reset through `model_role_set`. Rows follow every `model_roles`
/// frame, so a change from another client (or the broadcast after our own
/// set) lands without a manual refresh.
class ModelRolesViewModel extends ViewModel<ModelRolesState> {
  final IActionsRepository _repo;
  StreamSubscription<List<WireModelRole>>? _sub;
  bool _disposed = false;

  ModelRolesViewModel(this._repo) : super(const ModelRolesLoading()) {
    _sub = _repo.modelRolesStream.listen(_adopt);
  }

  /// Sends `list_model_roles`. A failure keeps known rows and shows the
  /// message inline; with no rows the tab shows a retry state.
  Future<void> refresh() async {
    if (state is ModelRolesFailed) _emit(const ModelRolesLoading());
    try {
      final roles = await _repo.listModelRoles();
      final cur = state;
      // A successful refresh drops a stale error message.
      _emit(
        ModelRolesReady(
          roles,
          busyRole: cur is ModelRolesReady ? cur.busyRole : null,
        ),
      );
    } on ActionFailure catch (e) {
      final cur = state;
      _emit(
        cur is ModelRolesReady
            ? ModelRolesReady(
                cur.roles,
                busyRole: cur.busyRole,
                error: e.message,
              )
            : ModelRolesFailed(e.message),
      );
    }
  }

  /// Sends `list_model_roles {role}` and merges the one-role reply into its
  /// row (other rows stay as they are). Returns the role with its
  /// `candidates` (`null` there = the full catalogue), or `null` on failure,
  /// whose text lands on [ModelRolesReady.error].
  Future<WireModelRole?> loadRole(String role) async {
    try {
      final reply = await _repo.listModelRoles(role: role);
      final scoped = reply.where((r) => r.role == role).firstOrNull;
      if (scoped == null) {
        _rowError(role, 'unknown model role: $role');
        return null;
      }
      final cur = state;
      if (cur is ModelRolesReady) {
        // A fresh reply for this row drops its old row error.
        final ownError = cur.errorRole == role;
        _emit(
          ModelRolesReady(
            [for (final r in cur.roles) r.role == role ? scoped : r],
            busyRole: cur.busyRole,
            error: ownError ? null : cur.error,
            errorRole: ownError ? null : cur.errorRole,
          ),
        );
      }
      return scoped;
    } on ActionFailure catch (e) {
      // Includes the extension's `error` frame (`invalid_message`) for an
      // unknown or hidden role.
      _rowError(role, e.message);
      return null;
    }
  }

  void _rowError(String role, String message) {
    final cur = state;
    if (cur is ModelRolesReady) {
      _emit(
        ModelRolesReady(
          cur.roles,
          busyRole: cur.busyRole,
          error: message,
          errorRole: role,
        ),
      );
    }
  }

  /// Sets [role] to [model] (and [thinking] when given). Returns `false`
  /// on `action_error`, whose text lands on [ModelRolesReady.error].
  Future<bool> setRole(
    String role,
    WireModel model, {
    ThinkingLevel? thinking,
  }) => _send(
    role,
    () => _repo.setModelRole(
      role,
      provider: model.provider,
      modelId: model.id,
      thinking: thinking,
    ),
  );

  /// Clears [role] back to its default (`model_role_set` without a model).
  Future<bool> resetRole(String role) =>
      _send(role, () => _repo.setModelRole(role));

  void clearError() {
    final cur = state;
    if (cur is ModelRolesReady && cur.error != null) {
      _emit(ModelRolesReady(cur.roles, busyRole: cur.busyRole));
    }
  }

  Future<bool> _send(String role, Future<void> Function() body) async {
    _emit(ModelRolesReady(state.roles, busyRole: role));
    try {
      await body();
      _emit(ModelRolesReady(state.roles));
      return true;
    } on ActionFailure catch (e) {
      _emit(ModelRolesReady(state.roles, error: e.message));
      return false;
    }
  }

  void _adopt(List<WireModelRole> roles) {
    final cur = state;
    _emit(
      cur is ModelRolesReady
          ? ModelRolesReady(
              roles,
              busyRole: cur.busyRole,
              error: cur.error,
              errorRole: cur.errorRole,
            )
          : ModelRolesReady(roles),
    );
  }

  void _emit(ModelRolesState next) {
    if (_disposed) return;
    emit(next);
  }

  @override
  void dispose() {
    _disposed = true;
    _sub?.cancel();
    super.dispose();
  }
}

import 'package:app/protocol/protocol.dart';
import 'package:flutter/foundation.dart';

/// Plan 66 — state of the model picker's Roles tab.
sealed class ModelRolesState {
  const ModelRolesState();

  List<WireModelRole> get roles => const [];
}

/// No role list yet; the first `list_model_roles` is in flight.
class ModelRolesLoading extends ModelRolesState {
  const ModelRolesLoading();

  @override
  bool operator ==(Object other) => other is ModelRolesLoading;

  @override
  int get hashCode => (ModelRolesLoading).hashCode;
}

/// The first `list_model_roles` failed and no rows are known.
class ModelRolesFailed extends ModelRolesState {
  final String message;
  const ModelRolesFailed(this.message);

  @override
  bool operator ==(Object other) =>
      other is ModelRolesFailed && other.message == message;

  @override
  int get hashCode => message.hashCode;
}

/// Rows are known. [busyRole] marks the role whose `model_role_set` is in
/// flight; [error] is the last `action_error` (or refresh failure) text.
/// With [errorRole] set the error belongs to that row (a failed role-scoped
/// `list_model_roles`) and shows inside it; otherwise above the rows.
class ModelRolesReady extends ModelRolesState {
  @override
  final List<WireModelRole> roles;
  final String? busyRole;
  final String? error;
  final String? errorRole;
  const ModelRolesReady(
    this.roles, {
    this.busyRole,
    this.error,
    this.errorRole,
  });

  @override
  bool operator ==(Object other) =>
      other is ModelRolesReady &&
      listEquals(other.roles, roles) &&
      other.busyRole == busyRole &&
      other.error == error &&
      other.errorRole == errorRole;

  @override
  int get hashCode =>
      Object.hash(Object.hashAll(roles), busyRole, error, errorRole);
}

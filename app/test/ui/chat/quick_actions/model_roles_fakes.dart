// Plan 66 — shared fake [IActionsRepository] for the model-roles view-model
// and Roles-tab widget tests. Records every `model_role_set` call and lets a
// test push `model_roles` broadcasts.

import 'dart:async';

import 'package:app/data/actions/actions_repository.dart';
import 'package:app/protocol/protocol.dart';

class RoleSetCall {
  final String role;
  final String? provider;
  final String? modelId;
  final ThinkingLevel? thinking;
  const RoleSetCall(this.role, this.provider, this.modelId, this.thinking);
}

class FakeRolesRepo implements IActionsRepository {
  List<WireModelRole> roles;
  ModelsCatalogue catalogue;
  Object? listRolesError;
  Object? setRoleError;

  /// When set, `setModelRole` waits on it before resolving (busy-state tests).
  Completer<void>? setRoleGate;

  int listRolesCalls = 0;
  final List<RoleSetCall> setCalls = [];
  final _rolesController = StreamController<List<WireModelRole>>.broadcast();

  FakeRolesRepo({
    this.roles = const [],
    this.catalogue = const ModelsCatalogue(models: []),
  });

  void broadcast(List<WireModelRole> next) {
    roles = next;
    _rolesController.add(next);
  }

  /// Role-scoped replies (`list_model_roles {role}`) by role id. Missing
  /// entries reply with the role's current row (no candidates).
  final Map<String, WireModelRole> scopedReplies = {};

  /// When set, role-scoped requests wait on it (loading-state tests).
  Completer<void>? scopedGate;

  /// `role` argument of every `listModelRoles` call (`null` = full list).
  final List<String?> listRolesArgs = [];

  @override
  Future<List<WireModelRole>> listModelRoles({String? role}) async {
    listRolesCalls++;
    listRolesArgs.add(role);
    if (listRolesError != null) throw listRolesError!;
    if (role == null) return roles;
    if (scopedGate != null) await scopedGate!.future;
    final scoped =
        scopedReplies[role] ?? roles.where((r) => r.role == role).firstOrNull;
    return scoped == null ? const [] : [scoped];
  }

  @override
  Future<void> setModelRole(
    String role, {
    String? provider,
    String? modelId,
    ThinkingLevel? thinking,
  }) async {
    setCalls.add(RoleSetCall(role, provider, modelId, thinking));
    if (setRoleGate != null) await setRoleGate!.future;
    if (setRoleError != null) throw setRoleError!;
  }

  @override
  Stream<List<WireModelRole>> get modelRolesStream => _rolesController.stream;

  @override
  Future<ModelsCatalogue> listModels({bool forceRefresh = false}) async =>
      catalogue;

  @override
  WireModel? get cachedCurrentModel => catalogue.current;

  @override
  ActiveRoomMeta get activeRoomMeta => const ActiveRoomMeta();

  @override
  Stream<ActiveRoomMeta> get activeRoomMetaStream =>
      const Stream<ActiveRoomMeta>.empty();

  @override
  Future<void> compact() async {}

  @override
  Future<void> newSession() async {}

  @override
  Future<void> reloadPlugins() async {}

  @override
  Future<void> setPlanMode(PlanModeAction action) async {}

  @override
  Future<void> setModel(String provider, String modelId) async {}

  @override
  Future<void> setThinking(ThinkingLevel level) async {}

  @override
  void dispose() {
    _rolesController.close();
  }
}

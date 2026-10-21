import 'dart:async';

import 'package:app/config/dependencies.dart';
import 'package:app/data/actions/actions_repository.dart';
import 'package:app/protocol/protocol.dart';
import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/chat/quick_actions/states/model_roles_state.dart';
import 'package:app/ui/chat/quick_actions/viewmodels/model_roles_viewmodel.dart';
import 'package:app/ui/chat/quick_actions/viewmodels/quick_actions_viewmodel.dart';
import 'package:app/ui/chat/quick_actions/widgets/thinking_segmented.dart';
import 'package:app/ui/home/widgets/session_tile.dart' show thinkingLabel;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

/// Plan/28 Wave C — Model sub-picker pushed from the Quick Actions sheet.
/// Lists every model the Pi reports as available, optionally filtered by
/// provider. Tapping a row dispatches `model_set` via the parent
/// [QuickActionsViewModel] and closes the sub-picker on success.
///
/// Plan 66 — a Roles tab next to the session model list shows omp's model
/// roles. Tapping a role picks a model, then a thinking level, and sends
/// `model_role_set`; Reset clears the role. [rolesVm] is injected by tests;
/// the app resolves a fresh [ModelRolesViewModel] per sheet.
Future<void> showModelPickerSheet(
  BuildContext context, {
  required QuickActionsViewModel vm,
  ModelRolesViewModel? rolesVm,
}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.colors.bg,
    barrierColor: Colors.black.withValues(alpha: 0.6),
    isScrollControlled: true,
    showDragHandle: false,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) {
      return MultiProvider(
        providers: [
          ChangeNotifierProvider<QuickActionsViewModel>.value(value: vm),
          if (rolesVm != null)
            ChangeNotifierProvider<ModelRolesViewModel>.value(value: rolesVm)
          else
            ChangeNotifierProvider<ModelRolesViewModel>(
              create: (_) => injector.get<ModelRolesViewModel>(),
            ),
        ],
        child: const _ModelPickerBody(),
      );
    },
  );
}

enum _PickerTab { session, roles }

class _ModelPickerBody extends StatefulWidget {
  const _ModelPickerBody();

  @override
  State<_ModelPickerBody> createState() => _ModelPickerBodyState();
}

class _ModelPickerBodyState extends State<_ModelPickerBody> {
  late Future<ModelsCatalogue> _future;
  String? _providerFilter;
  String _searchQuery = '';
  final TextEditingController _searchController = TextEditingController();

  _PickerTab _tab = _PickerTab.session;

  /// Role being edited (model step), and the model picked for it (thinking
  /// step). Both `null` on the role list.
  WireModelRole? _editingRole;
  WireModel? _pickedModel;

  /// True while the role-scoped `list_model_roles {role}` for
  /// [_editingRole] is in flight. [_roleLoadSeq] drops stale replies.
  bool _loadingRole = false;
  int _roleLoadSeq = 0;

  @override
  void initState() {
    super.initState();
    _future = _load(forceRefresh: true);
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<ModelsCatalogue> _load({required bool forceRefresh}) {
    final vm = context.read<QuickActionsViewModel>();
    return vm.loadModels(forceRefresh: forceRefresh);
  }

  Future<void> _refresh() async {
    if (_tab == _PickerTab.roles && _editingRole == null) {
      await context.read<ModelRolesViewModel>().refresh();
      return;
    }
    setState(() {
      _future = _load(forceRefresh: true);
    });
    await _future.catchError((Object _) => const ModelsCatalogue(models: []));
  }

  Future<void> _onPick(WireModel model) async {
    final vm = context.read<QuickActionsViewModel>();
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      await vm.setModel(model);
      if (!mounted) return;
      Navigator.of(context).pop();
    } catch (e) {
      final msg = e is ActionFailure
          ? e.message
          : 'Failed to switch to ${model.name}';
      messenger?.showSnackBar(
        SnackBar(
          content: Text(msg),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 4),
        ),
      );
    }
  }

  void _clearSearch() {
    _searchController.clear();
    _searchQuery = '';
    _providerFilter = null;
  }

  void _selectTab(_PickerTab tab) {
    if (tab == _tab) return;
    setState(() {
      _tab = tab;
      _editingRole = null;
      _pickedModel = null;
      _clearSearch();
    });
    // Refresh on open: every switch to the Roles tab re-reads omp's roles.
    if (tab == _PickerTab.roles) {
      unawaited(context.read<ModelRolesViewModel>().refresh());
    }
  }

  /// Opens the model step for [role]: asks for its candidate pool
  /// (`list_model_roles {role}`) and shows a loading state until the reply.
  Future<void> _onRoleTap(WireModelRole role) async {
    final rolesVm = context.read<ModelRolesViewModel>();
    final seq = ++_roleLoadSeq;
    setState(() {
      _editingRole = role;
      _pickedModel = null;
      _loadingRole = true;
      _clearSearch();
    });
    final scoped = await rolesVm.loadRole(role.role);
    if (!mounted || seq != _roleLoadSeq || _editingRole?.role != role.role) {
      return;
    }
    setState(() {
      _loadingRole = false;
      // A failed request (e.g. the extension's `error` frame for an unknown
      // or hidden role) returns to the list; the row shows the message.
      _editingRole = scoped;
    });
  }

  void _onRoleModelPick(WireModel model) {
    if (!model.reasoning) {
      unawaited(_commitRole(model, null));
      return;
    }
    setState(() => _pickedModel = model);
  }

  /// Sends `model_role_set` and returns to the role list right away; the
  /// row shows a spinner until the reply, then the broadcast updates it.
  Future<void> _commitRole(WireModel model, ThinkingLevel? thinking) async {
    final role = _editingRole;
    if (role == null) return;
    final rolesVm = context.read<ModelRolesViewModel>();
    setState(() {
      _editingRole = null;
      _pickedModel = null;
      _clearSearch();
    });
    await rolesVm.setRole(role.role, model, thinking: thinking);
  }

  void _back() {
    _roleLoadSeq++;
    _loadingRole = false;
    if (_pickedModel != null) {
      setState(() => _pickedModel = null);
    } else if (_editingRole != null) {
      setState(() {
        _editingRole = null;
        _clearSearch();
      });
    } else {
      Navigator.of(context).pop();
    }
  }

  String get _title {
    if (_tab == _PickerTab.session) return 'Choose a model';
    final role = _editingRole;
    if (role == null) return 'Model roles';
    if (_pickedModel != null) return 'Thinking for ${role.name}';
    return 'Model for ${role.name}';
  }

  bool get _showSearch =>
      _tab == _PickerTab.session ||
      (_editingRole != null && _pickedModel == null && !_loadingRole);

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final mq = MediaQuery.of(context);
    final maxHeight = mq.size.height * 0.85;
    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Padding(
          padding: EdgeInsets.only(bottom: mq.viewInsets.bottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(height: 10),
              _DragHandle(),
              const SizedBox(height: 8),
              _Header(title: _title, onBack: _back, onRefresh: _refresh),
              if (_editingRole == null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                  child: Row(
                    children: [
                      _Chip(
                        key: const Key('model-picker-tab-session'),
                        label: 'Session',
                        selected: _tab == _PickerTab.session,
                        onTap: () => _selectTab(_PickerTab.session),
                      ),
                      const SizedBox(width: 6),
                      _Chip(
                        key: const Key('model-picker-tab-roles'),
                        label: 'Roles',
                        selected: _tab == _PickerTab.roles,
                        onTap: () => _selectTab(_PickerTab.roles),
                      ),
                    ],
                  ),
                ),
              if (_showSearch)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                  child: Container(
                    height: 38,
                    decoration: BoxDecoration(
                      color: colors.surface,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: colors.border),
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: Row(
                      children: [
                        Icon(LucideIcons.search, size: 16, color: colors.muted),
                        const SizedBox(width: 8),
                        Expanded(
                          child: TextField(
                            controller: _searchController,
                            onChanged: (v) => setState(() => _searchQuery = v.trim().toLowerCase()),
                            style: TextStyle(
                              fontFamily: kMonoFamily,
                              fontSize: 12,
                              color: colors.text,
                            ),
                            decoration: InputDecoration(
                              hintText: 'Search models, providers, or IDs...',
                              hintStyle: TextStyle(
                                fontFamily: kMonoFamily,
                                fontSize: 12,
                                color: colors.muted,
                              ),
                              border: InputBorder.none,
                              isDense: true,
                              contentPadding: EdgeInsets.zero,
                            ),
                          ),
                        ),
                        if (_searchQuery.isNotEmpty)
                          GestureDetector(
                            onTap: () {
                              _searchController.clear();
                              setState(() => _searchQuery = '');
                            },
                            child: Icon(LucideIcons.x, size: 14, color: colors.muted),
                          ),
                      ],
                    ),
                  ),
                ),
              Divider(color: colors.border, height: 1, thickness: 1),
              if (_tab == _PickerTab.roles) const _RolesError(),
              Flexible(
                child: switch (_tab) {
                  _PickerTab.session => _catalogueView(
                    current: null,
                    onPick: _onPick,
                  ),
                  _PickerTab.roles => _rolesView(),
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _rolesView() {
    final role = _editingRole;
    if (role == null) {
      return _RolesList(onRoleTap: _onRoleTap);
    }
    if (_loadingRole) {
      return const _LoadingState(key: Key('role-candidates-loading'));
    }
    final picked = _pickedModel;
    if (picked != null) {
      final sameModel = role.model?.id == picked.id &&
          role.model?.provider == picked.provider;
      return _RoleThinkingStep(
        model: picked,
        current: sameModel ? role.thinking : null,
        onPick: (level) => _commitRole(picked, level),
        onSkip: () => _commitRole(picked, null),
      );
    }
    // The role-scoped reply's candidate pool when it sends one; without it
    // the pool is the full catalogue.
    final candidates = role.candidates;
    return _catalogueView(
      current: role.model,
      onPick: _onRoleModelPick,
      filter: candidates == null
          ? null
          : (m) => candidates.any((c) => c.matches(m)),
    );
  }

  /// The models catalogue (`models_list`). [current] overrides the
  /// highlighted row; `null` keeps the session's current model.
  Widget _catalogueView({
    required WireModel? current,
    required ValueChanged<WireModel> onPick,
    bool Function(WireModel)? filter,
  }) {
    final forRole = _tab == _PickerTab.roles;
    return FutureBuilder<ModelsCatalogue>(
      future: _future,
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const _LoadingState();
        }
        if (snap.hasError) {
          return _ErrorState(
            message: snap.error is ActionFailure
                ? (snap.error as ActionFailure).message
                : 'Failed to load models',
            onRetry: _refresh,
          );
        }
        final cat = snap.data!;
        if (!forRole) return _modelList(cat, onPick);
        final models = filter == null
            ? cat.models
            : cat.models.where(filter).toList();
        return _modelList(
          ModelsCatalogue(models: models, current: current),
          onPick,
        );
      },
    );
  }

  Widget _modelList(ModelsCatalogue cat, ValueChanged<WireModel> onPick) {
    if (cat.models.isEmpty) {
      return const _EmptyState();
    }
    return _ProviderTabs(
      catalogue: cat,
      selectedProvider: _providerFilter,
      searchQuery: _searchQuery,
      onProviderTap: (p) => setState(() => _providerFilter = p),
      onModelPick: onPick,
    );
  }
}

// ---------------------------------------------------------------------------

class _DragHandle extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      width: 36,
      height: 4,
      decoration: BoxDecoration(
        color: context.colors.border,
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final String title;
  final VoidCallback onBack;
  final VoidCallback onRefresh;
  const _Header({
    required this.title,
    required this.onBack,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 8, 10),
      child: Row(
        children: [
          IconButton(
            icon: Icon(LucideIcons.arrowLeft, size: 18, color: colors.muted),
            onPressed: onBack,
            tooltip: 'Back',
          ),
          const SizedBox(width: 4),
          Expanded(
            child: Text(
              title,
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 13,
                color: colors.text,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          IconButton(
            key: const Key('model-picker-refresh'),
            icon: Icon(LucideIcons.refreshCw, size: 18, color: colors.muted),
            onPressed: onRefresh,
            tooltip: 'Refresh',
          ),
        ],
      ),
    );
  }
}

class _ProviderTabs extends StatelessWidget {
  final ModelsCatalogue catalogue;
  final String? selectedProvider;
  final String searchQuery;
  final ValueChanged<String?> onProviderTap;
  final ValueChanged<WireModel> onModelPick;
  const _ProviderTabs({
    required this.catalogue,
    required this.selectedProvider,
    required this.searchQuery,
    required this.onProviderTap,
    required this.onModelPick,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final providerCounts = <String, int>{};
    for (final m in catalogue.models) {
      providerCounts[m.provider] = (providerCounts[m.provider] ?? 0) + 1;
    }
    final providers = providerCounts.keys.toList()..sort();
    final queryFiltered = searchQuery.isEmpty
        ? catalogue.models
        : catalogue.models.where((m) {
            final q = searchQuery;
            return m.name.toLowerCase().contains(q) ||
                m.id.toLowerCase().contains(q) ||
                m.provider.toLowerCase().contains(q);
          }).toList();

    final filtered = selectedProvider == null
        ? queryFiltered
        : queryFiltered
            .where((m) => m.provider == selectedProvider)
            .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (providers.length > 1)
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                _Chip(
                  label: 'all (${catalogue.models.length})',
                  selected: selectedProvider == null,
                  onTap: () => onProviderTap(null),
                ),
                const SizedBox(width: 6),
                for (final p in providers) ...[
                  _Chip(
                    label: '$p (${providerCounts[p]})',
                    selected: selectedProvider == p,
                    onTap: () => onProviderTap(p),
                  ),
                  const SizedBox(width: 6),
                ],
              ],
            ),
          ),
        if (filtered.isEmpty)
          Padding(
            padding: const EdgeInsets.all(32),
            child: Center(
              child: Text(
                searchQuery.isNotEmpty
                    ? 'No models match "$searchQuery"'
                    : 'No models available',
                style: TextStyle(
                  fontFamily: kMonoFamily,
                  fontSize: 12,
                  color: colors.muted,
                ),
              ),
            ),
          )
        else
          Flexible(
            child: ListView.separated(
              padding: const EdgeInsets.only(bottom: 18),
              shrinkWrap: true,
              itemCount: filtered.length,
              separatorBuilder: (_, _) =>
                  Divider(color: colors.border, height: 1, thickness: 1),
              itemBuilder: (_, i) {
                final m = filtered[i];
                final isCurrent = (catalogue.current?.id == m.id &&
                        catalogue.current?.provider == m.provider) ||
                    catalogue.current?.id.toLowerCase() == m.id.toLowerCase() ||
                    catalogue.current?.name.toLowerCase() == m.name.toLowerCase();
                return _ModelTile(
                  model: m,
                  current: isCurrent,
                  onTap: () => onModelPick(m),
                );
              },
            ),
          ),
      ],
    );
  }
}

class _Chip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _Chip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          border: Border.all(
            color: selected ? colors.accent : colors.border,
          ),
          color: selected ? colors.accent.withValues(alpha: 0.12) : colors.bg,
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontFamily: kMonoFamily,
            fontSize: 11,
            color: selected ? colors.accent : colors.muted,
          ),
        ),
      ),
    );
  }
}

class _ModelTile extends StatelessWidget {
  final WireModel model;
  final bool current;
  final VoidCallback onTap;
  const _ModelTile({
    required this.model,
    required this.current,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      onTap: onTap,
      child: Container(
        color: current ? colors.accent.withValues(alpha: 0.08) : Colors.transparent,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          model.name,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontFamily: kMonoFamily,
                            fontSize: 13,
                            fontWeight: current ? FontWeight.w600 : FontWeight.w500,
                            color: current ? colors.accent : colors.text,
                          ),
                        ),
                      ),
                      if (model.reasoning) ...[
                        const SizedBox(width: 6),
                        const _Badge(label: 'reasoning'),
                      ],
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    _subtitle(model),
                    style: TextStyle(
                      fontFamily: kMonoFamily,
                      fontSize: 10,
                      color: current ? colors.accent.withValues(alpha: 0.8) : colors.muted,
                    ),
                  ),
                ],
              ),
            ),
            if (current)
              Icon(LucideIcons.check, color: colors.accent, size: 18),
          ],
        ),
      ),
    );
  }

  static String _subtitle(WireModel m) {
    final ctx = m.contextWindow;
    if (ctx <= 0) return m.provider;
    final humanized = ctx >= 1000 ? '${(ctx / 1000).round()}k' : '$ctx';
    return '${m.provider} · ctx $humanized';
  }
}

class _Badge extends StatelessWidget {
  final String label;

  /// Muted badges carry secondary facts (a role's non-global source).
  final bool muted;
  const _Badge({required this.label, this.muted = false});
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tint = muted ? colors.muted : colors.accent;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: tint.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(3),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: kMonoFamily,
          fontSize: 9,
          color: tint,
        ),
      ),
    );
  }
}

class _LoadingState extends StatelessWidget {
  const _LoadingState({super.key});
  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 120,
      child: Center(
        child: SizedBox(
          width: 18,
          height: 18,
          child: CircularProgressIndicator(
            strokeWidth: 1.6,
            color: context.colors.accent,
          ),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 120,
      child: Center(
        child: Text(
          'No models available',
          style: TextStyle(
            fontFamily: kMonoFamily,
            fontSize: 12,
            color: context.colors.muted,
          ),
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            message,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: kMonoFamily,
              fontSize: 12,
              color: colors.error,
            ),
          ),
          const SizedBox(height: 14),
          OutlinedButton(
            onPressed: onRetry,
            style: OutlinedButton.styleFrom(
              foregroundColor: colors.accent,
              side: BorderSide(color: colors.border),
            ),
            child: const Text(
              'Retry',
              style: TextStyle(fontFamily: kMonoFamily, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Plan 66 — Roles tab
// ---------------------------------------------------------------------------

/// Role rows from [ModelRolesViewModel].
class _RolesList extends StatelessWidget {
  final ValueChanged<WireModelRole> onRoleTap;
  const _RolesList({required this.onRoleTap});

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<ModelRolesViewModel>();
    final colors = context.colors;
    return switch (vm.state) {
      ModelRolesLoading() => const _LoadingState(),
      ModelRolesFailed(:final message) => _ErrorState(
        message: message,
        onRetry: vm.refresh,
      ),
      ModelRolesReady(
        :final roles,
        :final busyRole,
        :final error,
        :final errorRole,
      ) =>
        roles.isEmpty
          ? SizedBox(
              height: 120,
              child: Center(
                child: Text(
                  'No model roles',
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    fontSize: 12,
                    color: colors.muted,
                  ),
                ),
              ),
            )
          : ListView.separated(
              padding: const EdgeInsets.only(bottom: 18),
              shrinkWrap: true,
              itemCount: roles.length,
              separatorBuilder: (_, _) =>
                  Divider(color: colors.border, height: 1, thickness: 1),
              itemBuilder: (_, i) {
                final role = roles[i];
                return _RoleTile(
                  role: role,
                  busy: busyRole == role.role,
                  error: errorRole == role.role ? error : null,
                  // Project-scoped roles are not edited from the app.
                  onTap: busyRole == null && role.source != 'project'
                      ? () => onRoleTap(role)
                      : null,
                  onReset: busyRole == null && role.source == 'global'
                      ? () => vm.resetRole(role.role)
                      : null,
                );
              },
            ),
    };
  }
}

class _RoleTile extends StatelessWidget {
  final WireModelRole role;
  final bool busy;

  /// Failure of this row's role-scoped request, shown inside the row.
  final String? error;
  final VoidCallback? onTap;
  final VoidCallback? onReset;
  const _RoleTile({
    required this.role,
    required this.busy,
    this.error,
    required this.onTap,
    required this.onReset,
  });

  String get _modelLine {
    final model = role.model;
    if (model == null) return 'not set';
    final thinking = role.thinking;
    return thinking == null
        ? model.name
        : '${model.name} · ${thinkingLabel(thinking)}';
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      key: Key('role-row-${role.role}'),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 12, 8, 12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          role.name,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontFamily: kMonoFamily,
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: colors.text,
                          ),
                        ),
                      ),
                      // `default` is the session model: it applies to new
                      // sessions (the Session tab changes the live one).
                      if (role.role == 'default') ...[
                        const SizedBox(width: 6),
                        const _Badge(label: 'new sessions'),
                      ],
                      if (role.source != 'global') ...[
                        const SizedBox(width: 6),
                        _Badge(label: role.source, muted: true),
                      ],
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    _modelLine,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: kMonoFamily,
                      fontSize: 11,
                      color: role.model == null ? colors.muted : colors.accent,
                    ),
                  ),
                  if (role.description.isNotEmpty) ...[
                    const SizedBox(height: 3),
                    Text(
                      role.description,
                      style: TextStyle(
                        fontFamily: kMonoFamily,
                        fontSize: 10,
                        color: colors.muted,
                      ),
                    ),
                  ],
                  if (error != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      error!,
                      key: Key('role-error-${role.role}'),
                      style: TextStyle(
                        fontFamily: kMonoFamily,
                        fontSize: 10,
                        color: colors.error,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (busy)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.6,
                    color: colors.accent,
                  ),
                ),
              )
            else ...[
              if (onReset != null)
                IconButton(
                  key: Key('role-reset-${role.role}'),
                  icon: Icon(LucideIcons.rotateCcw, size: 16, color: colors.muted),
                  onPressed: onReset,
                  tooltip: 'Reset',
                ),
              if (onTap != null)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: Icon(
                    LucideIcons.chevronRight,
                    color: colors.muted,
                    size: 18,
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Inline `action_error` (or refresh failure) text above the Roles tab.
class _RolesError extends StatelessWidget {
  const _RolesError();

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<ModelRolesViewModel>();
    final state = vm.state;
    // Row-scoped errors show inside their row instead.
    final error = state is ModelRolesReady && state.errorRole == null
        ? state.error
        : null;
    if (error == null) return const SizedBox.shrink();
    final colors = context.colors;
    return Container(
      key: const Key('model-roles-error'),
      width: double.infinity,
      color: colors.error.withValues(alpha: 0.1),
      padding: const EdgeInsets.fromLTRB(18, 8, 8, 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              error,
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 11,
                color: colors.error,
              ),
            ),
          ),
          IconButton(
            icon: Icon(LucideIcons.x, size: 14, color: colors.error),
            onPressed: vm.clearError,
            tooltip: 'Dismiss',
          ),
        ],
      ),
    );
  }
}

/// Thinking step of the role flow: the picked model's levels, or the model's
/// default thinking (no `thinking` in `model_role_set`).
class _RoleThinkingStep extends StatelessWidget {
  final WireModel model;
  final ThinkingLevel? current;
  final ValueChanged<ThinkingLevel> onPick;
  final VoidCallback onSkip;
  const _RoleThinkingStep({
    required this.model,
    required this.current,
    required this.onPick,
    required this.onSkip,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            model.name,
            style: TextStyle(
              fontFamily: kMonoFamily,
              fontSize: 13,
              fontWeight: FontWeight.w500,
              color: colors.text,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            model.provider,
            style: TextStyle(
              fontFamily: kMonoFamily,
              fontSize: 10,
              color: colors.muted,
            ),
          ),
          const SizedBox(height: 16),
          Text(
            'Thinking',
            style: TextStyle(
              fontFamily: kMonoFamily,
              fontSize: 11,
              color: colors.muted,
            ),
          ),
          const SizedBox(height: 10),
          ThinkingSegmented(
            keyPrefix: 'role-thinking-',
            current: current,
            disabled: false,
            levels: model.thinkingLevels,
            onPick: onPick,
          ),
          const SizedBox(height: 8),
          TextButton(
            key: const Key('role-thinking-skip'),
            onPressed: onSkip,
            style: TextButton.styleFrom(foregroundColor: colors.accent),
            child: const Text(
              'Use model default',
              style: TextStyle(fontFamily: kMonoFamily, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}

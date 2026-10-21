// Plan 66 — omp model roles frames.
//
// Mirrors the contract in plan/66-omp-model-roles.md (the TypeScript side
// lives in pi-extension/src/protocol/types.ts):
//   ClientMessage:  list_model_roles, model_role_set
//   ServerMessage:  model_roles (reply when in_reply_to is set, broadcast
//                   otherwise). model_role_set replies with action_ok /
//                   action_error.

import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

const _opus = {
  'id': 'claude-opus-4-7',
  'name': 'Claude Opus 4.7',
  'provider': 'anthropic',
  'reasoning': true,
  'context_window': 200000,
  'vision': true,
  'thinking_levels': ['off', 'low', 'high'],
};

void main() {
  group('ClientMessage — model roles', () {
    test('ListModelRoles with role scopes the request', () {
      expect(ListModelRoles(id: 'r1', role: 'plan').toJson(), {
        'type': 'list_model_roles',
        'id': 'r1',
        'role': 'plan',
      });
    });

    test('ListModelRoles encodes as list_model_roles', () {
      expect(ListModelRoles(id: 'r1').toJson(), {
        'type': 'list_model_roles',
        'id': 'r1',
      });
    });

    test('ModelRoleSet encodes role, provider, model_id and thinking', () {
      final j = ModelRoleSet(
        id: 'r2',
        role: 'plan',
        provider: 'anthropic',
        modelId: 'claude-opus-4-7',
        thinking: ThinkingLevel.high,
      ).toJson();
      expect(j, {
        'type': 'model_role_set',
        'id': 'r2',
        'role': 'plan',
        'provider': 'anthropic',
        'model_id': 'claude-opus-4-7',
        'thinking': 'high',
      });
    });

    test('ModelRoleSet without thinking omits the key', () {
      final j = ModelRoleSet(
        id: 'r3',
        role: 'task',
        provider: 'openai',
        modelId: 'gpt-5',
      ).toJson();
      expect(j.containsKey('thinking'), isFalse);
      expect(j['provider'], 'openai');
      expect(j['model_id'], 'gpt-5');
    });

    test('ModelRoleSet clear omits provider, model_id and thinking', () {
      final j = ModelRoleSet(id: 'r4', role: 'task').toJson();
      expect(j, {'type': 'model_role_set', 'id': 'r4', 'role': 'task'});
    });
  });

  group('ServerMessage — model_roles', () {
    test('parses a reply with in_reply_to, model and thinking', () {
      final m = ServerMessage.fromJson({
        'type': 'model_roles',
        'in_reply_to': 'r1',
        'roles': [
          {
            'role': 'default',
            'name': 'Default',
            'description': 'Main session model',
            'model': _opus,
            'thinking': 'high',
            'source': 'global',
          },
          {
            'role': 'smol',
            'name': 'Smol',
            'description': 'Fast, cheap model',
            'source': 'default',
          },
        ],
      });
      expect(m, isA<ModelRoles>());
      final r = m as ModelRoles;
      expect(r.inReplyTo, 'r1');
      expect(r.roles, hasLength(2));
      final def = r.roles.first;
      expect(def.role, 'default');
      expect(def.name, 'Default');
      expect(def.description, 'Main session model');
      expect(def.model, WireModel.fromJson(_opus));
      expect(def.model!.thinkingLevels, [
        ThinkingLevel.off,
        ThinkingLevel.low,
        ThinkingLevel.high,
      ]);
      expect(def.thinking, ThinkingLevel.high);
      expect(def.source, 'global');
      final smol = r.roles.last;
      expect(smol.model, isNull);
      expect(smol.thinking, isNull);
      expect(smol.source, 'default');
      expect(smol.candidates, isNull);
    });

    test('a frame without in_reply_to is a broadcast', () {
      final m =
          ServerMessage.fromJson({'type': 'model_roles', 'roles': <dynamic>[]})
              as ModelRoles;
      expect(m.inReplyTo, isNull);
      expect(m.roles, isEmpty);
    });

    test('unknown thinking string parses as null (forward-compat)', () {
      final m =
          ServerMessage.fromJson({
                'type': 'model_roles',
                'roles': [
                  {
                    'role': 'plan',
                    'name': 'Plan',
                    'description': '',
                    'thinking': 'mega',
                    'source': 'project',
                  },
                ],
              })
              as ModelRoles;
      expect(m.roles.single.thinking, isNull);
      expect(m.roles.single.source, 'project');
    });

    test(
      'a role-scoped reply carries candidates as provider/model_id refs',
      () {
        final m =
            ServerMessage.fromJson({
                  'type': 'model_roles',
                  'in_reply_to': 'r9',
                  'roles': [
                    {
                      'role': 'plan',
                      'name': 'Plan',
                      'description': 'Planning',
                      'source': 'global',
                      'candidates': [
                        {
                          'provider': 'anthropic',
                          'model_id': 'claude-opus-4-7',
                        },
                        {'provider': 'openai', 'model_id': 'gpt-5'},
                      ],
                    },
                  ],
                })
                as ModelRoles;
        expect(m.roles.single.candidates, const [
          WireModelRef(provider: 'anthropic', modelId: 'claude-opus-4-7'),
          WireModelRef(provider: 'openai', modelId: 'gpt-5'),
        ]);
        const ref = WireModelRef(provider: 'openai', modelId: 'gpt-5');
        expect(ref.toJson(), {'provider': 'openai', 'model_id': 'gpt-5'});
        expect(WireModelRef.fromJson(ref.toJson()), ref);
        expect(
          ref.matches(
            const WireModel(
              id: 'gpt-5',
              name: 'GPT-5',
              provider: 'openai',
              reasoning: true,
              contextWindow: 0,
            ),
          ),
          isTrue,
        );
      },
    );

    test('WireModelRole round-trips through toJson / fromJson', () {
      final role = WireModelRole(
        role: 'plan',
        name: 'Plan',
        description: 'Planning model',
        model: WireModel.fromJson(_opus),
        thinking: ThinkingLevel.low,
        source: 'global',
      );
      expect(WireModelRole.fromJson(role.toJson()), role);
      const scoped = WireModelRole(
        role: 'plan',
        name: 'Plan',
        description: 'Planning model',
        source: 'global',
        candidates: [WireModelRef(provider: 'openai', modelId: 'gpt-5')],
      );
      expect(WireModelRole.fromJson(scoped.toJson()), scoped);
      const bare = WireModelRole(
        role: 'web',
        name: 'Web',
        description: 'Web search',
        source: 'default',
      );
      final j = bare.toJson();
      expect(j.containsKey('model'), isFalse);
      expect(j.containsKey('thinking'), isFalse);
      expect(WireModelRole.fromJson(j), bare);
    });
  });

  test('ActionName parses model_role_set', () {
    expect(ActionName.fromWire('model_role_set'), ActionName.modelRoleSet);
    expect(ActionName.modelRoleSet.wire, 'model_role_set');
  });
}

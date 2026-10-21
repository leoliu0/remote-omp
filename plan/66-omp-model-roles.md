# Plan 66 — Change omp model roles from the app

Status: approved 2026-10-21; implemented and checked on the emulator 2026-10-21. Targets `pi-extension/` and `app/`. The relay does not change.

## Context

The user asked on 2026-10-21 to change the model for omp's other roles (plan, task and so on), not only the session model. Remote Pi is for the user's personal omp use, so it can follow omp closely.

omp keeps one model per role in `~/.omp/agent/config.yml` under `modelRoles`, as `provider/model:thinking`. The user's roles today are `default`, `plan`, `task`, `smol`, `advisor`, `designer` and `web`.

What omp 18.12 exposes (`@oh-my-pi/pi-coding-agent` types):

- `config/settings`: a `settings` singleton with `getModelRoles()`, `getModelRole(role)`, `setModelRole(role, id | undefined)` and `getModelRoleSource(role)` (`project` / `global` / `default`).
- `config/model-roles`: `getKnownRoleIds(settings)`, `getRoleInfo(role, settings)` (name and description), `roleCandidatePool(role, settings, registry)` (eligible models), `isKindRole(role)`, and the alias prefix `@`.
- The extension `ctx` has `modelRegistry`, `setModel` and `setThinkingLevel`, but no settings handle.

The app's model picker today: `list_models` → `models_list` (`WireModel[]`, `current`), then `model_set` changes the session model only.

## Design

**Frames (app ↔ extension):**

| Frame | Direction | Fields |
|---|---|---|
| `list_model_roles` | app → ext | `id` |
| `model_roles` | ext → app | `in_reply_to`, `roles: [{ role, name, description, model?: WireModel, thinking?, source }]` |
| `model_role_set` | app → ext | `id`, `role`, `provider`, `model_id`, `thinking?` (omit `provider`/`model_id` to clear the role back to its default) |

`model_role_set` replies with the existing `action_ok` / `action_error`. On success the extension broadcasts a fresh `model_roles` to every connected owner. `model_roles.roles[].model` reuses `WireModel`, so the app can reuse its model row widget and thinking levels.

**Extension.**

- It must use **omp's own** `settings` instance and the role helpers, not a separate copy. Step 1 checks this. If an extension import resolves to a different module instance, the fallback is to read `modelRoles` from `config.yml` and write it through omp's settings API exposed some other way. Writing the YAML file directly while omp runs is not acceptable, because omp's next save would overwrite the change.
- Roles are global: they apply to every omp session, as when roles are set in the TUI. A project-scoped role shows its `source` and is not edited from the app in this plan.
- `default` stays the session model. The existing picker keeps changing it, and the Roles list marks `default` as "new sessions".

**App.**

- The model sheet gets a **Roles** tab next to the current model list. Each role row shows its name, the model and thinking level, and the description in muted text. Tapping a row opens the same model list filtered to that role's candidates, then the thinking level. "Reset" clears the role.
- The tab refreshes on open and on each `model_roles` broadcast.

## Steps with acceptance criteria

### 1. omp settings access — `pi-extension/`
- Prove the extension sees omp's live `settings`: inside a scratch omp, read `getModelRoles()` and compare it with `config.yml`, set a scratch role, and see omp's `/model` role view show it.
- Acceptance: a short note in `pi-extension/README.md` saying how the extension reaches settings. If neither route works, stop and report before building the rest.

### 2. Frames and handlers — `pi-extension/` + `app/`
- Add the three frames (TS and Dart), a `list_model_roles` handler, and a `model_role_set` handler with validation (unknown role, model not in that role's candidate pool, unsupported thinking level → `action_error`).
- Acceptance: codec round-trip tests on both sides. Handler tests with a fake settings object: list, set, clear, reject, and the broadcast after a set.

### 3. Roles tab — `app/`
- Add the tab, the role → model → thinking flow and Reset.
- Acceptance: widget tests for the role list, the filtered candidates, set → `model_role_set` sent, the `action_error` message, and a broadcast updating the rows.

### 4. Real surface
- Scratch omp + emulator: change `plan` and `task` from the app. `config.yml` shows the new values, omp's model view shows them, and a `/plan` run uses the plan model (seen in the TUI header or logs). Reset `task`, and it returns to its default. Screenshot each step.
- Phone: the APK is sent to the user.

## Definition of done

- Steps 1–3 merged with tests. `tsc` and `flutter analyze` clean; extension and app suites green.
- Step 4 screenshots in `review/screens/` and a dated row in `review/TESTING.md`.

## Risks

- **Global effect:** changing a role from the phone changes it for every running omp session and the terminal. That is intended for personal use.
- **omp internals:** `config/settings` and `config/model-roles` are not part of omp's documented extension API, so an omp update may move them. Step 1's test pins the import, so a break shows up as a failing test, not silent drift.

## Next plans

- The same Roles tab on the web client (`site/`).

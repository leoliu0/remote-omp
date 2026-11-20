# Plan 68 - Mobile parity pack: new session, upload, @files, saved prompts, switcher, retry

## Context

2026-11-20 review of Claude Code Remote Control, Happy, Sesori, Paseo, Omnara and AgentsRoom
(see conversation). Already shipped from that list: push notifications, Git changes sheet,
HTTPS relay (`dc433f56`). The user asked to implement the rest of the recommended set plus a
Retry button. Skipped on purpose: per-tool approval popups, multi-harness, cloud sandboxes,
E2E encryption (transport is TLS now).

Decision 2026-11-19 (plan 67) stands: a *registered* daemon is permanent and only local
commands end it. Sessions started from the phone are therefore **ephemeral by default** (the
supervisor runs them until they exit; Quit ends them, nothing respawns them, a supervisor restart
drops them). "Keep always on" registers a daemon instead, which follows plan 67.

## Features and acceptance

| # | Feature | Acceptance |
|---|---|---|
| 1 | New session from the phone | Home → PC → "New session": recent folders + directory browser, optional name, "Keep always on" toggle; always omp (plan 69). The session appears as a live tile and opens. Refuses a folder that already has a live session. Needs the supervisor (`remote-pi install`); otherwise a clear error. Only for the PC the app is connected to. |
| 2 | Upload any file phone → PC | Attach sheet gains "File". Chunked, acknowledged transfer to `~/.pi/remote/uploads/<date>/<name>`; on success the composer gets the absolute path. Progress and cancel; size cap; works over the relay. |
| 3 | `@` file autocomplete | Typing `@frag` in the composer lists matching files from the session cwd (`rg --files`, fallback `git ls-files`, then a bounded walk), fuzzy-ranked; tap inserts the relative path. |
| 4 | Saved prompts | Local list (app storage) of prompts; one tap inserts; save the current composer text; delete/reorder. Seeded with a few defaults the user can remove. |
| 5 | Session switcher | Tap the chat title → sheet of sessions (live first) with working/idle dots and a per-session colour badge; one tap switches. The active session's colour badge is visible in the app bar. |
| 6 | Retry | A failed turn (provider error) shows "Retry" under the error; tap re-runs the failed turn without duplicating the prompt (omp `AgentSession.retry()` via the extension's SDK handle). omp only (plan 69): no re-send fallback. |

## Wire additions (all request/reply via the typed-action id prefix)

- `list_files {query, limit?}` → `files_list {in_reply_to, root, files[], truncated}`
- `list_dirs {path?}` → `dirs_list {in_reply_to, path, parent, home, dirs[{name,path,is_git}], recent[{path,name,last_used?}], truncated}`
- `spawn_session {cwd, name?, persistent?}` → `spawn_result {in_reply_to, cwd, name, persistent, daemon_id}`
- `upload_start/upload_chunk/upload_end/upload_cancel` → `upload_ack/upload_done/upload_error`
- `retry_turn {}` → `action_ok {action:"retry_turn"}` or `error {code:"nothing_to_retry"|...}`

Older extensions ignore unknown request types; the app times out after 15 s and shows "Update Remote Pi on the PC".

## Verification

Extension: vitest per feature + typecheck + build. App: flutter analyze + tests + emulator
(`RemotePi_Pixel`) walk-through with screenshots in `review/screens/2026-11-20-parity-*`, ledger
row in `review/TESTING.md`, CHANGELOG entries.

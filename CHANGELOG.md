# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-06-23

### Added
- Per-job `extensions` and `skills` fields on subagent jobs (closes #13). Each accepts `boolean | string[]`: `true` loads all registered extensions/skills, an array loads only the named ones, and unset or an empty array loads none (default — current behavior unchanged). Plumbed from the `schedule_prompt` `add`/`update` tool params through `CronJob` to `runSubagentOnce`, which drives `noExtensions`/`noSkills` and `extensionsOverride`/`skillsOverride` on the resource loader
- Enabling `extensions` also switches the subagent from the default builtin toolset to the full set (`tools: undefined`) and calls `session.bindExtensions()` — both are required for extension-provided tools to activate (e.g. MCP, Telegram). `skills` does not widen the toolset: skills surface via the system prompt and the `read` tool. Both fields are no-ops for inline (no-model) jobs

### Fixed
- Widget no longer crashes rendering a job with an undefined `runCount` (now defaults to `0`)

## [0.4.0] - 2026-05-31

### Changed
- **Breaking**: pi runtime packages migrated from the `@mariozechner/*` scope to `@earendil-works/*`. Peer deps are now `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, with the floor raised to `>=0.74.0`. Import paths in `src/` updated accordingly.
- `Type`/`Static` are now imported from `@earendil-works/pi-ai` (which re-exports them from `typebox`) rather than the `typebox` package directly — using a single typebox identity avoids a `TUnsafe` portability error in the inferred tool-param type. Dropped the direct `typebox` dependency.

## [0.3.0] - 2026-05-03

### Added
- Per-session job binding (closes #5): each job has an optional `session` field on `CronJob`. Jobs without a `session` field still load in every pi running in the cwd — the explicit opt-in to "any pi runs it" (useful for hand-edited project-wide cron; accepts duplicate fires)
- `defaultJobScope` setting (`"session"` | `"workdir"`) controls whether newly-created jobs are bound to the creating session. Toggle via `/schedule-prompt → Settings → Bind new jobs to session`; persists in the existing two-layer settings file
- Defensive re-read at dispatch: `executeJob` / `executeJobInSubagent` re-read the job from storage before firing and bail if it's been removed, disabled, or rebound to another session mid-tick
- `CronScheduler.validateSchedule(type, schedule)` — single source of truth for schedule validation, shared by tool `add`/`update` and the UI. `CronScheduler.describeSchedule(type, schedule)` renders a humanized form for confirm dialogs and the widget
- `/schedule-prompt → Add New Job`: the schedule step re-prompts on validation failure instead of bailing the whole flow — the user no longer loses name, type, and prompt to a single typo
- `/schedule-prompt → Add New Job`: confirm dialog with the humanized schedule before save (e.g. `Schedule: daily at 9:00`), so a typo'd cron expression like `0 9 * * * *` (every minute past hour 9) doesn't silently get saved as if it were `0 0 9 * * *` (9am daily)
- `/schedule-prompt → Add New Job` now accepts relative time (`+5m`, `+10s`) and rejects past / too-soon timestamps with the same messages the tool uses; previously the manual flow only accepted ISO strings
- Add flow now asks per-job whether to bind to this session or share with every pi in this cwd. The choice is pre-listed by the global `defaultJobScope` setting (so hitting enter takes the configured default), but every individual add can override it
- New `Jobs` overlay (`/schedule-prompt → Jobs`) — a single TUI view with hotkey-driven actions (`↑↓` navigate, `a` add, `t` toggle enabled, `s` toggle scope (session-bound ↔ shared), `x` remove, `c` cleanup disabled, `q` quit). Foreign-session jobs render read-only in a dedicated "Other sessions" group; actions ignore them. The selected job's full details (id, type, next run, last run, run count, prompt) show below the list

### Changed
- **`/schedule-prompt` menu collapsed to two items**: `Jobs` and `Settings`. The previous five job operations (`View All Jobs`, `Add New Job`, `Toggle Job`, `Remove Job`, `Cleanup Disabled Jobs`) are folded into the `Jobs` overlay
- **Default behaviour change:** new jobs are now bound to the creating session by default (`defaultJobScope: "session"`). Two pi sessions in the same cwd no longer fire the same newly-added job twice. Existing jobs from older versions have no `session` field and keep firing in every pi — flip the setting and re-add (or hand-edit) to migrate them
- Widget, the tool's `list`/`cleanup` actions, and shutdown auto-cleanup all filter to "loaded" jobs only (`!session || session === mySessionId`). Foreign-session jobs are invisible to other pi sessions and never touched on shutdown. The Jobs overlay deliberately shows foreign jobs read-only so the user can still see what else is scheduled in this cwd
- `humanizeCron` and `formatISOShort` lifted from `cron-widget.ts` into `scheduler.ts` (re-exported) so the widget and the confirm dialog produce identical strings

### Fixed
- `saveSettings` now writes only the deliberately-changed field to the project settings file (`<cwd>/.pi/schedule-prompts-settings.json`) instead of snapshotting the merged in-memory state. Previously, toggling `widgetVisible` would also pin the merged value of `defaultJobScope` (or any other field set via the global file) into the project file, masking subsequent global edits
- Widget now actually re-renders on `cron:change` events (add/remove/update/fire/error). Previously the refresh path was gated on a callback pi only registered on theme changes, so the widget went stale until a manual refresh. The 30-second tick used the same gate and was also a no-op
- Widget no longer leaks event listeners across `session_start` / `session_shutdown` cycles. The `pi.events.on("cron:change", …)` subscription's unsubscribe handle is now captured and called from `destroy()` — without it, every reload spawned a zombie widget instance that would also try to render against a stale `ctx`
- `/schedule-prompt → Add New Job` now checks for duplicate names before any prompts — was only checked on the tool path

## [0.2.0] - 2026-05-01

### Added
- Optional `model` field on scheduled jobs (closes #4, #7): when set, the prompt runs in a fresh in-process `AgentSession` with the chosen model instead of being injected into the current chat. The current chat keeps its own model and context untouched. Permissive resolution: `"haiku"`, `"sonnet"`, or `"provider/model-id"` — first match in the available registry wins
- Optional `notify` flag (subagent jobs only): when `true`, the subagent's result is delivered to the parent agent as a follow-up that triggers a new turn. Default is silent. No-op for inline (no-model) jobs — the prompt itself already wakes the parent — and accepted without rejection so existing inline jobs aren't broken by stray `notify` values
- Subagent lifecycle markers in the chat: `subagent_start`, `subagent_done` (with a 500-char output snippet), and `subagent_error` — rendered with a `(subagent: <model>)` tag
- Widget badges for subagent jobs: `[<model>]` per row, with a trailing `!` when `notify=true`
- Active subagents are tracked per `AbortController` and aborted when the scheduler stops (session shutdown / switch / fork), preventing late completions and unhandled rejections
- Test suite (`vitest`): scheduler, subagent runner, and tool — 45 tests covering the new paths
- CI workflow (`.github/workflows/ci.yml`) and Biome config
- Persistent widget visibility setting via a two-layer config (closes #2):
  - Global: `~/.pi/agent/schedule-prompts-settings.json` — manual user defaults
  - Project: `<cwd>/.pi/schedule-prompts-settings.json` — written by the UI
  - Project overrides global on load; survives package upgrades
- `Settings` submenu in `/schedule-prompt` displaying the current widget visibility state live in the row label, with redraw after each change

### Changed
- `executeJob` branches on `job.model`: with no model, prompt is injected into the current chat (existing behavior); with a model, runs the prompt in a subagent. The marker is posted before `sendUserMessage` so it always lands above the prompt
- `model` parameter must be a non-empty string (`minLength: 1` in the schema, plus runtime checks in `add` and `update`). To switch a job from subagent back to inline mode, remove and re-add it without `model` — there's no in-place clearing
- Replaced "Toggle Widget Visibility" menu item with the new `Settings` submenu — the menu itself is the source of truth for current state, removing the need for a success toast
- Schedule input (`/schedule-prompt → Add New Job`) is trimmed before validation, so pasted strings with surrounding whitespace validate cleanly
- Package description updated to reference "Pi's Heartbeat"
- Migrated from `@sinclair/typebox` (v0.34.x legacy line) to the unscoped `typebox` (^1.1.24) package — pi's runtime packages migrated to the new namespace, and mixing the two produced "TUnsafe<string> not assignable to TSchema" errors across `tool.ts` / `types.ts`

### Removed
- Success toast on widget visibility toggle (the menu shows the new state directly). The "session only; failed to persist" warning toast is retained because it's the only signal the user couldn't otherwise observe.
- Dead `session_switch` / `session_fork` listeners — those event names don't exist in pi's `ExtensionEvent` API (the real events are `session_before_switch` / `session_before_fork`), so the handlers never fired and `session_start` already covers the reload/new/resume/fork cases (#3)

### Fixed
- Scheduler no longer leaks croner timers across `session_start` (which fires on reload/resume/fork too): `initializeSession` is now idempotent and tears down any prior scheduler/widget before creating new ones, eliminating duplicate fires of recurring jobs in long-lived sessions (#3)
- `runCount` now advances on every fire: `executeJob` re-reads the job from storage instead of using the closure-captured snapshot, which previously kept writing the same stale `snapshot + 1` value (#3). Same fix applied to the subagent execution path (#7)
- Subagent jobs no longer leave `lastStatus: "running"` if the post-completion marker `pi.sendMessage` throws: storage is advanced to the terminal status before the (best-effort) marker is posted, so a teardown-time failure can't crash the process or stick the job
- Scheduled prompts no longer inject twice into the parent agent's context: the chat marker now carries empty `content` so it's purely a UI event — the renderer still draws it from `details`, and only `sendUserMessage` carries the prompt to the LLM. Previously the prompt text was in both, producing duplicate turns / "PROMPT\n\nPROMPT" rendering, especially when the agent was streaming at fire time
- `notify: false` on subagent jobs is now genuinely silent: the done/error markers are posted with no delivery options (instead of `{deliverAs: "followUp", triggerTurn: false}`) so the parent agent isn't woken even when it was streaming at completion time — pi's `sendCustomMessage` would otherwise take the `followUp` branch and queue a turn regardless of `triggerTurn`. The renderer still surfaces the snippet/error from `details`. `notify: true` still uses `followUp` + `triggerTurn: true` and carries the result snippet in `content` so the parent can react to it
- Stale `lastStatus: "running"` no longer persists across sessions: `CronScheduler.start()` clears the flag for any job that was interrupted mid-execution (subagent aborted by shutdown, process kill). Without this, the widget would render `⟳` for a job that isn't actually running until the cron next fired
- Subagent error messages are now truncated to 500 chars with an ellipsis, matching the success-snippet behavior — verbose API errors / stack traces would otherwise overflow the chat row when the marker is rendered
- `update` action now resolves relative-time schedules (`+5m`, `+10s`, etc.) the same way `add` does, so `update {schedule: "+5m"}` no longer fails with "Invalid timestamp: +5m". Same past-timestamp / too-soon guards as `add`

---

Earlier releases (`v0.1.0`–`v0.1.2`): see [git tags](https://github.com/tintinweb/pi-schedule-prompt/tags).

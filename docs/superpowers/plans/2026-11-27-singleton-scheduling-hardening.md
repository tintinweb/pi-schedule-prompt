# Singleton Scheduling and Shared-Store Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every singleton/live-sync review finding and its regression tests without replacing the extension's file-based architecture.

**Architecture:** Serialize shared-store writers, key singleton claims by scheduled occurrence, and contain scheduler lifecycle/error paths. Add recoverable watching, coherent singleton intervals, bucketed claim pruning, and explicit creation-scope validation.

**Tech Stack:** TypeScript, Node.js filesystem/timers/workers, Pi extension APIs, Croner, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-27-singleton-scheduling-hardening-design.md`

## Global Constraints

- Preserve the synchronous `CronStorage` API and existing non-singleton/session-bound behavior.
- Singleton claim coordination fails closed; `EEXIST` is the only normal losing-claim result.
- Singleton `idle` is unsupported and must be rejected or safely disabled.
- Prompt/model-only edits do not restart armed timers.
- Use one final detailed conventional commit; do not create per-task commits.
- Add no runtime dependency. A dev-only TypeScript process runner is allowed for multi-process tests.

## Review Focus

- A claimant crashes after creating a claim: its occurrence remains claimed and is not stolen.
- A delayed cron/headless callback crosses a wall-clock boundary: it still uses its originally armed occurrence.
- A process dies holding the storage mutation lock: writers recover only through the tested stale-lock path, never by deleting a live lock.
- A project store is removed or malformed while watched: reconciliation fails safely and a later valid save converges.
- A user explicitly chooses duplicate-firing shared scope despite singleton defaults: the explicit choice is preserved.

---

### Task 1: Cross-process transactional storage

**Files:**
- Create: `src/storage-lock.ts`
- Modify: `src/storage.ts`
- Create: `test/storage-lock.test.ts`
- Create: `test/storage-concurrency.integration.test.ts`
- Create: `test/fixtures/storage-writer.ts`
- Modify: `package.json`, `package-lock.json` (dev-only process runner)

**Interfaces:**
- Produces: `withStoreLock<T>(storePath: string, operation: () => T): T` used by every `CronStorage` mutation, plus `incrementRunCount(id, nextRun?): boolean` for atomic counter/metadata updates.
- Preserves: `addJob(job): void`, `removeJob(id): boolean`, `updateJob(id, partial): boolean`, and `save(store): void` signatures.

- [ ] **Step 1: Write failing lock unit tests**
  Cover serialized operation execution, release after a thrown operation, acquisition timeout, live-lock preservation, and stale-lock recovery. Use real temporary directories and controllable timestamps/ownership.
- [ ] **Step 2: Write the failing multi-process integration test**
  Spawn independent fixture processes sharing one `PI_CODING_AGENT_DIR`; each adds unique jobs, updates different jobs, and increments a shared counter after a barrier. Assert every job and terminal field survives, all 400 increments survive, no writer exits nonzero, and no temp files remain.
- [ ] **Step 3: Run the tests and verify RED**
  Run `npx vitest run test/storage-lock.test.ts test/storage-concurrency.integration.test.ts`; expect missing lock/export and lost-update failures.
- [ ] **Step 4: Implement bounded locking and unique-temp saves**
  Use atomic lock-directory creation, `finally` release, unique temp paths, and locked `addJob`/`removeJob`/`updateJob` transactions. Do not lock read-only methods.
- [ ] **Step 5: Run storage tests and verify GREEN**
  Run `npx vitest run test/storage-lock.test.ts test/storage-concurrency.integration.test.ts test/storage.test.ts`; expect all to pass.

### Task 2: Occurrence claims and scalable pruning

**Files:**
- Modify: `src/claims.ts`
- Modify: `test/claims.test.ts`

**Interfaces:**
- Produces: `claimTick(job, occurrenceAt): string` and `tryClaim(cwd, job, sessionId, occurrenceAt): ClaimRecord | null`.
- Produces: `pruneClaims(cwd, now?): void`, removing expired UTC-hour shards and legacy flat claims.
- Consumes: scheduled occurrence timestamps supplied by Task 3.

- [ ] **Step 1: Replace claim tests with occurrence-focused RED cases**
  Assert distinct second-resolution cron occurrences differ, delayed callbacks retain the supplied occurrence, once uses its target, invalid timestamps throw, two claimants have one winner, an existing claim is not stolen after its owner's PID dies, non-`EEXIST` failures throw instead of electing anyone, and `claimedAt` is wall-clock rather than occurrence time.
- [ ] **Step 2: Add pruning RED cases**
  Create current and expired hour shards with many claims; assert expired shards disappear without per-claim mtime manipulation, current shards survive, empty job directories are removed, and legacy stale flat claims remain handled.
- [ ] **Step 3: Run claim tests and verify RED**
  Run `npx vitest run test/claims.test.ts`; expect old minute bucketing, fail-open behavior, and missing shard behavior to fail the new assertions.
- [ ] **Step 4: Implement explicit occurrence keys and bucketed claims**
  Hash project/job identities, derive a UTC-hour directory from occurrence time, use `wx` for atomic claims, return `null` only for `EEXIST`, and throw all other failures.
- [ ] **Step 5: Implement bucket pruning and run GREEN**
  Run `npx vitest run test/claims.test.ts`; expect all claim unit tests to pass before scheduler integration changes.

### Task 3: Scheduler occurrence delivery, lifecycle, and error containment

**Files:**
- Modify: `src/scheduler.ts`
- Modify: `test/claims.test.ts`, `test/scheduler.test.ts`
- Modify: `src/types.ts` only if scheduler-facing occurrence types require documentation

**Interfaces:**
- Consumes: Task 2 occurrence-claim API and Task 1 transactional storage.
- Produces: occurrence-aware timer callbacks, aligned singleton intervals, cancellable grace waits, periodic claim pruning, and fully observed execution failures.

- [ ] **Step 1: Write scheduler RED regressions**
  Cover every-second cron, delayed cron occurrence identity, stop during grace, reschedule/scope/singleton changes during grace, storage failure after a successful claim, claim filesystem failure, singleton idle disable, and no post-stop marker/prompt/subagent.
- [ ] **Step 2: Add singleton interval RED regressions**
  Arm the same singleton interval at staggered wall-clock phases and assert one execution per aligned occurrence with no sub-interval burst. Assert non-singleton intervals retain relative behavior.
- [ ] **Step 3: Run focused tests and verify RED**
  Run `npx vitest run test/claims.test.ts test/scheduler.test.ts`; record each expected failure before implementation.
- [ ] **Step 4: Implement occurrence-aware timers**
  Track Croner occurrences, pass one-shot targets, align only singleton intervals with recursive timeouts, and pass the originally armed occurrence through grace delays.
- [ ] **Step 5: Implement stopped/grace generation handling and full error containment**
  Cancel pending waits on stop, invalidate changed timer signatures, observe every launched promise, and make terminal error updates best-effort.
- [ ] **Step 6: Add periodic pruning and verify GREEN**
  Start an unref'd prune timer, clear it on stop, and run `npx vitest run test/claims.test.ts test/scheduler.test.ts`; expect all focused tests to pass.

### Task 4: Recoverable, consistent live synchronization

**Files:**
- Modify: `src/scheduler.ts`, `src/store-watcher.ts`
- Modify: `test/scheduler.test.ts`, `test/store-watcher.test.ts`, `test/claims.test.ts`

**Interfaces:**
- Preserves: `CronStorage.watch(onChange, onError): () => void` and `CronScheduler.updateJob(id, updated): void` public shapes.
- Produces: watch-before-snapshot startup, terminal-error retry/reconciliation, and no-op payload-only updates for armed timers.

- [ ] **Step 1: Write startup-race RED test**
  Use controlled storage that changes between watcher registration and snapshot acquisition; assert the externally added job is armed without a later event.
- [ ] **Step 2: Write watcher recovery RED tests**
  Simulate a terminal watcher error, successful retry, cleanup during backoff, and a final on-change reconciliation after recovery. Also cover a removed/malformed store followed by a valid save: timers must fail safely and converge on the valid store.
- [ ] **Step 3: Write payload-update RED tests**
  Advance an interval partway, apply prompt/model/preference edits through the tool-facing scheduler path, and assert its original due time and peer phase remain intact. Cover idle model changes without stale `inlineFireAt` coordination.
- [ ] **Step 4: Run watcher/scheduler tests and verify RED**
  Run `npx vitest run test/store-watcher.test.ts test/scheduler.test.ts test/claims.test.ts`; expect the new cases to fail.
- [ ] **Step 5: Implement recovery and signature-aware updates**
  Install watches before snapshots, own retry/backoff cleanup in `watchStore`, skip unchanged-signature rescheduling, and refresh idle timer payloads from storage.
- [ ] **Step 6: Run focused tests and verify GREEN**
  Repeat Step 4; expect all synchronization tests to pass.

### Task 5: Tool and interactive creation paths

**Files:**
- Modify: `src/types.ts`, `src/tool.ts`, `src/ui/add-flow.ts`, `src/ui/jobs-view.ts`
- Modify: `test/tool.test.ts`
- Create: `test/add-flow.test.ts`, `test/jobs-view.test.ts`

**Interfaces:**
- Adds tool param: `scope?: "session" | "workdir"`.
- Enforces: explicit singleton without scope implies workdir; explicit session+singleton and idle+singleton are errors.
- Preserves: explicit ordinary shared scope despite singleton defaults.

- [ ] **Step 1: Write tool RED tests**
  Cover singleton under default settings, explicit scope override, incompatible combinations, default singleton/preference propagation, update validation, and ordinary shared backward compatibility.
- [ ] **Step 2: Write add-flow and JobsView RED tests**
  Cover singleton-first defaults, explicit shared override, idle singleton omission/cycling, TUI preference persistence, and updated scope labels.
- [ ] **Step 3: Run creation tests and verify RED**
  Run `npx vitest run test/tool.test.ts test/add-flow.test.ts test/jobs-view.test.ts`; expect missing scope/default/validation behavior to fail.
- [ ] **Step 4: Implement schema and UI fixes**
  Add scope resolution and validation, correct option ordering, omit/reject idle singleton, and update stale JobsView comments.
- [ ] **Step 5: Run creation and settings tests and verify GREEN**
  Run `npx vitest run test/tool.test.ts test/add-flow.test.ts test/jobs-view.test.ts test/settings.test.ts`; expect all to pass.

### Task 6: Documentation, full verification, and detailed commit

**Files:**
- Modify: `README.md`, `CHANGELOG.md`
- Verify: all files above

**Interfaces:**
- Produces: one detailed conventional commit containing design, plan, code, tests, and documentation.

- [ ] **Step 1: Update documentation**
  Document occurrence-keyed at-most-once claims, fail-closed errors, supported singleton types, aligned intervals, seven-day bucket retention with periodic pruning, explicit tool scope, UI defaults, and recoverable live synchronization.
- [ ] **Step 2: Run the complete verification suite**
  Reconcile installed dependencies with `package.json`, then run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`; require zero failures.
- [ ] **Step 3: Review the final diff against all 13 findings**
  Map every finding to code and at least one regression test; check for accidental files, stale comments, secrets, and temporary fixtures/artifacts.
- [ ] **Step 4: Create the single detailed commit**
  Use `fix: harden singleton scheduling and shared-store synchronization` with a body summarizing storage transactions, occurrence/lifecycle fixes, synchronization recovery, creation/UI changes, and test coverage.
- [ ] **Step 5: Verify the committed state**
  Run `git status --short`, `git show --stat --oneline HEAD`, and the complete verification commands on the committed worktree; report exact results and commit SHA.

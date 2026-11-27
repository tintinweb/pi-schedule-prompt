# Singleton Scheduling and Shared-Store Hardening Design

## Intent

Fix every finding from the `HEAD^1` paranoid-architect review while preserving the extension's current per-session scheduler architecture. The work addresses both defects introduced by singleton/live synchronization and latent storage/timer bugs exposed by those features.

## Goals

- Make shared-store mutations safe under real concurrent processes.
- Give every supported singleton execution a stable scheduled-occurrence identity.
- Guarantee at-most-once execution while the configured claim-retention safety window covers all contenders.
- Fail closed and visibly when singleton coordination is unavailable.
- Cancel obsolete executions on shutdown and schedule/scope changes.
- Make live synchronization race-resistant, recoverable, and consistent across originating and peer sessions.
- Make singleton creation work through both the tool and interactive UI.
- Bound claim-file growth during long-lived sessions and make pruning scale by time buckets rather than individual historical claims.
- Add regression coverage for every finding and update the affected documentation.

## Non-goals

- No centralized scheduler, daemon, presence registry, heartbeat protocol, or external database.
- No exactly-once recovery after a claimant crashes; behavior remains at-most-once per claimed occurrence.
- No redesign of non-singleton interval semantics.
- No support for singleton idle jobs.

## Constraints

- Preserve the existing synchronous `CronStorage` public API.
- Keep the existing Pi extension and TypeScript/Vitest stack.
- Use one final detailed conventional commit for design, plan, implementation, tests, and documentation.
- Do not silently execute a singleton job when its claim cannot be coordinated.
- Prompt/model-only edits must not restart an armed timer.
- Existing non-singleton and session-bound behavior must remain backward compatible except where explicitly documented.

## Approaches Considered

### Selected: harden the current file-based architecture

Add a cross-process storage mutation lock, explicit occurrence keys, cancellable grace waits, watcher recovery, and bucketed claim storage. This is the smallest change that addresses the root causes without introducing a service or database.

### Rejected: targeted patches only

Adding second-resolution keys or catching individual errors would leave lost store updates, interval identity drift, shutdown races, and unbounded claim growth intact.

### Rejected: centralized scheduler or SQLite

A single-owner daemon or embedded database could provide stronger transactions, but either would be a substantial architectural replacement with new deployment/runtime requirements. The current extension's synchronous API and file-based profile/project layout do not justify that migration for this fix.

## Design

### 1. Transactional shared storage

Introduce `withStoreLock(storePath, operation)` in `src/storage-lock.ts`. An atomic lock-directory create guards the complete load→mutate→save transaction. Acquisition retries for a bounded period, records diagnostic ownership, and reclaims only demonstrably stale locks. Lock release is in `finally`.

`CronStorage.addJob`, `removeJob`, and `updateJob` use the lock. `incrementRunCount(id, nextRun?)` keeps counter reads, increments, and terminal metadata in the same transaction rather than reintroducing a compound-write race. Saves use unique temp filenames in the store directory, followed by rename and best-effort temp cleanup. Atomic rename remains responsible for reader consistency; the lock is responsible for writer serialization.

A dev-only TypeScript process runner is permitted for integration tests that launch independent `CronStorage` writers. Tests must prove concurrent adds all survive, concurrent updates do not resurrect disabled jobs, and no shared-temp rename errors occur.

### 2. Occurrence-keyed singleton claims

`tryClaim(cwd, job, sessionId, occurrenceAt)` uses the scheduled occurrence for the claim key and the actual wall clock only for diagnostic `claimedAt`. `once` uses its target timestamp; cron callbacks pass the occurrence armed by Croner; singleton intervals pass their aligned occurrence. Timestamp validation errors and all non-`EEXIST` filesystem errors propagate to the scheduler. `EEXIST` alone returns `null` and means another session won.

Singleton `idle` is unsupported and rejected at tool/UI creation and update boundaries. A hand-edited enabled singleton idle job is disabled with an explanatory error instead of firing ambiguously.

### 3. Coherent singleton intervals

Singleton intervals use epoch-aligned occurrences and recursive `setTimeout`, not independent relative `setInterval` phases. Each callback receives the occurrence it was armed for and schedules the next future occurrence. Non-singleton intervals retain their existing behavior.

Cron scheduling tracks the next occurrence alongside each Croner instance so delayed callbacks still claim the occurrence they were armed for, not the wall-clock minute in which they happen to run.

### 4. Execution lifecycle and errors

The scheduler tracks stopped state and pending grace waits. `stop()` cancels and resolves every pending wait. After a grace wait, execution proceeds only if the scheduler is still active and the timer signature (type, schedule, interval, session, singleton) is unchanged. Prompt/model/preference payloads may still be read fresh.

The complete claim-and-dispatch path is contained by error handling. Timer launchers explicitly observe rejections. Failures are reported through the scheduler's UI-safe `report()` path and make a best-effort terminal `lastStatus: "error"` update without throwing a second unhandled error.

### 5. Claim storage and pruning

Claims are sharded by hashes of project/job identity and a UTC hour bucket derived from the scheduled occurrence. Pruning removes whole expired buckets with recursive directory removal instead of statting every historical claim. Legacy flat claim files remain prunable.

A lightweight, unref'd periodic prune runs while the scheduler is active and is cleared by `stop()`. The existing seven-day retention remains the documented safety window; periodic pruning bounds steady-state growth to that window instead of allowing indefinite growth in long-lived sessions.

### 6. Live synchronization

`start()` installs the watcher before taking its fresh store snapshot, then reconciles. Watcher creation failure still leaves explicit local scheduling behavior and reports the problem.

`watchStore` owns its retry lifecycle. A terminal watcher error closes the failed watcher and retries with bounded backoff. A successful retry triggers reconciliation. Cleanup cancels watchers, debounce timers, and retries.

`CronScheduler.updateJob()` leaves an enabled timer in place when its timer signature is unchanged. Idle bookkeeping and timer callbacks read the current model/prompt so payload-only edits do not leave stale inline coordination.

### 7. Creation and UI behavior

The tool gains `scope: "session" | "workdir"`. Explicit `singleton: true` without `scope` selects workdir scope; explicit session scope plus singleton is rejected. Incompatible idle/singleton combinations are rejected on add and update.

The add flow lists singleton first when workdir + singleton are the configured defaults and omits singleton as an option for idle jobs. JobsView cycles session↔shared for idle jobs and session→shared→singleton for supported types. Existing per-job TUI preference behavior is preserved.

### 8. Documentation and verification

Update README, CHANGELOG, and stale code comments for scope behavior, supported job types, occurrence semantics, failure behavior, retention, and live synchronization.

Verification requires focused red/green regression tests, real multi-process storage tests, the complete Vitest suite, TypeScript, Biome, build, and `git diff --check`. The existing checkout's stale dependencies must be reconciled with `package.json` before treating full-suite results as authoritative.

## Builder Calls

- Keep seven-day claim retention; periodic bucket pruning fixes indefinite growth without weakening the documented late-contender window.
- Use a dev-only process runner for genuine multi-process integration tests rather than adding a runtime dependency.
- Preserve non-singleton relative intervals to avoid an unrelated scheduling behavior change.
- Treat malformed hand-edited singleton idle jobs as unsafe and disable them rather than silently running in every session.

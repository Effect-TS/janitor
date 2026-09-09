# 09: Delete repository data on explicit disconnection

Status: ready-for-agent
Blocked by: 07, 08

## What to build

Make explicit disconnection delete Janitor's repository data, with reconnection behaving as a fresh connection.

## Acceptance criteria

- [x] Disconnect deletes policies, drafts and published history, labeling rules and groups, stored facts, repository event history, and associated cached evaluation data.
- [x] Remove retained repository payloads and pending work that would otherwise preserve or recreate that data.
- [x] Already-applied GitHub labels remain unchanged.
- [x] Reconnection restores no deleted configuration and requires successful synchronization before becoming ready for future events.
- [x] Keep only the identity/access information needed to offer the repository for a fresh connection.
- [x] Delayed webhook processing, retries, and in-flight work cannot recreate the disconnected repository's deleted data or apply automation.
- [x] The UI clearly states the deletion semantics, distinguishing disconnection from pause and access loss.
- [x] Verify deletion completeness, idempotent disconnection, stale-work handling, and fresh reconnection end to end.

## Implementation notes

- Disconnection deletes repository configuration, policy drafts and versions, rules and groups, facts and collections, AI consent and cached decisions, evaluations, event history, HTTP cache entries, notifications and pending or accepted outbox entries. Repeated disconnection also clears data retained by older releases.
- Repository identity and access remain available for reconnection. A retained generation floor prevents deleted synchronization identities from being reused. Reconnection clears any legacy configuration, enables synchronization, and waits for all required tracks before becoming ready.
- Repository webhook ciphertext is journaled under the repository lock, without queue or R2 copies. Legacy queue deliveries are attributed before journaling, checked against the admission cutoff, acknowledged and removed when stale. Unattributed legacy journal payloads are identified with the encryption key before deletion.
- Synchronization responses, evaluation traces and label plans are no longer persisted in workflow results. Replayed page writes repeat under the generation fence. AI claims and cache writes recheck connection ownership under the repository lock. GitHub labels remain unchanged by disconnection.
- Migration 0020 requires stopping old workers, draining legacy queued payloads and clearing retained legacy workflow results before rollout. See apps/cluster/migrations/README.md for the deployment prerequisites.
- The user confirmed the existing connection service/database, webhook and worker, and repository UI test boundaries. Coverage includes every repository-attributed table, cascade deletion, legacy retained configuration, delayed encrypted overflow delivery across reconnection, stale generations, readiness and unchanged GitHub writes.
- Review baseline: b8899594446b42c89169afe4afbdd5a2cc50a05e. Standards review found no documented violations and one optional suggestion to move legacy attribution behind the journal module. Spec review findings about durable payload copies and page replay were fixed and re-reviewed.
- Validation: vp check --fix passed with warnings. The full suite passed all 525 tests across 93 files using the local Podman socket. Targeted synchronization and connection tests passed after the final replay and legacy-upgrade fixes.

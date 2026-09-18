# Issue-review completion review

Reviewed on 2026-09-18 at `96a6cd3` against the confirmed spec, backend design, ticket acceptance criteria, implementation history, current backend code, and regression coverage.

All 13 implementation tickets have implementation evidence. No additional implementation ticket was identified by this review. Deployment and live verification remain outstanding; completion here does not establish live production readiness.

## Reconciled records

Tickets 01–07 and 10 had unchecked acceptance criteria despite completed implementations. Tickets 08, 09, 11, 12, and 13 already had checked criteria and implementation notes. None had an explicit completion field. Ticket 10 also lacked its implementation note entirely.

The tickets now have checked criteria and explicit completion fields. Their `Status:` fields use the repository's canonical triage vocabulary, which has no completed role. The obsolete `in-review` values on 02–04 were normalized to `ready-for-agent`; `Completion: complete` records closure independently of triage. The ticket index no longer says implementation has not started.

Ticket 05's old `@effect-janitor` reference now matches `@janitor`, as established by commit `5d24041`, ADR 0007, the mention parser, and its tests. The spec and backend design identify their original authorization language as historical. The implementation-facts document is marked as a pre-implementation baseline rather than a current gap list.

## Implementation evidence

Paths below are relative to the repository root. The [verification record](../../docs/issue-review-verification.md) maps acceptance scenarios to test files and distinguishes controlled external services from live checks.

| Ticket | Implementation commit | Current evidence                                                                                                                            |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 01     | `1ab61b5`             | `RepositoryEligibility.ts`, Slack repository access, migration 0038, eligibility and Slack tests                                            |
| 02     | `de2ae6a`             | `Labeling/DirectLabeling.ts`, direct issue reads and previews, migration 0039, direct-labeling tests                                        |
| 03     | `c0864f0`             | Direct PR reads and collection pagination, migration 0041, PR-labeling tests                                                                |
| 04     | `d65762c`             | Migration 0042 removes cache eligibility predicates; `Labeling/CacheIndependence.test.ts` covers stale, absent, failed, and disabled cache  |
| 05     | `02cfa47`             | Review admission, authority, store, agent Entity, scheduler and controls; `Review/Review.test.ts`                                           |
| 06     | `2f2d88a`             | Persisted investigation actions, conversation/evidence boundaries, sandbox provisioning; `Review/Investigation.test.ts` and workspace tests |
| 07     | `27c5cdc`             | Patch and reproduction validation, retained attempts and evidence; patch, reproduction, workspace and investigation tests                   |
| 08     | `b2272e7`             | Summary publication and guards, durable summary ownership, output validation and interrupted-write tests                                    |
| 09     | `c440f54`             | Separate branch and draft-PR actions, scoped GitHub adapters, publication intent and recovery tests                                         |
| 10     | `368ae13`             | `Review/DraftPublication.ts`, migration 0048, PR adapter and investigation tests for reuse and human changes                                |
| 11     | `46b8f98`             | `Review/SavedPublication.ts`, ingress authorization and frontend publication, saved-result integration tests                                |
| 12     | `5b42165`             | `Review/Retention.ts`, migration 0050, expiry, deduplication, disconnect and post-expiry reuse tests                                        |
| 13     | `96a6cd3`             | Default-off production gate, complete automatic and saved-result scenarios, restart coverage, operator and verification guides              |

Ticket 10 checks recorded ownership, branch head, PR content fingerprints, base, and open/draft state before updates. Tests cover changed title/body/head, a missing branch, marking ready, closed/merged PRs, changes between writes, authority loss, lost update responses, and repeated completion delivery. This is implemented work whose tracker record was stale.

Earlier tickets' comments retain historical limitations. Ticket 04 retires the legacy synchronization fence described in 01–03. Ticket 07 adds execution and reproduction beyond 06's original read-only investigation. Ticket 13 replaces the development gate. Recorded remote check/write races remain an explicit limitation in the operator guide, not a missing atomic-write guarantee.

## Remaining work

Run the nine [deployment smoke-test scenarios](../../docs/issue-review-verification.md#deployment-smoke-tests-still-required) during a separately authorized rollout. They cover deployed migrations and container provisioning, real model/GitHub integration, credential-free package installation and reproduction, dry-run and explicit publication, automatic publication, ordering/replay, restart/workspace loss, cancellation and revocation, uncertain writes and human edits, retention, and cache independence.

Record the deployed version, environment, artifacts, and outcomes before claiming live readiness. Deployment and repository opt-in were not performed in this review. The production feature gate remains default-off in code.

## Validation

- `vp install` succeeded.
- `vp check` passed with 0 errors and 347 warnings.
- `vp test` passed all 790 tests across 125 files, with no skipped tests.

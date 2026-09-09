# 06: Expire and invalidate cached AI results

Status: ready-for-agent
Blocked by: 02

## What to build

Reuse successful AI results only while both their lifetime and rule inputs remain valid.

## Acceptance criteria

- [x] One deployment-controlled cache lifetime applies to all AI rules, defaulting to 24 hours; there is no per-rule lifetime setting.
- [x] Reuse requires unchanged rule parameters, referenced facts, and deployment-wide provider and model.
- [x] Changes to minimum confidence, label actions, priority, or other rule parameters invalidate reuse even when prompt text stays unchanged.
- [x] Expiry and configuration edits do not initiate AI requests. The next eligible evaluation makes a fresh request.
- [x] Operational failures are not reused as successful cached answers.
- [x] Concurrent evaluations do not bypass expiry or return results for superseded parameters.
- [x] Show whether an evaluation reused a result; validate the deployment setting at its boundary.
- [x] Verify reuse before expiry, refresh after expiry, and invalidation by actions, priority, confidence, facts, and model changes.

## Implementation notes

- `LABELING_AI_CACHE_TTL_SECONDS` sets one deployment-wide lifetime, defaulting to 86,400 seconds. The deployment boundary accepts whole seconds from 1 through 2,147,483,647.
- Cache keys include the rule binding and revision, program, referenced facts, input budget, and provider/model. Both configured test evaluations and automatic labeling supply the rule binding.
- Cache lookups and concurrent waiters apply the same expiry check. Successful refreshes replace expired rows and restart the lifetime at completion. Operational failures do not populate the cache.
- Cache returns and provider attempts check whether work remains current and consent still matches. A concurrent evaluation with changed rule parameters gets a separate request. Reverting a rule edit cannot revive an earlier answer. Configuration tests reject results if their revision changes during evaluation.
- Evaluation responses retain the existing `cached` flag and the rule editor displays cache reuse.
- Validation: `vp check --fix` passed with warnings. All 514 tests passed across 88 files using the local Podman socket.
- Review: no remaining Standards or Spec findings. Fixes added rule revision invalidation and configuration-test freshness checks, and removed a test dependency on the internal polling sequence.

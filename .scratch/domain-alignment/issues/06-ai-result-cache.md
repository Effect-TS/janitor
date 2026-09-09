# 06: Expire and invalidate cached AI results

Status: ready-for-agent
Blocked by: 02

## What to build

Reuse successful AI results only while both their lifetime and rule inputs remain valid.

## Acceptance criteria

- [ ] One deployment-controlled cache lifetime applies to all AI rules, defaulting to 24 hours; there is no per-rule lifetime setting.
- [ ] Reuse requires unchanged rule parameters, referenced facts, and deployment-wide provider and model.
- [ ] Changes to minimum confidence, label actions, priority, or other rule parameters invalidate reuse even when prompt text stays unchanged.
- [ ] Expiry and configuration edits do not initiate AI requests. The next eligible evaluation makes a fresh request.
- [ ] Operational failures are not reused as successful cached answers.
- [ ] Concurrent evaluations do not bypass expiry or return results for superseded parameters.
- [ ] Show whether an evaluation reused a result; validate the deployment setting at its boundary.
- [ ] Verify reuse before expiry, refresh after expiry, and invalidation by actions, priority, confidence, facts, and model changes.

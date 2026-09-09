# 09: Delete repository data on explicit disconnection

Status: ready-for-agent
Blocked by: 07, 08

## What to build

Make explicit disconnection delete Janitor's repository data, with reconnection behaving as a fresh connection.

## Acceptance criteria

- [ ] Disconnect deletes policies, drafts and published history, labeling rules and groups, stored facts, repository event history, and associated cached evaluation data.
- [ ] Remove retained repository payloads and pending work that would otherwise preserve or recreate that data.
- [ ] Already-applied GitHub labels remain unchanged.
- [ ] Reconnection restores no deleted configuration and requires successful synchronization before becoming ready for future events.
- [ ] Keep only the identity/access information needed to offer the repository for a fresh connection.
- [ ] Delayed webhook processing, retries, and in-flight work cannot recreate the disconnected repository's deleted data or apply automation.
- [ ] The UI clearly states the deletion semantics, distinguishing disconnection from pause and access loss.
- [ ] Verify deletion completeness, idempotent disconnection, stale-work handling, and fresh reconnection end to end.

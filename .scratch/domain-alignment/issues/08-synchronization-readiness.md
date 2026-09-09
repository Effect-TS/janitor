# 08: Gate automation on successful synchronization

Status: ready-for-agent
Blocked by: 07

## What to build

Show when repository automation is ready or blocked by synchronization failure, with automatic recovery and no catch-up labeling.

## Acceptance criteria

- [ ] First connection and manual resumption require successful synchronization before automation becomes ready.
- [ ] A failed repository synchronization blocks all repository automation and exposes a clear reason and recovery action.
- [ ] Automatic synchronization retries continue while blocked. Webhooks may update stored facts but cannot trigger automation or clear the block.
- [ ] Successful recovery clears the failure block unless the repository was manually paused; partial success must not mask remaining failed synchronization work.
- [ ] Becoming ready after connection, resumption, or recovery waits for new webhook events. It neither replays blocked events nor labels all existing items.
- [ ] Manual synchronization refreshes facts without triggering automation.
- [ ] Policy publication and rule changes continue to affect future evaluations without starting labeling.
- [ ] Automatic labeling concerns only the open issue or pull request associated with the new event. Closed or merged items cannot receive automation writes.
- [ ] Verify state transitions and stale queued work across failure, retry, pause, and recovery, including no catch-up label writes.

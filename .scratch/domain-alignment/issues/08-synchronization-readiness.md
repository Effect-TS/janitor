# 08: Gate automation on successful synchronization

Status: ready-for-agent
Blocked by: 07

## What to build

Show when repository automation is ready or blocked by synchronization failure, with automatic recovery and no catch-up labeling.

## Acceptance criteria

- [x] First connection and manual resumption require successful synchronization before automation becomes ready.
- [x] A failed repository synchronization blocks all repository automation and exposes a clear reason and recovery action.
- [x] Automatic synchronization retries continue while blocked. Webhooks may update stored facts but cannot trigger automation or clear the block.
- [x] Successful recovery clears the failure block unless the repository was manually paused; partial success must not mask remaining failed synchronization work.
- [x] Becoming ready after connection, resumption, or recovery waits for new webhook events. It neither replays blocked events nor labels all existing items.
- [x] Manual synchronization refreshes facts without triggering automation.
- [x] Policy publication and rule changes continue to affect future evaluations without starting labeling.
- [x] Automatic labeling concerns only the open issue or pull request associated with the new event. Closed or merged items cannot receive automation writes.
- [x] Verify state transitions and stale queued work across failure, retry, pause, and recovery, including no catch-up label writes.

## Implementation notes

- Readiness is distinct from manual pause. Initial connection and resumption require verified labels, entities and pull requests. Failed repository and entity targets block automation, and partial recovery retains the block.
- Automatic and manual retries retain failed work. Webhook receipt time qualifies only the event's entity refresh; manual synchronization and scans cannot qualify labeling. Recovery changes the admission boundary, fencing queued evaluations and delayed blocked events.
- Issue webhooks now refresh the concerned issue. Snapshot publication and label writes reject closed issues and closed or merged pull requests.
- Repository settings display readiness, the synchronization error, automatic retry behavior and a retry action.
- Confirmed test seams: repository connections, sync targets, webhook projection, labeling workflows and repository status UI. Review baseline: `2c7a70dd57302dede72d4a8ab3480a1e08ec2249`.

- Standards and Spec reviews have no remaining findings. The review fix centralized failed-entity retries in `SyncTargets`.
- Validation: all 524 tests across 93 files pass with the local Podman socket and four workers. `vp check --fix` passes with warnings, and `vp build apps/web` passes with a bundle-size warning.

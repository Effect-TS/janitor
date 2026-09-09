# 04: Enforce labeling-group exclusivity and priority

Status: ready-for-agent
Blocked by: 01, 02, 03

## What to build

Make labeling groups enforce at-most-one-label behavior with understandable priorities and a usable reordering operation.

## Acceptance criteria

- [x] A group belongs to one repository and one target. Validate membership and target changes through the API and editor.
- [x] Larger priority numbers take precedence. Priorities are unique within the group, including disabled rules.
- [x] Reorder multiple rules atomically, permitting swaps if final priorities are unique. Reject conflicting concurrent changes.
- [x] Among applicable enabled rules requesting presence, retain only the highest-priority rule's label, regardless of whether presence came from match or non-match.
- [x] Remove other group labels, including labels owned by disabled rules or rules taking no action.
- [x] If applicable rules request no label, remove the group's labels. If no enabled rule applies, leave all group labels unchanged.
- [x] Any enabled rule with an unknown or failed evaluation blocks all label changes for the group. Not-applicable rules step aside.
- [x] Disabling a rule itself removes no labels; later group decisions can remove its label.
- [x] Existing priorities and mixed-target groups receive an explicit migration strategy that preserves user intent or reports conflicts for resolution.
- [x] Verify the decision cases above through rule testing and automatic labeling, as well as API validation and UI reordering.

## Implementation notes

- Groups use repository and name as their identity. Membership checks use current published targets and include disabled rules. Rule edits, AI target changes, and policy saves/publication validate under the repository mutation lock.
- Larger priorities win among both match and non-match presence requests. Applicable group decisions remove all other member labels, including disabled and no-action rules. Unknown and failed evaluations block the group; no applicable enabled rules leave it unchanged.
- Configuration snapshots retain disabled group members without evaluating them or requesting their fact tracks. Preview and automatic labeling share these decisions.
- Reordering sends the complete membership, observed versions, and final priorities in one API operation. The editor provides move-up/down controls and reserves disabled priorities. Concurrent or stale membership changes return 409; invalid final priorities return 422.
- Migration 0017 reports mixed-target groups and duplicate priorities for resolution before changing records. It converts priorities with `-priority - 1` to retain existing precedence, advances rule versions and configured revisions, and preserves historical snapshots and decisions. Deployment instructions are in `apps/cluster/migrations/README.md`.
- Review baseline: `4d0c55ae71ffa246001ce28caac4047d82214174`. Standards and Spec reviews have no remaining findings. The spec review found an editor race during reordering; a regression reproduces it and verifies that unrelated edits and explicit priority edits both survive the response.
- Validation: `vp check --fix` passed with warnings and the web production build passed. The full suite passed 494 tests across 85 files; the remaining readiness suite hit its 60-second database setup timeout. Its isolated rerun passed, completing all 495 tests across 86 files. Tests used the local Podman socket.

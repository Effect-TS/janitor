# 04: Enforce labeling-group exclusivity and priority

Status: ready-for-agent
Blocked by: 01, 02, 03

## What to build

Make labeling groups enforce at-most-one-label behavior with understandable priorities and a usable reordering operation.

## Acceptance criteria

- [ ] A group belongs to one repository and one target. Validate membership and target changes through the API and editor.
- [ ] Larger priority numbers take precedence. Priorities are unique within the group, including disabled rules.
- [ ] Reorder multiple rules atomically, permitting swaps if final priorities are unique. Reject conflicting concurrent changes.
- [ ] Among applicable enabled rules requesting presence, retain only the highest-priority rule's label, regardless of whether presence came from match or non-match.
- [ ] Remove other group labels, including labels owned by disabled rules or rules taking no action.
- [ ] If applicable rules request no label, remove the group's labels. If no enabled rule applies, leave all group labels unchanged.
- [ ] Any enabled rule with an unknown or failed evaluation blocks all label changes for the group. Not-applicable rules step aside.
- [ ] Disabling a rule itself removes no labels; later group decisions can remove its label.
- [ ] Existing priorities and mixed-target groups receive an explicit migration strategy that preserves user intent or reports conflicts for resolution.
- [ ] Verify the decision cases above through rule testing and automatic labeling, as well as API validation and UI reordering.

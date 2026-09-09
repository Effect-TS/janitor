# 03: Enforce label ownership

Status: ready-for-agent
Blocked by: None

## What to build

Give each label a single controlling labeling rule per repository and target, with clear conflict feedback during creation and editing.

## Acceptance criteria

- [ ] At most one rule owns a repository's label for a given target, including disabled rules.
- [ ] Separate issue and pull-request rules may own the same label.
- [ ] Creates, edits, and policy-target changes cannot introduce duplicate ownership, including concurrent requests.
- [ ] The API rejects conflicts with an actionable error and the editor identifies the conflict.
- [ ] Disabling retains ownership; deletion releases it without removing GitHub labels.
- [ ] Inspect existing records before enforcing the invariant. Report existing conflicts for resolution rather than silently deleting or reassigning user configuration.
- [ ] Verify concurrent conflicting creates, a disabled owner's reservation, and permitted cross-target reuse.

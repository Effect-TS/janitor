# 03: Enforce label ownership

Status: ready-for-agent
Blocked by: None

## What to build

Give each label a single controlling labeling rule per repository and target, with clear conflict feedback during creation and editing.

## Acceptance criteria

- [x] At most one rule owns a repository's label for a given target, including disabled rules.
- [x] Separate issue and pull-request rules may own the same label.
- [x] Creates, edits, and policy-target changes cannot introduce duplicate ownership, including concurrent requests.
- [x] The API rejects conflicts with an actionable error and the editor identifies the conflict.
- [x] Disabling retains ownership; deletion releases it without removing GitHub labels.
- [x] Inspect existing records before enforcing the invariant. Report existing conflicts for resolution rather than silently deleting or reassigning user configuration.
- [x] Verify concurrent conflicting creates, a disabled owner's reservation, and permitted cross-target reuse.

## Comments

Implemented on 2026-09-09. Ownership checks run under the existing repository-row mutation lock for rule writes and policy saves/publication. Ownership follows the current published target; publishing rechecks changes made since draft save. The API returns an actionable `duplicate-label` issue, which the editor displays.

Read-only inspection of the running local development database found no duplicate owners. Migration `0016_label_ownership.sql` checks each database and reports conflicting repository, label, target, and rule IDs without modifying configuration. Stop old workers before migration and start the new release after it passes.

Focused service, API, editor, and migration tests pass, including concurrent creates, publication racing with creation, disabled reservations, cross-target reuse, edit rollback, and deletion. Review baseline: `5e47efe77bb12452496abdee2bbd2eb282b448c6`.

Final validation: `vp check` passed with warnings; `vp test run` passed all 489 tests across 83 files using the local Podman socket. Existing classifier and policy fixtures now use unowned labels. The code-review Standards and Spec axes each reported zero findings.

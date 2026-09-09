# 02: Configure match and non-match label actions

Status: ready-for-agent
Blocked by: 01

## What to build

Let users configure both result actions on policy-based and AI labeling rules through the API and rule editor.

## Acceptance criteria

- [x] Match and non-match each independently support ensure present, ensure absent, and take no action.
- [x] Ensure present restores manually removed labels; ensure absent removes manually added labels only when that action is requested.
- [x] Take no action makes no label request. Unknown, failed, and not-applicable results do not run either configured result action.
- [x] Remove the preserve-only restriction on AI rules while preserving AI permission controls.
- [x] Existing rules migrate to match = ensure present and their existing non-match behavior without losing configuration.
- [x] Rule testing, automatic labeling, and activity descriptions use the same actions and vocabulary.
- [x] Editing a rule changes future evaluations and does not itself trigger labeling.
- [x] Verify an AI rule that removes a label on match and adds it on non-match, plus no-action behavior.

## Implementation notes

- Both rule types now accept independent `onMatch` and `onNoMatch` actions: `ensure-present`, `ensure-absent`, or `no-action`. The editor saves and previews those choices without scheduling labeling.
- Migration `0015_configurable_label_actions.sql` adds the match action and converts legacy `preserve` values to `no-action` in rules and configuration snapshots. It retains revisions, timestamps, AI definitions, and other settings.
- AI rules retain consent, evidence validation, and owned-policy controls. Classifier bindings and policy publishing no longer impose the preserve-only restriction.
- Plans record the requested action for activity history, including when no write is needed. Older activity remains readable without inventing a historical action.
- Group priority and exclusivity changes remain in ticket 04. The existing priority order remains in use; either result can now request presence.
- Regression coverage includes API defaults and validation, AI editing, migration of existing records, reversed AI actions through testing and GitHub writes, and no-action behavior.
- Validation: `vp check --fix` passed with warnings; all 482 tests passed across 81 files; the web production build passed. Tests used the local Podman socket.
- Review: no remaining Standards or Spec findings. Review fixes moved HTTP coverage onto real services and Postgres, removed an internal outbox assertion, and narrowed action helpers to the domain result type.

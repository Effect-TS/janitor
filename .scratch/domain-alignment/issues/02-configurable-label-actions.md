# 02: Configure match and non-match label actions

Status: ready-for-agent
Blocked by: 01

## What to build

Let users configure both result actions on policy-based and AI labeling rules through the API and rule editor.

## Acceptance criteria

- [ ] Match and non-match each independently support ensure present, ensure absent, and take no action.
- [ ] Ensure present restores manually removed labels; ensure absent removes manually added labels only when that action is requested.
- [ ] Take no action makes no label request. Unknown, failed, and not-applicable results do not run either configured result action.
- [ ] Remove the preserve-only restriction on AI rules while preserving AI permission controls.
- [ ] Existing rules migrate to match = ensure present and their existing non-match behavior without losing configuration.
- [ ] Rule testing, automatic labeling, and activity descriptions use the same actions and vocabulary.
- [ ] Editing a rule changes future evaluations and does not itself trigger labeling.
- [ ] Verify an AI rule that removes a label on match and adds it on non-match, plus no-action behavior.

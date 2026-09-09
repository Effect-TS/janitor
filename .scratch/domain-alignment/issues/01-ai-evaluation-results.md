# 01: Distinguish failed AI evaluations from unknown results

Status: ready-for-agent
Blocked by: None

## What to build

Expose meaningful AI evaluation results in automatic labeling, rule testing, and activity history. The domain-modeling interview is the source of these decisions.

## Acceptance criteria

- [x] Missing required facts produce unknown, never non-match.
- [x] A completed classification below minimum confidence produces non-match; an accepted answer produces match or non-match according to its answer.
- [x] Timeouts, provider failures, and invalid provider configuration produce a distinct failed evaluation with an actionable error.
- [x] Unknown and failed evaluations leave the affected label unchanged. Within a labeling group, either result leaves all group labels unchanged while unrelated rules may still act.
- [x] Failure is distinct from a label-write failure in displayed results and stored activity.
- [x] Existing AI consent and input validation controls continue to apply. Resolve any previously supported inconclusive-provider-answer case explicitly rather than silently interpreting it as a confident answer.
- [x] Verify results end to end, including a provider failure that cannot remove labels and a below-threshold answer that is a non-match.

## Implementation notes

- Explicit provider `matches: null` remains unknown with an insufficient-evidence reason. Completed Boolean answers below minimum confidence are non-matches.
- Failed evaluations preserve affected label IDs across the plan, including blocked groups and legacy shared ownership. Unrelated rules can still act.
- Forward migration `0014_failed_evaluations.sql` permits failed per-rule activity records; label-write failures remain separate. Historical records are not reinterpreted, and a new decision cache key avoids reusing old low-confidence results.
- AI consent, input reporting, and existing preserve-only rule configuration remain intact. Configurable label actions and evaluation retry behavior belong to the later tickets.
- Standards and spec reviews completed with no remaining findings.
- Validation: `vp check --fix` passed with warnings; all 473 tests passed across 78 files. Focused tests reproduced the low-confidence, provider-failure, storage, UI, missing-evidence, and shared-label regressions before their fixes.

# 01: Distinguish failed AI evaluations from unknown results

Status: ready-for-agent
Blocked by: None

## What to build

Expose meaningful AI evaluation results in automatic labeling, rule testing, and activity history. The domain-modeling interview is the source of these decisions.

## Acceptance criteria

- [ ] Missing required facts produce unknown, never non-match.
- [ ] A completed classification below minimum confidence produces non-match; an accepted answer produces match or non-match according to its answer.
- [ ] Timeouts, provider failures, and invalid provider configuration produce a distinct failed evaluation with an actionable error.
- [ ] Unknown and failed evaluations leave the affected label unchanged. Within a labeling group, either result leaves all group labels unchanged while unrelated rules may still act.
- [ ] Failure is distinct from a label-write failure in displayed results and stored activity.
- [ ] Existing AI consent and input validation controls continue to apply. Resolve any previously supported inconclusive-provider-answer case explicitly rather than silently interpreting it as a confident answer.
- [ ] Verify results end to end, including a provider failure that cannot remove labels and a below-threshold answer that is a non-match.

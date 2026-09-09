# 05: Retry temporary AI failures

Status: ready-for-agent
Blocked by: 01

## What to build

Recover automatically from temporary AI request failures without applying outdated results or retrying permanent configuration errors.

## Acceptance criteria

- [x] Retry temporary failures a bounded number of times with increasing delays, honoring provider retry guidance.
- [x] Configuration errors fail immediately with an actionable explanation.
- [x] Labels remain unchanged while retrying, including all labels in the affected group; unrelated rules may continue.
- [x] Exhaustion leaves a failed evaluation and waits for a new webhook event.
- [x] A newer event supersedes retries for an outdated evaluation; stale results cannot write labels.
- [x] Pause, disconnection, or lost access prevents retry work from applying automation.
- [x] Retry status and terminal failure are understandable in activity and test results.
- [x] Verify temporary recovery, exhaustion, permanent failure, and supersession with controlled time and provider responses.

## Implementation notes

- Temporary provider failures make at most three attempts. Delays increase from two seconds and respect Retry-After seconds or HTTP dates. The four-minute evaluation window includes time reserved for the next provider request; longer guidance leaves a failed evaluation without retrying early.
- Authentication, quota, invalid requests, and other permanent provider errors fail immediately with sanitized configuration guidance. Budget exhaustion retains its distinct reason code.
- Each attempt reacquires consent and budget access. Waiting releases the consent lease and preserves the request claim. Automatic evaluations recheck repository access, configuration, and snapshot freshness before retrying and after receiving an answer.
- Reconciliation claims include snapshot generation and rules revision, so a newer event with identical AI inputs can complete independently of an obsolete retry. Successful decision caching remains shared. Final label writes serialize with event invalidation and repository controls.
- Activity and rule-test jobs expose retry progress. Terminal results explain exhaustion or recovery. Rule tests keep their existing five-minute retention period.
- Standards review found no violations. The spec review found and resolved a same-input replacement claim bug; the final review has no remaining findings.
- Validation: full suite passed all 504 tests across 87 files. After review fixes, all 21 focused tests passed, including the added same-input replacement regression. Typechecking, linting, and formatting passed with existing warnings.

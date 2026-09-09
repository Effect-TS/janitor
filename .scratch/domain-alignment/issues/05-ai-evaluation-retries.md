# 05: Retry temporary AI failures

Status: ready-for-agent
Blocked by: 01

## What to build

Recover automatically from temporary AI request failures without applying outdated results or retrying permanent configuration errors.

## Acceptance criteria

- [ ] Retry temporary failures a bounded number of times with increasing delays, honoring provider retry guidance.
- [ ] Configuration errors fail immediately with an actionable explanation.
- [ ] Labels remain unchanged while retrying, including all labels in the affected group; unrelated rules may continue.
- [ ] Exhaustion leaves a failed evaluation and waits for a new webhook event.
- [ ] A newer event supersedes retries for an outdated evaluation; stale results cannot write labels.
- [ ] Pause, disconnection, or lost access prevents retry work from applying automation.
- [ ] Retry status and terminal failure are understandable in activity and test results.
- [ ] Verify temporary recovery, exhaustion, permanent failure, and supersession with controlled time and provider responses.

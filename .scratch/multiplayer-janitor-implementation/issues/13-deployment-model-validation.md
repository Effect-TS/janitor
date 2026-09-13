# 13: Validate a deployment model and credential rotation

**What to build:** Operators can configure a real supported model for the runner and rotate its team credential while existing sessions retain their chosen model and history.

**Blocked by:** 06: Edit, test and recover repository work.

**Status:** needs-info

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Select the deployment provider/model using primary provider evidence for endpoint, authentication, model identity, limits and capabilities. Preserve the preference for inexpensive open-weight models; no personal subscriptions or model-picker UI.
- [x] Use immutable configuration records and the real native resolver/transport. Document accurate context/output limits and local compaction with the pinned session model; do not substitute fixture metadata or labeling-client compatibility.
- [ ] Run an explicitly authorized bounded real-provider smoke test for streamed responses, incremental/multiple tool calls, tool results and continued output. Verify recorded usage normalization and compaction with retained tool history.
- [x] Use controlled transport tests for first-response/mid-stream inactivity, disconnects, missing models, authentication failures and retry classification without flooding a real provider.
- [x] Verify runtime-only secret loading and redaction, rotation across runtime activation, pinned existing-session selection and new-session default changes. No secrets enter conversation, workspace, checkpoints or outward errors.
- [x] Missing/invalid credentials and unavailable models preserve work with actionable failure; temporary errors follow native retries without fallback. Retired models require new sessions and never silently migrate history.
- [x] Provide repeatable deployment validation and credential setup instructions. Missing real-provider access is an explicit prerequisite to the live check, not permission to fabricate a passing result or make unbounded paid calls.

## Comments

2026-09-13: Implemented the Groq `llama-3.1-8b-instant` deployment record, native output settings, record-change guards, credential redaction before native persistence, and error-body inactivity deadlines. Added controlled rotation, retirement, tool/usage/compaction checks and a bounded live driver. See [deployment validation](../../../runner/MODEL-VALIDATION.md) for primary evidence, setup and evidence limits.

The complete driver passes with controlled responses through the production HTTP transport and native repository tools. Live provider behavior remains unverified. `JANITOR_AGENT_RUNNER_MODEL_API_KEY` is absent from this process environment, and no paid-call authorization has been given. The live check requires a team credential location and explicit authorization for at most eight provider requests, 2,048 maximum output tokens per request, 131,072 request bytes per request and three minutes. No live paid calls or deployment were made. The ticket remains open for that acceptance check.

Standards review: passed. Spec review: identified fragmented credential echoes bypassing HTTP-line redaction. Added a failing native text/write/read regression, then redacted decoded native stream events and final tool inputs before persistence/execution. The regression passes, and both reviewers cleared the fix. The live prerequisite remains open.

Final validation: `vp check` passed with zero errors and 486 existing warnings; root tests passed with 644 passed and two skipped; runner tests passed with 61 passed and two skipped, including the gated live check; bridge tests passed with nine passed. Runner typechecking and production build passed. Full suites were rerun using a temporary directory on the larger workspace volume after the initial runs exhausted `/tmp`. Two maintenance tests now poll the documented quiescence response instead of assuming shutdown finishes within the first 50 ms response; both affected suites and the final full runner suite pass.

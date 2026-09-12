# 13: Validate a deployment model and credential rotation

**What to build:** Operators can configure a real supported model for the runner and rotate its team credential while existing sessions retain their chosen model and history.

**Blocked by:** 06: Edit, test and recover repository work.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Select the deployment provider/model using primary provider evidence for endpoint, authentication, model identity, limits and capabilities. Preserve the preference for inexpensive open-weight models; no personal subscriptions or model-picker UI.
- [ ] Use immutable configuration records and the real native resolver/transport. Document accurate context/output limits and local compaction with the pinned session model; do not substitute fixture metadata or labeling-client compatibility.
- [ ] Run an explicitly authorized bounded real-provider smoke test for streamed responses, incremental/multiple tool calls, tool results and continued output. Verify recorded usage normalization and compaction with retained tool history.
- [ ] Use controlled transport tests for first-response/mid-stream inactivity, disconnects, missing models, authentication failures and retry classification without flooding a real provider.
- [ ] Verify runtime-only secret loading and redaction, rotation across runtime activation, pinned existing-session selection and new-session default changes. No secrets enter conversation, workspace, checkpoints or outward errors.
- [ ] Missing/invalid credentials and unavailable models preserve work with actionable failure; temporary errors follow native retries without fallback. Retired models require new sessions and never silently migrate history.
- [ ] Provide repeatable deployment validation and credential setup instructions. Missing real-provider access is an explicit prerequisite to the live check, not permission to fabricate a passing result or make unbounded paid calls.

# 14: Verify the complete team workflow for release

**What to build:** The assembled MVP demonstrates two authorized teammates collaborating from private Slack through a reviewable PR and GitHub feedback, with reliable observation and a documented release procedure.

**Blocked by:** 12: Upgrade running sessions safely; 13: Validate a deployment model and credential rotation.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Run the complete new-work and existing-blog-post-PR walkthrough with two linked teammates. Verify ordinary queued replies, unique home-thread routing, human commit preservation, automatic authorized reviews and human-only merging.
- [ ] Verify membership/removal races and Access-expiry behavior in the integrated flow, including rejected-message immutability and browser observation access.
- [ ] Inject bounded runner/bridge/delivery failures and confirm recovery without duplicate inputs, tool execution or publication. Include checkpoint uncertainty, missed invalidations and independent execution/delivery state.
- [ ] Validate production composition of model resolution, native compaction, usage, supervised progress and operator maintenance using the evidence produced by prerequisite tickets.
- [ ] Document isolated test/production configuration, migrations, initial admin, platform callbacks/scopes, runtime secrets, bindings, release manifests, setup and cleanup. Never use disposable fixture identities as production defaults.
- [ ] Run required project checks and relevant integration tests. Resolve or deliberately isolate prototype-only check failures with an explicit rationale; do not label historical timeouts or unchecked fixtures as a green production validation.
- [ ] Record release evidence, known bounded recovery limitations and any remaining external prerequisite. Remove disposable resources/messages/branches and close test PRs without merging. This ticket does not itself authorize production deployment or indefinite paid testing.

# 12: Upgrade running sessions safely

**What to build:** Operators perform controlled releases while incoming instructions remain durable, resume supported sessions afterward, and preserve incompatible sessions for repair.

**Blocked by:** 10: Recover missed events and interrupted platform delivery; 11: Preserve or clean up work when repository access changes.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Create release manifests with independently versioned command/events, native migration sets, Janitor schemas, checkpoint format and running bridge capabilities. Pin build/image/dependency identities and supported combinations.
- [ ] Validate outer compatibility metadata and native migration journal before SDK host construction. Reject unknown/newer state, missing metadata on nonempty databases and incompatible checkpoints without mutation or reset.
- [ ] Persist migration intent and completion around supported native forward migrations. Handle partial committed migration failure explicitly and test supported restart; do not assume whole-upgrade atomicity or downgrade support.
- [ ] Establish a durable maintenance barrier before enumerating sessions, keep authenticated durable intake active, withhold new dispatch and obtain per-runner quiescence using native shutdown semantics that preserve recoverable claims.
- [ ] Wait for prior writers and finite operations, commit checkpoints/results or retain uncertainty, and keep holds effective across alarms/restarts. Unreachable is not quiescent; newer disconnection/removal fences outrank stale maintenance release.
- [ ] Deploy compatible consumers before new writers and verify actual bridge image/protocol after rollout. Release only matching holds after state, peer and credential checks; retain session model records and current approved secrets.
- [ ] Permit rollback only on a tested path supporting actual current state/peers. Otherwise repair forward while blocked; never rewind inputs, publication receipts or whole-state snapshots automatically.
- [ ] Exercise the full isolated maintenance path with incoming messages, active model/tool work, old images, restart, partial migration, stale acknowledgments and refused rollback. Surface maintenance/compatibility reasons through existing observation.

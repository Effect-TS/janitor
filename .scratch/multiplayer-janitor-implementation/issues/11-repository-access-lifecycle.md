# 11: Preserve or clean up work when repository access changes

**What to build:** Repository pause and access loss preserve ongoing work, while explicit disconnection ends sessions and reliably removes remote state with notice of unpublished-work loss.

**Blocked by:** 04: Observe sessions and recorded usage in Janitor; 07: Publish new work as a pull request.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Fence new repository operations when readiness is lost or a repository is paused; show concrete blocked reasons while retaining session data and workspace.
- [ ] Resume repository work only after readiness is restored; deliberate pause still requires repository resumption. Recheck fences before publication and reject late invalid completions.
- [ ] Persist cleanup ownership, generations and remote identities before existing destructive repository-data deletion can erase them. Disconnection must not strand resources because its caller crashed.
- [ ] On disconnection terminate execution, remove the native session and saved workspace/checkpoint data, and remove projections/usage. Preserve only cleanup tombstones required to exclude stale work until cleanup completes.
- [ ] Provide explicit unpublished-work-loss notice through the repository disconnect flow. Keep published GitHub work intact; reconnection allocates fresh identities.
- [ ] Test disconnect during a command/publication attempt, retry after partial cleanup, inaccessible remote cleanup, late alarms/completions, deliberate pause versus access restoration and reconnect. Teammate removal alone never deletes shared sessions.

# 10: Enforce required GitHub access throughout the lifecycle

Status: ready-for-agent
Blocked by: 08

## What to build

Make connection and recovery depend on the GitHub permissions Janitor needs, preserving repository identity and configuration when access changes.

## Acceptance criteria

- [x] Require permission to read repository facts and change labels before connection, with actionable API and UI errors for missing permissions.
- [x] Newly accessible repositories remain available until someone explicitly connects them.
- [x] Losing either required permission, installation suspension, or uninstall stops automation and synchronization without deleting configuration or stored data.
- [x] Restoring access requires successful synchronization before automation becomes ready; a deliberately paused repository stays paused.
- [x] Restoration does not replay events or trigger catch-up labeling.
- [x] Renaming preserves connection and configuration. Transfer preserves identity and configuration, with operation dependent on required access under the new owner.
- [x] Public and private repositories follow the same rules.
- [x] Verify permission loss and restoration, manual-pause preservation, rename, and owner transfer across API state and automation behavior.

## Comments

Implemented permission verification, access fences, synchronization recovery, retained data, and repository identity updates. Standards and spec review findings were resolved.

Validation: `vp check --fix` passed with warnings. The full suite passed 526 tests; the readiness suite hit a setup timeout and its remaining test passed when rerun alone.

# 10: Enforce required GitHub access throughout the lifecycle

Status: ready-for-agent
Blocked by: 08

## What to build

Make connection and recovery depend on the GitHub permissions Janitor needs, preserving repository identity and configuration when access changes.

## Acceptance criteria

- [ ] Require permission to read repository facts and change labels before connection, with actionable API and UI errors for missing permissions.
- [ ] Newly accessible repositories remain available until someone explicitly connects them.
- [ ] Losing either required permission, installation suspension, or uninstall stops automation and synchronization without deleting configuration or stored data.
- [ ] Restoring access requires successful synchronization before automation becomes ready; a deliberately paused repository stays paused.
- [ ] Restoration does not replay events or trigger catch-up labeling.
- [ ] Renaming preserves connection and configuration. Transfer preserves identity and configuration, with operation dependent on required access under the new owner.
- [ ] Public and private repositories follow the same rules.
- [ ] Verify permission loss and restoration, manual-pause preservation, rename, and owner transfer across API state and automation behavior.

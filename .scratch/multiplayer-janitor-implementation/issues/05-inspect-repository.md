# 05: Let an agent inspect a repository

**What to build:** An agent session obtains an isolated repository workspace and answers repository questions using native read/search tools through the authenticated remote execution bridge.

**Blocked by:** 02: Run a durable agent conversation.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Create or adopt the same deterministic workspace resource on repeated requests, including when a prior creation response or binding save was lost. Validate selected connected repository readiness.
- [ ] Use the pinned Sandbox base image and required native utilities. Implement private authenticated bridge transport, running-image protocol/capability checks and generation/epoch validation before dispatch.
- [ ] Clone/read through repository-scoped GitHub App credentials. Keep the App private key outside execution and exclude tokens from URLs, persistent Git config, output and workspace files.
- [ ] Implement the native workspace/filesystem and process interfaces required for read/search, including cwd, argv, binary stdin, output cursors, exit and cancellation. Register only this slice’s supported tools; repository mutation/publication is not advertised yet.
- [ ] Persist immutable operation admission and payload identity before dispatch. Same-epoch retries retrieve existing operations; mismatched epochs or uncertain operations cannot trigger blind replay.
- [ ] Demonstrate two sessions with separate workspaces, native file/search output, lost bridge responses, invalid credentials, stale generations and an old-image capability mismatch using the service acceptance driver.
- [ ] Provide deterministic cleanup for disposable resources and preserve operation evidence needed by the subsequent mutation/checkpoint slice.

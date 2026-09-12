# 05: Let an agent inspect a repository

**What to build:** An agent session obtains an isolated repository workspace and answers repository questions using native read/search tools through the authenticated remote execution bridge.

**Blocked by:** 02: Run a durable agent conversation.

**Status:** needs-triage

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Create or adopt the same deterministic workspace resource on repeated requests, including when a prior creation response or binding save was lost. Validate selected connected repository readiness.
- [x] Use the pinned Sandbox base image and required native utilities. Implement private authenticated bridge transport, running-image protocol/capability checks and generation/epoch validation before dispatch.
- [x] Clone/read through repository-scoped GitHub App credentials. Keep the App private key outside execution and exclude tokens from URLs, persistent Git config, output and workspace files.
- [x] Implement the native workspace/filesystem and process interfaces required for read/search, including cwd, argv, binary stdin, output cursors, exit and cancellation. Register only this slice’s supported tools; repository mutation/publication is not advertised yet.
- [x] Persist immutable operation admission and payload identity before dispatch. Same-epoch retries retrieve existing operations; mismatched epochs or uncertain operations cannot trigger blind replay.
- [x] Demonstrate two sessions with separate workspaces, native file/search output, lost bridge responses, invalid credentials, stale generations and an old-image capability mismatch using the service acceptance driver.
- [x] Provide deterministic cleanup for disposable resources and preserve operation evidence needed by the subsequent mutation/checkpoint slice.

## Comments

Implemented; awaiting maintainer evaluation.

Repository selection now flows from Janitor to the runner. Selected sessions provision isolated Sandboxes, clone with repository-scoped GitHub App credentials, and expose native read/glob/grep through the authenticated bridge. Runner and bridge journals record operation identity before dispatch; generation, epoch, capability and readiness checks guard execution. Cleanup retains a tombstone before destroying the deterministic resource. The runner protocol is now version 2 to reject older creation contracts that omit repository selection.

Validation was local, with external GitHub/model boundaries controlled and the built Sandbox image exercised through the service acceptance driver:

- Root suite: 103 files, 575 tests passed.
- Runner suite: 5 files, 28 tests passed.
- Bridge suite: 4 tests passed, including controlled Git clone credential handling.
- Formatting/lint checks, runner typecheck, production build and image build passed. Image provenance is recorded in runner/bridge/release.json.
- Running the root and runner suites concurrently caused a test-bundle rebuild race; the runner suite passed when rerun serially.

Code review against d252e654fd60a630506caf6143c0363afe54cd2d:

- Standards: no hard violations. Non-blocking follow-up: replace caller-selected BridgeRpc response generics with a shared route/request/response contract.
- Spec: found a Sandbox resource name exceeding the SDK's 63-character limit. Creation and cleanup now share a 63-character name retaining 220 hash bits. The acceptance adapter exercises the real SDK helper and reproduced the failure before the fix. The focused acceptance test passed after the fix; follow-up review found no further issues.

No deployment or paid model calls were performed. Checkpoint, mutation and publication orchestration remain in subsequent tickets.

# Replace the container workspace with Durable Object SQLite

The user superseded the Linux workspace design. OpenCode remains embedded in the session Durable Object. SQLite owns repository metadata, lazily fetched blobs, file edits and atomic tool receipts. GitHub's Git Data APIs replace clone, commit and push processes. No shell, package installation or local test execution is advertised; publication must describe validation honestly.

Implementation sequence:

1. Add the SQLite workspace and GitHub repository modules, preserving paths, immutable repository identity, concurrent-edit checks and publication receipts.
2. Connect SDK filesystem adapters and controlled read/write/edit/delete/search/diff/publication tools. Keep native model execution, inbox and recovery.
3. Remove container, bridge, process and checkpoint machinery from application code, build scripts, dependencies and Alchemy. Preserve legacy data or block explicitly rather than silently discarding it.
4. Replace container tests with native runner RPC/HTTP tests against controlled GitHub responses. These are the previously approved test seams. Cover atomic edits and tool replay, restart recovery, conflicts, lost GitHub responses and cleanup.
5. Update local composition, CI and architecture/release documentation, then validate and update PR #39.

Production deployment and deletion of retained legacy resources remain outside this change's execution. The PR must document how legacy workspaces are handled before rollout.

Implemented the SQLite workspace, controlled OpenCode tools, GitHub Git Data publication and conservative legacy import. Removed the container/process/archive-write implementation, image build scripts, runner-specific Docker permissions and Sandbox dependency. Alchemy keeps the existing Worker/session namespace and retained R2 bucket. A retirement-only provider handles the old retained image state entry without building or deleting an image.

Local validation: runner type checking, root formatting/lint/type checks, production Worker build, native SQLite recovery/publication/migration tests, and the local Alchemy smoke passed. The first full project run identified the backend's old state-family constant; the corrected maintenance/acceptance/publication tests passed (11 tests). Final full CI is pending.

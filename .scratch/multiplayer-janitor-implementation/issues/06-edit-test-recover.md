# 06: Edit, test and recover repository work

**What to build:** The agent edits repository files and runs foreground tests, with workspace changes preserved durably across turns and Sandbox loss.

**Blocked by:** 05: Let an agent inspect a repository.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Enable native edit/write and shell tools using the accepted process adapter. Support shell pipelines, binary input/output and command descendants within the workspace; reject unsupported interfaces explicitly.
- [ ] Enforce foreground-only requests and process-tree containment. Keep the two-minute default and explicit longer finite deadlines; reject zero/unlimited timeouts and session-background/direct session-shell entry points.
- [ ] Persist operation admission before execution. Stop writers and descendants, transfer native temporary captures into unpublished workspace storage and rewrite full-output notices to readable paths.
- [ ] Upload a consistent R2 archive and atomically commit its pointer and operation result before returning the native tool result. Failed commands leaving edits use the same durability path.
- [ ] Preserve working tree, index, local commits, required ignored files, modes and symlinks. Exclude credentials and reproducible caches; keep the previous committed archive until replacement commit and prune unreferenced uploads durably.
- [ ] Restore verified archives into a clean workspace. A successful upload is not a committed checkpoint; changed bridge epochs preserve uncertainty rather than authorizing replay.
- [ ] Demonstrate native edits/tests, large captured output, failed commands with edits, timeout cleanup, restart on both sides of pointer commit, full workspace restoration and session isolation. Expose failures through native results/events for existing consumers.

# 06: Edit, test and recover repository work

**What to build:** The agent edits repository files and runs foreground tests, with workspace changes preserved durably across turns and Sandbox loss.

**Blocked by:** 05: Let an agent inspect a repository.

**Status:** needs-triage

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Enable native edit/write and shell tools using the accepted process adapter. Support shell pipelines, binary input/output and command descendants within the workspace; reject unsupported interfaces explicitly.
- [x] Enforce foreground-only requests and process-tree containment. Keep the two-minute default and explicit longer finite deadlines; reject zero/unlimited timeouts and session-background/direct session-shell entry points.
- [x] Persist operation admission before execution. Stop writers and descendants, transfer native temporary captures into unpublished workspace storage and rewrite full-output notices to readable paths.
- [x] Upload a consistent R2 archive and atomically commit its pointer and operation result before returning the native tool result. Failed commands leaving edits use the same durability path.
- [x] Preserve working tree, index, local commits, required ignored files, modes and symlinks. Exclude credentials and reproducible caches; keep the previous committed archive until replacement commit and prune unreferenced uploads durably.
- [x] Restore verified archives into a clean workspace. A successful upload is not a committed checkpoint; changed bridge epochs preserve uncertainty rather than authorizing replay.
- [x] Demonstrate native edits/tests, large captured output, failed commands with edits, timeout cleanup, restart on both sides of pointer commit, full workspace restoration and session isolation. Expose failures through native results/events for existing consumers.

## Comments

Implemented on 2026-09-12. Native repository tools now serialize admission and checkpoint completion. The bridge freezes writers and command descendants, transfers shell captures outside the Git repository, and streams a verified archive to R2. SQLite commits the archive pointer and saved tool result together. Unknown tool outcomes hold recovery; committed checkpoints restore into a clean workspace after Sandbox loss.

The native acceptance test covers write/edit, foreground pipelines, failed commands retaining edits, timeout descendant cleanup, default and explicit longer deadlines, rejected background/unlimited requests, large-output capture reads, two isolated sessions, 40 MB files through R2, and crashes before and after pointer commit. The bridge test verifies working tree/index/local commits, ignored data, binary bytes, modes, symlinks, tracked environment templates, hash/format/path rejection and capture-path protection. R2 cleanup is checked after session removal.

### Standards review

No documented standards violations. One duplication suggestion identified repeated production tool lists; both exposure and permissions now use one constant. Test expectations remain independent.

### Spec review

The initial review found unconditional exclusions dropping tracked templates and a cumulative buffered-archive size limit. Tracked paths now override exclusions, and archives stream in bounded chunks. Security review also found caller environment variables reaching the launcher before privilege separation. The bridge now drops its OS identity before loading the launcher and applies caller environment variables only inside the process namespace. Follow-up review confirmed these fixes and found no further concrete correctness issues.

Validation passed: root `vp test` with 106 files and 585 tests; runner `vp run test` with five files and 28 tests; six bridge tests; runner typecheck and production build; rebuilt bridge image with recorded digest. Root `vp check` passed with zero errors and 434 existing warnings.

No deployment, live repository writes, messages to teammates or paid model calls were performed. Production stage bindings remain deployment work. Native per-command output retains the bridge's existing 8 MiB limit; archives have no cumulative Worker-memory size ceiling.

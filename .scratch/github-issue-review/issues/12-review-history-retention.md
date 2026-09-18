# 12: Expire detailed history without losing publication ownership

**What to build:** The frontend retains detailed review history for 14 days, then removes it while preserving the minimal records needed to prevent replay and recognize Janitor-owned publications.

**Blocked by:** 10: Handle subsequent reproductions without overwriting human work.

**Status:** ready-for-agent

**Completion:** complete. Reconciled on 2026-09-18. See [completion review](../completion-review.md).

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0011, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [x] Retain invoker/instructions, commit, findings, test evidence, proposed patch, and publication links for the accepted 14-day window, including agent/action records that contain equivalent detailed data.
- [x] Expire detailed records and artifacts after the window without leaving copies indefinitely in actor state, action results, or auxiliary persistence.
- [x] Retain minimal invocation receipts, summary identity, branch/PR ownership, and last-publication fingerprints while the repository remains connected; use fingerprints rather than full historical prose where sufficient.
- [x] Expired results are not publishable through any endpoint, even if a client has cached an earlier eligible view. History renders expired/unavailable data accurately.
- [x] Replay after expiry cannot create another run or repeat publication. New invocations can still identify owned artifacts and detect human changes without old detailed logs.
- [x] Respect repository disconnection and admission-generation fencing so retained or delayed messages cannot recreate management state after disconnect/reconnect.
- [x] Verify time-boundary expiry, expired publication requests, retained deduplication, later PR reuse, human edits after log expiry, and repository removal.

## Comments

Implemented 2026-09-18. Detailed runs expire from acceptance, with database and workspace cleanup, retained invocation receipts and ownership fingerprints, and guards against expired publication and delayed work after disconnection. History explains the 14-day window.

Validation: `vp check --fix` passed with warnings; `vp test` passed all 787 tests across 125 files. Standards review: 0 findings. Spec review: 0 remaining findings. Production enablement still waits for ticket 13.

2026-09-18 completion review: implementation commit `5b42165` and current code/test coverage support completion of this ticket. Earlier comments describe each slice at implementation time; later tickets supersede their temporary limitations. Live deployment verification remains separate, as recorded in [the completion review](../completion-review.md).

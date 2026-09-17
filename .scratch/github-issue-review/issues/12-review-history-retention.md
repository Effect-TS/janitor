# 12: Expire detailed history without losing publication ownership

**What to build:** The frontend retains detailed review history for 14 days, then removes it while preserving the minimal records needed to prevent replay and recognize Janitor-owned publications.

**Blocked by:** 10: Handle subsequent reproductions without overwriting human work.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0011, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Retain invoker/instructions, commit, findings, test evidence, proposed patch, and publication links for the accepted 14-day window, including agent/action records that contain equivalent detailed data.
- [ ] Expire detailed records and artifacts after the window without leaving copies indefinitely in actor state, action results, or auxiliary persistence.
- [ ] Retain minimal invocation receipts, summary identity, branch/PR ownership, and last-publication fingerprints while the repository remains connected; use fingerprints rather than full historical prose where sufficient.
- [ ] Expired results are not publishable through any endpoint, even if a client has cached an earlier eligible view. History renders expired/unavailable data accurately.
- [ ] Replay after expiry cannot create another run or repeat publication. New invocations can still identify owned artifacts and detect human changes without old detailed logs.
- [ ] Respect repository disconnection and admission-generation fencing so retained or delayed messages cannot recreate management state after disconnect/reconnect.
- [ ] Verify time-boundary expiry, expired publication requests, retained deduplication, later PR reuse, human edits after log expiry, and repository removal.

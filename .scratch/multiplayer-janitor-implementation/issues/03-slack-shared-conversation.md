# 03: Collaborate with Janitor in a private Slack thread

**What to build:** Two linked teammates use a private Slack thread as a shared agent conversation. A mention starts work; ordinary later replies steer it while concise activity and agent responses appear in the thread.

**Blocked by:** 01: Connect and manage teammate identities; 02: Run a durable agent conversation.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Configure the specified bot scopes/events and authenticate Slack signatures. Journal receipts durably before prompt acknowledgment; reject stale/invalid signatures and prevent bot loops.
- [ ] Authorize linked teammates transactionally with acceptance. Deduplicate mention/message overlap by workspace/channel/timestamp while separately preserving transport receipts. Edits/deletions are not new prompts and rejected messages cannot become accepted on retry.
- [ ] Establish one stable home thread and deterministic session identity. Resolve connected repository references or ask for clarification while preserving buffered inputs; repository tools remain disabled until selection/readiness.
- [ ] For an existing thread, page only its discussion through the initiating boundary, deduplicate repeated roots and sort exact timestamps. Freeze attributed context once and admit later ordinary replies in durable order.
- [ ] Deliver ordinary questions, substantive responses and concise updating progress. Persist ordered output intent and stable markers before sending; coalesce only pending progress, retain final/error output and honor channel throttling.
- [ ] On ambiguous publication, reconcile positive author/target/marker matches or hold uncertain output; do not blind-repost. Show private account-link guidance where supported without public fallback clutter.
- [ ] Demonstrate two teammates prompting during execution, initialization races, duplicate callbacks, a lost admission receipt, edited messages, transient delivery failure and ephemeral onboarding. Live fixtures require bounded destinations and cleanup.

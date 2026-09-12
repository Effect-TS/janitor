# 03: Collaborate with Janitor in a private Slack thread

**What to build:** Two linked teammates use a private Slack thread as a shared agent conversation. A mention starts work; ordinary later replies steer it while concise activity and agent responses appear in the thread.

**Blocked by:** 01: Connect and manage teammate identities; 02: Run a durable agent conversation.

**Status:** needs-triage

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Configure the specified bot scopes/events and authenticate Slack signatures. Journal receipts durably before prompt acknowledgment; reject stale/invalid signatures and prevent bot loops.
- [x] Authorize linked teammates transactionally with acceptance. Deduplicate mention/message overlap by workspace/channel/timestamp while separately preserving transport receipts. Edits/deletions are not new prompts and rejected messages cannot become accepted on retry.
- [x] Establish one stable home thread and deterministic session identity. Resolve connected repository references or ask for clarification while preserving buffered inputs; repository tools remain disabled until selection/readiness.
- [x] For an existing thread, page only its discussion through the initiating boundary, deduplicate repeated roots and sort exact timestamps. Freeze attributed context once and admit later ordinary replies in durable order.
- [x] Deliver ordinary questions, substantive responses and concise updating progress. Persist ordered output intent and stable markers before sending; coalesce only pending progress, retain final/error output and honor channel throttling.
- [x] On ambiguous publication, reconcile positive author/target/marker matches or hold uncertain output; do not blind-repost. Show private account-link guidance where supported without public fallback clutter.
- [x] Demonstrate two teammates prompting during execution, initialization races, duplicate callbacks, a lost admission receipt, edited messages, transient delivery failure and ephemeral onboarding. Live fixtures require bounded destinations and cleanup.

## Comments

2026-09-12: Implemented for maintainer review. The user confirmed Slack webhook intake, the shared-conversation service and outbound Slack transport as test boundaries, and `d252e65` as the review baseline. Migration `0024_slack_conversations.sql` persists transport receipts, immutable authorization decisions, buffered inputs, deterministic thread identity, paged context, repository/PR association, publication cursors and ordered output intent. Worker routes and a cron-driven singleton connect these services to the existing runner handoff.

Tests use Postgres and controlled Slack/runner boundaries. They cover signed intake, overlapping callbacks, frozen rejection after linking, changed transport retries, paged initialization races, repository clarification, ordinary replies from two teammates during execution, a lost runner admission response, edited messages, ephemeral onboarding, lost Slack send responses, wrong-author reconciliation, uncertain-output holds, progress coalescing/updating, Unicode splitting and rate-limit retries. Setup and the app manifest are in `docs/slack/`. No live Slack messages, real-provider calls or deployment were performed. Live installation validation still requires the bounded test destination and cleanup described in that guide. Repository tools, missed-message recovery and dashboard presentation remain in their later tickets.

Validation: `vp check` passed with warnings; the full application suite passed 579 tests with four skipped. The separate runner-backed acceptance driver was skipped because its isolated dependencies are not installed. The review found no standards issues and three specification issues, all fixed and regression-tested. See [the review record](../review-03.md).

# Decide what the observation dashboard shows

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 01, 02, 03

## Question

What must teammates be able to observe in Janitor to understand ongoing agent work and usage, and find the home thread where they can participate?

Decide which session state, activity, repository and PR links, token usage, and usage totals belong in the initial dashboard. Walk through someone returning after an absence and someone monitoring several concurrent sessions. Apply the agreed visibility rules and session lifecycle. Establish what detail is useful without turning the dashboard into another conversation venue. Configurable budgets, additional approval controls, dedicated session controls, and detailed execution-log retention and presentation are deferred beyond the MVP by [Decide how teammates direct Janitor's shared work](03-steering-shared-work.md).

## Comments

The user accepted the recommended session list, compact session detail view, and token reporting. No additional dashboard capabilities were requested.

## Answer

Later scope refinement: [Decide dashboard and usage data contracts](../../multiplayer-janitor-technical/issues/08-observation-contracts.md) defers team totals and period filtering. Per-session token totals and team-wide session visibility remain in the MVP. The original discussion below is retained.

The main view is a team-wide session list. Each entry shows a short title, repository when associated, current state, latest activity time, token usage, and links to its home thread and related PR when present. Working sessions appear first; recent idle and failed sessions remain accessible.

Opening a session shows basic session information, its latest activity or error, usage, and related links. The conversation stays in Slack or Discord. This provides a way to find and inspect work without adding a conversation viewer or detailed execution-log viewer to the MVP.

Usage reporting shows input and output token counts per session, plus team-wide totals for a selected period. Monetary estimates and more detailed breakdowns are deferred. This adds observation, not configurable budgets or approval controls.

All authorized teammates can observe all sessions, as already decided. Links to private home threads do not grant chat-channel access. A returning teammate can find recent work and follow its links; someone monitoring ongoing work can scan active sessions, latest activity or errors, and usage.

The walkthrough should demonstrate this scope using working, idle, and failed examples. Exact layout and labels can be evaluated in [Test the blog-post collaboration experience](05-collaboration-walkthrough.md); technical metric collection and retention belong to later implementation planning.

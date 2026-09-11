# Decide where the shared discussion lives

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: none

## Question

In the blog-post PR scenario, what does bringing discussion into a single place mean for the team: a shared discussion usable through connected platforms, a dedicated Janitor workspace, the PR itself, or another arrangement?

Walk through Mike requesting input, a teammate replying in Slack, and another teammate joining through GitHub. Decide where each person reads the current discussion, which contributions travel between places, and which platforms the first walkthrough must represent. Establish what joins these contributions to the same ongoing work, including work that starts before an issue or PR exists. Do not assume that every message is copied everywhere.

## Comments

### Agreed direction, first discussion round

The user accepted these recommendations:

- A shared Janitor workspace contains the discussion, agent activity, and proposed changes. Slack and GitHub support starting work, contributing, and receiving updates. The workspace provides the complete picture; the PR remains the review point.
- Someone explicitly connects a discussion thread to shared work, after which subsequent replies in that thread are included. Do not assume that all surrounding channel discussion is collected.
- Shared work may begin before an issue or PR exists. Issues and PRs are linked artifacts, not prerequisites for collaboration.

The ticket remains claimed while we clarify participation from external platforms, message distribution, and the initial walkthrough's platform coverage.

### User-supplied interaction reference

The user supplied [Ryan Vogel's gangprompting post](https://ryan.ceo/blog/gangprompting-shared-agent-sessions) as a reference for Slack interaction. It describes teammates joining and steering the same agent conversation with its existing context; conflicting directions require a human decision.

Design implication to confirm: a connected Slack thread should support direct participation in the shared agent conversation. How workspace-originated contributions appear in Slack remains open; summaries alone may not provide the experience the user intends. This is a proposed interpretation, not a resolved decision.

### Direction corrected by the user

The user clarified that the Janitor application can initially be a place to observe sessions and token usage, with actual agent collaboration happening in Slack or Discord. This supersedes the interactive Janitor workspace and workspace-to-Slack message distribution proposed earlier. The user then explicitly accepted one home thread per session.

## Answer

Each agent session has one home thread in Slack or Discord. Teammates join and steer the same ongoing agent conversation there. The initial design does not let someone join that session through a second platform's thread.

Janitor's application initially provides an observation dashboard for ongoing sessions and usage, including token usage. It is not an additional conversation venue. GitHub PRs remain the central place for formal review of proposed changes.

Shared work can begin before an issue or PR exists and later link to those artifacts. Connecting a thread to Janitor is explicit; this decision does not authorize collecting unrelated channel conversations. The exact invocation, handling of prior thread history, and relationship between work and multiple sessions remain to be specified.

Use Mike's Slack discussion and blog-post PR as the anchor walkthrough. Discord is another possible home for a session, not a mirrored participant in the Slack session. Platform release order is not settled here.

The user confirmed the observation-dashboard correction and the one-home-thread recommendation. Interaction controls remain in [Decide how teammates direct Janitor's shared work](03-steering-shared-work.md); permissions and visibility remain in [Decide who can participate and what they can see](02-participation-and-visibility.md). Later tickets must decide how GitHub review feedback reaches an active session rather than assuming automatic conversation synchronization.

Subsequent clarification: [Decide how feedback becomes reviewable changes](04-proposals-and-pr-review.md) resolves automatic PR review handling on GitHub. Follow that decision alongside the single home-thread model; it does not introduce mirrored Slack/Discord conversations.

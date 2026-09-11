# Design shared work with Janitor

Labels: wayfinder:map
Status: resolved

## Destination

Agree on a broader product and interaction design for teammates collaborating with Janitor-run agents across connected platforms. Concrete journeys and rough prototypes should make the experience clear enough to evaluate and choose a first release; implementation-ready specifications and a complete technical architecture are later work.

## Notes

- Consult wayfinder, grilling, domain-modeling, and unslop. Consult prototype when working a prototype ticket. Follow the local tracker conventions in `docs/agents/issue-tracker.md`.
- This is a planning effort. Resolve decisions with the human; do not implement the product or silently choose answers for them.
- The anchor scenario is Mike's blog-post pull request in the Effect website repository. Team feedback was split between Slack and the PR, and detailed feedback required a companion PR. The desired improvement is to bring that collaboration together. No particular PR has been identified or inspected.
- The user selected a broader product and interaction design as the destination. Begin with shared ongoing work that teammates can join and steer. Coordinating separate efforts is a later exploration.
- The PR is the central point for review and human participation. Follow the resolved review ticket for editing, automatic feedback handling, and merging behavior.
- Janitor runs agents for the team using API pricing. Connecting teammates' personal agent subscriptions is outside this effort.
- The user's tentative execution direction is OpenCode V2 in a Durable Object, reusing harness functionality and initially using inexpensive open-weight models. This is a preference for later technical investigation, not a verified hosting design or model-cost claim.
- Follow the final scope decision for first-release coverage; earlier broader platform exploration is retained as reference.
- The user named OpenCode's "gang prompting" as a product reference. Investigate its actual behavior before treating it as evidence for design choices.
- Current Janitor provides GitHub labeling automation, repository connections, activity records, and durable workflows. A conversational coding-agent experience would be new product behavior. Existing labeling terminology in `CONTEXT.md` does not define that experience.
- These notes capture the charter agreed during charting. Decisions so far indexes child-ticket resolutions only.
- This product-design map is complete. Use its linked decisions and accepted walkthrough as input to subsequent technical planning; no product implementation was performed in this effort.

## Decisions so far

- [Investigate OpenCode's gang prompting reference](issues/06-opencode-gang-prompting.md): Found Dax's first-party account of a shared team OpenCode server; exact X reference, joint-control behavior, and cross-platform coordination remain unverified.
- [Decide where the shared discussion lives](issues/01-unified-discussion.md): One Slack or Discord home thread per agent session; Janitor observes sessions and usage, with PR review on GitHub.
- [Decide who can participate and what they can see](issues/02-participation-and-visibility.md): Equal team control, private-channel sessions, team-wide observation, necessary GitHub publication, and chat accounts connected after Cloudflare Access sign-in.
- [Decide how teammates direct Janitor's shared work](issues/03-steering-shared-work.md): Ordinary thread messages prompt the agent, busy-session messages queue for the next turn, and activity and errors appear in the thread.
- [Decide how feedback becomes reviewable changes](issues/04-proposals-and-pr-review.md): Update existing PRs directly, automatically address authorized teammates' reviews on GitHub, preserve concurrent edits, and leave merging to teammates.
- [Decide what the observation dashboard shows](issues/07-observation-dashboard.md): Team-wide session list and compact details, with activity, errors, links, per-session token counts, and period-based team totals.
- [Decide how teammates connect their chat accounts](issues/08-chat-account-connection.md): Personal Connected accounts page, private onboarding prompts where supported, explicit resend after connection, and self-service account replacement or disconnection.
- [Verify account connection and private onboarding support](issues/09-account-connection-support.md): Slack supports targeted ephemeral replies; Discord requires interactions for ephemeral replies, and reusing Access for GitHub identity still needs deployment verification.
- [Test the blog-post collaboration experience](issues/05-collaboration-walkthrough.md): The user accepted the general MVP flows; GitHub-to-chat completion notifications are deferred until after the MVP.
- [Choose the MVP scope and planning handoff](issues/10-mvp-scope-and-handoff.md): Slack-first general repository work, one repository per session, with a team acceptance scenario and handoff to technical planning.

## Not yet specified

None within this product-design destination. Remaining technical investigations are identified in [Choose the MVP scope and planning handoff](issues/10-mvp-scope-and-handoff.md).

## Out of scope

- Building or deploying the product during this map.
- Discord in the first release; it follows the Slack MVP using the explored interaction model.
- Coordinating separate agent efforts or work spanning repositories, deferred to later efforts. Independent sessions across connected repositories are included in the MVP.
- A complete technical architecture or implementation-ready specification. This effort supplies the product direction for that subsequent work.
- Connecting teammates' personal agent subscriptions. The user expects Janitor-run agents paid through APIs.
- Making another review venue replace the PR in the initial design. Other review venues may be explored in a future effort.
- Joining the same agent conversation from threads on multiple platforms, or making Janitor an interactive conversation venue, in the initial design. These may be revisited in a later effort.
- Dedicated stop/resume commands and a session-shutdown feature for the MVP. The user deferred session shutdown until after a usable MVP exists.
- Configurable spending limits, budgets, and additional approval controls for the MVP, deferred by the user.
- Detailed execution-log retention and presentation, deferred to later design work. Visible activity and errors remain part of the current interaction design.
- Monetary usage estimates and detailed usage breakdowns beyond input/output tokens per session and team totals, deferred beyond the initial dashboard.
- GitHub-to-chat completion notifications after implementing review feedback, deferred by the user until after the MVP. See [Test the blog-post collaboration experience](issues/05-collaboration-walkthrough.md).

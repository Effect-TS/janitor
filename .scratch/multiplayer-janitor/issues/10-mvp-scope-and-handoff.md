# Choose the MVP scope and planning handoff

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 05

## Question

Which part of the accepted collaboration design is the first MVP, and is the product direction clear enough to hand off to technical planning?

Choose initial platform coverage and work coverage using the validated blog-post PR walkthrough. Determine whether the same release includes new work before an issue or PR exists, ordinary bug fixes and maintenance, or work spanning repositories. Distinguish repository coverage from coordinating multiple sessions or separate approaches, which was reserved for later exploration.

Review the map's remaining Not yet specified entries. Decide which still need product exploration toward this destination and which belong to a later effort. Record what observable team workflow will count as a useful MVP. Keep the tentative OpenCode V2 and Durable Object direction as input to subsequent technical feasibility work; do not turn this product map into an implementation plan or treat unverified platform capabilities as settled.

## Comments

The user agreed with all three recommendations: Slack first, general repository work with one repository per session, and the proposed team acceptance scenario. They also accepted deferring coordination of separate agent efforts and work spanning repositories, then handing the product direction to technical planning.

## Answer

The first release supports Slack, GitHub review handling, and the Janitor observation dashboard. Discord follows later using the same interaction model. Earlier Discord walkthroughs and onboarding research remain useful references for that follow-on work, not requirements for the first release.

The MVP supports general repository work, including writing, bug fixes, and maintenance. A session may begin with an idea, an issue, or an existing PR. Each session works within one repository. Different sessions may work across the team's connected repositories; the MVP is not limited to the Effect website repository or blog posts.

A useful MVP lets two authorized teammates collaborate in one private Slack thread, produce or revise a PR, leave GitHub review feedback that the agent handles automatically, and inspect session status and token usage in Janitor. The previously resolved participation, prompting, review, onboarding, and dashboard decisions define this experience. Teammates still perform the merge.

Coordinating separate agent efforts and work spanning repositories are later efforts. All other explicitly deferred features remain outside the first release, including GitHub-to-chat completion notifications.

The product-design destination is reached. The accepted walkthrough and linked decisions are the handoff to technical planning, not an implementation-ready specification or completed product. Subsequent technical work should investigate the tentative OpenCode V2/Durable Object approach, harness execution and queue behavior, repository access, Slack integration, GitHub review events and authorized reviewer recognition, and the connection between Cloudflare Access and platform identities. Hosting feasibility and specific API capabilities remain unverified where the research explicitly says so.

No product decision remains open in this map. If technical investigation exposes a constraint that changes the accepted experience, bring that concrete tradeoff back for a new decision rather than silently changing the design.

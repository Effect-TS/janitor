# Test the blog-post collaboration experience

Type: prototype
Labels: wayfinder:prototype
Status: resolved
Parent: ../map.md
Blocked by: 01, 02, 03, 04, 07, 08, 09

## Question

Does the proposed interaction design let Mike and two teammates collaborate on his blog-post PR without repeatedly reconstructing context across Slack, GitHub, and companion contributions?

Build a throwaway walkthrough or rough interactive prototype showing the selected entry points, joining ongoing work, giving detailed feedback, asking Janitor to act, redirecting it, and reviewing the result on the PR. Include a conflicting instruction and a private contribution so the discussion tests the agreed rules. Ask the human to evaluate the experience and record what works and what must change. Link the prototype as an asset. This ticket evaluates a design; it does not implement integrations or a production agent runtime.

Use one Slack home thread for the anchor session, GitHub for PR review, and Janitor for observing sessions and token usage. Check whether the same interaction model works with a Discord home thread as an alternative; do not depict the same session spanning both platforms or accepting conversational input in Janitor.

Apply [Decide who can participate and what they can see](02-participation-and-visibility.md): the home thread is in a private channel, authorized teammates have equal control, and the dashboard is visible across the team. Include the first-time account connection from [Decide how teammates connect their chat accounts](08-chat-account-connection.md). A private contribution is private from the public, not from other authorized teammates viewing Janitor.

Apply [Decide how teammates direct Janitor's shared work](03-steering-shared-work.md): after creation, ordinary thread messages prompt the agent, and messages arriving during work queue for its next turn. Show a working state, concise tool activity, and an error example. Do not add repeated mentions, custom conflict arbitration, stop/resume commands, budget approvals, or a detailed log viewer to the walkthrough.

Apply [Decide how feedback becomes reviewable changes](04-proposals-and-pr-review.md): show the agent updating Mike's PR directly and automatically addressing an authorized teammate's GitHub review, including a reply on GitHub. Show how concurrent human edits are preserved and how ambiguity leads to a clarification on the PR. Teammates perform the merge. A review-completion message in Slack is optional, not a required step.

Apply [Decide what the observation dashboard shows](07-observation-dashboard.md): include the team-wide session list with working sessions first, accessible recent idle and failed sessions, compact session details, links, and input/output token reporting with a team total for a selected period. Use the resolved ticket for field details; do not add monetary estimates, conversation viewing, or detailed execution logs.

For onboarding, follow [Decide how teammates connect their chat accounts](08-chat-account-connection.md). Show a private connection prompt where supported, then connection and an explicit resend. Consult [Verify account connection and private onboarding support](09-account-connection-support.md) before portraying platform-specific interactions or automatic GitHub identity recognition as available.

## Comments

### Prototype ready for human evaluation

[Open the standalone walkthrough](../prototype/walkthrough.html). This is a single self-contained HTML file; open it in a browser without installing anything.

Context pointer: branch `prototype/multiplayer-walkthrough`, commit `4e9f5bc`, path `.scratch/multiplayer-janitor/prototype/walkthrough.html`. The prototype was originally captured on that throwaway branch; a copy is now included here at the user's request. It remains a simulation, not product code.

The prototype tests interaction and state flow, not visual design. It has six guided scenarios plus free-play actions: shared revision with queued teammate messages, automatic GitHub review, an ambiguous concurrent edit, Slack account connection, a separate Discord-home alternative, and failure reporting. The dashboard shows simulated sessions and usage; no services, agents, authentication, or persistence are connected.

Agent responses, queue grouping, tool descriptions, token counts, identity recognition, and layout are illustrative. The Discord ordinary-message scenario uses a short visible onboarding fallback rather than claiming ephemeral replies are available for that event. Detailed execution logs and session-control commands remain excluded.

Validation: exercised all six guided paths through the DOM and checked their displayed end states. The embedded browser preview could not load in this environment, so visual browser verification is incomplete. No automated test suite was added for the throwaway prototype.

Awaiting the user's evaluation of whether the flow removes context relaying and companion-PR friction. The ticket stays claimed; creating the prototype is not a resolution.

### Human evaluation

The user said that, in general, the walkthrough's flows match their expectations for the MVP. They identified GitHub-to-chat completion notifications as an unresolved question and explicitly deferred that decision until after the MVP.

## Answer

The walkthrough is accepted as the MVP interaction direction. This validates the general flow, not every simulated response, exact queue behavior, visual detail, or implementation choice. The prototype remains a throwaway reference on branch `prototype/multiplayer-walkthrough`, commit `4e9f5bc`, linked above.

Do not include automatic Slack or Discord notifications after GitHub feedback implementation in the MVP. Whether those notifications should exist, and what they contain, is deferred until after the MVP. This does not change ordinary home-thread agent responses, visible work activity, or error reporting. Each session still has one Slack or Discord home thread.

No additional interaction correction was requested. [Choose the MVP scope and planning handoff](10-mvp-scope-and-handoff.md) will identify the first release's platform and work coverage, and distinguish remaining product decisions from technical implementation planning.

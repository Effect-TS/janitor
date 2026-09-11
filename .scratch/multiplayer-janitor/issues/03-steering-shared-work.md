# Decide how teammates direct Janitor's shared work

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 01, 02

## Question

How do teammates start and continue the same ongoing conversation with agents run by Janitor, and observe its progress?

Use a request for feedback on Mike's blog post. Distinguish discussion and suggestions from instructions to act. Decide how Janitor handles two teammates giving incompatible instructions, a new instruction arriving during work, and a teammate returning after an absence. Define the visible progress, questions, results, failures, and cost controls people need. Establish where human decisions are required on the way to a reviewable PR, without selecting an agent provider or runtime architecture.

Apply [Decide where the shared discussion lives](01-unified-discussion.md): collaboration happens in one Slack or Discord home thread per agent session. Specify how someone explicitly starts or connects a session, whether prior thread messages enter its context, and how they resume work or start a new session for the same effort. Dashboard presentation belongs to [Decide what the observation dashboard shows](07-observation-dashboard.md).

## Comments

### Agreed session entry and prompting

The user accepted these recommendations:

- An authorized teammate mentions Janitor with a request to start work. In an existing thread, that thread becomes the session's home; a channel-level request starts a new thread. Linked issues and PRs provide relevant work context, but are not prerequisites for starting a session.
- When joining an existing thread, Janitor reads the preceding discussion in that thread and the linked issue or PR. It does not automatically read unrelated channel history.
- Subsequent thread replies supply context. Explicit mentions request work or redirect Janitor, and direct answers to questions Janitor asked can let it continue. Ordinary discussion does not independently trigger action.

The ticket remains claimed. Handling instructions during active work, conflicting directions, stopping and resuming, progress and failures, and cost controls remain open.

### User correction: the home thread is the agent conversation

The user explicitly replaced the mention-to-act rule. After session creation, ordinary messages from authorized teammates are agent inputs and receive responses, as in an agent harness. No repeated mentions or special distinction between discussion and prompting is required. Messages arriving while the agent is working queue for its next turn rather than interrupting current work.

Conflicting directions use the agent harness's normal conversation behavior. Do not add a Janitor-specific arbitration rule, a last-speaker policy, or a mandatory pause for human agreement. This specifies delegation to normal agent behavior, not a claim about a particular harness's implementation.

The user rejected specific stop/resume commands for the MVP. A session-shutdown command may be considered after a usable MVP exists. The earlier proposed stop, preservation, and explicit-resume workflow was not accepted.

Initial mention-based session creation and reading the existing thread remain agreed. Thread presentation of progress, results and failures, and the MVP's treatment of usage controls remain to be clarified. Exact queue mechanics are later implementation work.

### Visible activity and execution direction

The user accepted a visible working state and concise tool activity, with errors shown in the thread so teammates know when work fails. Detailed execution-log retention is deferred; no log-storage or dashboard-log design was selected.

The user expects to consider OpenCode V2 as the agent harness, running in a Durable Object, and to reuse its execution functionality. This is a tentative direction, not a verified capability or an architecture decision. They expect to start with inexpensive open-weight models and explicitly deferred configurable spending limits, budgets, and additional approval controls.

## Answer

An authorized teammate starts a session by mentioning Janitor with a request. An existing thread becomes its home; a channel-level request starts a new thread. Janitor takes the preceding home-thread discussion and linked issue or PR as context, without automatically reading unrelated channel history. An issue or PR is not required to begin.

After creation, the home thread behaves as the agent conversation. Ordinary messages from authorized teammates are prompts and receive agent responses. No repeated mention or special resume command is needed to continue the conversation. Messages arriving during active work queue for the next turn rather than interrupting it. Exact queue mechanics belong to later implementation work.

Conflicting directions follow the chosen harness's normal conversation behavior. Janitor adds no special arbitration or mandatory agreement workflow. Equal participation does not introduce a session owner with exclusive control.

The thread shows agent responses, a visible working state, concise tool activity, and errors when work fails. Detailed execution-log retention and presentation are deferred. Dashboard usage presentation remains in [Decide what the observation dashboard shows](07-observation-dashboard.md).

Dedicated stop/resume and shutdown controls are outside the MVP. Configurable spending limits, budgets, and additional approval controls are also deferred. The already agreed PR review point remains; [Decide how feedback becomes reviewable changes](04-proposals-and-pr-review.md) resolves the review experience.

The user's tentative OpenCode V2 and Durable Object direction should inform later technical investigation, without treating hosting feasibility or harness behavior as established facts. This ticket resolves the user interaction model and does not select a runtime architecture.

# Decide how agents ask teammates questions

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 03, 07

## Question

Should the MVP disable OpenCode's structured `question` tool and have agents ask questions in ordinary thread replies, or support native form submission through an explicit Slack interaction contract?

The lifecycle fixture reproduced a mismatch with the accepted ordinary-message flow: the native question tool waited on a form, while a subsequent queued message saying "Choose A" remained undelivered. The session stayed locally active and alarms kept checking. A queued message is not a form submission. Source inspection also shows form waiting uses an in-memory deferred, so native form recovery needs explicit treatment if this path is retained.

Recommend ordinary thread replies for MVP questions, excluding the structured question tool from the runner's advertised tools and instructing the agent to finish its turn when it needs a teammate's answer. A later ordinary authorized message then starts the next turn through existing harness semantics. This retains questions in the conversation and requires no special commands or Slack form interface. It is a proposed tool configuration change, not yet accepted.

If native forms are retained, decide how answers are associated with a question, which teammate may submit, what happens to conflicting submissions, how unrelated queued instructions behave, what persists across a restart, and how waiting changes alarm scheduling. Do not silently treat arbitrary queued messages as answers or build a form UI without this decision.

## Evidence

- [Lifecycle verification results](../research/runner-lifecycle-results.md)
- [Native structured-question reproduction](../research/runner-question-result.json)
- [Ordinary-question alternative fixture](../prototype/runner-fixture/probe-plain-question.mjs)
- [Passing local ordinary-question result](../research/runner-plain-question-result.json)

Pinned source: `packages/core/src/tool/plugin/question.ts:75` calls `Form.ask`; `packages/core/src/form.ts:145` awaits the form's deferred result. Normal prompt admission in `packages/core/src/session/session.ts:139` admits into the inbox and wakes execution; it does not submit a form.

## Comments

The user accepted ordinary conversational questions for the MVP: "Yes for the MVP that's fine".

## Answer

Disable OpenCode's structured `question` tool in the MVP runner's advertised tool set. Instruct the agent to ask questions through ordinary conversation replies and finish its turn when it needs a teammate's answer. Janitor delivers those replies through the existing thread-output contract. Any authorized teammate can answer with an ordinary message; the existing acceptance order and native conversation queue handle that input. No form submission, special answer command or question-specific control owner is introduced.

With no other accepted work pending, a question that ends the turn leaves execution idle and clears its execution-check alarm. The session remains available. A later ordinary input arms supervision and starts eligible native work. If other inputs were already queued, preserve native queue behavior rather than adding a separate lock that waits for a designated answer.

The pinned local Workerd fixture passed with the structured tool removed: the model's advertised tools excluded `question`, the first question ended its turn and cleared the alarm, and an ordinary answer caused a second completed turn. See the [ordinary-question result](../research/runner-plain-question-result.json). The twenty deployed lifecycle cases remain valid; this local check covers the newly selected tool configuration and conversation behavior. It does not claim a live Slack delivery test.

Native form interactions, their UI and recovery semantics are deferred beyond the MVP. The earlier reproduction remains evidence for this restriction, not an unresolved requirement to implement forms. No additional live deployment is needed to record this decision.

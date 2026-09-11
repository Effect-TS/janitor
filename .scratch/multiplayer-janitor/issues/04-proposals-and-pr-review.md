# Decide how feedback becomes reviewable changes

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 01, 02, 03

## Question

Apply [Decide where the shared discussion lives](01-unified-discussion.md), with the user's subsequent clarification below: PR review feedback can automatically prompt agent work on GitHub while the session retains one Slack or Discord home thread.

How should Janitor turn discussion and detailed editorial feedback into proposed changes while keeping the PR the team's central review point?

In the anchor scenario, a teammate needed a companion PR to express detailed feedback on Mike's PR. Decide what that teammate should do instead or how Janitor should make the companion contribution easier to manage. Clarify when Janitor offers suggestions, changes an existing branch, or creates a separate proposal; how authorship and acceptance appear; and what happens if Mike edits the same passage while Janitor is working. Use the agreed participation and agent-control rules. Do not settle repository write mechanics before the desired review experience is understood.

## Comments

### Initial review direction

The user agreed with updating the existing PR branch when asked to revise it, creating a separate proposal when explicitly requested, and creating a PR for new work when appropriate. The agent carries work through PR creation and revisions; teammates merge on GitHub.

The user added a caveat: "I think the agent should address review feedback on the PR." Clarify whether this means review comments automatically trigger agent work, replies to reviewers appear on GitHub, or both. Do not treat the proposed home-thread request requirement as accepted until this is clarified. The ticket remains claimed.

### Automatic PR review handling

The user confirmed that the agent should automatically pick up PR review feedback, implement changes, and reply to reviewers directly on GitHub without another prompt in Slack or Discord. This supersedes the proposed requirement to request review handling in the home thread.

The user said a Slack or Discord message after implementing feedback may be considered optionally. Do not require progress or completion notifications for this review workflow in the home thread.

The session retains its single Slack or Discord home thread; GitHub review handling is an additional source of work and a place for review replies. This does not establish general-purpose GitHub chat or mirrored Slack/Discord sessions. Which reviewers may trigger automatic work, and handling concurrent human edits, remain open.

### Confirmed reviewer authority and concurrent edits

The user accepted limiting automatic review-triggered work to authorized teammates. Outside contributors' feedback can be addressed when an authorized teammate asks the agent to handle it.

The user also accepted incorporating the latest PR changes and preserving concurrent human edits. If the edits conflict in meaning, the agent asks for clarification on the PR through its normal workflow, without adding a separate approval system.

## Answer

When asked to revise an existing PR, the agent updates that PR's branch. A separate proposal is created when explicitly requested. For new work, the agent creates a PR when appropriate. This lets teammates express detailed feedback through the shared conversation without needing to prepare a companion PR themselves.

On a PR being worked on by Janitor, review feedback from authorized teammates automatically prompts the agent to implement changes and reply to reviewers on GitHub. No additional request in Slack or Discord is required. Feedback from outside contributors requires an authorized teammate's request before the agent acts on it.

The agent incorporates current PR changes and preserves concurrent human edits. When changes conflict in meaning, it asks for clarification on the PR through its normal agent workflow. This is not a separate approval or arbitration system.

The agent carries work through PR creation and subsequent revisions. Teammates merge on GitHub. The session retains one Slack or Discord home thread, with GitHub review handling as an additional source of work and a place for review replies. A completion notification in the home thread is optional and not required for the MVP.

These choices were confirmed through the discussion above. The identity-connection design must establish how GitHub reviewers map to authorized teammates, and how participants and agent contributions are identified. Detailed Git author metadata, webhook mechanics, and write-conflict implementation remain later technical work.

Subsequent scope refinement: [Test the blog-post collaboration experience](05-collaboration-walkthrough.md) defers GitHub-to-chat review-completion notifications until after the MVP, replacing the earlier optional-in-MVP treatment.

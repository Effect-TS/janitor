# OpenCode gang prompting reference

Investigated 2026-09-10 for Janitor's shared-work design.

## Finding

Dax's first-party post is a strong match for the user's recollection. He describes a team-accessible OpenCode installation at `gangprompt.opencode.ai`, protected by Cloudflare Access SSO, running on a machine with the team's repositories cloned. Teammates can submit prompts and observe one another's work. This establishes the intended shared environment in the author's account. I did not locate the exact X post the user remembers or inspect a live demonstration. [Dax's original LinkedIn post](https://www.linkedin.com/posts/thdxr_we-setup-gangpromptopencodeai-threw-activity-7463400956605599744--MsN)

## What the sources establish

| Interaction        | Evidence and limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Join               | Dax describes access through SSO to a common team installation. He does not explain invitations, roles, or account mapping. [Original post](https://www.linkedin.com/posts/thdxr_we-setup-gangpromptopencodeai-threw-activity-7463400956605599744--MsN)                                                                                                                                                                                                                                         |
| Contribute prompts | The team can prompt from the shared installation. The post does not establish simultaneous prompting in one session or how contributions are attributed. [Original post](https://www.linkedin.com/posts/thdxr_we-setup-gangpromptopencodeai-threw-activity-7463400956605599744--MsN)                                                                                                                                                                                                            |
| Observe work       | Dax describes visibility into teammates' work. Official web documentation separately describes viewing active sessions, starting sessions, and attaching a terminal to the web server with shared sessions and state. Those docs are supporting context, not proof of the historical setup's exact UI. [Original post](https://www.linkedin.com/posts/thdxr_we-setup-gangpromptopencodeai-threw-activity-7463400956605599744--MsN), [OpenCode web documentation](https://opencode.ai/docs/web/) |
| Coordinate control | Current server documentation lists session operations for messages, status, abort, fork, and diffs. It does not settle who may override whom in Dax's installation. API operations alone do not demonstrate a team control policy. [OpenCode server documentation](https://opencode.ai/docs/server/)                                                                                                                                                                                            |

The inspected sources do not establish Slack, Discord, or GitHub conversation synchronization, cross-platform identity matching, PR review synchronization, shared-branch isolation, or conflict arbitration for this setup. These remain questions for Janitor's design. A separate follow-up by Dax calls the experiment a bad idea without explaining the cause in the accessible text. It supplies no basis to infer a particular failure mode. [Dax's follow-up](https://www.linkedin.com/posts/thdxr_ok-this-was-immediately-a-bad-idea-activity-7463401696740900865-bY1C)

## Relevance to Mike's blog-post PR

The following are design inferences for discussion, not OpenCode capabilities established by the reference.

- A team-accessible session could let Mike and reviewers inspect the same agent context and proposed edits. That is a useful direction for reducing repeated explanation.
- A new shared website could also add another destination alongside Slack and GitHub. The reference does not answer whether Janitor should gather discussion into a dedicated place or let people participate through their existing platforms.
- Avoiding a companion PR requires a decision about how a teammate proposes detailed edits against Mike's work and how Mike accepts them. Shared session visibility does not settle that decision.
- The walkthrough should test one teammate proposing a rewrite while another disagrees, and a teammate returning later to understand what changed. These examples expose attribution and control choices that the reference leaves unspecified.

Use the reference as evidence that a team can share access to an agent environment. Do not treat it as a completed design for Janitor's collaboration workflow.

## Research boundary

Searched for OpenCode gang prompting, `gangprompt.opencode.ai`, and matching posts by `thdxr`. Located the author's original LinkedIn explanation and follow-up, and inspected official OpenCode web/server documentation. No exact X URL or verified interactive demo was recovered. The user has not confirmed that the located post is the reference they intended. No authenticated access to the team installation was attempted.

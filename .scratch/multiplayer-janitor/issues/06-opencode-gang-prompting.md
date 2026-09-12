# Investigate OpenCode's gang prompting reference

Type: research
Labels: wayfinder:research
Status: resolved
Parent: ../map.md
Blocked by: none

## Question

What did OpenCode demonstrate or describe as "gang prompting," and which observable interactions can inform Janitor's shared-work design?

Locate the original post, demo, or first-party explanation the user recalls. Establish how people join, contribute prompts, observe shared work, and coordinate control, distinguishing demonstrated behavior from inference. Record source links and any uncertainty about whether the located reference is the one the user means. Compare the demonstrated experience with the blog-post PR scenario without deciding that Janitor must copy it.

## Answer

Found a strong first-party match in [Dax's original description of gangprompt.opencode.ai](https://www.linkedin.com/posts/thdxr_we-setup-gangpromptopencodeai-threw-activity-7463400956605599744--MsN). He describes a common OpenCode server with team repositories cloned, SSO through Cloudflare Access, and teammates submitting prompts and observing each other's work. The exact recalled X post and an interactive demonstration remain unidentified.

The reference supports exploring a shared agent environment. It does not establish simultaneous control of one session, attribution, conflicting instructions, branch isolation, or Slack/GitHub/Discord synchronization. Those remain design questions. In Mike's blog-post scenario, a shared environment may reduce repeated context, but introducing another website alone would not resolve the need to move between Slack and GitHub or propose detailed edits.

Research context: [Cited findings and evidence limits](../research/opencode-gang-prompting.md), branch `research/opencode-gang-prompting`, commit `e34911d`. The research was originally captured on that throwaway branch; a copy is now included here at the user's request. Resolved as an investigation with explicit unknowns, not a product decision or confirmation that this is the user's exact reference.

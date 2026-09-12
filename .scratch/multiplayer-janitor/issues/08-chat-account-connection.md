# Decide how teammates connect their chat accounts

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 02, 04

## Question

Later user decision: [Decide platform identity and authorization contracts](../../multiplayer-janitor-technical/issues/06-platform-identity.md) supersedes ongoing Cloudflare Access eligibility with persistent linked-account authorization and explicit admin removal. Access expiry or removal alone does not disable linked-account usage. Historical discussion below is retained.

What should a teammate experience when connecting a Slack or Discord account after signing into Janitor through the existing Cloudflare Access identity provider?

Walk through first-time connection, an unconnected account prompting Janitor, and a teammate replacing or disconnecting an account. Decide how Janitor shows which identity authored an instruction, and the expected behavior when team eligibility ends. Preserve the agreed single source of team eligibility rather than introducing a second authorization list. Resolve product behavior; leave protocol and implementation details to later technical work, creating focused research tickets if platform facts become prerequisites.

Also establish how GitHub reviewers are recognized as authorized teammates for [Decide how feedback becomes reviewable changes](04-proposals-and-pr-review.md). Do not assume that the existing Cloudflare Access assertion provides a GitHub username or a chat-account mapping. Describe how the experience distinguishes teammate instructions and agent contributions, without prescribing Git commit metadata here.

## Comments

The user accepted the proposed Connected accounts page, refusing work from unconnected accounts until they connect and resend, and self-service disconnection or replacement. They added that onboarding responses should be private to the requesting user wherever the platform supports it, to avoid cluttering the thread.

## Answer

After Cloudflare Access sign-in, teammates manage their identities on a personal Connected accounts page. It shows Slack, Discord, and their recognized GitHub identity. Teammates connect only the chat platforms they use. Investigate whether existing sign-in can provide a verified GitHub identity before adding another connection step.

When an unconnected account prompts Janitor, provide a short sign-in and account-connection link. Make this response private to the requesting user where supported. Janitor does not execute the original request; the teammate sends it again after connecting. Connecting an account never replays earlier requests automatically.

Teammates can disconnect or replace accounts from the same page. Disconnecting prevents new instructions from that account while preserving shared sessions and past contributions. Losing team eligibility also prevents new instructions, regardless of connected accounts. Cloudflare Access remains the source of team eligibility.

The user confirmed this product flow. Platform-specific private-response support and GitHub identity recognition are tracked in [Verify account connection and private onboarding support](09-account-connection-support.md). That investigation may reveal a need for a further product decision; this resolution does not assert that every platform event supports private replies or that the existing Access assertion exposes a GitHub username. Detailed identity verification and historical attribution storage remain implementation work.

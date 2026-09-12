# Decide who can participate and what they can see

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: none

## Question

Later user decision: [Decide platform identity and authorization contracts](../../multiplayer-janitor-technical/issues/06-platform-identity.md) supersedes ongoing Cloudflare Access eligibility with persistent linked-account authorization and explicit admin removal. Admin/member roles govern team administration; equal control over agent work is preserved. Historical discussion below is retained.

Who can contribute context, instruct Janitor, approve changes, and stop work, and what may Janitor share between a private team conversation and a public repository?

Use a private Slack discussion about Mike's public PR as the concrete case. Distinguish team members from outside contributors, decide how the experience communicates authorship and authority, and identify which actions require recognizing the same person across platforms. Decide the expected behavior when someone can access one conversation but not another. Capture product rules; defer identity-provider and permission implementation choices.

## Comments

### Agreed participation boundary

The user specified that only authorized team members can direct Janitor, all teammates have equivalent control, and sessions initially run only in private channels. Starting a session grants no exclusive control to its initiator. Being a channel participant does not by itself authorize someone to direct Janitor.

Dashboard visibility, authorization administration, and the boundary between private discussion and public output remain open. The ticket remains claimed.

### Team visibility and existing identity provider

The user rejected restricting dashboard session visibility by private-channel membership. Authorized teammates can see sessions across the company in Janitor; this does not make sessions public outside the team.

Janitor may publish work to GitHub when necessary to carry out the work. The user did not require an explicit publication request for every output. The detailed agent workflow remains a separate decision.

Use the existing Cloudflare Access identity provider for team access instead of introducing a separately administered list of authorized accounts. How a Slack or Discord message author is associated with that authenticated team identity needs clarification against the existing setup.

Local inspection confirms that `apps/cluster/src/Ingress/Access.ts` admits `Effectful-Tech` GitHub organization members through Cloudflare Access. `AccessJwt.ts` supplies a verified issuer and subject identity to application requests. No Slack or Discord identity linking exists in the current application. Reusing team eligibility is supported by the current setup; recognizing chat authors needs an additional connection to that identity.

### Account connection direction

The user accepted figuring out a way for teammates to connect Slack and Discord accounts after logging into Janitor. This settles the direction, not the exact onboarding flow or integration mechanism.

## Answer

Only authorized team members may direct Janitor. All authorized teammates have equivalent control; initiating a session grants no exclusive authority. Sessions initially run only in private Slack or Discord channels.

Every authorized teammate may observe every session in the Janitor dashboard, regardless of membership in its home channel. This is team-wide visibility, not public access or a grant of access to the underlying chat channel.

Janitor may publish work to GitHub when needed to carry out the agreed work. Do not require a separate explicit publication request for every output. This decision does not prescribe automatic merging or publishing entire conversation histories; detailed PR behavior belongs to [Decide how feedback becomes reviewable changes](04-proposals-and-pr-review.md).

Use the existing Cloudflare Access identity provider as the source of team eligibility. Teammates connect Slack or Discord accounts after signing in to Janitor, so chat participation can be associated with that team identity. Do not introduce a separate manually administered authorization list. The exact connection experience is delegated to [Decide how teammates connect their chat accounts](08-chat-account-connection.md).

The user's answers confirm these product boundaries. Detailed controls and conflict handling remain in [Decide how teammates direct Janitor's shared work](03-steering-shared-work.md). Dashboard presentation follows these visibility rules in [Decide what the observation dashboard shows](07-observation-dashboard.md).

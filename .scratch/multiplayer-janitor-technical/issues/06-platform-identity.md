# Decide platform identity and authorization contracts

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: none

## Discussion status

The user accepted the first round and subsequently replaced ongoing Cloudflare Access eligibility with persistent linked-account authorization and explicit teammate removal in Janitor. Carry forward equal teammate control, self-service account connections, private onboarding where supported, no replay of rejected inputs, and preservation of shared sessions and historical contributions after account disconnection. Discord remains outside the MVP.

The bounded fact investigation is complete. No deployed identity response was inspected or Access-subject-to-GitHub-ID mapping assumed. The answer below records the final contract and supersedes earlier recommendations in this discussion.

## Comments

Accepted decisions:

1. Allow one Slack account per teammate per connected workspace and one recognized GitHub account per teammate. Each platform account belongs to one Janitor teammate at a time. Replacement requires ownership proof and cannot silently transfer an account linked to another teammate.
2. Already accepted instructions remain contributions to the shared session. Account disconnection or loss of team eligibility prevents further inputs but does not cancel accepted or running work. Preserve original authorship. Repository pause and disconnection remain independent controls.

### Identity facts and next discussion round

Read-only investigation found that `AccessJwt.ts` exposes issuer, subject, email, and expiry, with offline JWT verification but no user revocation lookup. `Ingress/Access.ts` configures an eight-hour application session and GitHub organization eligibility. No deployed identity response was inspected.

[Slack OIDC](https://docs.slack.dev/authentication/sign-in-with-slack/) can prove workspace/user identifiers through a separate account-linking flow. Bind state and nonce to the initiating Access identity, verify the returned token, and check the workspace. Bot installation alone does not link a teammate.

[Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) do not establish a mapping from the Access subject to GitHub's numeric user ID. The current application has no verified mapping. GitHub App user authorization followed by [GET /user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user) is a documented fallback to prove GitHub identity, separate from installation credentials for repository work.

Cloudflare's [active-session API](https://developers.cloudflare.com/api/typescript/resources/zero_trust/subresources/access/subresources/users/subresources/active_sessions/methods/list/) and [session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) can support investigation of revocation, but do not establish fresh evaluation of GitHub organization membership for each asynchronous message. Neither a stored account link nor offline JWT verification supplies immediate offboarding awareness.

Pending recommendations: accept an explicit GitHub connection step if deployed Access cannot supply verified GitHub identity; and initially bound chat/review authorization to the verified Access session's existing expiry, requiring renewed sign-in when it expires. An ordinary page visit with the same assertion must not extend that expiry. Whether the resulting sign-in frequency is acceptable is a user decision. Revocation checking and its measurable freshness still need a concrete contract; no immediate-removal guarantee is claimed.

## Question

### Accepted change to ongoing authorization

The user accepted an explicit GitHub account connection when deployed Access cannot supply a verified GitHub identity. They rejected tying linked-account use to Access expiry and explicitly directed that Cloudflare Access must not determine usage once accounts have been successfully linked.

Access protects sign-in and account management. Successful account links persist independently of Access session expiry or subsequent Access eligibility. Do not introduce periodic Access reauthentication or background Access/GitHub organization membership checks as conditions for accepting linked-account instructions.

The user accepted an explicit teammate-removal action in Janitor. Removal disables all the teammate's links and rejects further instructions, preserving previously accepted work and original attribution. Removing someone from Cloudflare Access alone does not revoke their linked accounts in Janitor. This supersedes the ongoing-eligibility requirement in the earlier product participation/account-connection decisions; their historical discussion is retained.

The user chose admin and member roles. Only admins may remove teammates; members may not. This distinguishes team administration from the accepted equal control over shared agent work. The prior suggestion that any active teammate could remove another was not accepted.

The user accepted configuring the initial admin during setup, admitting new teammates as members, admin-only role changes and restoration, and preventing removal or demotion of the last active admin. Signing in or relinking cannot undo removal.

### Original question

How are Slack senders and GitHub reviewers verified as the same eligible teammates admitted through Cloudflare Access?

Use the existing [account-connection research](../../multiplayer-janitor/research/account-connection-support.md), verify any missing deployment facts, and choose the account-linking flow, identifiers, storage, and authorization checks. Cover connection replacement, disconnection, team eligibility changes, private onboarding replies, and messages from unconnected accounts that must not replay after connection. Separate platform request authentication from human authorization. Specify contracts for the Connected accounts page and agent inputs, without granting authority from display names or presumed Access subject mappings.

## Answer

### Team admission and roles

Cloudflare Access protects browser sign-in and account management. After admission and successful linking, Janitor's durable teammate and account-link records authorize platform use independently of Access session expiry or later Access eligibility. No periodic Access sign-in or organization-membership check gates linked-account instructions. This explicitly supersedes the earlier product requirement that ongoing Access eligibility controls participation.

Configure the initial admin during setup against a verified Access identity, not whichever visitor arrives first. New teammates join as members. Admins alone can change roles, remove teammates, and restore removed teammates. Prevent removal or demotion of the last active admin, including concurrent requests. Both roles have equal control over shared agent work.

### Identity and linking contract

Janitor owns a stable teammate ID associated with the verified Access issuer and subject, a role, and active or removed status. Display names and email are display information, not account-link proof. Do not infer that an Access subject is a GitHub account ID.

Use Sign in with Slack OIDC after Access sign-in to prove the Slack workspace ID and user ID. Bind the callback to the initiating teammate with single-use state and nonce, verify the returned identity, and require the connected workspace. Store one Slack link per teammate per workspace and ensure each workspace/user pair belongs to at most one teammate.

For GitHub, reuse a verified numeric account ID from deployed Access only if that mapping is actually established. Otherwise use the accepted explicit GitHub App user-authorization flow and authenticated user lookup. Store one GitHub numeric account ID per teammate with unique ownership. This proof is distinct from the App installation credentials used for repository operations. GitHub login names may change without changing account ownership.

Keep teammate records, account links, uniqueness constraints, and administrative changes in Janitor's durable application storage, not runner conversation storage. Persist input attribution using the stable teammate and platform IDs plus the display information at acceptance, so account replacement or renaming does not rewrite history.

### Account management and removal

Connected accounts shows the teammate's Slack and GitHub identities and permits self-service connection, replacement, and disconnection. Verify replacement ownership before changing a link; reject links already owned by another teammate. Self-service disconnection blocks new instructions from that account without affecting shared sessions or previously accepted contributions.

Admin removal disables all links for the teammate and blocks further instructions. Preserve the removed identity and link ownership records so ordinary sign-in or relinking cannot silently create a replacement active teammate. Admin restoration explicitly reverses removal; it does not replay previously rejected messages. A self-disconnected account still requires linking again. If Access identity changes, do not automatically merge people by email or transfer existing platform links; identity recovery requires explicit administration.

Removal from Cloudflare Access alone does not remove a teammate from Janitor. Conversely, a removed Janitor teammate cannot regain account-management or administrative privileges merely by presenting a valid Access assertion. Browser operations check Janitor status and role as well as Access authentication.

### Input authorization

Authenticate Slack requests and GitHub webhook deliveries separately from authorizing the human sender. A valid platform signature does not confer teammate authority. Resolve the verified platform sender to an active Janitor teammate through an enabled link. Apply the existing private-home-thread, session routing, and repository-readiness rules. Never grant authority from names, message text, or bot installation alone.

Serialize authorization changes against durable input acceptance: an instruction accepted before removal remains accepted, while one arriving after removal is rejected. Retried accepted inputs retain their original identity and outcome. Inputs rejected while unlinked or removed never become executable because a later link or restoration succeeds; the teammate must send a new message. Already accepted queued or running work continues with original attribution.

Provide short account-connection guidance privately in Slack where supported, following the existing ephemeral-response research. The Connected accounts page remains the reliable place to inspect connection state. GitHub review authorization uses the linked numeric reviewer ID; outside contributors do not acquire authority from posting review feedback.

### Handoff checks

Verify ownership proofs and callback replay rejection; concurrent linking and replacement; member rejection for admin actions; last-admin protection under concurrent requests; removal racing input acceptance; accepted-input retries after removal; expired Access with a still-authorized platform link; removed users signing in or relinking; and no replay after connection or restoration. The event-delivery ticket specifies transport retries and private-response delivery details using this authorization contract.

No deployed identity response or live account-linking flow was tested during this discussion. The explicit GitHub connection fallback permits implementation without relying on an unverified Access mapping.

# Verify account connection and private onboarding support

Type: research
Labels: wayfinder:research
Status: resolved
Parent: ../map.md
Blocked by: 08

## Question

Which first-party capabilities support the agreed account-connection experience, and do any constraints require changing its walkthrough?

Check private onboarding responses for ordinary mentions and messages versus app interactions in Slack and Discord. Establish whether Janitor's existing Cloudflare Access GitHub sign-in exposes or can supply a verified GitHub user identity for review-author recognition. Inspect local authentication code and primary documentation; distinguish currently available identity fields from possible additional integrations. Identify viable product fallbacks without selecting one for the user or designing a complete authentication architecture. Keep the findings bounded to these onboarding questions.

## Answer

Slack supports targeted ephemeral messages after ordinary mentions or messages, with best-effort delivery and active-thread constraints. Discord supports ephemeral interaction responses, but its ordinary message API cannot send an ephemeral reply. A DM is a possible private alternative; the agreed short response remains a fallback where private delivery is unsupported. The walkthrough must reflect these differences without making interactions mandatory.

Existing Janitor authentication returns Access issuer, subject, optional email, and expiry, with no GitHub user ID or login. Cloudflare's authenticated full-identity endpoint can return IdP data, but reviewed documentation does not establish GitHub-specific identity fields for this deployment. Reusing that identity needs verification; an additional GitHub user authorization flow and authenticated `GET /user` is a documented fallback, not a selected requirement. Do not infer GitHub identity from Access subject or email.

Findings: [Account connection and private onboarding support](../research/account-connection-support.md).

Context pointer: branch `research/account-connection-support`, commit `f3f6939`, path `.scratch/multiplayer-janitor/research/account-connection-support.md`. The research was originally captured on that branch; a copy is now included here at the user's request. Sources and unverified deployment questions are recorded in the artifact. No live authentication experiments or product implementation were performed.

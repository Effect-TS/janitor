# 01: Connect and manage teammate identities

**What to build:** Teammates sign into Janitor, connect their Slack and GitHub accounts, and manage participation through account screens. Admins manage roles and membership while members retain equal control of agent work.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Persist stable teammates from verified Access issuer/subject; explicitly configure the first admin and admit subsequent teammates as members. Browser operations require both valid Access and active Janitor membership.
- [x] Implement Slack OIDC ownership proof with bound single-use state/nonce and workspace validation. Use explicit GitHub App user authorization and numeric user lookup unless a deployed Access mapping has actually been verified.
- [x] Enforce unique account ownership, one Slack link per teammate/workspace and one GitHub account per teammate. Support verified replacement and self-disconnection without rewriting historical attribution.
- [x] Admin-only role/removal/restoration actions work through the UI. Protect the last active admin under concurrent requests. Removed identities retain ownership records and cannot evade removal by signing in or relinking.
- [x] Provide a transactional authorization interface for later input acceptance, so acceptance can serialize against removal. Persistent platform authority does not expire with the browser Access session.
- [x] Test callback replay, conflicting concurrent links, replacement, member/admin boundaries, last-admin races, removal/relinking and expired browser authentication independently of enabled platform links.
- [x] Provide setup instructions for verified callbacks and initial-admin configuration; do not embed fixture identities or credentials.

## Comments

2026-09-12: Implemented. Migration `0022_teammates.sql` adds teammates, links, single-use link attempts and audit. `Teammates` (admission, roles, removal/restoration, links, transactional `authorize`) and `AccountLinking` (Slack OIDC with bound state/nonce and workspace validation; GitHub App user authorization with numeric user lookup) sit behind the new membership middleware, which every human route now requires in addition to Access. Routes live under `/api/v1/account` and `/api/v1/team`; the web app gains an Account page with connected accounts and the admin roster. Tests cover callback replay, conflicting concurrent links, replacement, member/admin boundaries, last-admin races, removal/relinking and the authorization-versus-removal transaction; browser expiry is checked independently of links in the middleware tests. Setup instructions are in the README and `.env.example`. No verified deployed Access mapping supplies GitHub identity, so explicit user authorization is used. Real Slack and GitHub callbacks were exercised against stubbed platforms only; a live round trip still needs the apps described in the README.

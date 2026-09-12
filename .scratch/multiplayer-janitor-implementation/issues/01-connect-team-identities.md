# 01: Connect and manage teammate identities

**What to build:** Teammates sign into Janitor, connect their Slack and GitHub accounts, and manage participation through account screens. Admins manage roles and membership while members retain equal control of agent work.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Persist stable teammates from verified Access issuer/subject; explicitly configure the first admin and admit subsequent teammates as members. Browser operations require both valid Access and active Janitor membership.
- [ ] Implement Slack OIDC ownership proof with bound single-use state/nonce and workspace validation. Use explicit GitHub App user authorization and numeric user lookup unless a deployed Access mapping has actually been verified.
- [ ] Enforce unique account ownership, one Slack link per teammate/workspace and one GitHub account per teammate. Support verified replacement and self-disconnection without rewriting historical attribution.
- [ ] Admin-only role/removal/restoration actions work through the UI. Protect the last active admin under concurrent requests. Removed identities retain ownership records and cannot evade removal by signing in or relinking.
- [ ] Provide a transactional authorization interface for later input acceptance, so acceptance can serialize against removal. Persistent platform authority does not expire with the browser Access session.
- [ ] Test callback replay, conflicting concurrent links, replacement, member/admin boundaries, last-admin races, removal/relinking and expired browser authentication independently of enabled platform links.
- [ ] Provide setup instructions for verified callbacks and initial-admin configuration; do not embed fixture identities or credentials.

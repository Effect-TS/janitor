# Trim the Account page content to the mockup

Status: ready-for-agent
Parent: ../spec.md
Blocked by: 06

## Task

Rebuild the three panes' content in `apps/web/src/components/account.ts` to match `docs/settings-mockups/07-sidebar-sections.html` and the "Section content" table in the spec. Keep the Message union, API calls and pending gating exactly as they are; only the view functions change.

## Steps

1. Replace `section(h, title, children)` (`:480-484`) with the sign + lede + panel composition from ticket 04. Content column `max-w-[640px]`.
2. **You** pane: a three-row definition grid (Email, Role chip, Teammate since). Format `createdAt` as `d MMM yyyy`; add a tiny `formatDate` helper or reuse one if the workspace already has it.
3. **Connected accounts** pane: rewrite `platformRow` (`:345-407`) to the one-status-line, one-action shape from the spec. Derive the status line from `activeLink`, then the newest non-active link (`links` is ordered active-first, newest first), then `linking[platform]`. Keep `Replace` as a `link`-variant button beside Disconnect. Busy labels unchanged.
4. **Team** pane: rewrite `rosterRow` (`:409-478`) to the dense row (avatar, name, optional "No email on record" sub-line, role chip, actions). No actions on the viewer's own row. Split the roster into active and removed; render removed rows only when `showRemoved`, behind the footer toggle wired to `ToggledRemoved`. Footer left text "N active".
5. Member viewer: lede "Only admins can manage the team." and the empty-state panel.
6. Loading: "Loading your account…" inside a skeleton panel in the content column.
7. Copy changes (old → new), for ticket 08's test updates:
   - "No {name} account connected." → "Not connected"
   - "{name} linking is not configured for this deployment." → "Not available in this deployment"
   - "Connected as X in workspace T1." → "Connected as X"
   - "Connected accounts may direct Janitor from Slack and GitHub until you disconnect them, independently of this browser session." → "Accounts that can give Janitor instructions on your behalf."
   - "Removing a teammate disables their connected accounts and sign-in; their accepted work and attribution are kept. The last active admin cannot be removed or demoted." → "Everyone who has signed in. New teammates start as members." plus the panel footnote "Disconnecting stops new instructions from that account. Work it already contributed is kept." on the accounts pane.
   - Roster meta "Admin · Active · Slack: Me" is removed.

## Done when

- Each pane fits in a 1400×800 viewport with the default fixture data (four active, one removed).
- All five state combinations from the spec's Validation section render correctly in day and night.

## Comments

Done. Panes match the mockup: You is a three-row grid, Connected accounts is one status line and one action per platform (Replace kept as a quiet link button), Team is a dense roster with removed teammates behind a footer toggle. Member viewers get the empty-state panel. Old copy replaced as listed above.

# Utility Room restyle and Account page restructure

Status: ready-for-agent

This plan applies the "Utility Room" design (see `docs/settings-mockups/07-sidebar-sections.html` and `docs/settings-mockups/utility-room.css`) to `apps/web`, and restructures the Account page into three switchable sections. The mockups are the visual reference; this document is the implementation handoff.

## Outcome

- The whole web app renders with Utility Room tokens: cobalt, navy, safety yellow, cream on a cinderblock wall, Archivo / Big Shoulders Display / Spline Sans Mono, hard navy drop edges instead of soft shadows.
- Night shift is a warm charcoal palette, not the navy-on-navy `.dark` block from the original theme file.
- The Account page (`/account`) becomes a settings page with a section rack on the left (You, Connected accounts, Team) and one section in the centre, each fitting a single screen with only the information a user needs.
- Existing behaviour is unchanged: link start/return/disconnect, role changes, remove/restore, single pending-action gating, error and notice reporting.

## Scope decision: tokens are global

The app uses shadcn semantic tokens (`bg-card`, `text-muted-foreground`, `bg-sidebar-accent`, `rounded-md`, ...) in 21 of ~30 files. Swapping the values behind those names restyles every page at once. That is the intended approach: change the palette, radii, fonts and shadows at the token layer, upgrade the shared primitives, and then compose the Account page fully. Other pages inherit the new look and get a polish pass afterwards (ticket 09). Restyling only the Account page would require a parallel token set and is not worth it.

## Sources of truth

| Item | Source | Where it lands |
| --- | --- | --- |
| Design tokens and component specs | `docs/design/DESIGN.md` (checked in from the review attachment) | Update in ticket 01 with the recorded deviations |
| Tailwind v4 theme | `docs/design/theme.css` (Tailwind + shadcn mapping, checked in) | `apps/web/src/styles.css`, replacing the oklch palette |
| Night palette | `docs/settings-mockups/utility-room.css`, "Night shift" block | `apps/web/src/styles.css` `.dark` block |
| Layout and content of the Account page | `docs/settings-mockups/07-sidebar-sections.html` | `apps/web/src/components/account.ts` |

## Recorded deviations from DESIGN.md

Both were requested during mockup review and should be written into the checked-in DESIGN.md so the doc stays authoritative.

1. **Destructive button is filled.** Rust fill, cream text, rust-dark border and drop edge, darker fill on hover. DESIGN.md currently specifies a cream button with a rust outline that inverts on hover.
2. **Night shift is warm charcoal.** Wall `#1c1b18`, mortar `#262420`, card `#2a2823`, raised `#34312b`, inset `#14130f`, outlines `#5a554b` / `#7b7466`, ink `#f6efdd`, muted `#a8a08e`, rust `#e0705c`. Cobalt signs, yellow on-states and the hazard stripe keep their day colours. The theme file's `.dark` block (navy-deep background, navy panel cards) is discarded.

## Architecture of the change

```
styles.css (tokens, @utility jn-*, night palette)        ← ticket 01, 02
  └─ ui/button, input, skeleton, sidebar, sheet, command  ← ticket 03
       └─ ui/sign, chip, panel, rack, mark (new)          ← ticket 04
            └─ main.ts shell (sidebar, header)             ← ticket 05
                 └─ routes.ts + account.ts sections        ← ticket 06
                      └─ account.ts trimmed content        ← ticket 07
                           └─ tests, vp check, visual pass ← ticket 08
                                └─ other pages polish       ← ticket 09
```

Tickets 01 to 05 are safe to ship independently; each leaves the app working with progressively more of the new look. Tickets 06 and 07 change the Account page structure and must ship together with 08.

## Account page specification

### Routes

`AppRoute.Account` gains a `section` field: `"you" | "accounts" | "team"`. Paths:

| Path | Section |
| --- | --- |
| `/account` | `accounts` (default; redirect-free, just the default parse) |
| `/account/you` | `you` |
| `/account/accounts` | `accounts` |
| `/account/team` | `team` |
| `/account/:platform/return?code&state&error` | unchanged `AccountReturn`; after completion navigate to `/account/accounts` |

`accountReturn` stays first in `Route.oneOf` so `/account/slack/return` never parses as a section. `Routes.section` / `Routes.sectionPath` are repository-scoped and must not be reused.

### Layout

Inside the existing inset (48px header keeps the title; see below), a two-column grid: a 200px section rack on the left with three hook tags (`aria-current="page"` on the active one), and a content column with `max-width: 640px`. Below 880px the rack becomes a horizontal wrapped row above the content. No punch card, no tallies, no enamel sign per row.

Each section is: one enamel sign (`h2`, uppercase, Big Shoulders), one lede sentence in muted ink, one mounted panel.

### Section content (what is shown, and nothing else)

**You**
- Email (or subject when email is null)
- Role chip: `admin` (yellow on-state) or `member`
- Teammate since `createdAt`
- Lede: "How Janitor knows you. Sign-in is handled by Cloudflare Access."

**Connected accounts**
- Lede: "Accounts that can give Janitor instructions on your behalf."
- One row per platform (GitHub, Slack) with a 30px platform mark, the platform name, and exactly one status line:
  - active link: "Connected as `displayName`"
  - no link and linking available: "Not connected"
  - most recent link is `disconnected` or `replaced`: "Disconnected · was `displayName`"
  - linking unavailable: "Not available in this deployment"
- Exactly one action per row: filled rust **Disconnect** when active; yellow **Connect GitHub / Connect Slack** otherwise; a disabled Connect when unavailable.
- Keep **Replace** as a `link`-variant button next to Disconnect. It calls the same start endpoint and preserves the `replaced` link status; dropping it would force disconnect-then-connect, which records a different history. It is visually quiet so the row still reads as one action.
- Footer sentence under the panel: "Disconnecting stops new instructions from that account. Work it already contributed is kept."
- Removed from today's view: workspace IDs, account IDs, linked dates, "in workspace T1" phrasing.

**Team** (admin only; `view.team !== null`)
- Lede: "Everyone who has signed in. New teammates start as members."
- Dense list (`.jn-dense`): avatar initials, email (or subject with a "No email on record" sub-line), role chip, and for other active teammates **Make admin / Make member** and filled rust **Remove**. Your own row shows no actions.
- Removed teammates are collapsed. Panel footer: "N active" on the left, a link-style "Show N removed / Hide removed" toggle on the right (view-local boolean in the Account model, not persisted). Removed rows show `removed` danger chip and **Restore**.
- Member viewers see the lede "Only admins can manage the team." and an empty-state panel: "Ask an admin if you need a role change or to remove someone."
- Removed from today's view: the "Admin · Active · Slack: Me, GitHub: octocat" meta line, per-row explanation of the last-admin rule (the guard is expressed by not offering actions on your own row; the server error still surfaces in the alert if it ever fires).

### Header title

`mainHeader` shows "Account" for the account routes today. Keep "Account"; the section name is carried by the active tag and the enamel sign, so the header does not need to change per section.

### Busy and error states

Unchanged model: one `pending` operation at a time, button labels switch to their gerund while busy ("Opening…", "Disconnecting…", "Updating…", "Removing…", "Restoring…"), `role="alert"` for errors and `role="status"` for notices, rendered above the active section. Loading shows the existing "Loading your account…" text inside a skeleton panel.

## Validation

- `vp check` and `vp test` pass.
- `apps/web/test/components/account.test.ts` updated for sections (see ticket 08).
- Manual visual pass with the preview tools in day and night, at 1400px and 800px wide, for: all connected; never linked; disconnected; Slack unavailable; member viewer.
- Contrast: every text/background pair in the night palette meets 4.5:1. Check muted ink `#a8a08e` on card `#2a2823` and rust `#e0705c` on card in particular.

## Risks

- **Font weight.** Three new families via `@fontsource` add roughly 300 to 500 KB of woff2 before subsetting. Load only the weights used (Archivo 400/500/600/700, Big Shoulders 700/800, Spline Sans Mono 400/600) and check the build output.
- **Hand-written CSS.** `styles.css:171-401` styles the policy workspace with hardcoded hex colours, including `.dark` overrides. These will clash with the new palette until ticket 09 converts them to tokens.
- **Other pages look half-done** between ticket 01 and ticket 09. Acceptable on a branch; do not deploy between them.
- **Tests assert copy.** Several account-page strings change; ticket 08 owns the test updates and lists the old strings.

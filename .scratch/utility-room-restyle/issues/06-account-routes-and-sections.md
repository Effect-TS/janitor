# Add account sections to the routes and the Account model

Status: ready-for-agent
Parent: ../spec.md
Blocked by: 04, 05

## Task

Give the Account page three URL-addressable sections and render them behind a section rack. No content changes yet beyond moving the existing sections into panes; ticket 07 trims the content.

## Steps

1. `apps/web/src/routes.ts`
   - `Account` (`:28`) becomes `{ section: AccountSection }` with `AccountSection = "you" | "accounts" | "team"`.
   - Builders: `/account` parses to `{ section: "accounts" }`; add `/account/you`, `/account/accounts`, `/account/team`. Implement as `Route.literal("account")` optionally followed by a literal segment; do not use `idSegment` so `/account/slack/return` cannot collide.
   - Keep `accountReturn` before `account` in `Route.oneOf` (`:138-139`); add the new builder after it. Extend `path` (`:143-160`).
   - Add `Routes.accountSection(section)` and `Routes.accountSectionOf(route)` helpers.
2. `apps/web/src/main.ts`
   - `enterAccount` (`:153-180`): after a successful `FinishedReturn`, navigate to `Routes.accountSection("accounts")`.
   - `accountView` (`:1131-1138`): pass `viewInputs: { section }` from the route so the Account view knows which pane to render. The `isAccountRoute` guard and header title are unchanged.
3. `apps/web/src/components/account.ts`
   - `view` takes the section as a view input. Render the rack (ticket 04) with three tags linking to the three section paths, `aria-current` on the active one, and only the matching pane. Team's tag is hidden when `view.team === null`; if the URL asks for `team` and the viewer is a member, render the member empty state from the spec.
   - Error, load error and notice stay above the pane.
   - Add `showRemoved: boolean` to the Model and a `ToggledRemoved` message (view-local, not persisted) for ticket 07 to use.
4. `apps/web/test/routes.test.ts`: add cases for the three section paths and confirm `/account/slack/return?code=…&state=…` still parses as `AccountReturn`.

## Done when

- Visiting `/account/team` as an admin shows the Team pane with the Team tag current; `/account` shows Connected accounts.
- Completing a Slack or GitHub return lands on `/account/accounts` with the notice visible.
- `vp test` passes for `routes.test.ts`; `account.test.ts` may fail until ticket 08.

## Comments

Done. `Account` route carries `section`; bare `/account` parses as `accounts` and prints back without a segment. `Routes.accountSection` / `accountSectionOf` added. The Account view takes `{ section }` and renders a rack plus one pane; `showRemoved` and `ToggledRemoved` added for ticket 07. One account test fails until ticket 08 splits assertions per section.

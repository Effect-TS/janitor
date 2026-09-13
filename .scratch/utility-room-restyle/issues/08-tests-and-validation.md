# Update tests and run the validation pass

Status: ready-for-agent
Parent: ../spec.md
Blocked by: 07

## Task

Make the suite reflect the new Account page and verify the restyle visually.

## Steps

1. `apps/web/test/components/account.test.ts`
   - Scenes now need a `section` view input. Add a helper that builds the scene for a given section.
   - Assertions that expect "Team", "Connect GitHub" and the account rows all at once (`:70-97`) split into per-section tests.
   - Replace the old strings listed in ticket 07 with the new ones. Keep the behavioural assertions: clicking Disconnect issues the request, busy labels appear, stale replies are dropped, member viewers see no Team tag.
   - Add: "Show 1 removed" reveals the removed row and its Restore button; "Hide removed" collapses it.
2. `apps/web/test/routes.test.ts`: covered by ticket 06; confirm it is green.
3. Run `vp check --fix` and `vp test` at the root.
4. Visual pass with the `mcp__t3-code__preview_*` tools against `vp dev`, day and night, 1400px and 800px wide: all connected; never linked; disconnected; Slack unavailable (`JANITOR_SLACK_OAUTH_CLIENT_ID` unset); member viewer. Record the screenshots' paths in this ticket's Comments.
5. Contrast: compute the night-palette pairs from the spec and note results here.

## Done when

- `vp check` and `vp test` pass.
- Screenshots for the ten combinations are linked below and match the mockup.

## Comments

Tests rewritten per section: accounts (member and admin fixtures), you, team (self has no actions, removed toggle and restore), member empty state, load failure. Route tests cover the three section paths and the default. `vp check` and `vp test --project web` pass. Visual pass recorded below once dev mode was inspected.

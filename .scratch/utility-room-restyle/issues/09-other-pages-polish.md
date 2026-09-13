# Polish the remaining pages on the new tokens

Status: needs-triage (first pass shipped)
Parent: ../spec.md
Blocked by: 05

## Task

After the token swap, every page is on the Utility Room palette but was composed for the old look. Walk each route and fix what the tokens alone did not: hand-written hex colours, soft shadows, oversized radii, headings that should be enamel signs, and lists past eight rows that should use `.jn-dense`.

## Known work

- `styles.css:171-401` policy workspace block: replace hardcoded hex (`.policy-status-badge.*` and its `.dark` overrides, `.policy-document-*`) with tokens; convert `.repository-nav-link` to classes and delete the rule.
- Repository pages (Overview, Policies, Rules, Activity, Settings under `/repositories/:id/…`): section headings become signs; primary actions confirm they are the single yellow element on the screen; destructive actions (pause, disconnect repository) sit under a `jn-hazard` strip.
- `repository-connections.ts` and the `Connect repository` flow: cards to `panel`, install links to `link` buttons.
- `activity.ts` and any run/audit lists: apply `.jn-dense` past eight rows.
- Empty states (`policy-empty` class in `main.ts:1160`): use `emptyPanel`; the mascot stays out of Settings and error states per DESIGN.md.

## Done when

- No hex colour literals remain in `styles.css` outside the token definitions.
- Each route has been screenshotted in day and night and reviewed.

## Comments

First pass done: every hex literal in the page CSS is now a token or a color-mix of one (draft state cobalt, published and enabled switches yellow, unknown decisions yellow-tinted, match decisions cobalt), and page radii map to the xs/sm/md scale. Section signs and hazard strips on repository pages remain open; review each route in dev before deciding where they belong.

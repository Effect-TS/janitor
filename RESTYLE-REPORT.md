# Restyle report: Utility Room → Ops Console / Blueprint

Branch `t3code/restyle-ops-console-blueprint`, six commits on top of `a158d2f`.
The audit is `RESTYLE-AUDIT.md`; unresolved cases are `OPEN-QUESTIONS.md`;
the normative identity is `docs/design/DESIGN.md` (the project keeps it there,
per the owner's answer to gap G1).

## What changed per phase

**Phase 0, `a119bc2`.** `RESTYLE-AUDIT.md`. No code.

**Phase 1, `edd0a43`.** Appendix A written over `docs/design/DESIGN.md` with a
"Project notes" section for the three owner decisions (mascot stays in the top
bar, GitHub label colours stay as muted dots, the rule editor is the blueprint
host). `apps/web/src/styles.css` rebuilt from Appendix B: palette, shadcn
semantic set for light and dark, theme mapping, base layer with Inter feature
settings and tabular figures, blueprint utilities, agent utilities, dense
table and primitive overrides through `data-slot` selectors, and an alias
block keeping every Utility Room name alive. Fonts switched from Archivo, Big
Shoulders Display and Spline Sans Mono to Inter and JetBrains Mono through
the existing Fontsource mechanism. The manifest `theme_color` and two new
`theme-color` meta tags carry the canvas colour. Utility Room mockups
(`docs/settings-mockups`), the reference `docs/design/theme.css` and the
`.scratch/utility-room-restyle` planning files were deleted. The lint tool
reported one legitimate contrast warning, fixed by darkening
`foreground-subtle` from `#6E7681` to `#6C747F` (4.56:1 on `surface-muted`).

**Phase 2, `2f403ac`.** Every project primitive restyled (list below), new
styled wrappers added for controls the app rendered ad hoc, tailwind-merge
taught the theme's font sizes so `text-label` no longer discards colour
classes, icons set to 14px at 1.5px stroke, and the `/design-system` route
added. It renders every primitive in every state in light, then the same set
inside a `.dark` container, including a 200-row dense table, the activity
feed, the inspector and a blueprint canvas.

**Phase 3, `254049f`.** All screens converted: app shell (sidebar, top bar,
toasts, home, 404, unavailable-repository, first-repository), rules table,
overview, settings, policy library and editor, CodeMirror chrome, activity
feed, test bench, AI input inspector, sessions list and detail, account,
connections, and the rule editor rewritten onto the blueprint canvas. Agent
authorship marked everywhere the inventory listed it.

**Phase 4, `accff1f` and `30e6de4`.** Alias block, dense-list rule and every
unreferenced page CSS rule deleted; sidebar `calc()` offsets moved from
arbitrary class values into the theme file; `tw-animate-css` removed from the
workspace; a non-link issue number returned to plain mono; focus rings
restored on inputs, selects, textareas, menu buttons, sidebar items, command
items and code editor hosts.

## Files in `components/ui/` and why

This codebase is foldkit, not React or shadcn. `@foldkit/ui` is headless and
emits no classes or `data-slot` attributes, so the project's own styled layer
in `apps/web/src/components/ui/` is the only place the Utility Room class
strings lived. Tailwind utilities in those strings outrank the
`@layer components` overrides, so restyling through selectors alone was not
possible. Every file was edited for that reason:

| File                                                                                                       | Change                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button.ts`                                                                                                | Flat 1px border, no shadow or press travel; blue primary, plain secondary and outline, filled danger; 28px default; emits `data-size` and `data-variant`; `buttonBase` exported for link-shaped buttons |
| `chip.ts`                                                                                                  | Badge: 3px radius, mono-xs, variants `neutral`, `selected` (pill), `success`, `danger`, `agent`; emits `data-slot="badge"`                                                                              |
| `command.ts`                                                                                               | Palette on `popover` with hairline separators, caption headings, mono shortcuts                                                                                                                         |
| `input.ts`, `textarea.ts`, `input-group.ts`                                                                | `surface-muted` fill, 1px border, 28px, primary border and 2px ring on focus; help text at `foreground-muted`                                                                                           |
| `mark.ts`                                                                                                  | Hairline mono squares, 28px and 32px                                                                                                                                                                    |
| `panel.ts`                                                                                                 | Card with optional header strip (`panelHeader`) and `emptyPanel`                                                                                                                                        |
| `rack.ts`                                                                                                  | Section nav: 26px rows, primary wash and 2px edge on `aria-current`                                                                                                                                     |
| `sheet.ts`                                                                                                 | One panel class, hairline border, 8px radius, overlay shadow, 120ms user-triggered entry                                                                                                                |
| `sidebar.ts`                                                                                               | 216px width from the token, 26px rows, caption group labels, no shadows, deterministic skeleton, `data-padding` for the CSS offsets                                                                     |
| `sign.ts`                                                                                                  | Plain sentence-case h2                                                                                                                                                                                  |
| `skeleton.ts`                                                                                              | Static `surface-muted` block                                                                                                                                                                            |
| `switch.ts`, `select.ts`, `dialog.ts`, `overlay.ts`, `table.ts`, `feed.ts`, `inspector.ts`, `blueprint.ts` | New: styled wrappers so screens stop styling headless controls inline                                                                                                                                   |

## Tokens added beyond the target

| Token                                                                                    | Justification                                                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `--oc-on-blue`                                                                           | Text on filled primary in both themes without a literal in the semantic block   |
| `--color-destructive-hover`                                                              | Danger button hover, from `danger-hover` in DESIGN.md                           |
| `--color-primary-hover`, `--color-primary-wash`, `--color-primary-line`, `--color-scrim` | Utility access to values Appendix B defines only as raw variables               |
| `--text-numeral`                                                                         | The `numeral` typography scale was in DESIGN.md but not in Appendix B           |
| `--spacing-sidebar`, `--spacing-inspector`, `--spacing-app-bar`                          | 216px, 292px and 46px from DESIGN.md Layout, so widths are not literals in code |
| `oc-human-dot` utility                                                                   | The `foreground-faint` feed marker DESIGN.md describes for human entries        |
| `data-numeric` and `data-code` cell attributes                                           | Right-aligned tabular and mono table cells without per-cell classes             |
| `--chart-2` dark value `#4d7cc4`                                                         | Appendix B leaves the dark chart-2 undefined                                    |

## Contrast table

Computed from the token file. Dark values in parentheses.

| Pair                                        | Light | Dark |
| ------------------------------------------- | ----- | ---- |
| foreground on surface                       | 16.4  | 14.2 |
| foreground on canvas                        | 15.1  | 15.5 |
| foreground-muted on surface                 | 6.3   | 8.5  |
| foreground-muted on surface-muted           | 6.1   | 7.9  |
| foreground-muted on canvas                  | 5.9   | 9.3  |
| foreground-subtle on surface                | 4.7   | 6.1  |
| foreground-subtle on surface-muted          | 4.6   | 5.6  |
| foreground-subtle on canvas                 | 4.4   | 6.6  |
| primary link on surface                     | 5.8   | 6.8  |
| primary-hover on primary-wash               | 7.2   | 7.7  |
| on-primary on primary                       | 5.8   | 7.4  |
| agent-ink on surface                        | 5.1   | 10.4 |
| agent-ink on agent-wash                     | 4.8   | 9.3  |
| success text on surface                     | 5.1   | 6.7  |
| danger text on surface                      | 5.9   | 5.5  |
| switch off track on surface (non-text)      | 2.2   | 2.3  |
| agent dot with agent-ink outline (non-text) | 5.1   | 10.4 |

The tightest text pair is `foreground-subtle` on `surface-muted` at 4.56:1
light, after the one-step darkening. `foreground-subtle` on `canvas` is
4.36:1 and no shipped text uses that pair; it is open question 4. The switch
track is below 3:1 by the target's own value; open question 3.

## Prose rules and how each was verified

| Rule                                             | Verification                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blue only for interactive elements               | Grep of `text-primary`, `bg-primary*`, `border-primary*` outside `ui/`: every hit is a link, focus state, pressed toggle or active nav item. One non-link issue number found and returned to plain mono in Phase 4.                                                                                |
| Yellow only for agent authorship                 | Grep of `agent` tokens and `oc-agent-*`: activity feed rows and AI reasons, sessions, test bench results, AI input inspector, AI rule chip, classification node. No warning uses yellow; the old `.activity-decision-unknown`, warning toast border, published badge and switch on-state are gone. |
| Agent entries also name the actor                | Every agent mark sits next to "The Janitor" or "AI" text (`Feed.actorName`, `Feed.agentBadge`, the chip). Confirmed on `/repositories/701/activity`, `/sessions`, `/repositories/701/rules/r3`.                                                                                                    |
| `--primary` is blue                              | `--primary: var(--oc-blue)` in both themes; the primary button and focus ring render `#1e5fd0` (computed `--ring` read from the page).                                                                                                                                                             |
| Mono is a signal                                 | Repository names, branches, label names, issue and PR numbers, revisions, counts, timestamps, rule expressions and IDs are `font-mono`; policy names, descriptions, prompts, session titles, emails and help text are Inter. Checked screen by screen in the screenshots.                          |
| Tabular figures                                  | `table` and `[data-numeric]` set `tabular-nums` in the base layer; body sets `"cv05" 0, "ss01" 0`.                                                                                                                                                                                                 |
| No shadows except overlays                       | Grep for `shadow-` in app code returns only `shadow-none` and `shadow-overlay`; `--oc-overlay-shadow` is used by dialogs, sheets, menus, popovers, tooltips and toasts only.                                                                                                                       |
| No gradients, no blurred backdrops               | The wall image, noise, enamel and steel gradients are gone; the scrim is flat `--oc-scrim` with `backdrop-filter: none`.                                                                                                                                                                           |
| Density: 28px rows, 13px base                    | Body computes to 13px Inter; `Table.cell` rows are 28px; sidebar and section nav rows are 26px; rules table collapsed to one line per row.                                                                                                                                                         |
| Motion only on user-triggered state              | All transitions are 120ms `--ease-ui` on hover, focus, switch and disclosure; no entrance or scroll animations; `animate-pulse` removed; `tw-animate-css` removed. With `prefers-reduced-motion: reduce` the page reports transition durations of 0.01ms and zero running animations.              |
| Blueprint vocabulary only on graph views         | `oc-canvas`, `oc-node`, `oc-wire`, `oc-junction` and `oc-annotation` appear in `ui/blueprint.ts`, the rule editor and the design-system page only.                                                                                                                                                 |
| No `foreground-faint` for text                   | `text-ink-faint` appears nowhere in app code; the token backs the switch track and human feed dots only.                                                                                                                                                                                           |
| `border` for structure, `border-subtle` for rows | Cards, sidebar, top bar and inspector use `border-border`; table rows, feed items, list rows and inspector rows use `border-border-subtle`.                                                                                                                                                        |
| Sentence case, no tracked uppercase              | The uppercase `rule-step-title` and enamel sign are gone; grep for `uppercase` and `tracking-` in app code returns nothing.                                                                                                                                                                        |
| Everything left-aligned, numerics right-aligned  | Centered overview, connect, sessions and empty states were left-aligned; numeric columns use `data-numeric`.                                                                                                                                                                                       |
| Cards do not nest                                | Inspector sections, disclosures and result blocks use bordered sections inside the column, not cards inside cards.                                                                                                                                                                                 |
| Empty and error states                           | One sentence plus at most one button in `emptyPanel`; errors carry `role="alert"` and say what to do; no illustrations inside working panels.                                                                                                                                                      |
| Help text under labels, not tooltips             | `input`, `textarea` and `Select.view` render descriptions below the control; the sync tooltip is the only tooltip and it existed before.                                                                                                                                                           |
| Focus visible everywhere                         | Tabbed through the rules table, the AI rule editor and the activity feed: every stop reports a 2px solid `#1e5fd0` outline, including the code editor host via `focus-within`.                                                                                                                     |
| Button labels are outcome verbs                  | "New rule", "Run as a test", "Disconnect repository", "Delete rule", "Grant access on GitHub", "Refresh repositories". "Cancel" and "Save & publish" were left as they were because tests and copy depend on them.                                                                                 |
| Dark mode ships                                  | Semantic tokens re-declared inside `.dark` so nested containers resolve; every route screenshot at 1440 dark.                                                                                                                                                                                      |

## Verification results

- `pnpm exec vp build` (web), `pnpm exec vp check` (0 errors, 510 warnings,
  all pre-existing categories) and `pnpm exec vp test apps/web` (215 passed)
  at `30e6de4`.
- `npx @google/design.md lint docs/design/DESIGN.md`: 0 errors, 2 warnings
  left. Both are `node-hover` and `node-agent`, whose `textColor` is a border
  colour; the lint schema has no border key, so the warnings cannot be
  satisfied without misdescribing the component.
- Hardcoded values outside `styles.css`: 4. The manifest `theme_color` and
  `background_color` and the two `theme-color` meta tags cannot reference CSS
  variables. GitHub label colours are interpolated from label records into a
  6px dot style, which is user data, not a design value.
- Arbitrary values in class strings: 3, all `transition-[left,right,width]`
  style property lists in `ui/sidebar.ts`, which select properties rather than
  set values.
- Screenshots: 76 captures in
  `~/.t3/userdata/attachments/ops-console/shots/final/` covering 19 routes at
  1440 light, 1440 dark, 768 and 390. Reviewed: design-system, rules, rule
  editor (policy and AI), activity (both modes, expanded), policies, sessions,
  account, connect, settings, overview, and the dark and 390 captures of the
  rule editor and activity.
- Adding a shadcn component is not possible here (no React, no shadcn). The
  equivalent check was rendering tabs, which no screen uses, from raw
  `data-slot` markup on `/design-system`; they take the active underline,
  hover and focus styling from the theme file alone.

## Tests changed

- `workspace.test.ts`: label badge helper renamed to `labelDotStyle`, which
  returns only the dot colour.
- `repository-switcher.test.ts`: expects `border` instead of `border-2`.
- `sessions.test.ts`: recovery summary and its "Retrying past" line are now
  two elements; expectations split.
- `repository-connections.test.ts`: repository name and status are separate
  elements; expectations split.

## What was not finished or not right

- The three screen-conversion agents were cut off mid-work by a session
  limit; their partial edits were completed by hand and every screen was
  checked, but `activity.ts`, `policy-editor.ts`, `sessions.ts`,
  `repository-connections.ts` and `account.ts` deserve a human read for copy
  that drifted (two labels were restored).
- The rule editor's "no match" wire label sits close to the "match" label on
  short graphs.
- The policy inspector and rule inspector stack below 1240px instead of
  becoming a slide-over (open question 7). The sidebar drawer switches at
  768px rather than 820px (open question 6).
- CodeMirror syntax colours are still the GitHub theme (open question 1).
- The rules table dropped the second line (policy description) per row to hit
  28px; the description is in the row's `title` and in the rule editor.
- The Utility Room memory of the settings mockups server was deleted along
  with the mockups.
- The local dev server needed `index.html` to reference `/src/entry.ts`
  absolutely; the relative path broke nested routes in Vite dev. Production
  output was unaffected, but the change is in the diff.

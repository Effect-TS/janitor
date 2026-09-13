# Phase 3 brief: converting screens to the Ops Console identity

Read `docs/design/DESIGN.md` (the normative identity) and `RESTYLE-AUDIT.md`
section 5 (agent-authorship inventory) before touching code. The theme lives in
`apps/web/src/styles.css`; the styled primitives live in
`apps/web/src/components/ui/`. The `/design-system` page
(`apps/web/src/components/design-system.ts`) shows how every primitive is
meant to be used; read it for idioms.

## What you are doing

Restyling screens. Behaviour, routes, data flow, messages, models, copy and
information architecture do not change. Only class strings, wrapper markup
needed for styling, and the primitives a view calls change. Do not rename
features, do not add screens, do not refactor state.

Button verbs are the one copy exception: labels are sentence-case verbs naming
the outcome ("New rule", "Run all as a test", "Disconnect repository"). Fix a
label only if it violates that.

## Hard rules (the report will grep for violations)

1. No hex, `rgb()`, `hsl()`, `oklch()`, or named colours anywhere in `.ts`.
   The only exception is GitHub label colours, which are user data and are
   passed as a style value from the label record (see rule 8).
2. No Tailwind arbitrary values: `text-[11px]`, `w-[200px]`, `bg-[#...]`,
   `shadow-[...]`, `grid-cols-[...]`, `translate-[...]` are all failures. Use
   the scale. If you genuinely need a dimension that has no utility, put it in
   `styles.css` under a `data-slot` selector in the `@layer components` block,
   not in the class string.
3. No stock Tailwind palette colours (`emerald-*`, `amber-*`, `black/40`,
   `gray-*`). Use the semantic tokens below.
4. No shadows except on overlays (`shadow-overlay`). No `shadow-md`,
   `shadow-lg`, `shadow-xl`, `shadow-edge`, `shadow-mount`. No gradients. No
   `animate-pulse`, `animate-in`, hover lifts, `rotate-*` on layout.
   `animate-spin` on an in-progress icon is acceptable because the user
   triggered the action.
5. No 2px or 3px borders except: the 2px `primary` left edge on a selected
   row or active nav item, the 3px `agent` left edge (`oc-agent-edge`), the
   2px `primary` bottom edge on an active tab.
6. Delete the old alias utilities from the files you own: `bg-cobalt*`,
   `text-cobalt*`, `border-cobalt*`, `navy*`, `cream*`, `rust*`,
   `yellow-safety*`, `outline` (as a colour), `metal*`, `wall`, `mortar`,
   `board`, `panel`, `inset`, `shadow-edge`, `shadow-mount`, `shadow-recess`,
   `font-sign`, `text-sign`, `text-stamp`, `text-display`, `text-button`,
   `rounded-lg`, `rounded-xl`, `jn-*`. Replace them with target tokens.
7. Blue means interactive only: links, buttons, focus, selected rows, active
   tabs, switch on-state. Never a heading, an icon on static content, a status
   pill or a decorative fill.
8. Yellow means The Janitor did it, and nothing else. Use `oc-agent-dot`,
   `oc-agent-edge`, `oc-agent-badge`, `Feed.agentBadge`, `Feed.item` with
   `actor: { kind: "agent" }`, `chip` variant `agent`, `Blueprint.node`
   `isAgent`. Always pair the mark with the words "The Janitor" or "AI" so the
   information survives greyscale. Never use yellow for warnings. There is no
   warning colour. A warning becomes neutral text with a Lucide icon; a real
   failure is `text-destructive`; a genuine success is `text-success`.
9. Mono is a signal: values from GitHub or the machine are `font-mono`:
   repository names, branches, SHAs, issue and PR numbers, label names, rule
   expressions, run and test IDs, event names, durations, counts, timestamps.
   Prose a human wrote is Inter. Numeric table columns are right-aligned with
   `tabular-nums` (the `Table.cell` helper's `numeric` option does this).
10. Density: table rows 28px (`Table.*` helpers), list rows 26 to 28px, base
    text 13px (`text-body-md`), secondary 12px (`text-body-sm`), column heads
    and eyebrow labels 11px (`text-caption` in `text-ink-subtle`). No
    uppercase tracked labels. Do not loosen this to "improve legibility".
11. Cards do not nest. A card is `panel` (`ui/panel.ts`); its optional header
    is `panelHeader`. Regions are separated by `border-border`; rows inside a
    region by `border-border-subtle`. No zebra striping.
12. Empty states: one sentence naming the next action plus at most one button,
    inside `emptyPanel`. No icons or illustrations inside working panels.
    Errors say what happened and what to do, never apologize, and carry
    `role="alert"` with `text-destructive` on the title only.
13. Loading states are text ("Loading sessions…") or static `skeleton`
    blocks. Never a shimmer.
14. Keep every ARIA attribute, `role`, `aria-current`, `aria-selected`,
    `aria-busy`, `sr-only` text and focus behaviour that exists today. Colour
    is never the only carrier of state.
15. Icons come from `Icon.view(h, LucideIcon)` at the default size; do not
    pass `size-4` or larger unless it is the single icon in an empty state.
16. `text-ink-faint` is never used for text.

## Token cheat sheet

Backgrounds: `bg-background` (page canvas), `bg-card` (surfaces),
`bg-surface-muted` (card headers, input fills, row hover), `bg-primary-wash`
(selected row, active nav), `bg-agent-wash` (agent annotation only),
`bg-popover` (overlays).

Text: `text-foreground`, `text-ink-muted` (secondary prose, help text),
`text-ink-subtle` (column heads, timestamps, metadata; alias
`text-muted-foreground` is the same value), `text-primary` (links only),
`text-agent-ink` (agent actor names only), `text-destructive`,
`text-success`.

Borders: `border-border` (structure), `border-border-subtle` (rows),
`border-primary-line` (hovered node), `border-agent-line` (agent annotation),
`border-destructive`.

Sizes: `text-h1` `text-h2` `text-h3` `text-body-md` `text-body-sm`
`text-label` `text-caption` `text-mono-md` `text-mono-sm` `text-mono-xs`
`text-numeral`. Radii: `rounded-xs` (badges, nodes), `rounded-sm`
(everything structural), `rounded-md` (sheets only), `rounded-full` (dots,
switch, junction chips). Motion: `transition-colors duration-120 ease-ui`.
Layout tokens: `w-sidebar` (216px), `w-inspector` (292px), `h-app-bar` (46px).

Primitives: `Button.view` (variants `default` = blue primary, `secondary` =
plain surface, `destructive`, `ghost`, `link`; sizes `xs` `sm` default `lg`
`icon*`), `input`, `textarea`, `Select.view`, `Switch.view`, `chip`
(variants `neutral` `selected` `success` `danger` `agent`), `panel`,
`panelHeader`, `emptyPanel`, `sign` (section h2), `rack` (section nav),
`Table.*`, `Feed.item`, `Feed.agentBadge`, `Inspector.*`, `Dialog.view`
(modal chrome) with `@foldkit/ui/dialog`, `Overlay.*` class strings for
menus, popovers, tooltips and toasts, `Blueprint.*` (graph views only:
rule editor, nowhere else), `skeleton`.

## GitHub label colours

The product owner keeps GitHub's label colours, muted. Render a label as a
`chip` whose first child is a 6px dot carrying the colour:

```ts
h.span(
  [h.Class("size-1.5 rounded-full"), h.Style({ backgroundColor: `#${color}` }), h.AriaHidden(true)],
  [],
)
```

Keep the existing hex validation guard before interpolating. Never fill the
whole badge with the colour and never colour the text.

## Page CSS

`styles.css` still carries `.policy-*`, `.rule-*`, `.rules-*`, `.activity-*`,
`.ai-*` and `.repository-*` rules from the old identity below the line
"Page CSS carried over from the previous identity". When you restyle a screen,
prefer moving its styling into Tailwind utilities on the elements, then delete
the CSS rules that are no longer referenced. You may edit only the CSS block
for the screens you own, with small targeted edits, because other agents are
editing other blocks of the same file at the same time. Read the file
immediately before each edit. Layout rules (grids, breakpoints, scroll
containers, sticky panes) may stay in CSS if that is simpler, but their
values must use tokens: `var(--border)`, `var(--oc-surface-muted)`, the
`--text-*` sizes, `var(--radius-sm)`, `var(--spacing-inspector)`. Breakpoints
are 1240px (inspector collapses) and 820px (sidebar becomes a drawer).

## Verification before you report

- `cd apps/web && pnpm exec vp build` succeeds.
- From the repo root, `pnpm exec vp check --fix` then `pnpm exec vp check`
  reports 0 errors.
- `pnpm exec vp test apps/web` passes. If a test asserted on a class name or
  markup that legitimately changed, update the test and say so.
- Grep your files for the strings in rules 1 to 6 and report zero hits, or
  list each remaining hit with a reason.
- Screenshot each screen you converted at 1440px and 390px in light and dark
  and look at them. A dev server is on http://localhost:1337 backed by a mock
  API (routes: `/repositories/701` and its `/policies`, `/policies/p1`,
  `/policies/p2`, `/policies/p3`, `/rules`, `/rules/new`, `/rules/r1`,
  `/rules/r3` (AI rule), `/activity`, `/settings`; `/sessions`,
  `/sessions/ses-working`, `/sessions/ses-blocked`; `/account`,
  `/account/you`, `/account/team`; `/repositories/connect`; `/`). Capture with:

  ```
  SHOT_TMP=/home/maxwellbrown/.t3/userdata/attachments/ops-console/tmp \
  node .scratch/ops-console-restyle/shot.mjs http://localhost:1337/<route> \
    /home/maxwellbrown/.t3/userdata/attachments/ops-console/shots/<name>.png \
    [--width 390] [--dark] [--eval "window.scrollTo(0,800)" --settle 500]
  ```

  Write screenshots only under that attachments directory, never under
  `/tmp` (the root filesystem is nearly full).

Report: the files you changed, every CSS rule you deleted, every test you
touched, every place you marked agent authorship, anything from DESIGN.md you
could not satisfy and why, and the screenshot paths.

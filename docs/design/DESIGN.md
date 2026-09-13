---
version: alpha
name: Ops Console
description: >-
  The visual identity for The Janitor — a control plane for GitHub auto-labeling
  rules and agent-assisted pull requests. A dense, neutral operations console
  with a schematic blueprint canvas for rule graphs. Blue means interactive.
  Yellow means the agent did it. Nothing else is colored.

colors:
  primary: "#1E5FD0"
  primary-hover: "#174CA8"
  primary-wash: "#EDF3FD"
  primary-line: "#B9CDF0"
  on-primary: "#FFFFFF"

  agent: "#FFCE1B"
  agent-ink: "#8A6A05"
  agent-wash: "#FFF8E0"
  agent-line: "#F0DFA0"
  on-agent: "#1B2027"

  canvas: "#F4F6F8"
  surface: "#FFFFFF"
  surface-muted: "#FAFBFC"

  foreground: "#1B2027"
  foreground-muted: "#59606B"
  foreground-subtle: "#6C747F"
  foreground-faint: "#A8AFB9"

  border: "#D6DBE1"
  border-subtle: "#E8EBEF"
  wire: "#A9BCDC"
  grid-line: "rgb(30 95 208 / 0.055)"

  success: "#1A7F37"
  on-success: "#FFFFFF"
  danger: "#B23A2B"
  danger-hover: "#8E2C20"
  on-danger: "#FFFFFF"

typography:
  h1:
    fontFamily: Inter
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em
  h2:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 600
    lineHeight: 1.35
  h3:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: 600
    lineHeight: 1.4
  body-md:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.45
  body-sm:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: Inter
    fontSize: 0.78125rem
    fontWeight: 500
    lineHeight: 1.4
  button:
    fontFamily: Inter
    fontSize: 0.78125rem
    fontWeight: 500
    lineHeight: 1.2
  caption:
    fontFamily: Inter
    fontSize: 0.6875rem
    fontWeight: 500
    lineHeight: 1.35
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 0.78125rem
    fontWeight: 400
    lineHeight: 1.4
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 0.71875rem
    fontWeight: 400
    lineHeight: 1.35
  mono-xs:
    fontFamily: JetBrains Mono
    fontSize: 0.65625rem
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0.01em
  numeral:
    fontFamily: JetBrains Mono
    fontSize: 0.71875rem
    fontWeight: 500
    lineHeight: 1.3
    fontFeature: "tnum"

rounded:
  none: 0px
  xs: 3px
  sm: 5px
  md: 8px
  full: 9999px

spacing:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  2xl: 24px
  3xl: 40px

components:
  app-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    height: 46px
    padding: 14px
  sidebar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    width: 216px
    padding: 12px
  sidebar-item:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-sm}"
    padding: 14px
    height: 26px
  sidebar-item-active:
    backgroundColor: "{colors.primary-wash}"
    textColor: "{colors.foreground}"
  sidebar-section-label:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-subtle}"
    typography: "{typography.caption}"

  page-title:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.foreground}"
    typography: "{typography.h1}"
  page-lede:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.body-sm}"

  tab:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.body-md}"
    padding: 11px
  tab-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.foreground}"

  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: 11px
    height: 28px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: 11px
    height: 28px
  button-default-hover:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
  button-danger-hover:
    backgroundColor: "{colors.danger-hover}"
    textColor: "{colors.on-danger}"

  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
  card-header:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.h3}"
    padding: 12px

  table-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-subtle}"
    typography: "{typography.caption}"
    padding: 12px
  table-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    padding: 12px
    height: 28px
  table-row-hover:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground}"
  table-row-selected:
    backgroundColor: "{colors.primary-wash}"
    textColor: "{colors.foreground}"
  table-cell-code:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.mono-sm}"
  table-cell-numeric:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.numeral}"

  input:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: 9px
    height: 28px
  input-placeholder:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground-subtle}"
  switch-off:
    backgroundColor: "{colors.foreground-faint}"
    rounded: "{rounded.full}"
    width: 26px
    height: 15px
  switch-on:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"

  badge:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.mono-xs}"
    rounded: "{rounded.xs}"
    padding: 5px
  badge-selected:
    backgroundColor: "{colors.primary-wash}"
    textColor: "{colors.primary-hover}"
    rounded: "{rounded.full}"
  badge-success:
    backgroundColor: "{colors.success}"
    textColor: "{colors.on-success}"
  badge-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"

  agent-badge:
    backgroundColor: "{colors.agent-wash}"
    textColor: "{colors.agent-ink}"
    typography: "{typography.mono-xs}"
    rounded: "{rounded.xs}"
    padding: 5px
  agent-marker:
    backgroundColor: "{colors.agent}"
    textColor: "{colors.on-agent}"
    rounded: "{rounded.full}"
    size: 7px
  feed-item:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    padding: 12px
  feed-item-agent:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.agent-ink}"
    typography: "{typography.label}"
  feed-timestamp:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-subtle}"
    typography: "{typography.mono-xs}"

  canvas:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
  canvas-grid:
    backgroundColor: "{colors.grid-line}"
    size: 22px
  canvas-wire:
    backgroundColor: "{colors.wire}"
    size: 1.25px
  canvas-column-label:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-subtle}"
    typography: "{typography.caption}"
  node:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.xs}"
    padding: 9px
  node-hover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary-line}"
  node-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
  node-agent:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.agent}"
  node-kind:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-subtle}"
    typography: "{typography.caption}"
  junction-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: 7px
  annotation:
    backgroundColor: "{colors.agent-wash}"
    textColor: "{colors.agent-ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xs}"
    padding: 9px
  annotation-leader:
    backgroundColor: "{colors.agent-line}"

  inspector:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    width: 292px
    padding: 14px
  inspector-key:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.body-sm}"
  inspector-value:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.mono-sm}"

  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  divider-subtle:
    backgroundColor: "{colors.border-subtle}"
    height: 1px
  link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
  focus-ring:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
---

## Overview

**Ops Console with a Blueprint canvas.** The Janitor is a tool an engineer opens
when something needs attention, often at the start of the day and often on a
second monitor next to GitHub. The interface is built to disappear: neutral,
dense, hairline-ruled, and fast to scan.

It has exactly one deliberate exception. Auto-labeling rules and agent-assisted
pull requests are fundamentally _graphs_ — a trigger, branching conditions, a
sequence of actions. Those render on a schematic canvas with a faint grid,
orthogonal connectors, and node boxes, borrowing the vocabulary of a printed
plan. The shift in register is the point: you can tell at a glance whether you
are reading a list or reading a diagram.

Two rules govern everything else.

**Blue means you can interact with it.** Links, buttons, focus rings, selected
rows, active tabs. Never a heading, never an icon on static content, never a
decorative fill.

**Yellow means The Janitor did it.** Agent-authored comments, commits the agent
pushed, runs it performed, prose it wrote. One meaning, no exceptions — which is
why there is no warning color in this system. Adding one would destroy the
signal that makes an activity feed readable at a glance.

Everything else is grey. If a screen has a third accent on it, something has
gone wrong.

The product's mascot does not appear anywhere in the application interface. He
belongs on the login screen, in onboarding, and on the marketing site.

## Colors

**Blue — `primary` `#1E5FD0`.** Interactive affordance, and only that. Four
supporting values: `primary-hover` `#174CA8` for hover and for blue text on
white where the extra contrast helps, `primary-wash` `#EDF3FD` for selected rows
and active navigation, `primary-line` `#B9CDF0` for the border of a hovered
node, and `on-primary` white for text on a filled blue button.

**Yellow — `agent` `#FFCE1B`.** Reserved entirely for marking work the agent
performed. It appears as small markers and left borders, never as a large fill.
Yellow is never a text color: use `agent-ink` `#8A6A05` for agent-attributed
text, which clears AA on white at 5.1:1. `agent-wash` `#FFF8E0` backs annotation
callouts and agent badges; `agent-line` `#F0DFA0` is their dashed border.

**Greys.** `canvas` `#F4F6F8` is the page behind cards. `surface` white is every
card, table, and panel. `surface-muted` `#FAFBFC` is card headers, input fills,
and row hover. Text runs `foreground` `#1B2027` for content, `foreground-muted`
`#59606B` for secondary text, and `foreground-subtle` `#6C747F` for column
headers, timestamps, and metadata.

`foreground-faint` `#A8AFB9` is **not a text color**. It is for non-text marks
only: switch tracks in the off position, disabled dots, chart gridlines. Using
it for text will fail contrast.

**Borders.** `border` `#D6DBE1` separates structural regions — card edges,
sidebar, top bar, table head. `border-subtle` `#E8EBEF` separates rows within a
list. Getting this distinction right is most of what makes a dense table
readable.

**Blueprint.** `wire` `#A9BCDC` is the connector stroke, and `grid-line` at
5.5% blue is the canvas grid. Both are structural, never text.

**Status.** `success` `#1A7F37` and `danger` `#B23A2B` only. Neither is used for
emphasis, only for genuine state.

Every foreground/background pair in `components` clears WCAG AA. The tightest is
`foreground-subtle` on `surface-muted` at 4.5:1 — do not lighten either one.

## Typography

**Inter** for everything a person reads or clicks. **JetBrains Mono** for
machine truth.

The mono rule is load-bearing. If a value came out of GitHub rather than out of
a person, it is mono: repository names, branch names, commit SHAs, issue and PR
numbers, label names, rule expressions, run IDs, event names, durations, and
counts. Prose a human wrote is Inter. This distinction is what lets someone scan
an activity feed without reading it word by word, and it is more important than
any color decision in this system.

Enable tabular figures (`font-feature-settings: "tnum"`) on every numeric
column. Ragged digits in a table of run counts are the fastest way to make this
identity look amateur.

Base size is 13px, not 16px. This is an operational tool where a table of two
hundred rows is a normal Tuesday. The scale below is tight on purpose; do not
loosen it in the name of legibility.

| Token     | Size   | Use                                                    |
| --------- | ------ | ------------------------------------------------------ |
| `h1`      | 18px   | Page title, one per screen                             |
| `h2`      | 14px   | Section headings                                       |
| `h3`      | 13px   | Card headers, row titles                               |
| `body-md` | 13px   | Default                                                |
| `label`   | 12.5px | Form labels, button text, emphasized feed actors       |
| `body-sm` | 12px   | Help text, secondary detail                            |
| `caption` | 11px   | Column heads, sidebar section labels, node kind labels |
| `mono-md` | 12.5px | Breadcrumbs, primary machine values                    |
| `mono-sm` | 11.5px | Machine values in tables and nodes                     |
| `mono-xs` | 10.5px | Badges, timestamps, run IDs                            |
| `numeral` | 11.5px | Numeric table columns, tabular                         |

Sentence case throughout. No tracked-out uppercase eyebrow labels above
headings. Body copy caps at 66 characters. Help text sits under its label at
`foreground-muted`, never in a tooltip.

## Layout

A three-column shell: a 216px sidebar, a fluid main column, and a 292px
inspector that collapses below 1240px. The sidebar and inspector are sticky and
scroll independently. Main content sits at 16–20px padding, which is tighter
than a marketing site and correct for this one.

```
┌────────────────────────────────────────────────────────────┐
│ mark  org / repo / section        [search]  status  avatar │ 46px
├────────┬─────────────────────────────────────┬─────────────┤
│ repos  │ Page title           [action][action]│ Inspector   │
│  · a   │ ─ tabs ────────────────────────────  │             │
│  · b   │ ┌─────────────────────────────────┐  │ selection   │
│        │ │ card header                     │  │ details     │
│ workspc│ │ dense table rows                │  │             │
│  · runs│ └─────────────────────────────────┘  │ dry run     │
│  · PRs │ ┌─────────────────────────────────┐  │             │
│        │ │ ▚ blueprint canvas ▚            │  │ history     │
│        │ └─────────────────────────────────┘  │             │
└────────┴─────────────────────────────────────┴─────────────┘
```

Everything is left-aligned. Numeric table columns are right-aligned. Nothing is
centered.

Cards stack with 18px between them and have no outer margin — the canvas colour
behind them provides the separation.

**Breakpoints.** Below 1240px the inspector becomes a slide-over triggered from
the selection. Below 820px the sidebar becomes a drawer. The blueprint canvas
never reflows; it scrolls horizontally inside its card at all widths, because a
graph that rewraps is a graph you can't read.

**Density.** Table rows are 28px with `border-subtle` dividers. Do not add
zebra striping — hover and selection are the row affordances. Lists longer than
about fifty rows should virtualize rather than paginate.

## Elevation & Depth

There is almost no elevation in this system. Separation is achieved with 1px
hairlines and background-colour shifts, not with shadow.

- **Structural regions** — cards, sidebar, top bar, inspector: `1px solid
border`, `rounded.sm`, no shadow.
- **Rows within a region**: `1px solid border-subtle` on the bottom edge, none
  on the last child.
- **Overlays** — dialogs, popovers, dropdowns, tooltips: the only shadowed
  elements, and only enough to lift them off the page:
  `0 6px 16px rgb(27 32 39 / 0.12), 0 0 0 1px var(--border)`.
- **Everything else**: flat.

No gradients. No blurred backdrops. The dialog overlay is a flat scrim at
`rgb(27 32 39 / 0.45)` with no `backdrop-filter`.

**Motion.** 120ms `ease-out`, applied only to state changes the user caused:
hover background, focus ring, switch travel, disclosure expansion, slide-over
entry. No entrance animations, no scroll-triggered reveals, no skeleton shimmer
(use a static `surface-muted` block). `prefers-reduced-motion: reduce` disables
transitions entirely.

## Shapes

Radii are small and used consistently.

- `xs` 3px — badges, blueprint nodes, annotation boxes
- `sm` 5px — buttons, inputs, cards, dialogs, everything structural
- `md` 8px — slide-overs and full-screen sheets only
- `full` — status dots, agent markers, switch tracks, junction chips

Nothing is rotated. Nothing is skewed. Icons are 14px stroke icons at 1.5px
weight, inheriting `currentColor`, aligned to the text baseline.

**Blueprint canvas specifics.** The grid is a 22px square lattice of 1px
`grid-line` rules. Connectors are 1.25px `wire` strokes, orthogonal only —
horizontal and vertical segments with square corners, never curves or diagonals.
Junction points are 2.6px filled circles. Nodes are `surface` boxes with a 1px
`border`, `rounded.xs`, and a `caption` kind label above a `mono-sm` expression.
A selected node takes a `primary` border and a 2px `primary-wash` ring; an
agent-authored node takes a 3px `agent` left border.

Annotations are dashed `agent-line` boxes on `agent-wash`, attached to a node by
a 1.25px dashed leader. They carry information the graph itself cannot express.
Use them sparingly — more than two on a canvas and they stop being annotations.

## Components

### Top bar

46px, `surface`, 1px bottom border. A small product mark, then a breadcrumb in
`mono-md` where each ancestor is a link and the current segment is plain and
semibold. Right side: a compact search input, a status pill, and an avatar. The
status pill uses an `agent` dot when the agent is actively running.

### Sidebar

`caption` section labels in `foreground-subtle`, 26px item rows in `body-sm`.
The active item takes `primary-wash` with a 2px `primary` left border and
`aria-current="page"`. Repository names are mono; workspace destinations are
not. Counts sit right-aligned in `mono-xs` at `foreground-subtle`.

### Tabs

Text buttons with a 2px `primary` bottom border when active, sitting on the
region's bottom hairline. No pill backgrounds, no boxes.

### Card

`surface`, 1px border, `rounded.sm`. An optional header strip in `surface-muted`
carrying an `h3` title, a `mono-sm` metadata string, and right-aligned actions.
Cards do not nest.

### Dense table

28px rows, `caption` column heads in `foreground-subtle`, `border-subtle` row
dividers. Machine values in mono, numeric columns right-aligned and tabular.
Row hover is `surface-muted`; row selection is `primary-wash` with a 2px
`primary` inset left edge and `aria-selected`. Inline controls inside rows are
small — a 26×15 switch, a 24px icon button — and must stop event propagation so
they don't trigger row selection.

### Blueprint canvas

Described in Shapes. Also: the canvas scrolls horizontally inside its card and
carries a footer bar in `surface-muted` with zoom controls on the left, a plain
summary in the middle, and machine counts in mono on the right. Column labels
("When", "If every condition matches", "Then") sit above the first node of each
column in `caption`, sentence case.

Node layout must come from a layout engine, not hardcoded coordinates. Cap the
visual builder at the graph complexity it can lay out legibly and fall back to a
YAML editor beyond that, with an explicit affordance to switch.

### Activity feed

Each entry is a 7px marker dot, a body line, and a right-aligned `mono-xs`
timestamp. Agent entries take the `agent` marker and an `agent-ink` actor name;
human entries take a `foreground-faint` marker and a plain semibold actor name.
Issue and PR references are mono links. Label names are badges.

Because the yellow/grey distinction is the whole point of this component, it
must not be the only carrier: agent entries also name "The Janitor" as the
actor, so the information survives greyscale and screen readers.

### Inspector

A stack of bordered sections, each with a `caption` heading. Configuration is
rendered as key/value rows: key in `body-sm` at `foreground-muted` in a fixed
88px column, value in `mono-sm`. Reflects the current selection, and shows a
plain instruction rather than a blank panel when nothing is selected.

### Buttons

Three variants, 28px tall, `rounded.sm`, `label` typography. Default is
`surface` with a 1px border. Primary is filled `primary`. Danger is filled
`danger`, used only for irreversible actions. No shadows, no press travel — the
only feedback is the background change.

Labels are sentence-case verbs naming the outcome: "New rule", "Run all as a
test", "Disconnect repository". The verb persists through the flow, so a button
reading "Pause" produces a toast reading "Paused", not "Success".

### Empty and error states

A single sentence in the interface's voice naming the next action, plus one
button. No illustrations inside working panels. Errors say what happened and
what to do, and never apologize.

## Do's and Don'ts

**Do** keep blue for interactive elements and yellow for agent authorship. Two
accents, two meanings.

**Do** set every value that came from GitHub in mono, and every value a human
wrote in Inter.

**Do** enable tabular figures on numeric columns.

**Do** use `border` for structure and `border-subtle` for rows within a
structure. The distinction is most of the visual system.

**Do** pair semantic color with text or an icon so state survives greyscale and
screen readers.

**Don't** add a third accent color. There is no warning yellow, no info blue, no
purple for anything. If something needs emphasis, use weight or position.

**Don't** use `agent` yellow as a text color, a large fill, or a status. It is a
small mark and a left border.

**Don't** use `foreground-faint` for text. It is for non-text marks only.

**Don't** add soft drop shadows to cards, rows, or buttons. Overlays are the
only shadowed elements in the system.

**Don't** let the blueprint vocabulary — grid backgrounds, node boxes, connector
lines — appear on ordinary pages. It marks graph views specifically.

**Don't** animate anything the user did not trigger, and don't use shimmer
skeletons.

**Don't** loosen the density to improve legibility. Fix contrast or hierarchy
instead; the row height is calibrated for long tables.

**Don't** put the product mascot anywhere in the application interface.

**Don't** use zebra striping, vertical table rules, or full-width horizontal
rules between form fields.

## Project notes

These sections record decisions specific to this codebase that the identity
above does not cover. They were agreed during the Ops Console restyle and are
normative for this repository.

### Mascot

The product owner keeps the mascot mark in the top bar of the application. It
is the single exception to the rule above: a 28px mark at the far left of the
top bar, and nowhere else inside the app.

### GitHub label colors

Label names are mono badges. Because GitHub labels carry a colour chosen by the
repository's maintainers, that colour is user data, not a design token, and it
is the one value the interface renders that does not come from this file. It
appears as a muted tint: the label's colour as a 6px dot at the left of the
badge, never as a full fill and never as text.

### Blueprint host

The only graph view today is the labeling rule editor. Its three-step flow
(trigger, conditions, actions) renders on the blueprint canvas. Policies are
YAML documents and stay in the code editor.

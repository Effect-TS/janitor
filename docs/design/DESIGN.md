---
version: beta
name: Ops Console
description: >-
  The visual identity for The Janitor — a control plane for GitHub auto-labeling
  rules and agent-assisted pull requests. A dark-first operations console at a
  comfortable scale, with a schematic blueprint canvas for rule graphs. Ink
  means you can act. Blue means it goes somewhere. Yellow means the agent did
  it. Nothing else is colored.

colors:
  # Dark is the primary theme. Light values are listed in the Themes section.
  primary: "#6FA3F5"
  primary-hover: "#8FB9F8"
  primary-wash: "#16243C"
  primary-line: "#2F4A78"
  on-primary: "#0D1117"

  action: "#E4E9EF"
  action-hover: "#CBD3DC"
  on-action: "#0D1117"

  agent: "#FFCE1B"
  agent-ink: "#E8C65A"
  agent-wash: "#2A2413"
  agent-line: "#4D431F"
  on-agent: "#1B2027"

  canvas: "#0D1117"
  surface: "#151B23"
  surface-muted: "#1B222C"

  foreground: "#E4E9EF"
  foreground-muted: "#AEB7C2"
  foreground-subtle: "#909AA6"
  foreground-faint: "#4D5663"

  border: "#2B333E"
  border-subtle: "#222932"
  wire: "#46587A"
  grid-line: "rgb(122 165 240 / 0.13)"

  success: "#46B566"
  on-success: "#0D1117"
  danger: "#E0705F"
  danger-hover: "#EA8778"
  on-danger: "#0D1117"

typography:
  h1:
    fontFamily: Inter
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.02em
  h2:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: 600
    lineHeight: 1.4
  h3:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 600
    lineHeight: 1.45
  body-md:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 500
    lineHeight: 1.4
  button:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 500
    lineHeight: 1.2
  caption:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1.5
  mono-xs:
    fontFamily: JetBrains Mono
    fontSize: 0.6875rem
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.01em
  numeral:
    fontFamily: JetBrains Mono
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
    fontFeature: "tnum"

rounded:
  none: 0px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px

components:
  app-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    height: 52px
    padding: 20px
  sidebar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    width: 240px
    padding: 12px
  sidebar-rail:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    width: 56px
  sidebar-item:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    padding: 10px
    height: 36px
    rounded: "{rounded.md}"
  sidebar-item-active:
    backgroundColor: "{colors.primary-wash}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
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
    typography: "{typography.body-md}"

  tab:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.body-md}"
    padding: 10px
  tab-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"

  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 32px
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
    textColor: "{colors.on-action}"
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 32px
  button-default-hover:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 32px
  button-danger-hover:
    backgroundColor: "{colors.danger-hover}"
    textColor: "{colors.on-danger}"
  button-icon:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    size: 32px

  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: 16px
  card-header:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.h3}"
    padding: 16px
    height: 48px

  table-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-subtle}"
    typography: "{typography.caption}"
    padding: 12px
    height: 40px
  table-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    padding: 12px
    height: 40px
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
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 32px
  input-placeholder:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-subtle}"
  switch-off:
    backgroundColor: "{colors.foreground-faint}"
    rounded: "{rounded.full}"
    width: 36px
    height: 20px
  switch-on:
    backgroundColor: "{colors.success}"
    textColor: "{colors.on-success}"

  badge:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.xs}"
    padding: 8px
    height: 24px
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
    padding: 6px
    height: 20px
  agent-marker:
    backgroundColor: "{colors.agent}"
    textColor: "{colors.on-agent}"
    rounded: "{rounded.full}"
    size: 8px
  feed-item:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    padding: 16px
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
    padding: 24px
  canvas-grid:
    backgroundColor: "{colors.grid-line}"
    size: 24px
  canvas-wire:
    backgroundColor: "{colors.wire}"
    size: 1px
  canvas-column-label:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-subtle}"
    typography: "{typography.caption}"
  node:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.md}"
    padding: 12px
    width: 208px
  node-hover:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.primary-line}"
  node-selected:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.primary}"
  node-kind:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground-subtle}"
    typography: "{typography.caption}"
  junction-chip:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: 10px
    height: 24px
  annotation:
    backgroundColor: "{colors.agent-wash}"
    textColor: "{colors.agent-ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xs}"
    padding: 12px
  annotation-leader:
    backgroundColor: "{colors.agent-line}"

  inspector:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    width: 320px
    padding: 16px
  inspector-section:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: 12px
  inspector-key:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-muted}"
    typography: "{typography.body-md}"
    width: 96px
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
hairline-ruled, and fast to scan, at a scale that reads from arm's length.

It has exactly one deliberate exception. Auto-labeling rules are fundamentally
_graphs_: a trigger, branching conditions, a sequence of actions. Those render
on a schematic canvas with a faint grid, orthogonal connectors, and node boxes,
borrowing the vocabulary of a printed plan. The shift in register is the point:
you can tell at a glance whether you are reading a list or reading a diagram.

Three rules govern everything else.

**Ink means you can act.** The primary button on a page is the foreground
colour filled: white on dark, near-black on light. There is one per page.

**Blue means it goes somewhere.** Inline links, breadcrumb ancestors, focus
rings, and the selection wash behind an active navigation item or a selected
row. Never a button fill, never a heading, never an icon on static content.

**Yellow means The Janitor did it.** Agent-authored comments, commits the agent
pushed, runs it performed, rules it proposed. One meaning, no exceptions, which
is why there is no warning colour in this system. Adding one would destroy the
signal that makes an activity feed readable at a glance.

Everything else is grey. Green and red appear only as genuine state, and the
"on" position of a switch is green because a switch is state.

The product's mascot does not appear anywhere in the application interface. He
belongs on the login screen, in onboarding, and on the marketing site.

**Scale.** The values in this file follow the shadcn Nova preset: 14px body,
32px controls, 40px table rows, 16px card padding, 24px page padding. This
replaced a 13px, 28px system in September 2026 because it was too small to
read comfortably and too tight to scan. Do not reintroduce the tighter scale
in the name of density; no screen in this product has enough rows to need it.

## Themes

**Dark is the primary theme.** Every value in the frontmatter is the dark
value, and every screen is designed and reviewed in dark first. The dark
palette is blue-black, not neutral grey: the blue cast sits under the blue
links and yellow agent marks without competing with them.

Light is derived from the same structure. Its values:

| Token              | Light     | Token          | Light     |
| ------------------ | --------- | -------------- | --------- |
| `primary`          | `#1E5FD0` | `canvas`       | `#F4F6F8` |
| `primary-hover`    | `#174CA8` | `surface`      | `#FFFFFF` |
| `primary-wash`     | `#EDF3FD` | `surface-muted`| `#FAFBFC` |
| `primary-line`     | `#B9CDF0` | `foreground`   | `#1B2027` |
| `on-primary`       | `#FFFFFF` | `foreground-muted` | `#59606B` |
| `action`           | `#1B2027` | `foreground-subtle` | `#6C747F` |
| `action-hover`     | `#2C333D` | `foreground-faint` | `#A8AFB9` |
| `on-action`        | `#FFFFFF` | `border`       | `#D6DBE1` |
| `agent-ink`        | `#8A6A05` | `border-subtle`| `#E8EBEF` |
| `agent-wash`       | `#FFF8E0` | `wire`         | `#A9BCDC` |
| `agent-line`       | `#F0DFA0` | `grid-line`    | `rgb(30 95 208 / 0.07)` |
| `success`          | `#1A7F37` | `on-success`   | `#FFFFFF` |
| `danger`           | `#B23A2B` | `on-danger`    | `#FFFFFF` |
| `danger-hover`     | `#8E2C20` |                |           |

`agent` yellow `#FFCE1B` is the same in both themes.

Theme switches suppress transitions for one frame so the page snaps rather
than smears.

## Colors

**Ink — `action`.** The foreground colour used as a fill. It is the primary
button and nothing else. In dark it is off-white on near-black text; in light
it is near-black on white text.

**Blue — `primary`.** Wayfinding. `primary` is link text and the focus ring.
`primary-hover` is the hover colour for links. `primary-wash` is the fill
behind the active sidebar item and a selected table row. `primary-line` is the
border of a hovered blueprint node. Blue is never a button.

**Yellow — `agent`.** Reserved entirely for marking work the agent performed.
It appears as an 8px marker dot and as the background of the AI chip, never as
a large fill. Yellow is never a text colour: use `agent-ink` for agent
attributed text. `agent-wash` and `agent-line` back the AI chip and annotation
callouts.

**Greys.** `canvas` is the page behind cards. `surface` is every card, table,
sidebar and inspector. `surface-muted` is card headers, blueprint nodes, row
hover, and the search field. Text runs `foreground` for content,
`foreground-muted` for secondary text and help, and `foreground-subtle` for
column headers, timestamps, and metadata.

`foreground-faint` is **not a text colour**. It is for non-text marks only:
switch tracks in the off position, human actor dots, chart gridlines.

**Borders.** `border` separates structural regions: card edges, sidebar, top
bar, table head. `border-subtle` separates rows within a list. Getting this
distinction right is most of what makes a table readable.

**Blueprint.** `wire` is the connector stroke, and `grid-line` is the canvas
grid. Both are structural, never text.

**Status.** `success` and `danger` only. Neither is used for emphasis, only for
genuine state: outcome badges, the on position of a switch, delivery warnings,
the destructive button.

Every foreground/background pair in `components` clears WCAG AA in both
themes. The tightest is `foreground-subtle` on `surface-muted`; do not lighten
either one.

## Typography

**Inter** for everything a person reads or clicks. **JetBrains Mono** for
machine truth.

The mono rule: if a value came out of GitHub or out of a configuration file
rather than out of a person, it is mono. Repository names, branch names,
commit SHAs, issue and PR numbers, label names, policy and group names, rule
expressions, run IDs, event names, durations, and counts. Prose a human wrote
is Inter. This distinction is what lets someone scan an activity feed without
reading it word by word.

The one exception is the top bar breadcrumb. It is read as a sentence, so it
is Inter, with the current segment semibold.

Enable tabular figures (`font-feature-settings: "tnum"`) on every numeric
column.

Base size is 14px. The scale:

| Token     | Size | Use                                                    |
| --------- | ---- | ------------------------------------------------------ |
| `h1`      | 24px | Page title, one per screen                             |
| `h2`      | 16px | Section headings                                       |
| `h3`      | 14px | Card headers, row titles                               |
| `body-md` | 14px | Default                                                |
| `label`   | 14px | Form labels, button text, active navigation, actors    |
| `body-sm` | 13px | Help text, secondary detail                            |
| `caption` | 12px | Column heads, sidebar section labels, node kind labels |
| `mono-md` | 13px | Primary machine values, code blocks                    |
| `mono-sm` | 12px | Machine values in tables, badges, nodes                |
| `mono-xs` | 11px | Timestamps, counts in the sidebar, AI chip             |
| `numeral` | 12px | Numeric table columns, tabular                         |

Nothing is set below 11px. Sentence case throughout. No tracked-out uppercase
labels. Body copy caps at 64 characters. Help text sits under its control at
`foreground-muted`, never in a tooltip.

## Layout

A three-column shell: a 240px sidebar, a fluid main column, and a 320px
inspector. The sidebar and inspector are sticky and scroll independently. Main
content sits at 24px padding.

```
┌──────────────────────────────────────────────────────────────┐
│ mark  org / repo / section          [search]  status  avatar │ 52px
├──────────┬────────────────────────────────────┬──────────────┤
│ repo ▾   │ Page title              [act][act] │ Inspector    │
│          │ lede                               │              │
│ Repos    │ ─ tabs ──────────────────────────  │ selection    │
│  · a     │ ┌────────────────────────────────┐ │ details      │
│  · b     │ │ card header                    │ │              │
│          │ │ 40px table rows                │ │ dry run      │
│ Team     │ └────────────────────────────────┘ │              │
│  · runs  │ ┌────────────────────────────────┐ │ history      │
│          │ │ ▚ blueprint canvas ▚           │ │              │
│          │ └────────────────────────────────┘ │              │
└──────────┴────────────────────────────────────┴──────────────┘
```

**The rail.** Screens whose main column needs the width, today only the rule
editor, collapse the sidebar to a 56px icon rail: the product mark, the
repository monogram, and one icon per destination. The active destination
takes the same `primary-wash` fill as the full sidebar item.

Everything is left-aligned. Numeric table columns are right-aligned. Nothing
is centered.

Cards stack 24px apart and have no outer margin; the canvas colour behind them
provides the separation. Inside a card, 16px padding and 16px between groups.
Controls in a row sit 8px apart.

**Breakpoints.** Below 1240px the inspector stacks under the main column with
a top hairline, the same breakpoint the editors use. Below 820px the sidebar
becomes a drawer. The blueprint
canvas never reflows; it scrolls horizontally inside its card at all widths.

**Density.** Table rows are 40px with `border-subtle` dividers. Rows carrying
two lines of content, such as a session with its reason, grow to fit. No zebra
striping: hover and selection are the row affordances. Lists longer than about
fifty rows virtualize.

## Elevation & Depth

Separation is achieved with 1px hairlines and background-colour shifts, not
with shadow.

- **Structural regions**: cards, sidebar, top bar, inspector. `1px solid
  border`, `rounded.md`, no shadow.
- **Rows within a region**: `1px solid border-subtle` on the bottom edge, none
  on the last child.
- **Overlays**: dialogs, popovers, dropdowns, tooltips. The only shadowed
  elements: `0 6px 18px rgb(0 0 0 / 0.5), 0 0 0 1px var(--border)` in dark,
  `0 6px 16px rgb(27 32 39 / 0.12), 0 0 0 1px var(--border)` in light.
- **Everything else**: flat.

No gradients. No blurred backdrops. The dialog overlay is a flat scrim.

**Concentric radius.** When a rounded element sits inside another, the outer
radius equals the inner radius plus the padding between them. A `rounded.xs`
badge inside a 4px-padded `rounded.md` cell is right; two `rounded.md` boxes
nested with 8px between them are wrong.

**Motion.** 120ms `ease-out`, applied only to state changes the user caused:
hover background, focus ring, switch travel, disclosure expansion, slide-over
entry. Pressable elements scale to `0.96` while pressed, with
`transition-property: transform, background-color`; this is the press
feedback and the only transform in the system. No entrance animations, no
scroll-triggered reveals, no skeleton shimmer. `prefers-reduced-motion:
reduce` disables the press scale and all transitions.

## Shapes

Radii are small and used consistently.

- `xs` 4px: badges, chips, the AI chip
- `sm` 6px: inline controls inside a 40px row, the switch thumb's track inset
- `md` 8px: buttons, inputs, cards, blueprint nodes, sidebar items, inspector
  sections
- `lg` 12px: dialogs, slide-overs, sheets
- `full`: status dots, agent markers, switch tracks, junction chips, avatars

**No left-border accents.** Nothing in the interface is marked with a coloured
strip on its left edge: not the active sidebar item, not a selected row, not an
agent-authored node. Selection is a wash fill. Agent authorship is a chip.

Nothing is rotated. Nothing is skewed. Icons are 16px stroke icons at 1.5px
weight beside regular text and 2px beside semibold, inheriting `currentColor`.

**Blueprint canvas specifics.** The grid is a 24px square lattice of 1px
`grid-line` rules. Connectors are 1px `wire` strokes, orthogonal only, with
square corners. Junctions carrying a branch name ("gate", "match", "no match")
are `junction-chip` pills sitting on the wire. Nodes are `surface-muted` boxes
with a 1px `border`, `rounded.md`, 12px padding and a 208px default width; a
node that hosts a form, such as the classification node, may be wider. Each
carries a `caption` kind label above its content. A selected node takes a
`primary` border and a 2px `primary-wash` ring. An agent node carries the AI
chip at the right of its kind label.

Annotations are dashed `agent-line` boxes on `agent-wash`, attached to a node
by a 1px dashed leader. Use them sparingly.

## Components

### Top bar

52px, `surface`, 1px bottom border. The product mark, then an Inter breadcrumb
where each ancestor is a blue link and the current segment is semibold. The
owner links to the repository list, the repository to its overview, and a
section to its page; only a rule or policy name at the end is mono. Right
side: 32px icon buttons for sync and theme. A search field, an agent status
pill and an avatar belong here once they have something behind them; nothing
is drawn until it works.

### Sidebar

240px. A repository switcher card at the top: a monogram square, the owner in
`mono-xs` above the repository in `mono-md` semibold, a green status dot, and
a chevron. Below it, `caption` section labels and 36px item rows in `body-md`
with a 16px icon. The active item takes `primary-wash`, `label` weight and
`aria-current="page"`. Counts sit right-aligned in `mono-xs` at
`foreground-subtle`.

### Tabs

Text buttons with a 2px `primary` bottom border when active, sitting on the
region's bottom hairline. No pill backgrounds, no boxes.

### Card

`surface`, 1px border, `rounded.md`, 16px padding. An optional 48px header
strip in `surface-muted` carrying an `h3` title, a `mono-sm` metadata string,
and right-aligned actions or a search field. Cards do not nest.

### Table

40px rows, 40px `caption` column heads in `foreground-subtle`, `border-subtle`
row dividers, 12px cell padding. Machine values in mono, numeric columns
right-aligned and tabular. Row hover is `surface-muted`; row selection is
`primary-wash` with `aria-selected`. Inline controls inside rows are 32px
icon buttons and 36×20 switches, and must stop event propagation so they don't
trigger row selection. Cells that must not wrap, such as timestamps and usage
figures, say so; the row's one flexible column is the title.

### Blueprint canvas

Described in Shapes. The canvas scrolls horizontally inside its card and
carries a 40px footer bar in `surface-muted` with a plain summary on the left
and machine counts in mono on the right. Column labels ("When", "If every
condition matches", "Then") sit above the first node of each column in
`caption`, sentence case.

Node layout must come from a layout engine, not hardcoded coordinates. Cap the
visual builder at the graph complexity it can lay out legibly and fall back to
a YAML editor beyond that, with an explicit affordance to switch.

### Activity feed

Each entry is an 8px marker dot, a body line, and a right-aligned `mono-xs`
timestamp, at 12px vertical and 16px horizontal padding. Agent entries take
the `agent` marker and an `agent-ink` actor name in `label` weight; human
entries take a `foreground-faint` marker and a plain semibold actor name.
Issue and PR references are mono links. Label names are badges. Outcomes
("match", "applied", "superseded", "failed") are mono badges: `success` and
`danger` fills for real outcomes, `surface-muted` for neutral ones.

Grouped views nest runs under a 44px subject row; the expanded subject row
takes `primary-wash`, and its runs indent 32px.

Because the yellow/grey distinction is the whole point of this component, it
must not be the only carrier: agent entries also name "The Janitor" as the
actor, so the information survives greyscale and screen readers.

### Inspector

320px, 16px padding. A stack of `caption`-headed sections, each a bordered
`rounded.md` box with 12px padding. Configuration is rendered as key/value
rows: key in `body-md` at `foreground-muted` in a 96px column, value in
`mono-sm`. Reflects the current selection, and shows a plain instruction rather
than a blank panel when nothing is selected.

### Buttons

Three variants, 32px tall, `rounded.md`, 12px horizontal padding, `button`
typography, 16px icons with 6px gap. Default is `surface` with a 1px border.
Primary is filled `action`. Danger is filled `danger`, used only for
irreversible actions. All three scale to `0.96` while pressed.

Labels are sentence-case verbs naming the outcome: "New rule", "Run all as a
test", "Delete rule". The verb persists through the flow, so a button reading
"Pause" produces a toast reading "Paused", not "Success".

### Inputs and selects

32px, `rounded.md`, 1px border, 10px horizontal padding. Values that are
machine truth render in `mono-sm`; human-readable choices render in `body-md`.
Labels sit above in `label`; help text sits below in `body-sm` at
`foreground-muted`.

### Switch

36×20 track, 16px thumb. `success` when on, `foreground-faint` when off. A
switch is state, which is why it is the one control that is green.

### Status pills

`mono-sm` text on a `rounded.xs` `surface-muted` box with a 6px dot: `agent`
for working, `foreground-faint` for idle, `danger` for blocked. The working
pill takes `agent-wash` and `agent-line`.

### Empty and error states

A single sentence in the interface's voice naming the next action, plus one
button. No illustrations inside working panels. Errors say what happened and
what to do, and never apologize.

## Do's and Don'ts

**Do** fill exactly one button per page with `action`, and keep blue for links,
focus, and selection.

**Do** keep yellow for agent authorship: a dot in feeds, a chip on rules and
nodes, never a fill.

**Do** set every value that came from GitHub or a configuration file in mono,
and every value a human wrote in Inter.

**Do** enable tabular figures on numeric columns.

**Do** use `border` for structure and `border-subtle` for rows within a
structure.

**Do** pair semantic colour with text or an icon so state survives greyscale
and screen readers.

**Do** design and review in dark first.

**Don't** add a left-border accent to anything. Selection is a wash, agent
authorship is a chip.

**Don't** fill a button with blue, or use `action` ink anywhere except the
primary button.

**Don't** add a third accent colour. There is no warning yellow, no info blue,
no purple for anything.

**Don't** use `agent` yellow as a text colour or a large fill.

**Don't** use `foreground-faint` for text.

**Don't** add drop shadows to cards, rows, or buttons. Overlays are the only
shadowed elements.

**Don't** let the blueprint vocabulary appear on ordinary pages.

**Don't** animate anything the user did not trigger, and don't use shimmer
skeletons.

**Don't** set anything below 11px, or shrink rows below 40px to fit more on
screen.

**Don't** put the product mascot anywhere in the application interface.

**Don't** use zebra striping, vertical table rules, or full-width horizontal
rules between form fields.

## Project notes

These sections record decisions specific to this codebase that the identity
above does not cover. They are normative for this repository.

### Mascot

The product owner keeps the mascot mark in the top bar of the application. It
is the single exception to the rule above: a 32px mark at the far left of the
top bar, and nowhere else inside the app.

### GitHub label colors

Label names are mono badges. Because GitHub labels carry a colour chosen by the
repository's maintainers, that colour is user data, not a design token, and it
is the one value the interface renders that does not come from this file. It
appears as an 8px dot at the left of the badge, never as a full fill and never
as text. A label that no longer exists on GitHub renders struck through with a
grey dot.

### Blueprint host

The only graph view today is the labeling rule editor. Its three-step flow
(trigger, conditions, actions) renders on the blueprint canvas, and the editor
is the one screen that collapses the sidebar to the rail. Policies are YAML
documents and stay in the code editor.

### Reference

The scale was settled against three rendered prototypes on 2026-09-14; the
winning one is the source for the numbers above. The prototype is kept on a
throwaway branch, not in main.

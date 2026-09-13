---
version: alpha
name: Utility Room
description: >-
  The visual identity for The Janitor — a control plane for GitHub auto-labeling
  rules and agent-assisted pull requests. Painted-cinderblock surfaces, enamel
  signage, and physical switchgear. Cobalt and safety yellow on cream, outlined
  in navy.

colors:
  primary: "#1E5FD0"
  primary-hover: "#174CA8"
  primary-light: "#4A8AF0"
  on-primary: "#FFFBF0"

  secondary: "#12225C"
  secondary-hover: "#0B1436"
  on-secondary: "#F6EFDD"

  tertiary: "#FFCE1B"
  tertiary-hover: "#E0A800"
  on-tertiary: "#12225C"

  neutral: "#DDD8C9"
  neutral-dim: "#C7C1B0"

  surface: "#F6EFDD"
  surface-raised: "#FFFBF0"
  surface-inset: "#0A1233"
  surface-panel: "#0E1B4A"
  surface-board: "#B9AE93"
  on-surface: "#12225C"
  on-surface-muted: "#4A5478"
  on-panel-muted: "#9DAAD0"

  danger: "#B23A2B"
  danger-hover: "#8E2C20"
  on-danger: "#FFFBF0"

  metal: "#8E97AE"
  metal-dark: "#4C5570"

typography:
  display:
    fontFamily: Big Shoulders Display
    fontSize: 2.75rem
    fontWeight: 800
    lineHeight: 1
    letterSpacing: 0.01em
  sign:
    fontFamily: Big Shoulders Display
    fontSize: 1.5625rem
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: 0.09em
  stamp:
    fontFamily: Big Shoulders Display
    fontSize: 2.125rem
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: 0.09em
  h2:
    fontFamily: Archivo
    fontSize: 1.25rem
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: -0.005em
  h3:
    fontFamily: Archivo
    fontSize: 1rem
    fontWeight: 600
    lineHeight: 1.35
  body-md:
    fontFamily: Archivo
    fontSize: 0.9375rem
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: Archivo
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: Archivo
    fontSize: 0.90625rem
    fontWeight: 600
    lineHeight: 1.4
  button:
    fontFamily: Archivo
    fontSize: 0.875rem
    fontWeight: 700
    lineHeight: 1.2
  numeral:
    fontFamily: Spline Sans Mono
    fontSize: 1.6875rem
    fontWeight: 600
    lineHeight: 1.1
  mono-md:
    fontFamily: Spline Sans Mono
    fontSize: 0.90625rem
    fontWeight: 600
    lineHeight: 1.4
  mono-sm:
    fontFamily: Spline Sans Mono
    fontSize: 0.6875rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0.02em

rounded:
  none: 0px
  xs: 3px
  sm: 4px
  md: 6px
  lg: 14px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 18px
  xl: 26px
  2xl: 40px
  3xl: 64px

components:
  top-rail:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-secondary}"
    height: 62px
    padding: 22px

  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: 17px
  button-primary-hover:
    backgroundColor: "{colors.tertiary-hover}"
    textColor: "{colors.on-tertiary}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: 17px
  button-secondary-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: 17px
  button-danger-hover:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
  button-link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary-hover}"
    typography: "{typography.button}"

  sign-plate:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.sign}"
    rounded: "{rounded.md}"
    padding: 20px

  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 18px

  time-card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    typography: "{typography.display}"
    rounded: "{rounded.md}"
    padding: 26px
  time-card-stamp:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.danger}"
    typography: "{typography.stamp}"
    rounded: "{rounded.sm}"
    padding: 14px

  breaker-panel:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-secondary}"
    rounded: "{rounded.md}"
    padding: 22px
  breaker-caption:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-panel-muted}"
    typography: "{typography.body-sm}"
  breaker-tape:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.tertiary}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.xs}"
    padding: 7px

  switch-off:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.metal}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.sm}"
    width: 70px
    height: 36px
  switch-on:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"
  switch-knob:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.xs}"
    width: 32px
    height: 26px

  clipboard:
    backgroundColor: "{colors.surface-board}"
    rounded: "{rounded.md}"
    padding: 18px
  clipboard-clip:
    backgroundColor: "{colors.metal}"
    rounded: "{rounded.sm}"
    width: 110px
    height: 24px
  clipboard-sheet:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xs}"
    padding: 20px

  hook-tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: 12px
  hook-tag-active:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"
  hook-tag-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
  hook-rail:
    backgroundColor: "{colors.metal-dark}"
    height: 14px
    rounded: "{rounded.xs}"

  chip:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.full}"
    padding: 9px
  chip-active:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"

  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: 11px
  input-focus:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
  checkbox:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xs}"
    size: 22px
  checkbox-checked:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"

  data-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.mono-md}"
    padding: 18px
  data-row-meta:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
  data-row-empty:
    backgroundColor: "{colors.neutral-dim}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    padding: 18px

  save-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.sign}"
    padding: 22px

  link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary-hover}"
    typography: "{typography.body-md}"
  focus-ring:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"
  agent-marker:
    backgroundColor: "{colors.primary-light}"
    textColor: "{colors.secondary-hover}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.full}"
    padding: 8px
---

## Overview

**Utility Room.** The Janitor is a maintenance worker for your repositories, so
its control plane is built like the room a maintenance worker keeps their tools
in: painted cinderblock walls, porcelain-enamel signage, a clipboard on a hook,
and a breaker panel with real switches on it.

The metaphor is load-bearing, not costume. Every physical object in the UI maps
to something that is genuinely physical in the product's model:

| Object | What it holds |
| --- | --- |
| Breaker panel | Standing permissions — binary, consequential, rarely changed |
| Clipboard | Schedules and preferences — a duty roster you fill in |
| Enamel sign | Section boundaries you can find by scanning, not reading |
| Hazard stripes | Destructive actions only |
| Punch card | Agent status and recent activity |
| Key tags on a rail | Navigation — things you take down and carry |

Three rules keep it from becoming a theme park.

1. **One loud thing per screen.** The breaker panel is the memorable object on
   Settings. Everything around it is quiet. If a new screen has two candidates
   for the loud thing, one of them is wrong.
2. **No decorative props.** No mop cursors, no wet-floor icons, no bucket
   spinners. A prop earns its place by carrying information.
3. **Density beats charm past eight rows.** The chunky treatment is for objects
   you look at. Lists you scan drop to hairlines. See `.jn-dense` in Layout.

The audience is a working engineer who opens this app when something needs
fixing. Charm is the second priority; legibility at 7am is the first.

## Colors

The palette comes from the product's mark: a cobalt disc, a navy outline, one
saturated yellow, and a cream mop head. Nothing has been added to it.

**Cobalt — `primary` `#1E5FD0`.** Structure and interactive affordance. Enamel
signs, links, focus targets, active states in charts. Never used as a page
background — cobalt is a plate you mount on the wall, not the wall.

**Navy — `secondary` `#12225C`.** The outline color, and the reason the whole
system reads as drawn rather than rendered. Every raised object gets a 2–3px
navy border. Also the top rail, and all body text on light surfaces. Use
`secondary-hover` `#0B1436` for the drop edge under raised objects, never as a
fill on its own.

**Safety yellow — `tertiary` `#FFCE1B`.** The strongest signal in the system and
therefore the most rationed. Yellow means exactly three things:

- a permission or setting is **on**
- an action is the **primary** one on the screen
- the element has **keyboard focus**

Yellow is never a background wash, never a chart series, never a decorative
accent, and never appears on more than a few square inches of any screen. If a
screen looks yellow, you have used it wrong. Note the deliberate collision with
hazard striping — yellow on navy diagonals marks destructive zones — which works
precisely because plain yellow is otherwise scarce.

**Cream — `surface` `#F6EFDD` / `surface-raised` `#FFFBF0`.** Every panel, card
and sheet. Warmer than white on purpose; against the cinderblock wall it reads
as paper and enamel rather than as a modal.

**Wall — `neutral` `#DDD8C9` with `neutral-dim` `#C7C1B0` mortar.** The app
background is a running-bond cinderblock pattern at very low contrast, plus a
5% fractal-noise overlay. Both are subliminal — if a reviewer can describe the
pattern from memory, turn it down. Never place body text directly on the wall;
text lives on cream.

**Rust — `danger` `#B23A2B`.** Destructive actions and the punch-card stamp. It
is the one color outside the mark's palette, chosen because it reads as stamp
ink and shop-floor paint rather than as a browser alert.

**Steel — `metal` `#8E97AE` / `metal-dark` `#4C5570`.** Hardware only: the hook
rail, the clipboard clip, screw heads. Never text, never a fill on a content
surface.

**Agent attribution.** `primary-light` `#4A8AF0` marks work The Janitor did
itself, in timelines and diffs, so a human can scan a thread and separate agent
actions from teammate actions without reading avatars. This is a semantic role,
not a decorative tint — do not reuse it.

All foreground/background pairs in `components` clear WCAG AA (4.5:1). The
tightest pair is `danger` on `surface` at 5.15:1; do not darken the cream or
lighten the rust without re-checking.

## Typography

Three families, each with a job that maps to a physical thing.

**Big Shoulders Display** is signage. It appears on enamel plates, the punch-card
headline, the punch-card stamp, and the save bar — and nowhere else. It is
condensed, industrial, and set uppercase with `0.09em` tracking on signs. This
is the one place uppercase is permitted, because these are objects with words
stamped into them, not labels.

**Archivo** is everything a person reads or clicks: body copy, form labels,
buttons, table content, help text. Sentence case throughout.

**Spline Sans Mono** is machine truth: repository names, branch names, rule
expressions, run IDs, counts on the punch card, and the small tape labels on the
breaker panel. If a value came out of GitHub rather than out of a person, it is
mono. This rule is what makes the interface scannable — mono is a signal, so
never use it for atmosphere.

The scale is a modest 1.2-ish progression anchored at 15px body, because this is
a dense operational tool rather than a marketing page. Display sizes jump hard
away from the body sizes so headings act as landmarks rather than as slightly
bigger paragraphs.

| Token | Size | Use |
| --- | --- | --- |
| `display` | 44px | Punch-card headline, one per page |
| `stamp` | 34px | Rotated status stamp |
| `sign` | 25px | Enamel section plates, save bar |
| `numeral` | 27px | Tally figures on the punch card |
| `h2` | 20px | Panel headings inside a section |
| `h3` | 16px | Row titles, breaker names |
| `label` | 14.5px | Form labels |
| `body-md` | 15px | Default |
| `body-sm` | 13px | Help text, row metadata |
| `mono-md` | 14.5px | Repository and branch names |
| `mono-sm` | 11px | Tape labels, chips, run IDs |

Body copy caps at 62 characters. Help text sits directly under its label at
`on-surface-muted`, never in a tooltip.

## Layout

A two-column shell: a 212px sticky hook rack on the left, fluid content on the
right, 1180px maximum, 34px gutter. Content is left-aligned throughout — nothing
is centered except the clipboard clip, which is centered because a real clip is.

```
┌──────────────────────────────────────────────────────┐
│ ▪ rail  The Janitor · org                    ⬤ user  │  62px, navy
├──────────┬───────────────────────────────────────────┤
│ ══════   │  ┌─────────────────────────────────────┐  │
│  ⌐ tag   │  │  PUNCH CARD — status + week + tally │  │  hero
│  ⌐ tag   │  └─────────────────────────────────────┘  │
│  ⌐ tag   │  ▐ ENAMEL SIGN ▌                          │
│  ⌐ tag   │  ┌─────────────────────────────────────┐  │
│  ⌐ tag   │  │  panel — rows                       │  │
│          │  └─────────────────────────────────────┘  │
│          │  ▐ ENAMEL SIGN ▌                          │
│          │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│          │  ┃  breaker panel — the loud thing     ┃  │
│          │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│          │  ▨▨▨ hazard ▨▨▨                           │
└──────────┴───────────────────────────────────────────┘
```

Sections are 40px apart. The enamel sign is not inside its panel — it sits above
it, like a plate screwed to the wall over a fixture, with the section's lede
paragraph between them.

**Breakpoints.** Below 880px the hook rack unhooks and becomes a horizontal
wrapped row of tags above the content. Below 620px, panels lose their offset
shadow (keeping the border) and switches shrink to 56×30. The punch card's week
strip stays — it is the reason to open the page on a phone.

**Density.** Any list past eight rows switches to `.jn-dense`: hairline
`neutral-dim` dividers instead of 2px navy, 8px vertical padding instead of 14,
no per-row shadow, mono at 13px. The outer panel keeps its border and shadow so
the object is still an object; only its contents get quiet. Treat this as the
default for repository lists, run history, and audit logs — the chunky variant
is for short, high-stakes sets like the breaker panel.

## Elevation & Depth

Depth in this system is physical, not atmospheric. There are no blurs, no
layered glows, and no `rgba(0,0,0,.1)` soft shadows. An object is either
mounted on the wall, recessed into a plate, or printed flat.

**Mounted** — the only raised treatment, identical for every object:

```css
border: 3px solid var(--color-secondary);
box-shadow: 0 3px 0 var(--color-secondary-hover),
            0 6px 14px rgb(11 20 54 / 0.28);
```

A hard navy drop edge does the work; the soft shadow only grounds it against the
wall. Because the value is fixed, there is no elevation scale to get wrong — a
card, a panel, a clipboard and the top rail are all mounted at the same depth.
Hierarchy comes from size and color, not from z-height.

**Recessed** — for anything a control sits inside (switch tracks, text inputs,
checkboxes):

```css
box-shadow: inset 0 3px 6px rgb(11 20 54 / 0.55);
```

**Flat** — content printed on a surface: table rows, sheet text, chips. No
shadow at all. Most of the interface is flat.

Buttons are the only objects that move. Pressing one translates it 3px down and
removes its drop edge, so the button physically travels into the surface. This
is the system's entire motion budget for interaction.

**Motion.** One transition curve, `cubic-bezier(.3, 1.6, .6, 1)` at 130ms, used
only where something physically moved: the switch knob sliding, the save bar
rising, the button depressing. No entrance animations, no hover lifts, no
scroll-triggered reveals. Everything respects `prefers-reduced-motion`, which
disables transitions entirely rather than shortening them.

## Shapes

Radii are small and inconsistent on purpose, because manufactured objects have
different corner treatments.

- `xs` 3px — things stamped or cut from sheet: switch knobs, tape labels, sheets
- `sm` 4px — hardware and controls: buttons, inputs, the clipboard clip
- `md` 6px — mounted panels, cards, enamel signs
- `lg` 14px — the bottom corners of hook tags only, where a real tag is rounded
- `full` — status chips only

Hook tags are the one asymmetric shape in the system: `4px 4px 14px 14px`, and
they hang at `rotate(-0.9deg)` from a transform origin near the hook, so they
swing upright on hover. Nothing else in the interface is rotated except the
punch-card stamp at `-3.5deg`. Two rotated things per page is the ceiling.

The hazard stripe is a fixed pattern: 45°, 14px bands, `tertiary` on `secondary`,
16px tall, with a 3px navy border beneath it. It appears only at the top of a
destructive region and along the top of the save bar. It is never a border on an
individual button and never a background fill.

## Components

### Enamel sign

The section heading. A cobalt plate with a vertical gloss gradient, a 3px navy
border, a 2px inset cream keyline, and a small cream dot at the left standing in
for a mounting screw. Set in `sign` typography, uppercase. Signs are always
horizontal — the temptation to hang one at an angle should be resisted.

### Breaker switch

70×36 track, recessed navy when off and `tertiary` when off→on, with a 32×26
cream knob carrying three ridged lines. The word "on" sits in the track and is
revealed as the knob travels. The knob overshoots slightly on the way over.

Wrap a real `<input type="checkbox">`, visually hidden and positioned over the
whole control, so keyboard and screen-reader behavior is native. Focus draws a
3px `tertiary` ring at 3px offset around the track. Disabled breakers drop to
50% opacity and must carry an inline explanation of what would enable them —
never a bare greyed switch.

Optional `breaker-tape` labels sit between the description and the switch for
constraints that qualify a permission, such as an approval count.

### Punch card

The status hero. Cream stock with a perforated top edge (a repeating
radial-gradient), a dashed inset keyline 9px in, a rotated rust stamp, a
seven-bar week strip, and a tally row of mono figures. The bars use `primary`
with `tertiary` for today. It carries live numbers only — never a placeholder
skeleton, because an empty punch card should say what to do instead.

### Clipboard

Board in `surface-board` with a steel clip centered and overhanging the top
edge, holding a cream sheet. Fields inside the sheet are a two-column flex row
that wraps: label plus help text on the left at `min-width: 190px`, control on
the right, hairline divider between. Used for schedules and notifications.

### Buttons

Four variants, all with a 2.5px border and a 3px hard drop edge in the border
color. Primary is yellow, secondary is cream with a navy border, danger is cream
with a rust border that inverts to a rust fill on hover, and ghost is a dashed
transparent outline with no drop edge and no press travel.

Labels are sentence case verbs that name the outcome: "Save changes", "Pause
everything", "Connect another repository". The verb persists through the flow —
"Pause everything" produces "Paused", not "Success".

### Save bar

Fixed to the bottom, hidden by default, slides up on the first change to any
control. A hazard strip runs along its top edge, then the word "Wet paint" in
`sign` type, a plain-language status line, a ghost Discard and a primary Save
changes. Nothing else in the app is fixed to the viewport bottom.

### Hook rack

A steel rail with two screw heads, and tags hanging below it. The active tag is
yellow and hangs straight; the rest are cream and tilted. The hazard-zone tag is
outlined in rust. Uses `aria-current="page"` for the active state — color alone
never carries it.

### Data row

The workhorse. Repository or branch name in `mono-md`, metadata beneath in
`body-sm` at `on-surface-muted`, a status chip, and an action button. Chips are
`neutral` for idle and `tertiary` for running. Past eight rows, apply `.jn-dense`.

### Empty states

An empty panel gets a dashed top border, a light 135° hatch fill, and one
sentence in the interface's voice naming the action, prefixed with a plus. Never
an illustration inside a working panel — the mascot appears in onboarding, full
page empty states, and marketing only.

## Do's and Don'ts

**Do** keep yellow to on-states, primary actions, and focus rings. Three
meanings, no more.

**Do** use mono for anything GitHub produced and Archivo for anything a person
wrote. The distinction is how people scan these screens.

**Do** give every mounted object the same 3px navy border and hard drop edge.
Sameness is what makes the wall read as a wall.

**Do** switch to `.jn-dense` past eight rows, and design the dense variant at
the same time as the chunky one.

**Do** write help text into the layout rather than into tooltips, and explain
what a disabled control needs in order to work.

**Don't** put the mascot on any screen a person opens because something is
wrong. He is not in Settings, not in error states, not in the hazard zone.

**Don't** add props. No mop icons, no bucket loaders, no wet-floor signs, no
sponge textures. The three surfaces — wall, cream, navy panel — and the existing
objects are the entire vocabulary.

**Don't** use uppercase outside Big Shoulders on enamel signs, stamps, and the
save bar. No tracked-out caps eyebrow labels above headings.

**Don't** introduce soft drop shadows, gradients as decoration, or blurred
overlays. Depth is a hard navy edge or an inset, never a haze.

**Don't** put text on the cinderblock wall, and don't raise the wall pattern's
contrast to make it visible. It is meant to be felt, not read.

**Don't** rotate more than two elements per page, and never rotate anything
containing an interactive control other than a hook tag.

**Don't** use cobalt as a page background or yellow as a fill on large areas.
Both are plates mounted on a surface, not the surface.

**Don't** animate anything the user did not trigger. No entrance fades, no
staggered reveals, no hover lifts on cards.

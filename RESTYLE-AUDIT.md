# Restyle audit: Utility Room → Ops Console / Blueprint

Phase 0 deliverable. No code changes were made. Everything below was read from
the worktree at commit `a158d2f`; line numbers refer to that state.

## 0. Facts that shape the whole plan

1. **This is not a React or shadcn codebase.** The web app (`apps/web`) is a
   foldkit application: Effect-based, TypeScript view functions producing
   virtual DOM. `@foldkit/ui` provides headless behaviour (dialog, menu,
   select, switch, tooltip, toast, popover, disclosure, virtual list) and emits
   no classes and no `data-slot` attributes. The styled layer is the project's
   own `apps/web/src/components/ui/*.ts` (13 files), which is the shadcn
   analogue here. `npx shadcn add` cannot run against this repo. The shadcn
   semantic variable set is still defined in the theme file, and this audit
   treats keeping it complete and correctly paired as the constraint to meet.
2. **There is exactly one theme file:** `apps/web/src/styles.css` (1833
   lines). No CSS modules, no styled-components, no other `.css` file. It is
   loaded from `index.html` with a `<link>`, not imported from TypeScript.
3. **The existing design doc lives at `docs/design/DESIGN.md`** (675 lines,
   "Utility Room"), with a sibling reference `docs/design/theme.css`. There is
   no `DESIGN.md` at the repository root. The task says to write Appendix A to
   the root; see gap G1.
4. **There is no rule-graph or PR-flow canvas in the app today.** The file
   `labeling-wire.ts` is the wire-protocol schema, not a drawing. The rule
   editor renders a vertical three-step form ("rule-flow": When / If / Then
   cards with a number bubble and a hairline spine). See gap G2.
5. **The current identity uses yellow for CTA, on-state and focus**, and
   cobalt-light for agent authorship. The target inverts this. Two agent
   primitives (`jn-agent`, `chip` variant `agent`) already exist and are used
   nowhere.
6. **Baseline tooling passes.** `vp check` reports 0 errors and 483
   pre-existing warnings. `npx @google/design.md lint docs/design/DESIGN.md`
   reports 0 errors, 1 warning (orphaned `danger-hover`). Fonts are loaded
   through Fontsource imports at the top of `styles.css`.
7. **Dark mode exists.** `theme-switcher.ts:67` toggles `.dark` on
   `<html>`, with a system-preference fallback. Both CodeMirror editors follow
   it with a `MutationObserver`.

## 1. Value inventory

### 1.1 Colors

**Theme file, light (`styles.css:14-107`).** Brand primitives `--jn-*`:
cobalt `#1e5fd0`, cobalt-dark `#174ca8`, cobalt-light `#4a8af0`, navy
`#12225c`, navy-deep `#0b1436`, panel `#0e1b4a`, inset `#0a1233`, yellow
`#ffce1b`, yellow-dark `#e0a800`, cream `#f6efdd`, cream-hi `#fffbf0`, wall
`#ddd8c9`, mortar `#c7c1b0`, board `#b9ae93`, rust `#b23a2b`, rust-dark
`#8e2c20`, metal `#8e97ae`, metal-dark `#4c5570`, muted-ink `#4a5478`,
muted-panel-ink `#9daad0`. Two data-URI SVG images (cinderblock wall, fractal
noise) with embedded hex. Semantic set maps `--primary` to **yellow**,
`--accent` to cobalt, `--border`/`--input` to navy, `--ring` to yellow,
`--background` to wall, `--card` to cream.

**Theme file, dark (`styles.css:113-160`).** `--nt-*`: wall `#1c1b18`,
mortar `#262420`, card `#2a2823`, card-hi `#34312b`, inset `#14130f`, line
`#5a554b`, line-strong `#7b7466`, ink `#f6efdd`, muted `#a8a08e`, rust
`#e0705c`. Shadows use literal `#000`.

**Theme file, component rules (`styles.css:330-1833`).** Literal colors
inside rules: `#606c93` (switch track text, :540), `#dcd3bc` (knob gradient,
:557), `#d2d8e6` (steel, :415), `rgb(246 239 221 / …)` (:386, :397),
`rgb(18 34 92 / 0.32)` (:562), `rgb(11 20 54 / 0.22)` (:476), `rgb(0 0 0 / …)`
(:558, :1300), plus ten `color-mix()` calls building tints from tokens
(:429-434, :786, :801, :836-838, :851-852, :1155, :1517, :1794-1801).

**Outside the theme file.**

| Location | Value | Purpose |
| --- | --- | --- |
| `repository-switcher.ts:153-155` | 12 hexes (`#e3d9ff` `#54368f` `#55427a` `#f0e7ff` `#d1e7ff` `#285579` `#28516d` `#e0f1ff` `#d5ece4` `#285d49` `#29594b` `#d9fff0`) | Repository tile tone ramp, chosen by name hash |
| `repository-switcher.ts:185` | `#277346`, `#8acaa1` | "Active" status text, light/dark |
| `ui/input.ts:7`, `ui/input-group.ts:11`, `ui/textarea.ts:6` | `rgb(18 34 92 / 0.1)` | Inset lip shadow, copy-pasted three times |
| `workspace.ts:1476-1478` | `#111111`, `#ffffff`, `` `#${color}` `` | GitHub label badge: bg/border from GitHub's hex, contrast text computed by luminance |
| `activity.ts:408` | `` `#${color}70` ``, `` `#${color}18` `` | GitHub label pill with hardcoded alpha suffixes |
| `activity.ts:474` | `` `#${color}` `` | Rule dot |
| `public/site.webmanifest:16-17` | `#0d47a1`, `#ffffff` | `theme_color` (stock Material blue, unrelated to the palette), `background_color` |
| `test/components/workspace.test.ts:714-724` | `#ffffff` `#111111` `#000000` `#d73a4a` | Assertions on the label badge helper |

**Stock Tailwind palette classes (bypass tokens entirely).**

| Class | Locations |
| --- | --- |
| `text-emerald-600/400` | `activity.ts:381`, `policy-editor.ts:1288`, `rule-editor.ts:1157`, `test-bench.ts:179` |
| `text-emerald-700/300`, `bg-emerald-500/15` | `sessions.ts:350` |
| `text-amber-700/400` | `activity.ts:385,391`, `ai-input-view.ts:40,74` |
| `text-amber-600/400` | `policy-editor.ts:822`, `rule-editor.ts:1052`, `test-bench.ts:183` |
| `text-amber-700/300`, `bg-amber-500/15` | `sessions.ts:352,454,523,556` |
| `text-amber-500` | `sync-button.ts:370` |
| `bg-black/40` | `policy-editor.ts:1346`, `repository-connections.ts:461`, `rule-editor.ts:1621` (dialog scrims; `ui/sheet.ts` uses `bg-navy-deep/55` instead) |

No `hsl()`, `oklch()` or named colors appear outside the theme file. There is
no `<meta name="theme-color">` in `index.html`.

### 1.2 Fonts

- Loaded: `@fontsource-variable/archivo`, `big-shoulders-display`,
  `spline-sans-mono` (`styles.css:3-5`, `package.json`).
- Stacks: `--font-sans` Archivo, `--font-sign` Big Shoulders Display,
  `--font-mono` Spline Sans Mono (`styles.css:214-216`). `font-display` is
  declared in the doc but has no utility; `font-sign` is used once
  (`ui/sign.ts:6`); `font-mono` 10 times.
- Hardcoded stack outside the theme: `policy-source/editor.ts:54` sets
  `.cm-scroller` to `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
  monospace`, so the YAML editor does not use the app mono face.
- Type scale (`styles.css:218-241`): body-sm 13px, body-md 15px, label 14.5px,
  button 14px, h3 16px, h2 20px, sign 25px, numeral 27px, stamp 34px, display
  44px, mono-sm 11px, mono-md 14.5px. Base body is 15px; target is 13px.
- Arbitrary text sizes in TSX: `text-[10px]` ×3 (`activity.ts:488,620,679`),
  `text-[11px]` ×8 (`repository-switcher.ts`, `ai-input-view.ts:29`),
  `text-[13px]` ×3 (`repository-switcher.ts`). Dozens of literal `font-size`
  values (9px to 21px) in the component rules of `styles.css`.
- Weight `550` is used at `styles.css:659`.
- No `tnum` / tabular figures anywhere.

### 1.3 Radii

Theme: `--radius` 6px, xs 3px, sm 4px, md 6px, lg 14px, xl through 4xl
computed from `--radius` (`styles.css:243-251`). Utilities used in TS:
`rounded-sm` 27, `rounded-md` 15, `rounded-lg` 8, `rounded-xs` 5,
`rounded-xl` 5, `rounded-full` 4, `rounded-none` 3,
`rounded-[calc(var(--radius)-5px)]` 1 (`ui/input-group.ts:14`), bare
`rounded` 1. Component CSS also uses `4px 4px 14px 14px` (`jn-tag`), `50%`,
`999px`, `9999px`.

### 1.4 Shadows

The current identity is built on hard drop edges and insets, which the target
removes entirely.

| Source | Value | Where |
| --- | --- | --- |
| `--jn-edge` | `0 3px 0 navy-deep` | `shadow-edge` on every button (`ui/button.ts:58`), `main.ts:1263` |
| `--jn-mount` | edge + `0 6px 14px rgb(11 20 54 / .28)` | `jn-mount` utility (panels), `shadow-mount` (`ui/sheet.ts`, `ui/sidebar.ts:228,791`) |
| `--jn-recess` | `inset 0 3px 6px rgb(11 20 54 / .55)` | switch tracks |
| inline | `inset 0 2px 0 rgb(18 34 92/0.1)` | input, input-group, textarea |
| inline | `0 3px 0 var(--jn-rust-dark)` | destructive button |
| inline | `0 0 0 2px var(--sidebar-border)` | `ui/sidebar.ts:555` |
| stock | `shadow-md` (`workspace.ts:1609`, `sync-button.ts:381`), `shadow-lg` (`repository-switcher.ts:273`), `shadow-xl` (three dialogs) | overlays |
| CSS | `.jn-sign` inset keyline + mount, `.jn-tag` `0 3px 0`, knob `0 2px 0`, view-toggle `0 0 0 2px` | component rules |

Gradients: `jn-sign`, `jn-steel`, `jn-perforated`, `jn-hazard`, `jn-empty`
hatch, switch knob, wall and noise images. All are out under the target.

### 1.5 Spacing and density

- Rows: rules table cells `18px 10px` padding (`styles.css:1233`), activity
  event summary 96px tall (`:1590`), activity group 72px (`:1662`), policy
  library items `9px 10px`. Target is 28px rows.
- Panels: `p-[18px]` (`ui/panel.ts:18`), `px-[18px]` ×3 (`account.ts`),
  page padding 24px. Cards stack with 18px gaps already in places.
- Sidebar widths: `16rem` / `18rem` mobile / `3rem` icon
  (`ui/sidebar.ts:28-36`); policy library 224px; rule inspector 300px; policy
  inspector 280px. Target: sidebar 216px, inspector 292px.
- Other arbitrary values: `w-[200px]`, `w-[2px]`, `size-[30px]`,
  `size-[34px]`, `size-[5px]`, `mt-[20vh]` ×3, `w-[calc(100%-2rem)]` ×3,
  `min-h-[60vh]`, `max-h-[min(430px,60dvh)]`, `max-w-[calc(100vw-1rem)]`,
  `grid-cols-[max-content_1fr]`, `grid-cols-[200px_minmax(0,640px)]`,
  `ml-[-0.3rem]` and siblings ×4, `border-[2.5px]` ×2, `border-*-[3px]` ×16,
  `translate-*-[±2.5rem]` ×40 (all in `ui/sheet.ts`), `translate-y-[3px]`,
  and the sidebar `calc(var(--sidebar-width-icon)+…)` trio.
- Breakpoints in CSS: 1200px, 1199px, 900px, 640px, 620px, 540px. Target:
  1240px and 820px.

### 1.6 Motion

- `transition-*` utilities: colors 6, transform 2, all 2, opacity 1, shadow 1,
  bare 4, arbitrary property lists 6; durations 100/150/200ms; easings
  `ease-linear` ×5, `ease-in-out` ×4, and a spring `--jn-ease`
  `cubic-bezier(0.3, 1.6, 0.6, 1)`.
- `animate-spin` ×2 (sync icon, validation spinner), `animate-pulse`
  (`ui/skeleton.ts:11`, the shimmer the target forbids).
- Hover lifts: `.jn-tag:hover` rotates and translates (`styles.css:492`).
  Press travel: buttons translate 3px on `:active`.
- Entry/exit: foldkit `data-enter` / `data-leave` / `data-starting-style` /
  `data-ending-style` variants in `ui/sheet.ts` (44 hits). `tw-animate-css` is
  imported but no `animate-in`/`fade-in`/`slide-in` class is used anywhere.
- `prefers-reduced-motion` is honored globally (`styles.css:330-337`) and for
  the rule switch (`:1400-1405`).

### 1.7 SVG and icons

- `lib/icons.ts:49-59` renders lucide nodes with `stroke="currentColor"`,
  `fill="none"`, `stroke-width="2"` (not configurable), default class
  `size-4 shrink-0`. Target is 14px at 1.5px; sizes used range `size-3` to
  `size-10`.
- `policy-source/editor.ts:114-135` builds a fold chevron by hand with
  `stroke-width="1.5"`.
- No charts render anywhere. `--chart-1..5` are defined and unused.

### 1.8 CodeMirror

Two editors (`policy-source/editor.ts`, `policy-source/ai-editor.ts`) use
`githubLight` / `githubDark` from `@uiw/codemirror-theme-github`, whose syntax
colors are GitHub's and unrelated to either identity. No custom
`HighlightStyle`. `EditorView.theme()` sets font size 13px, padding, min/max
heights and the hardcoded mono stack. `styles.css` overrides `.cm-editor`,
`.cm-gutters`, `.cm-foldGutter` backgrounds and the `.ai-fact-reference`
decoration (cobalt tint). See gap G4.

## 2. Primitive layer ("shadcn" equivalent)

Installed `@foldkit/ui` modules in use: button, textarea, dialog, input,
anchor, toast, popover, tooltip, switch, disclosure, select, menu, virtualList.
All headless.

Project-owned styled primitives in `apps/web/src/components/ui/`:

| File | Renders | `data-slot` | Notes |
| --- | --- | --- | --- |
| `button.ts` | 6 variants, 8 sizes; 2.5px outline, hard edge, press travel | `button` | Default variant is yellow |
| `chip.ts` | mono pill: neutral / on (yellow) / danger / agent (cobalt, unused) | `chip` | |
| `command.ts` | palette container/input/list/item/group | `command*` | three `!` overrides |
| `input-group.ts` | composite input shell, addons | `input-group*` | raw `onclick` string at :387 |
| `input.ts` | label + input + description | `label`, `input` | inset lip shadow |
| `mark.ts` | platform mark and avatar squares | none | only primitive without `data-slot` |
| `panel.ts` | raised cream plate, `emptyPanel` | `panel` | `jn-mount`, `p-[18px]` |
| `rack.ts` | hook-rail navigation with rotated tags | `rack` | rotation, steel gradient |
| `sheet.ts` | side dialog; four identical panel strings | `sheet-*` | 40 arbitrary translates |
| `sidebar.ts` | 797-line sidebar submodel and 20 view helpers | `sidebar*` | random skeleton width at :648 |
| `sign.ts` | enamel section heading, uppercase | `sign` | |
| `skeleton.ts` | `animate-pulse` block | `skeleton` | shimmer |
| `textarea.ts` | label + textarea + description | `label`, `textarea` | |

All of these were written for Utility Room; none are generated shadcn files,
so "modified from generated form" does not apply. Every one will change in
Phase 2. Missing primitives the target names and the app renders ad hoc:
badge, card, table, tabs, dialog content, dropdown content, tooltip content,
toast, select trigger, switch. Those are currently styled inline in
`workspace.ts`, `rule-editor.ts`, `policy-editor.ts`, `main.ts`
(toast, `:1157-1173`), `sync-button.ts` (tooltip), `repository-switcher.ts`
(popover) and in the `.policy-*` / `.rule-*` / `.activity-*` CSS blocks.

## 3. Custom CSS

Everything is in `styles.css`:

- `@layer base` (`:290-338`): `border-border outline-ring/50` on `*`, wall
  image and noise pseudo-element on body, 3px yellow focus ring, reduced
  motion.
- `@utility` blocks: `no-scrollbar`, `jn-mount`, `jn-recess`, `jn-sign`,
  `jn-screw`, `jn-press`, `jn-hazard`, `jn-steel`, `jn-perforated`,
  `jn-empty`, `jn-agent`. Of these, TS uses `jn-mount`, `jn-sign`, `jn-screw`,
  `jn-empty`, `jn-steel`, and `jn-dense`; `jn-recess`, `jn-press`,
  `jn-hazard`, `jn-perforated`, `jn-agent` are dead.
- `@layer components` (`:464-599`): `.jn-tag` (used), `.jn-switch*` (dead in
  TS; used only by the docs mockups).
- Unlayered page CSS (`:601-1833`): `.policy-*` (39 classes), `.rule-*` /
  `.rules-*` (19), `.activity-*` (22), `.ai-*` (3), `.repository-*`. Several
  rules are redefined later in the file with different values (rules-table
  column widths three times, `.policy-library-*` twice, `.rule-delete-actions`
  twice). Dead selectors: `.activity-decision-*` (5), `.activity-rule-action`,
  `.policy-save-status`, `.policy-status-badge` variants are used via
  `policy-status.ts`.
- `@apply` appears only in the base layer. No CSS modules, no CSS-in-JS beyond
  the two CodeMirror theme objects.

## 4. Surfaces outside the app tree

| Surface | Location | Carries brand? |
| --- | --- | --- |
| Favicons and touch icon | `public/*.png`; `index.html:6` references `/favicon.ico`, which does not exist | Yes, mascot artwork; out of scope for CSS, noted in G6 |
| Web manifest | `public/site.webmanifest` | `theme_color #0d47a1` must move to the new canvas or primary |
| Mascot logo | `src/assets/janitor-logo-{light,dark}.png`, rendered once in the app header via `janitor-icon.ts` from `main.ts:893` | **Violates the target**: mascot must not appear in the application interface |
| Settings mockups | `docs/settings-mockups/*.html`, `utility-room.css`, Google Fonts link | Static Utility Room artifacts; served separately (see memory note); leave as history or delete, G7 |
| Design reference CSS | `docs/design/theme.css` | Utility Room copy of the theme; superseded |
| GitHub comments | `apps/cluster/src/GitHub/FeedbackHttp.ts:196-224` | Plain agent text plus an HTML marker comment. No visible attribution; the GitHub App identity supplies the bot badge |
| Pull requests | `runner/src/Publication.ts:529-530`, `:344` | Title and body from the agent plus a marker comment; no attribution line |
| Slack messages | `apps/cluster/src/Slack/Transport.ts:163`, `Delivery.ts:100-146`, `Processor.ts` | `mrkdwn: false`, no Block Kit, plain sentences |
| Emails, PDFs, OG images, Storybook, docs site | none | none exist |
| Auth screen | none; Cloudflare Access handles sign-in | n/a |
| Error pages | in-app only (`main.ts:1232-1243` 404, `:1302-1326` unavailable repository) | yes, restyled in Phase 3 |
| Loading skeletons | `ui/skeleton.ts`, sidebar only; everything else uses "Loading…" text | shimmer to remove |

## 5. Agent-authorship inventory

**The product currently renders no agent-versus-human distinction anywhere.**
The only discriminator is the text "AI rule" / "Policy rule" in the activity
feed. The list below is what Phase 3 marks with `agent` yellow, an
`agent-ink` actor name, and the words "The Janitor" so the signal survives
greyscale and screen readers.

### 5.1 Entirely agent-authored surfaces

| Surface | Location | What the agent did | Current marking |
| --- | --- | --- | --- |
| Activity feed, every event | `activity.ts:566-689` | Evaluated an issue or PR and reconciled labels. `ActivityEntry` has no actor field; everything is a Janitor run | none |
| Applied label pills | `activity.ts:403-412`, `:522-561` | Added or removed a GitHub label | none; GitHub label color |
| Per-rule decision cards | `activity.ts:413-521` | Matched / no-match / unknown / failed | `.activity-decision-*` tones incl. **yellow for "unknown"** |
| AI reason prose | `activity.ts:513-515` | LLM wrote this sentence | none |
| Evaluation summary and rules-revision footnote | `activity.ts:663-683` | | none |
| Sessions list and detail | `sessions.ts:420-461`, `:537-578` | Agent conversation in a Slack home thread; title derived from first message (`Processor.ts:211`) | none |
| Execution badge Working / Idle / Blocked / Failed | `sessions.ts:342-354`, `:376-387` | The "agent is running" pill | emerald / amber / destructive |
| Recorded usage, latest error, pending delivery | `sessions.ts:364-367`, `:547-552`, `:579-597` | | none |
| Recovery scan section | `sessions.ts:490-535`; server `Agent/RecoveryStatus.ts` | Agent re-read GitHub and Slack history | amber when overdue |
| Session PR link | `sessions.ts:389-418` | The PR is agent-authored | plain link |
| Rule test bench result | `rule-editor.ts:1111-1233` | Agent evaluated the rule against one item; reason, confidence, trace, preview action | none |
| Test bench (draft and configuration modes) | `test-bench.ts:186-281`, `:359-439`, `:445-514` | Agent evaluated rules across recent items | outcome in emerald / amber |
| AI input inspector | `ai-input-view.ts:16-161` | What was sent to the model, what was omitted | amber for omissions |
| Sync status button and tooltip | `sync-button.ts:290-327`, `:344-375`; header mount `main.ts:1132-1143` | Janitor reading GitHub state; spinner while running | amber when failed |
| Sync toasts | `main.ts:351-395` | | warning border yellow |
| Live-channel banner | `main.ts:1117-1131` | Push channel for agent changes | muted |

### 5.2 Mixed surfaces (agent-shaped content inside human editing)

| Surface | Location | Note |
| --- | --- | --- |
| AI rule type, prompt editor, gate, confidence | `rule-editor.ts:1304-1338`, `:1714-1843` | Human writes the prompt; the rule is executed by the agent. Mark the rule as AI-evaluated, not the prompt as agent-written |
| Rules table Type column | `workspace.ts:1461-1466`, `:1540-1548` | "AI" and "Policy" share the same icon and color |
| Rule behavior summary | `workspace.ts:1458-1459` | First line of the AI prompt |
| `classify` node and inserted snippet | `policy-source/completion.ts:38`, `:308-310` | Editor-inserted template, not agent-authored; should not be yellow |
| Fact references in prompts | `ai-editor.ts:46-51`, `styles.css:1514-1521` | Cobalt tint today; interactive-ish, decide in G5 |
| AI consent panel (Settings) | `workspace.ts:1752-1836` | Human decision about the agent; "Draining" state is agent activity |

### 5.3 Human-authored content that must stay Inter and grey

Policy titles and descriptions, YAML policy source, rule names, AI prompt
text, account and team data, PR author login in the test bench
(`test-bench.ts:191`), and the `Inputs` counter of human messages in a
session (`sessions.ts:570-572`).

### 5.4 Yellow today, classified

| Use | Location | Class under target | Action |
| --- | --- | --- | --- |
| Global focus ring and 11 component overrides | `styles.css:320-323` and others | interactive | becomes blue `--ring` |
| Default button variant, connect CTA | `ui/button.ts:20`, `main.ts:1263` | interactive | becomes blue primary |
| `admin` role chip | `ui/chip.ts:13`, `account.ts:420,535` | decorative | neutral badge |
| Active nav tag | `styles.css:496-502` | interactive | `primary-wash` + 2px blue edge |
| Rule enable switch on-state | `styles.css:1286-1291` | interactive | blue |
| Published policy badge | `styles.css:795-799` | on-state | neutral badge with text |
| Activity "unknown" decision | `styles.css:1800-1803` | warning on an agent row | neutral; the row itself gets the agent mark |
| Warning toast border | `main.ts:1164` | warning | neutral (no warning color exists) |
| `jn-hazard`, `.jn-switch`, `--chart-2` | `styles.css:407,567,93` | unused | delete |

Amber classes listed in 1.1 are all warnings or outcome tones and become
neutral, danger, or success per the target's status rule.

## 6. Token mapping

Rows marked **drift** keep a name but change meaning; these are the ones to
watch when aliasing in Phase 1.

| Existing | Target | Value change | Drift |
| --- | --- | --- | --- |
| `--primary` | `--primary` | `#ffce1b` → `#1e5fd0` | **drift**: yellow CTA → blue interactive |
| `--primary-foreground` | `--primary-foreground` | navy → white | pairs with above |
| `--accent` | `--accent` | cobalt `#1e5fd0` → `primary-wash #edf3fd` | **drift**: solid cobalt fill → pale selection wash; `bg-accent` hover rules stay valid, `text-accent-foreground` on it flips from cream to blue-hover |
| `--accent-foreground` | `--accent-foreground` | cream-hi → `#174ca8` | |
| `--ring` | `--ring` | yellow → blue | drift: focus color |
| `--background` | `--background` | wall `#ddd8c9` → canvas `#f4f6f8` | wall image removed |
| `--card` / `--popover` | same | cream → white | |
| `--secondary` | `--secondary` | cream → `surface-muted #fafbfc` | |
| `--muted` | `--muted` | mortar `#c7c1b0` → `#fafbfc` | **drift**: was a darker fill used for pills and toggles; becomes near-white. Anything relying on `bg-muted` for contrast against `bg-card` loses it |
| `--muted-foreground` | `--muted-foreground` | `#4a5478` → `ink-subtle #6e7681` | lighter; only AA on white/surface-muted, check every use on darker fills |
| `--border` / `--input` | same | navy `#12225c` → `#d6dbe1` | **drift**: was a 2 to 3px dark outline; becomes a hairline. All `border-2`, `border-[2.5px]`, `border-*-[3px]` must drop to 1px |
| `--destructive` | `--destructive` | same rust | none |
| `--sidebar*` | `--sidebar*` | wall/navy/yellow → surface/line/blue | same drifts as above |
| `--chart-2` | `--chart-2` | yellow → `#7fa6e8` | |
| `--radius` | `--radius` | 6px → 5px | |
| `--radius-sm` | `--radius-sm` | 4px → 5px | |
| `--radius-md` | `--radius-md` | 6px → 8px | **drift**: md moves from cards to sheets only |
| `--radius-lg`, `xl`…`4xl` | none | removed | 8 `rounded-lg` and 5 `rounded-xl` uses need a target radius |
| `--jn-cobalt` / `-dark` / `-light` | `--oc-blue` / `--oc-blue-hover` / none | same hex for the first two; `cobalt-light` has no target | `cobalt-light` was the agent color; its 5 uses move to `agent` tokens or `primary-line` |
| `--jn-navy`, `-deep`, `-panel`, `-inset` | none | removed | used as border, text, gradients, scrim (`bg-navy-deep/55`) |
| `--jn-yellow` / `-dark` | `--oc-agent` / none | same hex; meaning changes entirely | **drift**: CTA → agent authorship |
| `--jn-cream`, `-hi`, `-wall`, `-mortar`, `-board` | `--oc-surface`, `-surface-muted`, `-canvas` | | one-to-many collapse |
| `--jn-rust` / `-dark` | `--oc-danger` / `-hover` | same | |
| `--jn-metal`, `-dark` | none | removed | `jn-steel` only |
| `--jn-muted-ink` | `--oc-ink-muted` | `#4a5478` → `#59606b` | |
| `--jn-muted-panel-ink` | none | removed | |
| `--jn-outline` | `--border` | navy → hairline | |
| `--jn-edge`, `-mount`, `-recess` | none | removed; overlays get `--oc-overlay-shadow` | |
| `--jn-ease` (spring) | `--ease-ui` | overshoot → ease-out | |
| `--jn-wall-image`, `-noise-image` | none | removed | |
| `--font-sans` | `--font-sans` | Archivo → Inter | |
| `--font-mono` | `--font-mono` | Spline Sans Mono → JetBrains Mono | |
| `--font-sign` | none | removed | `ui/sign.ts` becomes a plain `h2` |
| `--text-body-md` | `--text-body-md` | 15px → 13px | base size drop |
| `--text-body-sm` | `--text-body-sm` | 13px → 12px | |
| `--text-label` | `--text-label` | 14.5px → 12.5px | |
| `--text-button` | `--text-label` | 14px → 12.5px | name removed |
| `--text-h2` / `h3` | same | 20/16px → 14/13px | |
| `--text-mono-sm` | `--text-mono-sm` | 11px → 11.5px | |
| `--text-mono-md` | `--text-mono-md` | 14.5px → 12.5px | |
| `--text-sign`, `-stamp`, `-display`, `-numeral` (27px) | none, none, none, `numeral` 11.5px | | **drift**: `numeral` survives as a name but shrinks from a 27px hero figure to an 11.5px table figure |
| none | `--text-h1`, `--text-caption`, `--text-mono-xs` | new | |
| none | `agent-ink`, `agent-wash`, `agent-line`, `wire`, `grid-line`, `success`, `primary-line`, `primary-wash`, `border-subtle`, `ink-faint` | new | `success` replaces the emerald classes |

Utility names to alias during Phases 1-3 then delete in Phase 4:
`cobalt*`, `navy*`, `panel`, `inset`, `yellow-safety*`, `cream*`, `wall`,
`mortar`, `board`, `rust*`, `metal*`, `outline`, `shadow-mount`,
`shadow-edge`, `shadow-recess`, `ease-switch`, `text-sign`, `text-stamp`,
`text-display`, `text-button`, `font-sign`, `jn-*`.

## 7. Gap list (questions, not decisions)

- **G1. Where does `DESIGN.md` live?** The task says repository root; the
  project keeps it at `docs/design/DESIGN.md` next to `theme.css`, and
  `styles.css` cites that path. Proposed: write to `docs/design/DESIGN.md`,
  delete `docs/design/theme.css`, and add a one-line root `DESIGN.md` pointer
  only if you want one. Confirm.
- **G2. Blueprint canvas has no host.** The rule editor is a vertical
  When / If / Then form, not a graph, and there is no PR-flow view. "Do not
  invent components" and "rule graphs render on a blueprint canvas" conflict.
  Proposed: restyle the existing three-step flow with the node, wire, column
  label and grid vocabulary inside its card (it is a degenerate graph of three
  nodes), and leave the layout-engine and YAML-fallback requirements as an
  open question. Alternative: keep it a plain form and record the canvas as
  unbuilt. Which?
- **G3. GitHub label colors.** Label pills use GitHub's own hex per label
  (`workspace.ts:1467-1479`, `activity.ts:403-412`). The target says label
  names are mono badges and nothing else is colored, but a repo's labels are
  user data. Proposed: neutral badge with the label color reduced to a small
  dot or left border, keeping the luminance helper for that mark. Confirm, or
  keep full-color pills.
- **G4. Syntax highlighting theme.** Appendix A does not specify one. The
  GitHub theme is neutral-ish but uses its own blues, purples and reds, which
  puts a third accent on the policy screen. Proposed: keep the GitHub theme
  in Phase 3, log it in `OPEN-QUESTIONS.md`, and offer a two-tone
  ink/ink-muted highlight as a follow-up.
- **G5. Fact references inside AI prompts** (`{{fact:title}}`) are tinted
  cobalt today. They are not interactive and not agent-written. Proposed:
  `surface-muted` background, `foreground-muted` text, mono.
- **G6. Mascot in the header.** The target forbids it inside the app. The
  only in-app use is the 32px logo at `main.ts:893`. Proposed: replace with a
  small text product mark ("The Janitor" in `label`). Favicons stay as-is.
  Confirm removal.
- **G7. Utility Room artifacts in `docs/`.** `docs/settings-mockups/` and
  `docs/design/theme.css` carry the old identity. Delete, keep as history, or
  leave untouched?
- **G8. Status tones.** The target has `success` and `danger` only. Today:
  session `Blocked`, recovery `overdue`, sync `failed targets`, delivery
  warnings, conflict notices, and test-bench `no-match` are amber. Proposed:
  `Blocked` and `overdue` and delivery warnings become neutral text with an
  icon; failures become `danger`; `no-match` becomes neutral. Confirm.
- **G9. Repository tile tone ramp** (12 hexes in `repository-switcher.ts`).
  No neutral equivalent in the target. Proposed: mono initials mark on
  `surface-muted` with a hairline, no per-repo color.
- **G10. Manifest `theme_color`.** Proposed: `#f4f6f8` (canvas) light; there
  is no per-scheme manifest color. Or `#1e5fd0`? Pick one.
- **G11. Layout widths.** Sidebar is 256px, inspectors 280px and 300px,
  breakpoints 1200/900/640. Target says 216px, 292px, 1240/820. Layout is out
  of scope, but the tokens disagree. Proposed: adopt the target widths and
  breakpoints as a pure dimension change, no structural change. Confirm.
- **G12. Sessions "Working" pill.** Target: the top-bar status pill uses an
  `agent` dot when the agent is running. The app has no top-bar status pill;
  the nearest thing is the sync button. Proposed: give the session execution
  badge the agent dot and leave the header alone.
- **G13. Test baselines.** No snapshot or visual-regression baselines exist.
  Tests assert on class strings in places (`workspace.test.ts:714-724` and
  others); those will be updated as they break. Screenshots will be taken
  manually per the verification list. Confirm that no baseline tooling should
  be added.
- **G14. `--primary` on `<a>`.** Appendix B colors every anchor blue. The
  sidebar and rack render navigation as anchors and many rows are anchors;
  target says rows are grey with `primary-wash` on selection. Proposed: base
  rule applies, navigation components override to `foreground`. Confirm.

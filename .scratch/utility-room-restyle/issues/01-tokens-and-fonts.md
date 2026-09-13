# Replace the theme tokens and load the Utility Room fonts

Status: ready-for-agent
Parent: ../spec.md
Blocked by: none

## Task

Swap the shadcn oklch palette in `apps/web/src/styles.css` for the Utility Room tokens, keeping every semantic token name so the 21 files that use `bg-card`, `text-muted-foreground`, `bg-sidebar-accent` and friends keep compiling. Check the design doc into the repo.

## Steps

1. `docs/design/DESIGN.md` is already checked in. Add the two recorded deviations from the spec (filled destructive button, warm-charcoal night shift) to its Buttons and Colors sections.
2. In `styles.css`:
   - Keep `@import "tailwindcss"` and `@import "tw-animate-css"`. Remove `@import "@fontsource-variable/geist"`.
   - Replace the `:root` block (`styles.css:74-108`) with the `--jn-*` brand tokens and the light semantic mapping from `docs/design/theme.css` (sections 1 and 2). `--radius` becomes `6px`.
   - Extend `@theme inline` (`styles.css:7-72`) with the brand colour aliases (`--color-cobalt`, `--color-navy`, `--color-yellow-safety`, `--color-cream`, `--color-wall`, `--color-rust`, `--color-metal`, ...), `--font-sans: "Archivo"`, `--font-sign: "Big Shoulders Display"`, `--font-mono: "Spline Sans Mono"`, the `--text-*` scale, `--radius-xs|sm|md|lg`, `--shadow-mount|edge|recess`, and `--ease-switch`. Keep the existing `--radius-xl..4xl` derivations so current `rounded-xl` usages do not break.
   - Add the `@utility` blocks: `jn-mount`, `jn-recess`, `jn-sign`, `jn-screw`, `jn-press`, `jn-hazard`, `jn-steel`, `jn-perforated`, `jn-empty`, `jn-agent`, plus the `.jn-dense` density rules.
   - In `@layer base`, add the wall background image, the fractal-noise `body::before`, the yellow `:focus-visible` ring, and `p { max-width: 62ch }`.
   - Leave the policy workspace block (`styles.css:171-401`) untouched here; ticket 09 converts it.
3. Fonts: add `@fontsource-variable/archivo`, `@fontsource/big-shoulders-display` (weights 700 and 800), and `@fontsource-variable/spline-sans-mono` to `apps/web/package.json` and import them at the top of `styles.css`. Verify each package exists on npm before adding; if a variable build is missing, import the static weights listed in the spec's Risks section. Remove `@fontsource-variable/geist`.
4. Run `vp check` and `vp test`. Nothing should fail beyond formatting.

## Done when

- `vp dev` renders the app on the cinderblock wall with Archivo body text and no oklch values left in `styles.css`.
- `docs/design/DESIGN.md` records the two deviations.

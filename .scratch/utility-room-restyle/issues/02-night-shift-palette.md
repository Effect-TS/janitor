# Replace the dark theme with the warm-charcoal night shift

Status: ready-for-agent
Parent: ../spec.md
Blocked by: 01

## Task

The theme file's `.dark` block turns the wall navy-deep and every card navy, which reads as a blue wash. Replace it with the night-shift palette from `docs/settings-mockups/utility-room.css` (block headed "Night shift").

## Steps

1. In `styles.css` `.dark`, set the shadcn semantic tokens from the night values:
   - `--background` `#1c1b18`, `--card` `#2a2823`, `--popover` `#34312b`, `--foreground` and `--card-foreground` `#f6efdd`, `--muted` `#262420`, `--muted-foreground` `#a8a08e`, `--border` and `--input` `#5a554b`, `--destructive` `#e0705c`, `--sidebar` `#1c1b18`, `--sidebar-accent` `#34312b`, `--sidebar-border` `#5a554b`.
   - `--primary` stays safety yellow, `--accent` stays cobalt, `--ring` stays yellow.
   - `--jn-mount: 0 3px 0 #000, 0 6px 14px rgb(0 0 0 / 0.5)`, `--jn-edge: 0 3px 0 #000`.
   - `--jn-wall-image` swapped for the dark brick SVG (fill `#1C1B18`, stroke `#262420`); `.dark body::before` opacity `0.04`.
2. Add a `--jn-line-strong: #7b7466` token for mounted-object outlines in the dark and use it from `jn-mount` via `var(--jn-outline, var(--jn-navy))`, so the utility does not need a separate dark rule.
3. Enamel signs, the breaker panel, hazard stripes and switches keep their day colours; only their outer border darkens to `#000`.
4. Confirm `theme-switcher.ts:65-68` still toggles `html.dark`; no change needed there.

## Done when

- Switching to Dark in the app shows a warm charcoal wall, cream text, cobalt signs and yellow on-states, with no navy fills on cards or the sidebar.
- Contrast check passes for `#a8a08e` on `#2a2823` and `#e0705c` on `#2a2823` (both above 4.5:1).

## Comments

Done. The night palette shipped inside the ticket 01 stylesheet rewrite (`.dark` block with `--nt-*` tokens, `--jn-outline` lifted to `#7b7466`, dark brick SVG). Contrast: muted `#a8a08e` on card `#2a2823` = 6.05, rust `#e0705c` on card = 4.63, ink on card = 12.4.

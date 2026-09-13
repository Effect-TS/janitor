# Add the Utility Room composition helpers

Status: ready-for-agent
Parent: ../spec.md
Blocked by: 03

## Task

Add small view helpers for the objects the mockups use so pages compose them rather than repeating class strings. Follow the `ui/*` pattern: exported class strings plus a builder taking `HtmlBuilder` and `data-slot`.

## Components

| File          | Builder                                                 | Notes                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/sign.ts`  | `sign(h, { id, children })`                             | `h2.jn-sign font-sign uppercase text-sign` with a leading `span.jn-screw`. One per section.                                                                                                                |
| `ui/panel.ts` | `panel(h, { flush?, children })`                        | `bg-card text-card-foreground jn-mount`; `flush` removes padding for row lists.                                                                                                                            |
| `ui/rack.ts`  | `rack(h, { label, items: [{ href, label, current }] })` | Steel rail (`div.jn-steel h-[14px] rounded-xs` with two screw dots) and `a.jn-tag` items with `aria-current="page"` on the active one. Vertical by default; horizontal wrap below 880px via `md:` classes. |
| `ui/mark.ts`  | `platformMark(h, platform)` and `avatar(h, initials)`   | 30px and 34px bordered squares, mono letters ("GH", "SL", initials). No logos.                                                                                                                             |
| `ui/empty.ts` | `emptyPanel(h, { children })`                           | `panel` plus `jn-empty` and `p-[18px]`.                                                                                                                                                                    |

Move the `.jn-tag` and `.jn-switch` rules from the mockup stylesheet into `styles.css` under `@layer components` if ticket 01 did not already, since the tag builder depends on them. The switch is not used by the Account page but belongs with the system.

## Done when

- A scratch page or the Account page (ticket 06) renders a sign, a panel, a rack with three tags and two platform marks using only these helpers.
- `vp check` passes.

## Comments

Done: `ui/sign.ts`, `ui/panel.ts` (with `emptyPanel`), `ui/rack.ts`, `ui/mark.ts` (`platformMark`, `avatar`, `initialsOf`). The tag and switch CSS landed in `styles.css` under ticket 01.

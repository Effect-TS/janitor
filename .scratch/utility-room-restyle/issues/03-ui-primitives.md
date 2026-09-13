# Restyle the shared UI primitives

Status: ready-for-agent
Parent: ../spec.md
Blocked by: 01

## Task

Bring `apps/web/src/components/ui/*` and `theme-switcher.ts` onto the Utility Room look. All primitives are plain class strings composed with `cn()` and carry `data-slot`; keep both conventions.

## Steps

1. `ui/button.ts`
   - `buttonBase` (`:55-56`): `rounded-sm border-[2.5px] font-bold text-button shadow-edge transition-[transform,box-shadow,background-color] active:translate-y-[3px] active:shadow-none disabled:opacity-50`. Drop the current `rounded-lg` and 1px translate.
   - `buttonVariants` (`:16-27`): `default` yellow fill, navy text, `border-navy`, hover `bg-yellow-safety-dark`; `destructive` rust fill, cream text, `border-rust-dark shadow-[0_3px_0_var(--jn-rust-dark)]`, hover `bg-rust-dark`; `outline` and `secondary` cream fill, navy border, hover `bg-cream-hi`; `ghost` transparent, `border-dashed`, no shadow, no press travel; `link` no border, cobalt-dark text, underline.
   - `buttonSizes`: keep the keys; `sm` becomes `px-3 py-1.5 text-body-sm`.
2. `ui/input.ts`: `inputClass` to `border-2 border-navy rounded-sm bg-cream shadow-[inset_0_2px_0_rgb(18_34_92/0.1)] focus:bg-cream-hi`. Labels use `text-label font-semibold`; descriptions `text-body-sm text-muted-foreground`.
3. `ui/skeleton.ts`: `bg-mortar rounded-xs animate-pulse`.
4. `ui/sidebar.ts`: `sidebarHeaderClass`, `sidebarContentClass`, `sidebarFooterClass` unchanged; `sidebarMenuButtonClass` (`:549`) gets `rounded-sm text-body-sm font-medium hover:bg-cream data-[active=true]:bg-cream`; the group label (`:456`) becomes mono `text-mono-sm text-muted-foreground`; `sidebarInsetClass` (`:790`) unchanged; the sidebar container gets `border-r-2 border-navy`.
5. `ui/sheet.ts`, `ui/command.ts`, `ui/input-group.ts`, `ui/textarea.ts`: replace soft shadows and `rounded-lg`/`rounded-xl` with `jn-mount` and `rounded-md`; overlays become `bg-navy-deep/55` with no blur.
6. `theme-switcher.ts:285-291`: the inline `buttonClassName`, `itemsClassName`, `backdropClassName` strings get the same treatment (cream menu with `jn-mount`, yellow on the selected item).
7. Add a `chip` variant map to a new `ui/chip.ts`: `neutral` (mortar fill, navy border), `on` (yellow), `danger` (transparent, rust text and border), `agent` (cobalt-light). Mono `text-mono-sm`, `rounded-full`, `data-slot="chip"`.

## Done when

- Every page still renders with `vp dev`; no `rounded-lg` or `shadow-sm|md|lg` classes remain under `ui/`.
- `vp check` passes.

## Comments

Done. Also restyled the repository switcher trigger and rows (they hard-coded the old outline classes) and updated its test to expect the 2px border. `ui/chip.ts` added.

# Restyle the app shell

Status: ready-for-agent
Parent: ../spec.md
Blocked by: 03

## Task

Bring `apps/web/src/main.ts` sidebar and header in line with the mockup's shell (`07-sidebar-sections.html`, `.sidebar` / `.inset-head`). Structure stays the same: 16rem sidebar with brand, repository switcher, Repository group, Account footer link; 48px inset header with the page title and tools.

## Steps

1. Brand header (`main.ts` `brandHeader`): cobalt disc with a navy ring and cream inset, "The Janitor" in `font-bold`.
2. Repository switcher trigger (`components/repository-switcher.ts`): cream, 2px navy border, `rounded-sm`, mono repository name, chevron on the right.
3. `navMain` (`:900-958`): keep icons; the group label reads "Repository" in mono muted; active item `bg-cream font-semibold`. Delete the `.repository-nav-link` hand-written rule from `styles.css` once the classes cover it.
4. `accountLink` (`:960-981`): same treatment; keep `aria-current`.
5. `mainHeader` (`:999-1090`): `h-12 border-b-2 border-navy bg-card text-body-sm font-semibold`; the sync button and theme switcher become 28px bordered squares (they are already restyled by ticket 03).
6. Toasts (`toastEntry` `:1092-1109`): `bg-card jn-mount rounded-md` and the variant borders become `border-rust`, `border-yellow-safety-dark`, `border-cobalt`.

## Done when

- The shell matches the mockup at 1400px and collapses correctly below 768px (existing `SIDEBAR_MOBILE_MEDIA_QUERY` behaviour unchanged).
- `vp check` and `vp test` pass; `navigation.test.ts` and `routing.test.ts` are unaffected.

/** Class strings for headless overlays (menus, popovers, tooltips, toasts).
 *  Overlays are the only shadowed elements in the system. */
export const menuButtonClass =
  "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border bg-card text-foreground text-label font-medium transition-colors duration-120 ease-ui hover:bg-surface-muted aria-expanded:bg-surface-muted disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"

export const menuItemsClass =
  "z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-overlay"

export const menuItemClass =
  "flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-body-md text-foreground transition-colors duration-120 ease-ui"

export const menuItemActiveClass = "bg-primary-wash"

export const menuBackdropClass = "fixed inset-0 z-40"

export const popoverContentClass =
  "z-50 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-overlay"

export const tooltipContentClass =
  "z-50 max-w-72 rounded-md border border-border bg-popover px-2.5 py-1.5 text-body-sm text-popover-foreground shadow-overlay"

export const toastClass =
  "pointer-events-auto w-96 rounded-md border border-border bg-popover px-4 py-3 text-body-md text-popover-foreground shadow-overlay"

export const toastTitleClass = "font-medium"

export const toastDescriptionClass = "text-ink-muted"

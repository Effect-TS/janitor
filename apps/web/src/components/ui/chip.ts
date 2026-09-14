import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Badge. Mono, 3px radius, neutral by default. `selected` is the only pill
 *  shape. `agent` is yellow and means The Janitor produced the thing; `success`
 *  and `danger` are genuine state, never emphasis. */
export type ChipVariant = "neutral" | "selected" | "success" | "danger" | "agent"

export const chipClass =
  "inline-flex h-6 max-w-full items-center gap-1.5 truncate whitespace-nowrap rounded-xs border border-border bg-surface-muted px-2 font-mono text-mono-sm font-medium leading-none text-foreground"

export const chipVariants: Record<ChipVariant, string> = {
  neutral: "",
  selected: "rounded-full border-primary-line bg-primary-wash text-primary-hover",
  success: "border-success bg-success text-primary-foreground",
  danger: "border-destructive bg-destructive text-destructive-foreground",
  agent: "border-agent-line bg-agent-wash text-agent-ink",
}

export type ChipConfig = {
  readonly variant?: ChipVariant
  readonly className?: string
  readonly children: ReadonlyArray<Html | string>
}

export const chip = <M>(h: HtmlBuilder<M>, config: ChipConfig): Html =>
  h.span(
    [
      h.Class(cn(chipClass, chipVariants[config.variant ?? "neutral"], config.className)),
      h.DataAttribute("slot", "badge"),
      h.DataAttribute("variant", config.variant ?? "neutral"),
    ],
    config.children,
  )

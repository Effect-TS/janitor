import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Status chip. Mono, pill-shaped, and the only element allowed a full radius.
 *  `on` is safety yellow and therefore rationed: one meaning, "this is on". */
export type ChipVariant = "neutral" | "on" | "danger" | "agent"

export const chipClass =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border-2 px-2 py-0.5 font-mono text-mono-sm font-semibold"

export const chipVariants: Record<ChipVariant, string> = {
  neutral: "border-outline bg-muted text-foreground",
  on: "border-yellow-safety-dark bg-yellow-safety text-navy",
  danger: "border-destructive bg-transparent text-destructive",
  agent: "border-cobalt-dark bg-cobalt-light text-navy-deep",
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
      h.DataAttribute("slot", "chip"),
    ],
    config.children,
  )

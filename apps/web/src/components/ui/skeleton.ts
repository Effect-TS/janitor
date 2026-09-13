import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

type Child = string | Html

export type SkeletonConfig = {
  readonly className?: string
  readonly children: ReadonlyArray<Child>
}

export const skeletonClass = "bg-muted rounded-xs animate-pulse"

export const skeleton = <M>(h: HtmlBuilder<M>, config: SkeletonConfig): Html =>
  h.div(
    [h.Class(cn(skeletonClass, config.className)), h.DataAttribute("slot", "skeleton")],
    config.children,
  )

import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

type Child = string | Html

export type SkeletonConfig = {
  readonly className?: string
  readonly children: ReadonlyArray<Child>
}

/** A static surface-muted block. Never a shimmer. */
export const skeletonClass = "rounded-xs bg-surface-muted"

export const skeleton = <M>(h: HtmlBuilder<M>, config: SkeletonConfig): Html =>
  h.div(
    [h.Class(cn(skeletonClass, config.className)), h.DataAttribute("slot", "skeleton")],
    config.children,
  )

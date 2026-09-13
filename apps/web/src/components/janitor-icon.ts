import type { Html, HtmlBuilder } from "foldkit/html"
import janitorLogoDarkUrl from "@/assets/janitor-logo-dark.png"
import janitorLogoLightUrl from "@/assets/janitor-logo-light.png"
import { cn } from "@/lib/utils"

export type JanitorIconConfig = {
  readonly className?: string
}

export const view = <M>(h: HtmlBuilder<M>, config: JanitorIconConfig): Html =>
  h.span(
    [
      h.DataAttribute("slot", "janitor-icon"),
      h.Class(
        cn("relative block overflow-hidden rounded-sm border-2 border-outline", config.className),
      ),
    ],
    [
      h.img([
        h.Src(janitorLogoLightUrl),
        h.Alt(""),
        h.Decoding("async"),
        h.Class("absolute inset-0 size-full object-cover dark:hidden"),
      ]),
      h.img([
        h.Src(janitorLogoDarkUrl),
        h.Alt(""),
        h.Decoding("async"),
        h.Class("absolute inset-0 hidden size-full object-cover dark:block"),
      ]),
    ],
  )

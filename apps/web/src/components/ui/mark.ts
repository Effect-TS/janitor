import type { LinkPlatform } from "@janitor/domain/Team/Account"
import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Small bordered squares carrying mono letters. No logos, no props. */
const markClass =
  "inline-flex shrink-0 items-center justify-center rounded-xs border border-border bg-surface-muted font-mono font-medium text-foreground"

export const platformMark = <M>(
  h: HtmlBuilder<M>,
  platform: LinkPlatform,
  className?: string,
): Html =>
  h.span(
    [h.Class(cn(markClass, "size-7 text-mono-sm", className)), h.AriaHidden(true)],
    [platform === "github" ? "GH" : "SL"],
  )

/** Two-letter initials for a teammate, from their email or subject. */
export const initialsOf = (name: string): string => {
  const local = name.split("@")[0] ?? name
  const parts = local.split(/[.\-_ ]+/).filter((part) => part.length > 0)
  const letters =
    parts.length >= 2 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : local.slice(0, 2)
  return letters.toUpperCase()
}

export const avatar = <M>(h: HtmlBuilder<M>, name: string, className?: string): Html =>
  h.span(
    [h.Class(cn(markClass, "size-8 text-mono-sm", className)), h.AriaHidden(true)],
    [initialsOf(name)],
  )

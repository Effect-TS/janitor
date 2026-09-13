import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@/lib/utils"

/** Activity feed entry. Agent entries take the agent marker and name
 *  "The Janitor" as the actor in agent-ink; human entries take a faint
 *  marker and a plain semibold actor. The marker is never the only carrier. */
export type FeedActor =
  | { readonly kind: "agent" }
  | { readonly kind: "human"; readonly name: string }

export const AGENT_NAME = "The Janitor"

export type FeedItemConfig<M> = {
  readonly actor: FeedActor
  readonly body: ReadonlyArray<Html | string>
  /** Machine timestamp, rendered in mono-xs at the right edge. */
  readonly timestamp?: string
  readonly className?: string
  readonly attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}

export const actorName = <M>(h: HtmlBuilder<M>, actor: FeedActor): Html =>
  actor.kind === "agent"
    ? h.span(
        [h.Class("text-label font-medium text-agent-ink"), h.DataAttribute("actor", "agent")],
        [AGENT_NAME],
      )
    : h.span([h.Class("text-label font-semibold")], [actor.name])

export const marker = <M>(h: HtmlBuilder<M>, actor: FeedActor): Html =>
  h.span(
    [
      h.Class(cn("mt-1.5", actor.kind === "agent" ? "oc-agent-dot" : "oc-human-dot")),
      h.AriaHidden(true),
    ],
    [],
  )

export const item = <M>(h: HtmlBuilder<M>, config: FeedItemConfig<M>): Html =>
  h.div(
    [
      h.Class(
        cn(
          "flex items-start gap-2.5 border-b border-border-subtle px-3 py-2 text-body-md last:border-b-0",
          config.className,
        ),
      ),
      h.DataAttribute("slot", "feed-item"),
      h.DataAttribute("actor", config.actor.kind),
      ...(config.attributes ?? []),
    ],
    [
      marker(h, config.actor),
      h.div(
        [h.Class("min-w-0 flex-1 leading-snug")],
        [actorName(h, config.actor), " ", ...config.body],
      ),
      ...(config.timestamp === undefined
        ? []
        : [
            h.span(
              [
                h.Class("shrink-0 font-mono text-mono-xs text-ink-subtle"),
                h.DataAttribute("slot", "feed-timestamp"),
              ],
              [config.timestamp],
            ),
          ]),
    ],
  )

/** Small "The Janitor" badge for content the agent wrote inline. */
export const agentBadge = <M>(h: HtmlBuilder<M>, text = AGENT_NAME): Html =>
  h.span(
    [h.Class("oc-agent-badge"), h.DataAttribute("slot", "agent-badge")],
    [h.span([h.Class("oc-agent-dot"), h.AriaHidden(true)], []), text],
  )

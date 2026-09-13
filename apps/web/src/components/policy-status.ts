import type { Html, HtmlBuilder } from "foldkit/html"
import { chip } from "@/components/ui/chip"

export type Publication = {
  readonly published: boolean
  readonly revision: number | null
  readonly changes: boolean
}
export const label = ({ published, revision, changes }: Publication): string =>
  !published
    ? "Not published"
    : changes
      ? "Draft"
      : revision === null
        ? "Published"
        : `Published · v${revision}`

/** Publication badge. "Published · vN" and "Not published" are neutral
 *  chips; "Draft" takes the `selected` chip because it marks the thing the
 *  user is editing right now, the one place blue-wash means "yours, in
 *  progress". Never yellow: publication is not agent authorship. */
export const view = <M>(h: HtmlBuilder<M>, status: Publication): Html =>
  chip(h, {
    variant: status.published && status.changes ? "selected" : "neutral",
    className: "policy-status-badge",
    children: [
      h.span(
        [
          h.DataAttribute(
            "publication-status",
            !status.published ? "unpublished" : status.changes ? "changes" : "published",
          ),
        ],
        [label(status)],
      ),
    ],
  })

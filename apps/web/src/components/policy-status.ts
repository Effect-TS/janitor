import type { Html, HtmlBuilder } from "foldkit/html"

export type Publication = {
  readonly published: boolean
  readonly revision: number | null
  readonly changes: boolean
}
export const label = ({ published, revision, changes }: Publication): string =>
  !published
    ? "Not published"
    : changes
      ? "Changes to publish"
      : revision === null
        ? "Published"
        : `Published · v${revision}`

export const view = <M>(h: HtmlBuilder<M>, status: Publication): Html =>
  h.span(
    [
      h.Class(
        `policy-status-badge ${!status.published ? "is-unpublished" : status.changes ? "has-changes" : "is-published"}`,
      ),
      h.DataAttribute(
        "publication-status",
        !status.published ? "unpublished" : status.changes ? "changes" : "published",
      ),
    ],
    [label(status)],
  )

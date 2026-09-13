import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { AiInputDetails, type AiInputReport } from "@/components/labeling-wire"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Button from "@/components/ui/button"
import * as Feed from "@/components/ui/feed"
import * as Icon from "@/lib/icons"
import { ChevronRight, Info, Scissors } from "lucide"

export const InputInspection = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Loading", {}),
  Schema.TaggedStruct("Ready", { details: AiInputDetails }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
])
export type InputInspection = typeof InputInspection.Type
const size = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`

const summaryClass =
  "flex cursor-pointer list-none items-center gap-1.5 text-body-sm font-medium text-foreground marker:hidden [&::-webkit-details-marker]:hidden"

const noteClass = "flex items-start gap-1.5 text-body-sm text-ink-muted"

/** Byte counts are machine values: mono, tabular. */
const bytes = <M>(h: HtmlBuilder<M>, text: string): Html =>
  h.span([h.Class("font-mono text-mono-sm tabular-nums")], [text])

export const aiInputView = <M>(
  h: HtmlBuilder<M>,
  report: AiInputReport | undefined,
  inspection: InputInspection,
  inspect: M,
  available: boolean,
): Html => {
  if (!report) return h.empty
  const shortened = report.status === "shortened"
  /** What the agent received, verbatim: mono on a muted surface with the agent edge. */
  const code = (text: string) =>
    h.pre(
      [
        h.Class(
          "oc-agent-edge mt-1.5 max-h-64 overflow-auto rounded-xs border border-border-subtle bg-surface-muted p-2 font-mono text-mono-sm whitespace-pre-wrap wrap-anywhere",
        ),
      ],
      [text],
    )
  const disclosure = (title: string, body: Html): Html =>
    h.details(
      [h.Class("group/disclosure")],
      [
        h.summary(
          [h.Class(summaryClass)],
          [
            Icon.view(h, ChevronRight, "size-3.5 shrink-0 group-open/disclosure:hidden"),
            Icon.view(
              h,
              ChevronRight,
              "size-3.5 shrink-0 rotate-90 hidden group-open/disclosure:block",
            ),
            title,
          ],
        ),
        body,
      ],
    )
  return h.details(
    [
      h.Class("group/report mt-3 rounded-sm border border-border p-2.5 text-body-sm"),
      h.DataAttribute("slot", "ai-input-report"),
    ],
    [
      h.summary(
        [h.Class(summaryClass)],
        [
          Icon.view(h, ChevronRight, "size-3.5 shrink-0 group-open/report:hidden"),
          Icon.view(h, ChevronRight, "size-3.5 shrink-0 rotate-90 hidden group-open/report:block"),
          shortened ? Icon.view(h, Scissors, "size-3.5 shrink-0 text-ink-subtle") : h.empty,
          shortened
            ? "AI input shortened"
            : report.status === "rejected"
              ? "AI input too large"
              : "AI input · Complete",
        ],
      ),
      h.p(
        [h.Class("mt-2 text-ink-muted")],
        report.status === "rejected"
          ? [
              "Input was not sent. ",
              bytes(h, size(report.originalBytes)),
              " before preparation; ",
              bytes(h, size(report.budgetBytes)),
              " limit.",
            ]
          : [
              bytes(h, size(report.suppliedBytes)),
              " of ",
              bytes(h, size(report.budgetBytes)),
              " input budget used, including reserved framing.",
            ],
      ),
      ...report.facts.map((fact) =>
        h.div(
          [h.Class("mt-2 flex flex-col gap-0.5")],
          [
            h.div(
              [h.Class("flex flex-wrap items-baseline gap-2")],
              [
                h.span(
                  [h.Class("font-mono text-mono-sm font-medium text-foreground")],
                  [fact.name],
                ),
                h.span(
                  [h.Class("text-ink-muted")],
                  report.status === "rejected"
                    ? [bytes(h, size(fact.originalBytes)), " · not sent"]
                    : [
                        bytes(h, size(fact.originalBytes)),
                        " → ",
                        bytes(h, size(fact.suppliedBytes)),
                      ],
                ),
              ],
            ),
            fact.omission
              ? h.p(
                  [h.Class(noteClass)],
                  [
                    Icon.view(h, Scissors, "mt-0.5 size-3.5 shrink-0"),
                    h.span(
                      [],
                      [
                        bytes(h, String(fact.omission.end - fact.omission.start)),
                        ` ${fact.omission.unit} omitted (`,
                        bytes(h, `${fact.omission.start + 1}–${fact.omission.end}`),
                        ").",
                      ],
                    ),
                  ],
                )
              : h.empty,
          ],
        ),
      ),
      h.p(
        [h.Class("mt-2 text-ink-muted")],
        [
          report.status === "rejected"
            ? "No evidence was sent to the AI provider."
            : "Only the referenced facts listed here were prepared. Other facts were not requested.",
        ],
      ),
      report.status === "rejected"
        ? h.empty
        : inspection._tag === "Ready"
          ? h.div(
              [h.Class("mt-3 flex flex-col gap-2")],
              [
                h.div([h.Class("flex")], [Feed.agentBadge(h, "sent to the model")]),
                disclosure(
                  "View sent input",
                  code(inspection.details.system + "\n\n" + inspection.details.text),
                ),
                ...report.facts
                  .filter((fact) => fact.omission)
                  .map((fact) => {
                    const source = inspection.details.facts.find(
                      (source) => source.name === fact.name,
                    )
                    let omitted = "Input details are unavailable."
                    if (source && fact.omission) {
                      const value: unknown = Schema.decodeUnknownOption(
                        Schema.fromJsonString(Schema.Unknown),
                      )(source.json).pipe(Option.getOrNull)
                      omitted =
                        typeof value === "string"
                          ? Array.from(value).slice(fact.omission.start, fact.omission.end).join("")
                          : Array.isArray(value)
                            ? JSON.stringify(
                                value.slice(fact.omission.start, fact.omission.end),
                                null,
                                2,
                              )
                            : omitted
                    }
                    return disclosure(`View omitted ${fact.name}`, code(omitted))
                  }),
                h.p(
                  [h.Class(noteClass)],
                  [
                    Icon.view(h, Info, "mt-0.5 size-3.5 shrink-0"),
                    h.span(
                      [],
                      ["This is the snapshot used for this test, not the current PR contents."],
                    ),
                  ],
                ),
              ],
            )
          : !available
            ? h.p(
                [h.Class("mt-2 text-ink-muted")],
                ["Input details are unavailable for this earlier result."],
              )
            : h.div(
                [h.Class("mt-2 flex flex-col gap-2")],
                [
                  inspection._tag === "Failed"
                    ? h.p([h.Role("alert"), h.Class("text-destructive")], [inspection.reason])
                    : h.empty,
                  h.div(
                    [h.Class("flex")],
                    [
                      Button.view(h, {
                        label: inspection._tag === "Loading" ? "Loading input…" : "Inspect input",
                        variant: "secondary",
                        size: "sm",
                        isDisabled: inspection._tag === "Loading",
                        onClick: inspect,
                      }),
                    ],
                  ),
                ],
              ),
    ],
  )
}

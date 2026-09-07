import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { AiInputDetails, type AiInputReport } from "@/components/labeling-wire"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Button from "@/components/ui/button"

export const InputInspection = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Loading", {}),
  Schema.TaggedStruct("Ready", { details: AiInputDetails }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
])
export type InputInspection = typeof InputInspection.Type
const size = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`

export const aiInputView = <M>(
  h: HtmlBuilder<M>,
  report: AiInputReport | undefined,
  inspection: InputInspection,
  inspect: M,
  available: boolean,
): Html => {
  if (!report) return h.empty
  const shortened = report.status === "shortened"
  const code = (text: string) =>
    h.pre(
      [
        h.Class(
          "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 text-[11px]",
        ),
      ],
      [text],
    )
  return h.details(
    [h.Class("mt-3 rounded-md border p-2 text-xs")],
    [
      h.summary(
        [
          h.Class(
            `cursor-pointer font-medium ${shortened ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`,
          ),
        ],
        [
          shortened
            ? "AI input shortened"
            : report.status === "rejected"
              ? "AI input too large"
              : "AI input · Complete",
        ],
      ),
      h.p(
        [h.Class("mt-2 text-muted-foreground")],
        [
          report.status === "rejected"
            ? `Input was not sent. ${size(report.originalBytes)} before preparation; ${size(report.budgetBytes)} limit.`
            : `${size(report.suppliedBytes)} of ${size(report.budgetBytes)} input budget used, including reserved framing.`,
        ],
      ),
      ...report.facts.map((fact) =>
        h.div(
          [h.Class("mt-2")],
          [
            h.strong([], [fact.name]),
            h.span(
              [h.Class("ml-2 text-muted-foreground")],
              [
                report.status === "rejected"
                  ? `${size(fact.originalBytes)} · not sent`
                  : `${size(fact.originalBytes)} → ${size(fact.suppliedBytes)}`,
              ],
            ),
            fact.omission
              ? h.p(
                  [h.Class("text-amber-700 dark:text-amber-400")],
                  [
                    `${fact.omission.end - fact.omission.start} ${fact.omission.unit} omitted (${fact.omission.start + 1}–${fact.omission.end}).`,
                  ],
                )
              : h.empty,
          ],
        ),
      ),
      h.p(
        [h.Class("mt-2 text-muted-foreground")],
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
              [h.Class("mt-3 space-y-3")],
              [
                h.details(
                  [],
                  [
                    h.summary([h.Class("cursor-pointer")], ["View sent input"]),
                    code(inspection.details.system + "\n\n" + inspection.details.text),
                  ],
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
                    return h.details(
                      [],
                      [
                        h.summary([h.Class("cursor-pointer")], [`View omitted ${fact.name}`]),
                        code(omitted),
                      ],
                    )
                  }),
                h.p(
                  [h.Class("text-muted-foreground")],
                  ["This is the snapshot used for this test, not the current PR contents."],
                ),
              ],
            )
          : !available
            ? h.p(
                [h.Class("mt-2 text-muted-foreground")],
                ["Input details are unavailable for this earlier result."],
              )
            : h.div(
                [h.Class("mt-2")],
                [
                  inspection._tag === "Failed"
                    ? h.p([h.Role("alert")], [inspection.reason])
                    : h.empty,
                  Button.view(h, {
                    label: inspection._tag === "Loading" ? "Loading input…" : "Inspect input",
                    variant: "outline",
                    isDisabled: inspection._tag === "Loading",
                    onClick: inspect,
                  }),
                ],
              ),
    ],
  )
}

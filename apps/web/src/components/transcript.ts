import type * as Prompt from "effect/ai/Prompt"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ChevronRight } from "lucide"
import * as Icon from "@/lib/icons"

/**
 * The pieces PR review's and chat's transcripts share (EFF-2445, EFF-3021).
 * Everything in a transcript may come from someone outside the team or from
 * the model, so it is shown as plain, preformatted text; nothing is rendered
 * as HTML or Markdown.
 */

const summaryClass =
  "flex cursor-pointer list-none items-center gap-1.5 text-body-sm font-medium text-ink-muted marker:hidden [&::-webkit-details-marker]:hidden"

/** Untrusted text, verbatim: mono, preformatted, never parsed. */
export const verbatim = <M>(h: HtmlBuilder<M>, text: string) =>
  h.pre(
    [
      h.Class(
        "max-h-96 overflow-auto rounded-xs border border-border-subtle bg-surface-muted p-2 font-mono text-mono-sm whitespace-pre-wrap wrap-anywhere",
      ),
    ],
    [text],
  )

/** Prose the model or a person wrote, verbatim but in the body font. */
export const prose = <M>(h: HtmlBuilder<M>, text: string) =>
  h.pre([h.Class("font-sans text-body-md whitespace-pre-wrap wrap-anywhere")], [text])

/** A collapsed block: tool calls and results are long, and the prose around them says what they did. */
export const disclosure = <M>(h: HtmlBuilder<M>, title: string, body: Html) =>
  h.details(
    [h.Class("group/disclosure")],
    [
      h.summary(
        [h.Class(summaryClass)],
        [
          Icon.view(
            h,
            ChevronRight,
            "size-3.5 shrink-0 transition-transform group-open/disclosure:rotate-90",
          ),
          title,
        ],
      ),
      h.div([h.Class("mt-1.5")], [body]),
    ],
  )

const json = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const partView = <M>(h: HtmlBuilder<M>, part: Prompt.Part): Html => {
  switch (part.type) {
    case "text":
      return prose(h, part.text)
    case "reasoning":
      // The model's working, not its conclusion.
      return disclosure(h, "Reasoning", verbatim(h, part.text))
    case "file":
      return h.p([h.Class("text-body-sm text-ink-muted")], [`File · ${part.mediaType}`])
    case "tool-call":
      return disclosure(h, `Tool call · ${part.name}`, verbatim(h, json(part.params)))
    case "tool-result":
      return disclosure(
        h,
        `Tool result · ${part.name}${part.isFailure ? " · failed" : ""}`,
        verbatim(h, json(part.result)),
      )
    case "tool-approval-request":
    case "tool-approval-response":
      return h.p([h.Class("text-body-sm text-ink-muted")], [`Tool approval · ${part.approvalId}`])
  }
}

/** What each agent history role is called on the page. */
export type RoleLabels = Record<Prompt.Message["role"], string>

/** One agent history message, numbered, with its tool calls and results collapsed. */
export const messageView = <M>(
  h: HtmlBuilder<M>,
  message: Prompt.Message,
  index: number,
  labels: RoleLabels,
) =>
  h.li(
    [
      h.Class("flex flex-col gap-2 rounded-md border border-border bg-card p-3"),
      h.DataAttribute("role", message.role),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-2 text-caption font-medium text-ink-subtle")],
        [
          h.span([], [labels[message.role]]),
          h.span([h.Class("font-mono tabular-nums")], [`#${index + 1}`]),
        ],
      ),
      ...(typeof message.content === "string"
        ? [prose(h, message.content)]
        : message.content.map((part) => partView(h, part))),
    ],
  )

/** The page's one-line state: loading, empty or gone. */
export const status = <M>(h: HtmlBuilder<M>, text: string) =>
  h.p(
    [
      h.Role("status"),
      h.Class("rounded-lg border border-border bg-card px-4 py-3 text-body-sm text-ink-muted"),
    ],
    [text],
  )

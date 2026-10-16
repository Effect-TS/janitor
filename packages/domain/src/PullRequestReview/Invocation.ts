import * as Option from "effect/Option"

/**
 * Whether a pull request comment invokes janitor (EFF-1644), ported from the
 * issue review parser at janitor `7ec1d68`. The command must appear outside
 * quoted text, code spans, fenced blocks, link destinations and HTML
 * comments: those are evidence a commenter may be citing, not a request
 * they are making. Trusted code decides this; the model never does.
 */

/** The slash command a comment must contain to invoke a review. */
export const REVIEW_COMMAND = "/janitor"

/** A direct `/janitor` request. */
export interface Invocation {
  /**
   * The invoker guidance: the comment's text after the first direct command,
   * trimmed, and empty when there is none. It is capped where the prompt is
   * assembled, not here.
   */
  readonly guidance: string
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Blanks a region but keeps its length and line breaks, so offsets still
 * match the body. The placeholder isn't whitespace, so a blanked region
 * can't turn the rest of its line into indented code.
 */
const BLANK = "\u0000"
const blank = (region: string) => region.replace(/[^\n]/g, BLANK)

/**
 * Blanks the regions whose text cannot carry an invocation. Fenced blocks go
 * first (a closing fence may be longer than the opener), so a `>` or a
 * backtick inside a fence is not misread; then `<pre>` and `<code>` HTML,
 * indented code lines, blockquote lines, HTML comments, code spans, link
 * destinations and autolinks.
 */
const withoutEvidence = (body: string): string =>
  body
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[`~]*[ \t]*(?:\n|$)|$)/gm, blank)
    .replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blank)
    .replace(/^(?: {4}|\t).*$/gm, blank)
    .replace(/^[ \t]*>.*$/gm, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(`+)[^`][\s\S]*?\1/g, blank)
    .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, (destination) => `](${blank(destination.slice(2))}`)
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, blank)
    .replaceAll(BLANK, " ")

const command = new RegExp(
  `(^|[^A-Za-z0-9_/@.:-])${escape(REVIEW_COMMAND)}(?=$|\\s|[.,!?;:)](?=\\s|$)|\\])`,
  "i",
)

/** The invocation `body` makes, if it makes one. */
export const parseInvocation = (body: string): Option.Option<Invocation> => {
  const match = command.exec(withoutEvidence(body))
  if (match === null) return Option.none()
  const end = match.index + match[1]!.length + REVIEW_COMMAND.length
  return Option.some({ guidance: body.slice(end).trim() })
}

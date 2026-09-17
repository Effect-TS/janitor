/**
 * Whether a comment invokes Janitor directly (ADR 0007). The mention must
 * appear outside quoted text, code spans, fenced blocks, link destinations
 * and HTML comments: those are evidence a commenter may be citing, not a
 * request they are making. Trusted code decides this; the model never does.
 */

/** The GitHub handle a comment must mention to invoke issue review. */
export const REVIEW_MENTION_HANDLE = "effect-janitor"

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Removes the regions whose text cannot carry an invocation. Fenced blocks
 * go first (a closing fence may be longer than the opener), so a `>` or a
 * backtick inside a fence is not misread; then `<pre>` and `<code>` HTML,
 * indented code lines, blockquote lines, HTML comments, code spans, link
 * destinations and autolinks. Removed regions become spaces so word
 * boundaries survive.
 */
const withoutEvidence = (body: string): string =>
  body
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[`~]*[ \t]*(?:\n|$)|$)/gm, " ")
    .replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/^(?: {4}|\t).*$/gm, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(`+)[^`][\s\S]*?\1/g, " ")
    .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "]( )")
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, " ")

/** True when `body` mentions `handle` as a direct request rather than as evidence. */
export const mentionsDirectly = (body: string, handle: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_/@.-])@${escape(handle)}(?![A-Za-z0-9-])`, "i").test(
    withoutEvidence(body),
  )

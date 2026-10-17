/**
 * Everything janitor writes to GitHub for a PR review: the review body, inline
 * comments, thread replies and the `janitor/review` check run output, plus the
 * hidden markers read back from them. Pure text building.
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Judgement, Severity } from "./Finding.ts"
import { Fingerprint } from "./Fingerprint.ts"
import type { SkipReason, Verdict } from "./Run.ts"
import type { Actor, ThreadReply, ThreadState } from "./Threads.ts"
import type { GateFailure } from "./Verdict.ts"

const fenceOpening = /^ {0,3}(`{3,}|~{3,})(.*)$/
const fenceClosing = /^ {0,3}(`{3,}|~{3,})\s*$/

/**
 * Splits markdown into prose and fenced code blocks. A block left open is
 * closed at the end, so model text can't swallow what janitor writes after it.
 */
const splitFences = (markdown: string) => {
  const blocks: Array<{ readonly code: boolean; readonly lines: Array<string> }> = []
  let fence: string | undefined
  for (const line of markdown.split("\n")) {
    if (fence === undefined) {
      const opening = fenceOpening.exec(line)
      if (opening !== null && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) {
        fence = opening[1]!
        blocks.push({ code: true, lines: [line] })
        continue
      }
      const last = blocks.at(-1)
      if (last !== undefined && !last.code) last.lines.push(line)
      else blocks.push({ code: false, lines: [line] })
      continue
    }
    blocks.at(-1)!.lines.push(line)
    const closing = fenceClosing.exec(line)
    if (closing !== null && closing[1]![0] === fence[0] && closing[1]!.length >= fence.length) {
      fence = undefined
      blocks.push({ code: false, lines: [] })
    }
  }
  if (fence !== undefined) blocks.at(-1)!.lines.push(fence)
  return blocks.filter((block) => block.lines.length > 0)
}

/** Splits one paragraph into text and code spans; an unmatched backtick run is text. */
const splitCodeSpans = (paragraph: string) => {
  const parts: Array<{ readonly code: boolean; readonly text: string }> = []
  const runs = /`+/g
  let start = 0
  for (let run = runs.exec(paragraph); run !== null; run = runs.exec(paragraph)) {
    // Only the first backtick of a run can be escaped. Inside a code span,
    // backslashes are literal, so they do not escape its closing delimiter.
    let backslashes = 0
    for (let index = run.index - 1; index >= 0 && paragraph[index] === "\\"; index--) {
      backslashes++
    }
    const escaped = backslashes % 2
    const opening = run[0].slice(escaped)
    if (opening === "") continue
    const openingIndex = run.index + escaped
    const closing = new RegExp("(?<!\x60)" + opening + "(?!\x60)", "g")
    closing.lastIndex = run.index + run[0].length
    const close = closing.exec(paragraph)
    if (close === null) continue
    const end = close.index + opening.length
    parts.push({ code: false, text: paragraph.slice(start, openingIndex) })
    parts.push({ code: true, text: paragraph.slice(openingIndex, end) })
    start = end
    runs.lastIndex = end
  }
  parts.push({ code: false, text: paragraph.slice(start) })
  return parts
}

const zeroWidthSpace = "​"

/** Images can contain code spans in their alt text, but not start inside code. */
const stripImagesOnce = (paragraph: string) => {
  let offset = 0
  const codeSpans = splitCodeSpans(paragraph).flatMap((part) => {
    const start = offset
    offset += part.text.length
    return part.code ? [{ start, end: offset }] : []
  })
  let spanIndex = 0
  return paragraph.replace(
    /!\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])?/g,
    (image: string, alt: string, index: number) => {
      while (spanIndex < codeSpans.length && codeSpans[spanIndex]!.end <= index) spanIndex++
      const span = codeSpans[spanIndex]
      return span !== undefined && span.start <= index ? image : alt
    },
  )
}

const stripImages = (paragraph: string): string => {
  // Removing an inner image can expose an outer one. Each changed pass is
  // strictly shorter, and each pass still leaves literal code untouched.
  while (true) {
    const stripped = stripImagesOnce(paragraph)
    if (stripped === paragraph) return stripped
    paragraph = stripped
  }
}

const sanitiseText = (text: string) =>
  text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g, "")
    .replace(/<(?=[A-Za-z!/?])/g, "&lt;")
    // `/` is left alone so `https://host/@user` paths still work.
    .replace(/(?<![\w/])@(?=[A-Za-z0-9])/g, `@${zeroWidthSpace}`)
    // Starting only at a token boundary keeps this linear on long runs of word characters.
    .replace(/(?<![\w.-])([\w.-]+\/[\w.-]+)#(?=\d)/g, `$1#${zeroWidthSpace}`)

/**
 * Makes model text safe to post: breaks `@user` and `@org/team` mentions and
 * cross-repo `owner/repo#123` references outside code, strips raw HTML and
 * remote images, and keeps ordinary links and `suggestion` fences.
 */
export const sanitise = (markdown: string): string =>
  splitFences(markdown)
    .map((block) => {
      const text = block.lines.join("\n")
      if (block.code) return text
      // Code spans never cross a blank line, so each paragraph is split on its own.
      return text
        .split(/(\n[ \t]*\n)/)
        .map((paragraph) =>
          splitCodeSpans(stripImages(paragraph))
            .map((part) => (part.code ? part.text : sanitiseText(part.text)))
            .join(""),
        )
        .join("")
    })
    .join("\n")

/** Cuts text to at most `length` UTF-16 code units without splitting a surrogate pair. */
const cut = (text: string, length: number) => {
  if (text.length <= length) return text
  const end = length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1]!) ? length - 1 : length
  return text.slice(0, Math.max(0, end))
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

const code = (text: string) => `\`${text}\``

const unfinishedReasons: Record<Extract<GateFailure, { _tag: "Unfinished" }>["outcome"], string> = {
  steered: "the review had to be told to wrap up",
  interrupted: "the review hit its deadline",
  errored: "the review stopped on a provider error",
}

/** Why approval was withheld, or `undefined` for blocking findings, which are listed instead. */
const gateReason = (failure: GateFailure): string | undefined => {
  switch (failure._tag) {
    case "HeadMoved":
      return "the head moved during the review"
    case "Unfinished":
      return unfinishedReasons[failure.outcome]
    case "BlockingFindings":
      return undefined
    case "Closed":
      return "the pull request is closed"
    case "Draft":
      return "the pull request is a draft"
    case "BaseChanged":
      return "the base branch changed during the review"
    case "Forced":
      return "a forced review of an oversized pull request never approves"
    case "SensitivePaths":
      return `touches ${failure.paths.map(code).join(", ")}, needs a human approval`
  }
}

const notApproved = (failures: ReadonlyArray<GateFailure>) => {
  const reasons = failures.flatMap((failure) => gateReason(failure) ?? [])
  return reasons.length === 0 ? undefined : `Not approved: ${reasons.join("; ")}.`
}

/** GitHub rejects a review body of 65,536 characters or more. */
export const reviewBodyLimit = 65_536

/** Ends every `REQUEST_CHANGES` body: reply in the thread, or a maintainer can `/janitor` or dismiss. */
export const disputeFooter =
  "Disagree? Reply in the finding's thread, or a maintainer can comment `/janitor` to re-run or dismiss this review."

/** A finding that couldn't go inline: overflow past the inline limit, or an unanchorable file. */
export interface ListedFinding {
  readonly path: string
  readonly line: number
  readonly severity: Severity
  readonly comment: string
}

export interface ReviewBodyInput {
  readonly reviewedSha: string
  readonly event: Verdict
  /** From `taskComplete`; empty on a partial review that never got there. */
  readonly summary: string
  readonly partial: boolean
  readonly inline: ReadonlyArray<{ readonly severity: Severity }>
  readonly listed: ReadonlyArray<ListedFinding>
  readonly gateFailures: ReadonlyArray<GateFailure>
}

const partialNotice =
  "**Partial review.** The run ended before it finished, so this lists only the findings reported so far, and it can't approve."

const truncationNotice = "_Truncated to fit GitHub's limit on review length._"

/**
 * Cuts sanitised Markdown to at most `length` characters, notice included.
 * Closing a fence the cut left open can add as much again as its opener, so
 * the cut moves back until the closed text fits.
 */
const truncate = (markdown: string, length: number) => {
  const room = Math.max(0, length - truncationNotice.length - 2)
  let end = room
  let kept = sanitise(cut(markdown, end))
  while (kept.length > room) {
    end -= kept.length - room
    kept = sanitise(cut(markdown, end))
  }
  return `${kept}\n\n${truncationNotice}`
}

const counts = (input: ReviewBodyInput) => {
  const severities = [...input.inline, ...input.listed].map((finding) => finding.severity)
  const blocking = severities.filter((severity) => severity === "blocking").length
  const nits = severities.length - blocking
  return severities.length === 0
    ? `Reviewed at ${input.reviewedSha}: no new findings.`
    : `Reviewed at ${input.reviewedSha}: ${blocking} blocking, ${plural(nits, "nit")}.`
}

const listed = (input: ReviewBodyInput, severity: Severity, heading: string) => {
  const findings = input.listed.filter((finding) => finding.severity === severity)
  return findings.length === 0
    ? []
    : [
        heading,
        ...findings.map((finding) => {
          const comment = sanitise(finding.comment)
          // Prefixing a fence with the location turns it into prose. Keep
          // multiline Markdown on its own so its block boundaries survive.
          const separator = comment.includes("\n") ? "\n\n" : " "
          return `${code(`${finding.path}:${finding.line}`)} —${separator}${comment}`
        }),
      ]
}

/** Empty for an approval, which stays silent; always under `reviewBodyLimit`. */
export const reviewBody = (input: ReviewBodyInput): string => {
  if (input.event === "approve") return ""
  const summary = sanitise(input.summary.trim())
  const tail = input.event === "request_changes" ? `\n\n${disputeFooter}` : ""
  const head = (summary: string) =>
    [
      ...(input.partial ? [partialNotice] : []),
      ...(summary === "" ? [] : [summary]),
      counts(input),
      ...listed(input, "blocking", "Blocking findings that couldn't go inline:"),
      ...listed(input, "nit", "Nits that couldn't go inline:"),
      ...(input.event === "approve" ? [] : [notApproved(input.gateFailures)]),
    ]
      .filter((section) => section !== undefined)
      .join("\n\n")
  const budget = reviewBodyLimit - 1 - tail.length
  let body = head(summary)
  if (body.length > budget) {
    // Shorten the summary first so the listed findings and gate reasons survive.
    const room = summary.length - (body.length - budget)
    body =
      room > truncationNotice.length + 2
        ? head(truncate(summary, room))
        : truncate(head(""), budget)
  }
  return `${body}${tail}`
}

/** The last marker wins: janitor's own ends the text, after anything quoted in model output. */
const lastMatch = (pattern: RegExp, text: string) =>
  Option.fromNullishOr([...text.matchAll(pattern)].at(-1))

const decodeFingerprint = Schema.decodeUnknownOption(Fingerprint)

/**
 * The finding's sanitised comment plus a hidden marker with its fingerprint
 * and, when given, its severity, so a later run knows whether the thread
 * blocks.
 */
export const inlineComment = (finding: {
  readonly comment: string
  readonly fingerprint: Fingerprint
  readonly severity?: Severity
}): string =>
  `${sanitise(finding.comment.trim())}\n\n<!-- janitor:finding fingerprint=${finding.fingerprint}${
    finding.severity === undefined ? "" : ` severity=${finding.severity}`
  } -->`

const findingMarker = /<!-- janitor:finding fingerprint=(\S+?)(?: severity=(blocking|nit))? -->/g

export const parseFingerprintMarker = (comment: string): Option.Option<Fingerprint> =>
  lastMatch(findingMarker, comment).pipe(Option.flatMap((match) => decodeFingerprint(match[1])))

/** The severity in a finding marker; absent from markers written before it was added. */
export const parseSeverityMarker = (comment: string): Option.Option<Severity> =>
  lastMatch(findingMarker, comment).pipe(
    Option.flatMap((match) => Option.fromNullishOr(match[2] as Severity | undefined)),
  )

/**
 * What janitor stated in one of its thread replies, and the thread's state
 * when it did, so a later run can tell what has happened since.
 */
export interface ReplyMarker {
  readonly judgement: Judgement
  readonly outdated: boolean
  readonly resolved: boolean
}

/** The hidden marker trusted code ends each thread reply with. */
export const replyMarker = (marker: ReplyMarker): string =>
  `<!-- janitor:reply judgement=${marker.judgement} outdated=${marker.outdated} resolved=${marker.resolved} -->`

/** The last reply marker in a comment; replies written before markers have none. */
export const parseReplyMarker = (comment: string): Option.Option<ReplyMarker> =>
  lastMatch(
    /<!-- janitor:reply judgement=(still_applies|addressed|withdrawn) outdated=(true|false) resolved=(true|false) -->/g,
    comment,
  ).pipe(
    Option.map((match) => ({
      judgement: match[1] as Judgement,
      outdated: match[2] === "true",
      resolved: match[3] === "true",
    })),
  )

/** Characters of the agent's `note` kept in a thread reply. */
export const replyNoteCap = 1_000

/**
 * "Addressed in" the head SHA, "Withdrawn:", or "Still applies at" the
 * permalink, followed by the sanitised and capped note.
 */
export const threadReplyBody = (
  reply: ThreadReply,
  context: { readonly headSha: string },
): string => {
  const raw = reply.note?.trim() ?? ""
  const note =
    raw === ""
      ? undefined
      : sanitise(raw.length > replyNoteCap ? `${cut(raw, replyNoteCap)}…` : raw)
  const lead: Record<Judgement, string> = {
    addressed: `Addressed in ${context.headSha}.`,
    withdrawn: note === undefined ? "Withdrawn." : "Withdrawn:",
    still_applies:
      reply.stillAppliesAt === undefined
        ? "Still applies."
        : `Still applies at ${reply.stillAppliesAt}`,
  }
  return note === undefined ? lead[reply.judgement] : `${lead[reply.judgement]}\n\n${note}`
}

/** One of janitor's threads with a link to it, as the check run lists it. */
export interface ThreadLink {
  readonly url: string
  readonly state: ThreadState
  readonly outdated: boolean
  readonly resolvedBy?: Actor
}

/**
 * Why a run ended without a review: checkout, no sandbox before the deadline,
 * too many lost sandboxes, an unfinished run, or GitHub refusing the review.
 */
export type RunError =
  | "checkout_failed"
  | "sandbox_unavailable"
  | "resume_limit"
  | "incomplete"
  | "publish_failed"

/** What the `janitor/review` check run reports (EFF-1649 rule 18). */
export type CheckRunReport =
  | {
      readonly _tag: "Reviewed"
      readonly threads: ReadonlyArray<ThreadLink>
      readonly gateFailures: ReadonlyArray<GateFailure>
      /** Links to janitor's earlier `REQUEST_CHANGES` reviews it failed to dismiss. */
      readonly dismissalFailures: ReadonlyArray<string>
      /** A partial review: the incomplete explanation comes first. */
      readonly incomplete?: boolean
    }
  | { readonly _tag: "Reviewing" }
  | { readonly _tag: "Skipped"; readonly reason: SkipReason }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Errored"; readonly error: RunError }

export interface CheckRunOutput {
  readonly title: string
  readonly summary: string
}

/** Each blocking thread that still withholds approval goes in the first group it fits. */
const threadGroups: ReadonlyArray<readonly [string, (thread: ThreadLink) => boolean]> = [
  ["Resolved by the author but still blocking", (thread) => thread.resolvedBy === "author"],
  ["Outdated but still blocking", (thread) => thread.outdated],
  ["Conceded but not yet cleared for approval", (thread) => thread.state.clearing === "dismissal"],
  ["Open blocking threads", () => true],
]

const linkList = (heading: string, urls: ReadonlyArray<string>) =>
  urls.length === 0 ? [] : [`${heading}:\n\n${urls.map((url) => `- ${url}`).join("\n")}`]

const reviewedOutput = (
  report: Extract<CheckRunReport, { readonly _tag: "Reviewed" }>,
): CheckRunOutput => {
  const withholding = report.threads.filter(
    (thread) => thread.state.severity === "blocking" && thread.state.clearing !== "approval",
  )
  const open = withholding.filter((thread) => thread.state.clearing === "standing").length
  const groupOf = (thread: ThreadLink) => threadGroups.findIndex(([, fits]) => fits(thread))
  const reason = notApproved(report.gateFailures)
  const sections = [
    ...threadGroups.flatMap(([heading], group) =>
      linkList(
        heading,
        withholding.filter((thread) => groupOf(thread) === group).map((thread) => thread.url),
      ),
    ),
    ...linkList("Couldn't dismiss janitor's earlier review", report.dismissalFailures),
    withholding.length === 0
      ? `No blocking findings.${reason === undefined ? "" : ` ${reason}`}`
      : reason,
  ].filter((section) => section !== undefined)
  if (report.incomplete === true)
    return {
      title: erroredOutput.incomplete.title,
      summary: [erroredOutput.incomplete.summary, ...sections].join("\n\n"),
    }
  return {
    title:
      open > 0
        ? plural(open, "blocking finding")
        : withholding.length > 0 || reason !== undefined
          ? "No blocking findings, not approved"
          : "No blocking findings",
    summary: sections.join("\n\n"),
  }
}

const skippedOutput: Record<SkipReason, CheckRunOutput> = {
  oversized: {
    title: "Skipped: too large",
    summary: "This pull request is too large, comment `/janitor` to review anyway.",
  },
  run_cap: {
    title: "Skipped: automatic reviews paused",
    summary:
      "This pull request reached its automatic review limit, so automatic reviews paused, comment `/janitor` to re-run.",
  },
}

const erroredOutput: Record<RunError, CheckRunOutput> = {
  checkout_failed: {
    title: "Checkout failed",
    summary:
      "Checkout failed, so janitor couldn't review this head. Comment `/janitor` to try again.",
  },
  sandbox_unavailable: {
    title: "No sandbox available",
    summary:
      "Janitor couldn't get a sandbox for this review before its deadline. Comment `/janitor` to try again.",
  },
  resume_limit: {
    title: "Review stopped",
    summary:
      "The sandbox was lost too many times and the resume limit was reached, re-run with `/janitor`.",
  },
  incomplete: {
    title: "Incomplete review",
    summary:
      "The review ended before it finished. Findings reported so far were posted as a partial review, which never approves. Comment `/janitor` to re-run.",
  },
  publish_failed: {
    title: "Couldn't post the review",
    summary:
      "The review finished, but GitHub refused it, so nothing was posted. Comment `/janitor` to re-run.",
  },
}

const reviewingOutput: CheckRunOutput = {
  title: "Reviewing",
  summary: "Janitor is reviewing this head.",
}

const cancelledOutput: CheckRunOutput = {
  title: "Review cancelled",
  summary:
    "This review was cancelled, by a newer push, the pull request closing or turning draft, or PR review being disabled.",
}

export const checkRunOutput = (report: CheckRunReport): CheckRunOutput => {
  switch (report._tag) {
    case "Reviewed":
      return reviewedOutput(report)
    case "Reviewing":
      return reviewingOutput
    case "Skipped":
      return skippedOutput[report.reason]
    case "Cancelled":
      return cancelledOutput
    case "Errored":
      return erroredOutput[report.error]
  }
}

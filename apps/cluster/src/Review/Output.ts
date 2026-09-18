import type { ReviewPublication } from "@janitor/domain/Review/Publication"
import type { DraftPublication, ReproductionPrText } from "@janitor/domain/Review/Draft"
import type { RunRecord } from "./Store.ts"

export const permittedSummaryLinks = (
  run: RunRecord,
  repository: string,
): ReadonlyArray<string> => [
  ...(run.draftPublication?.url ? [run.draftPublication.url] : []),
  ...[run.commitSha, ...run.reproduction.attempts.map((a) => a.commitSha)]
    .filter((sha) => sha !== null)
    .map((sha) => `https://github.com/${repository}/commit/${sha}`),
  ...run.evidence
    .filter((e) => e.verified)
    .flatMap((e) =>
      e.kind === "file"
        ? [
            `https://github.com/${repository}/blob/${run.commitSha}/${e.reference.split("/").map(encodeURIComponent).join("/")}`,
          ]
        : e.url === null
          ? []
          : [e.url],
    ),
]

/** Reject unsafe output; never replace agent prose with application prose. */
export const outputReason = (
  run: RunRecord,
  repository: string,
  text: string,
  requireCommit = true,
  extraLinks: ReadonlyArray<string> = [],
) => {
  const permitted = new Set([...permittedSummaryLinks(run, repository), ...extraLinks])
  const urls = text.match(/https?:\/\/[^\s)<>\]"']+/g) ?? []
  const unsafeUrl = urls.some((url) => !permitted.has(url.replace(/#L\d+(?:-L\d+)?$/, "")))
  const withoutUrls = urls.reduce((body, url) => body.replace(url, ""), text)
  // No HTML, entities, escapes or reference/relative links that can hide a
  // mention or destination from this check. Rejected text stays in history.
  const hidden = /[@<>&\\]|\]\s*\[|\]\s*\(\s*(?!https:\/\/)|^\s*\[[^\]]+\]:/m.test(text)
  const otherLinks =
    /(?:[a-z][a-z\d+.-]*:\/\/|www\.|\b[a-z\d-]+\.(?:com|org|net|io|dev|app)\b)/i.test(withoutUrls)
  const itemRefs = [...withoutUrls.matchAll(/(?:#|\bGH-)(\d+)\b/gi)]
  const crossRepository = /[\w.-]+\/[\w.-]+#\d+/.test(withoutUrls)
  const commits = [run.commitSha, ...run.reproduction.attempts.map((a) => a.commitSha)]
  const unknownCommit = [...withoutUrls.matchAll(/\b[\da-f]{7,40}\b/gi)].some(
    ([sha]) => !commits.some((commit) => commit?.startsWith(sha.toLowerCase())),
  )
  const uncited = itemRefs.some(
    (match) =>
      !run.evidence.some((e) => e.verified && e.kind !== "file" && e.reference === match[1]),
  )
  return text.length > 20_000 || text.trim().length === 0
    ? "The summary is empty or exceeds 20,000 characters."
    : requireCommit && (run.commitSha === null || !text.includes(run.commitSha))
      ? "The summary must name the investigated commit."
      : hidden || unsafeUrl || otherLinks || uncited || crossRepository || unknownCommit
        ? "The summary contains a mention, unsupported link syntax, or a link outside its verified evidence."
        : null
}

export const summaryIntent = (
  run: RunRecord,
  repository: string,
  text = [run.findings, run.uncertainty].filter(Boolean).join("\n\n"),
): ReviewPublication => {
  const reason = outputReason(run, repository, text)
  return {
    status: reason === null ? "pending" : "rejected",
    body: `${text}\n\n<!-- janitor-review:${run.runId} -->`,
    commentId: null,
    url: null,
    reason,
  }
}

/** Only trusted, confirmed test evidence can authorize a reproduction proposal. */
export const draftIntent = (
  run: RunRecord,
  repository: string,
  text: ReproductionPrText | null | undefined,
): DraftPublication | null => {
  const { patch, assessment, attempts } = run.reproduction
  if (
    run.classification !== "bug" ||
    assessment?.outcome !== "reproduced" ||
    assessment.duplicate !== null
  )
    return null
  if (
    patch === null ||
    patch.baseCommit !== run.commitSha ||
    run.defaultBranch === null ||
    !attempts.some(
      (a) =>
        assessment.attemptIds.includes(a.id) &&
        a.patchId === patch.id &&
        a.commitSha === run.commitSha &&
        a.kind === "test" &&
        a.exitCode !== null &&
        a.exitCode !== 0 &&
        a.integrity &&
        a.limitation === null &&
        patch.files.some((f) => f.path === a.testPath),
    )
  )
    return null
  const issueUrl = `https://github.com/${repository}/issues/${run.issueNumber}`
  // Validate again with the actual GitHub URL before writing the summary.
  const reason =
    text === null || text === undefined
      ? "The agent did not supply reproduction PR text."
      : (outputReason(run, repository, text.title, false) ??
        outputReason(run, repository, text.body, true, [issueUrl]) ??
        outputReason(
          run,
          repository,
          text.publishedSummary.replaceAll("{{pr_url}}", issueUrl),
          true,
          [issueUrl],
        ) ??
        outputReason(run, repository, text.blockedSummary) ??
        (!text.body.includes(issueUrl) || !text.publishedSummary.includes("{{pr_url}}")
          ? "PR text must link the original issue and the published summary must include {{pr_url}}."
          : null))
  return {
    status: reason === null ? "pending" : "rejected",
    branch: `janitor/reproduction/${run.issueNumber}/${run.runId}`,
    baseCommit: patch.baseCommit,
    defaultBranch: run.defaultBranch,
    text: text ?? { title: "", body: "", publishedSummary: "", blockedSummary: "" },
    attempted: null,
    treeSha: null,
    commitSha: null,
    prNumber: null,
    url: null,
    reason,
  }
}

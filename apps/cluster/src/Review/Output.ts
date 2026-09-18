import type { ReviewPublication } from "@janitor/domain/Review/Publication"
import type { RunRecord } from "./Store.ts"

export const permittedSummaryLinks = (
  run: RunRecord,
  repository: string,
): ReadonlyArray<string> => [
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
export const summaryIntent = (run: RunRecord, repository: string): ReviewPublication => {
  const text = [run.findings, run.uncertainty].filter(Boolean).join("\n\n")
  const permitted = new Set(permittedSummaryLinks(run, repository))
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
  const reason =
    text.length > 20_000 || text.trim().length === 0
      ? "The summary is empty or exceeds 20,000 characters."
      : run.commitSha === null || !text.includes(run.commitSha)
        ? "The summary must name the investigated commit."
        : hidden || unsafeUrl || otherLinks || uncited || crossRepository || unknownCommit
          ? "The summary contains a mention, unsupported link syntax, or a link outside its verified evidence."
          : null
  return {
    status: reason === null ? "pending" : "rejected",
    body: `${text}\n\n<!-- janitor-review:${run.runId} -->`,
    commentId: null,
    url: null,
    reason,
  }
}

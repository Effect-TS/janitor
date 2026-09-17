import type {
  GitHubCheckRunApi,
  GitHubPullRequestFileApi,
  GitHubPullRequestReviewApi,
} from "./Api.ts"

/**
 * How GitHub's pull request listings become the collection facts rules
 * read. One place for the folding rules, shared by the UI cache refresh and
 * direct labeling reads, so the two cannot drift.
 */

/** The files a pull request changed, once per path. */
export const changedFiles = (
  files: ReadonlyArray<GitHubPullRequestFileApi>,
): ReadonlyArray<{ readonly path: string; readonly status: string }> =>
  [...new Map(files.map((file) => [file.filename, file])).values()].map((file) => ({
    path: file.filename,
    status: file.status,
  }))

/** A check run's state: its conclusion once complete, otherwise its status. */
export const checkRuns = (
  runs: ReadonlyArray<GitHubCheckRunApi>,
): ReadonlyArray<{ readonly name: string; readonly state: string }> =>
  runs.map((run) => ({ name: run.name, state: run.conclusion ?? run.status }))

/**
 * The latest review per reviewer, in submission order. A dismissal clears
 * the reviewer's standing; comments and pending reviews do not count.
 */
export const latestReviews = (
  reviews: ReadonlyArray<GitHubPullRequestReviewApi>,
): ReadonlyArray<{ readonly reviewer: string; readonly state: string }> => {
  const latest = new Map<string, string>()
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const reviewer = review.user?.login.toLowerCase()
    if (reviewer === undefined) continue
    if (review.state === "DISMISSED") latest.delete(reviewer)
    else if (review.state !== "COMMENTED" && review.state !== "PENDING")
      latest.set(reviewer, review.state)
  }
  return [...latest].map(([reviewer, state]) => ({ reviewer, state }))
}

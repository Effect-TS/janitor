import type { GitHubIssueApi, GitHubPullRequestApi } from "@janitor/domain/GitHub/Api"
import type { GitHubLabelDatabaseId } from "@janitor/domain/GitHub/Id"
import type { GitHubEntityKind } from "@janitor/domain/GitHub/ReadModel"
import type { PullRequest as WebhookPullRequest } from "@janitor/domain/GitHub/WebhookEvent/PullRequest"
import { type FactSnapshot, snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import type { Collections } from "./GitHubPullRequest.ts"

/**
 * The facts of one issue or pull request as read from GitHub, in the shape
 * the evaluator consumes (ADR 0006). One builder serves automatic labeling
 * and the test bench so both evaluate the same evidence.
 */

/** Everything a direct read gathered about one item. */
export interface ReadItem {
  readonly issue: GitHubIssueApi
  /** Present for a pull request. */
  readonly pullRequest: GitHubPullRequestApi | null
  /** Only the required collections; an incomplete one is unavailable to evaluation. */
  readonly collections: Collections
}

export const itemKind = (issue: GitHubIssueApi): GitHubEntityKind =>
  issue.pullRequest === undefined ? "issue" : "pull_request"

export const authorLogin = (issue: GitHubIssueApi) => issue.user?.login ?? "ghost"

/** Labeling scope: open, and for a pull request not merged. Merged implies closed on GitHub. */
export const isOpenPullRequest = (pullRequest: {
  readonly state: "open" | "closed"
  readonly merged?: boolean
}) => pullRequest.state === "open" && pullRequest.merged !== true

export const itemFacts = (item: ReadItem): FactSnapshot => {
  const { issue, pullRequest, collections } = item
  const { changedFiles, checks, reviews } = collections
  const snapshot = snapshotFacts({
    kind: itemKind(issue),
    title: issue.title,
    body: issue.body,
    authorLogin: authorLogin(issue),
    state: issue.state,
    labels: issue.labels.map((label) => label.id),
    pullRequest:
      pullRequest === null
        ? null
        : {
            baseRef: pullRequest.base.ref,
            draft: pullRequest.draft,
            headSha: pullRequest.head.sha,
          },
    collections: {
      ...(changedFiles?.complete ? { files: changedFiles.files } : {}),
      ...(checks === undefined ? {} : { checks }),
      ...(reviews === undefined ? {} : { reviews }),
    },
  })
  // An incomplete listing is unavailable, with the reason evaluation reports.
  return changedFiles !== undefined && !changedFiles.complete
    ? { ...snapshot, unavailableReasons: { changedFiles: changedFiles.reason } }
    : snapshot
}

// OBSERVED ITEMS

/**
 * What a webhook said about an item when it admitted work. Admission decides
 * scope from it; the work itself rereads GitHub when it runs.
 */
export interface ObservedItem {
  readonly kind: GitHubEntityKind
  readonly number: number
  readonly title: string
  readonly authorLogin: string
  /** Closed includes a merged pull request. */
  readonly open: boolean
  readonly baseRef: string | null
  readonly draft: boolean | null
  readonly labels: ReadonlyArray<GitHubLabelDatabaseId>
}

export const observedIssue = (issue: GitHubIssueApi): ObservedItem => ({
  kind: itemKind(issue),
  number: issue.number,
  title: issue.title,
  authorLogin: authorLogin(issue),
  open: issue.state === "open",
  baseRef: null,
  draft: null,
  labels: issue.labels.map((label) => label.id),
})

export const observedPullRequest = (pullRequest: WebhookPullRequest): ObservedItem => ({
  kind: "pull_request",
  number: pullRequest.number,
  title: pullRequest.title,
  authorLogin: pullRequest.user.login,
  open: isOpenPullRequest(pullRequest),
  baseRef: pullRequest.base.ref,
  draft: pullRequest.draft,
  labels: pullRequest.labels.map((label) => label.id),
})

const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  )

/** Only what concrete rules read, in a stable order. */
export const itemFingerprint = (item: ObservedItem) =>
  sha256Hex(
    JSON.stringify({
      kind: item.kind,
      title: item.title,
      author: item.authorLogin.toLowerCase(),
      state: item.open ? "open" : "closed",
      baseRef: item.baseRef,
      draft: item.draft,
      labels: [...item.labels].sort(),
    }),
  )

import {
  GitHubCheckRunsApi,
  GitHubPullRequestApi,
  GitHubPullRequestFileApi,
  GitHubPullRequestReviewApi,
} from "@janitor/domain/GitHub/Api"
import type { FactTrack } from "@janitor/domain/Labeling/Policy/Facts"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { SyncActivityError } from "../GitHub/SyncSupport.ts"
import type { GitHubTransport, GitHubRequest } from "../GitHub/Transport.ts"
import {
  fetchPages,
  get,
  type RepositoryTarget,
  repositoryPath,
  type Waits,
} from "./GitHubIssue.ts"

/**
 * Current pull request facts read straight from GitHub (ADR 0006): the pull
 * request itself and the collections the configured rules read, each
 * paginated to its bound. Nothing here touches the read model.
 */

/** The facts that need a listing beyond the pull request itself. */
export type CollectionTrack = Extract<FactTrack, "changed_files" | "checks" | "reviews">

const isCollectionTrack = (track: FactTrack): track is CollectionTrack =>
  track === "changed_files" || track === "checks" || track === "reviews"

export const collectionTracks = (tracks: Iterable<FactTrack>): ReadonlyArray<CollectionTrack> =>
  [...new Set([...tracks].filter(isCollectionTrack))].sort()

export type ChangedFiles =
  | {
      readonly files: ReadonlyArray<{ readonly path: string; readonly status: string }>
      readonly complete: true
    }
  | {
      readonly files: ReadonlyArray<{ readonly path: string; readonly status: string }>
      readonly complete: false
      /** Why the fact is unavailable to evaluation. */
      readonly reason: string
    }

/** Only the required collections are present. */
export interface Collections {
  readonly changedFiles?: ChangedFiles
  readonly checks?: ReadonlyArray<{ readonly name: string; readonly state: string }>
  readonly reviews?: ReadonlyArray<{ readonly reviewer: string; readonly state: string }>
}

export type PullRequestRead =
  | {
      readonly _tag: "Found"
      readonly pullRequest: GitHubPullRequestApi
      readonly collections: Collections
    }
  /** GitHub answered without the pull request: gone, forbidden, or not a pull request. */
  | { readonly _tag: "Unavailable"; readonly status: number; readonly message: string }
  /** The pull request kept changing while its collections were read. */
  | { readonly _tag: "Changed"; readonly detail: string }

const PAGE = 100
/** How many changed files one read lists before reporting the fact unavailable. */
export const MAX_CHANGED_FILES = 3000
/** Bounds the check-run and review listings one read follows. */
const MAX_COLLECTION_PAGES = 200
/** How often a read starts over because the pull request changed meanwhile. */
const MAX_REREADS = 1

const target = (
  repository: RepositoryTarget,
  priority: GitHubRequest["priority"],
  url: string,
): GitHubRequest => ({
  scope: { _tag: "Installation", installationId: repository.installationId },
  priority,
  method: "GET",
  url,
})

export const fetchPullRequest = <X>(
  name: string,
  repository: RepositoryTarget,
  number: number,
  waits: Waits<X>,
) =>
  waits(
    name,
    get(
      target(repository, "foreground", `${repositoryPath(repository)}/pulls/${number}`),
      GitHubPullRequestApi,
    ),
  )

const changedFiles = <X>(
  name: string,
  repository: RepositoryTarget,
  number: number,
  expected: number | undefined,
  waits: Waits<X>,
) =>
  Effect.gen(function* () {
    const listed = yield* fetchPages({
      name,
      repository,
      firstUrl: `${repositoryPath(repository)}/pulls/${number}/files?per_page=${PAGE}`,
      page: Schema.Array(GitHubPullRequestFileApi),
      items: (items) => items,
      maxPages: MAX_CHANGED_FILES / PAGE,
      waits,
    })
    if (listed._tag === "Failed") return listed
    const files = [...new Map(listed.items.map((file) => [file.filename, file])).values()].map(
      (file) => ({ path: file.filename, status: file.status }),
    )
    const result: ChangedFiles = listed.truncated
      ? {
          files,
          complete: false,
          reason: `Only ${files.length} of ${expected ?? "an unknown number of"} changed files are available; GitHub's file listing limit was reached`,
        }
      : expected === undefined
        ? {
            files,
            complete: false,
            reason: "Changed-file total is unavailable; completeness could not be verified",
          }
        : files.length === expected
          ? { files, complete: true }
          : {
              files,
              complete: false,
              reason: `Changed-file listing did not match the pull request's file count (${files.length} of ${expected})`,
            }
    return { _tag: "Ok", result } as const
  })

const checkRuns = <X>(
  name: string,
  repository: RepositoryTarget,
  headSha: string,
  waits: Waits<X>,
) =>
  fetchPages({
    name,
    repository,
    firstUrl: `${repositoryPath(repository)}/commits/${headSha}/check-runs?per_page=${PAGE}`,
    page: GitHubCheckRunsApi,
    items: (body) => body.checkRuns,
    maxPages: MAX_COLLECTION_PAGES,
    waits,
  }).pipe(
    Effect.map((listed) =>
      listed._tag === "Failed"
        ? listed
        : listed.truncated
          ? ({
              _tag: "Failed",
              status: 0,
              message: `${name} exceeded ${MAX_COLLECTION_PAGES} pages`,
            } as const)
          : ({
              _tag: "Ok",
              result: listed.items.map((run) => ({
                name: run.name,
                state: run.conclusion ?? run.status,
              })),
            } as const),
    ),
  )

/** The latest review per reviewer; dismissals clear it and comments do not count. */
const reviews = <X>(name: string, repository: RepositoryTarget, number: number, waits: Waits<X>) =>
  fetchPages({
    name,
    repository,
    firstUrl: `${repositoryPath(repository)}/pulls/${number}/reviews?per_page=${PAGE}`,
    page: Schema.Array(GitHubPullRequestReviewApi),
    items: (items) => items,
    maxPages: MAX_COLLECTION_PAGES,
    waits,
  }).pipe(
    Effect.map((listed) => {
      if (listed._tag === "Failed") return listed
      if (listed.truncated)
        return {
          _tag: "Failed",
          status: 0,
          message: `${name} exceeded ${MAX_COLLECTION_PAGES} pages`,
        } as const
      const latest = new Map<string, string>()
      for (const review of [...listed.items].sort((a, b) => a.id - b.id)) {
        const reviewer = review.user?.login.toLowerCase()
        if (reviewer === undefined) continue
        if (review.state === "DISMISSED") latest.delete(reviewer)
        else if (review.state !== "COMMENTED" && review.state !== "PENDING")
          latest.set(reviewer, review.state)
      }
      return {
        _tag: "Ok",
        result: [...latest].map(([reviewer, state]) => ({ reviewer, state })),
      } as const
    }),
  )

const same = (a: GitHubPullRequestApi, b: GitHubPullRequestApi) =>
  a.head.sha === b.head.sha &&
  a.changedFiles === b.changedFiles &&
  DateTime.Equivalence(a.updatedAt, b.updatedAt)

/**
 * Reads the pull request and its required collections as one observation:
 * the pull request is reread afterwards and the whole read starts over when
 * it changed meanwhile, so the collections describe the head that was
 * evaluated. `name` prefixes the waits of every request.
 */
export const readPullRequest = <X>(
  name: string,
  repository: RepositoryTarget,
  number: number,
  tracks: ReadonlyArray<CollectionTrack>,
  waits: Waits<X>,
): Effect.Effect<PullRequestRead, SyncActivityError, GitHubTransport | X> =>
  Effect.gen(function* () {
    const unavailable = (response: { readonly status: number; readonly message: string }) =>
      ({ _tag: "Unavailable", status: response.status, message: response.message }) as const
    for (let attempt = 0; attempt <= MAX_REREADS; attempt++) {
      const prefix = `${name}/${attempt}`
      const first = yield* fetchPullRequest(`${prefix}/Pull`, repository, number, waits)
      if (first._tag === "Failed") return unavailable(first)
      const pullRequest = first.body
      if (tracks.length === 0) return { _tag: "Found", pullRequest, collections: {} } as const
      const collections: {
        changedFiles?: ChangedFiles
        checks?: ReadonlyArray<{ name: string; state: string }>
        reviews?: ReadonlyArray<{ reviewer: string; state: string }>
      } = {}
      if (tracks.includes("changed_files")) {
        const listed = yield* changedFiles(
          `${prefix}/Files`,
          repository,
          number,
          pullRequest.changedFiles,
          waits,
        )
        if (listed._tag === "Failed") return unavailable(listed)
        collections.changedFiles = listed.result
      }
      if (tracks.includes("checks")) {
        const listed = yield* checkRuns(`${prefix}/Checks`, repository, pullRequest.head.sha, waits)
        if (listed._tag === "Failed") return unavailable(listed)
        collections.checks = listed.result
      }
      if (tracks.includes("reviews")) {
        const listed = yield* reviews(`${prefix}/Reviews`, repository, number, waits)
        if (listed._tag === "Failed") return unavailable(listed)
        collections.reviews = listed.result
      }
      const verified = yield* fetchPullRequest(`${prefix}/Verify`, repository, number, waits)
      if (verified._tag === "Failed") return unavailable(verified)
      if (same(pullRequest, verified.body))
        return { _tag: "Found", pullRequest: verified.body, collections } as const
    }
    return {
      _tag: "Changed",
      detail: `pull request #${number} changed on GitHub while its facts were read`,
    } as const
  })

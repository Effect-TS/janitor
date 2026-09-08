/**
 * The data a fresh development database is filled with.
 *
 * These are hand-written rather than generated. `Schema.toArbitrary` produces
 * values a schema accepts, not values a person recognises: repository names
 * come out as unicode, timestamps land decades away. Building screens against
 * that is miserable. Two repositories with names you know, labels you can
 * reason about, and policies that say something are worth more here than
 * volume. Reach for arbitrary data in property tests, where the point is
 * hostility.
 *
 * Everything is written through the same services the application uses, so
 * the camelCase-to-snake_case mapping lives in one place and this file cannot
 * drift away from the migrations.
 */
import { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import {
  GitHubAccountDatabaseId,
  GitHubCommitSha,
  GitHubInstallationId,
  GitHubLabelDatabaseId,
  GitHubLabelNodeId,
  GitHubPullRequestDatabaseId,
  GitHubPullRequestNodeId,
  GitHubRepositoryDatabaseId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import type { CreatePolicyRequest } from "@janitor/domain/Labeling/Policy/Configuration"

/** Every write is attributed to the local development identity, so the audit
 *  trail in a seeded database reads as clearly synthetic. */
export const actor = { issuer: "local-dev", subject: "dev@janitor.local" }

/** The read model advances on webhook journal sequence numbers. Seeded rows
 *  all claim the first one: nothing here replays a journal. */
export const sequence = GitHubWebhookJournalSequence.make("1")

export const installationId = GitHubInstallationId.make("77")
export const accountId = GitHubAccountDatabaseId.make("1")

export type SeedLabel = {
  readonly id: string
  readonly name: string
}

export type SeedPullRequest = {
  readonly number: number
  readonly title: string
  readonly baseRef: string
  readonly isDraft: boolean
  readonly state: "open" | "closed"
}

export type SeedPolicy = {
  readonly request: CreatePolicyRequest
  /** Publish it, so the repository has a live revision to bind rules against.
   *  An unpublished policy is a draft and rules cannot reference it. */
  readonly isPublished: boolean
  /** The label this policy drives, when it is bound to a rule. */
  readonly labelName: string | null
}

export type SeedRepository = {
  readonly id: string
  readonly owner: string
  readonly repo: string
  readonly isEnabled: boolean
  readonly labels: ReadonlyArray<SeedLabel>
  readonly pullRequests: ReadonlyArray<SeedPullRequest>
  readonly policies: ReadonlyArray<SeedPolicy>
}

const label = (id: string, name: string): SeedLabel => ({ id, name })

/**
 * Two repositories, deliberately different: `effect` is enabled with a full
 * configuration, `janitor` is disabled with nothing bound. The switcher, the
 * repository list, and the policy workbench all need both states to be worth
 * looking at.
 */
export const repositories: ReadonlyArray<SeedRepository> = [
  {
    id: "701",
    owner: "Effectful-Tech",
    repo: "effect",
    isEnabled: true,
    labels: [
      label("11", "bug"),
      label("12", "enhancement"),
      label("13", "documentation"),
      label("14", "needs-review"),
      label("15", "breaking-change"),
      label("16", "good-first-issue"),
    ],
    pullRequests: [
      {
        number: 5,
        title: "Fix the retry budget accounting",
        baseRef: "main",
        isDraft: false,
        state: "open",
      },
      {
        number: 6,
        title: "Add Hyperdrive connection pooling",
        baseRef: "main",
        isDraft: false,
        state: "open",
      },
      {
        number: 7,
        title: "WIP: rework the scheduler",
        baseRef: "main",
        isDraft: true,
        state: "open",
      },
      {
        number: 8,
        title: "Document the labeling policy DSL",
        baseRef: "docs",
        isDraft: false,
        state: "open",
      },
      {
        number: 9,
        title: "Drop the legacy ruleset table",
        baseRef: "next",
        isDraft: false,
        state: "open",
      },
      {
        number: 10,
        title: "Bump the workerd runtime",
        baseRef: "main",
        isDraft: false,
        state: "closed",
      },
    ],
    policies: [
      {
        request: {
          name: "Targets main",
          description: "Anything opened against the default branch.",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
          },
        },
        isPublished: true,
        labelName: "needs-review",
      },
      {
        request: {
          name: "Touches documentation",
          description: "Changes confined to the docs tree.",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "docs" },
          },
        },
        isPublished: true,
        labelName: "documentation",
      },
      {
        request: {
          name: "Still a draft",
          description: "Unpublished on purpose: the editor needs a draft to open.",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "next" },
          },
        },
        isPublished: false,
        labelName: null,
      },
    ],
  },
  {
    // A second owner, so the switcher's grouping has something to group.
    id: "703",
    owner: "vercel",
    repo: "next.js",
    isEnabled: true,
    labels: [label("31", "bug"), label("32", "needs-triage")],
    pullRequests: [
      {
        number: 2,
        title: "Tighten the router cache",
        baseRef: "canary",
        isDraft: false,
        state: "open",
      },
    ],
    policies: [],
  },
  {
    id: "702",
    owner: "Effectful-Tech",
    repo: "janitor",
    isEnabled: false,
    labels: [label("21", "bug"), label("22", "infrastructure")],
    pullRequests: [
      {
        number: 1,
        title: "Seed the development database",
        baseRef: "main",
        isDraft: false,
        state: "open",
      },
    ],
    policies: [],
  },
]

/** Ids are derived rather than listed so adding a pull request above needs no
 *  bookkeeping here. They only have to be unique and stable. */
export const issueId = (repositoryId: string, number: number): number =>
  Number(repositoryId) * 1000 + number

export const pullRequestId = (repositoryId: string, number: number): GitHubPullRequestDatabaseId =>
  GitHubPullRequestDatabaseId.make(String(Number(repositoryId) * 10_000 + number))

export const pullRequestNodeId = (repositoryId: string, number: number): GitHubPullRequestNodeId =>
  GitHubPullRequestNodeId.make(`PR_${repositoryId}_${number}`)

export const labelNodeId = (id: string): GitHubLabelNodeId => GitHubLabelNodeId.make(`LA_${id}`)

export const repositoryDatabaseId = (id: string): GitHubRepositoryDatabaseId =>
  GitHubRepositoryDatabaseId.make(id)

export const labelDatabaseId = (id: string): GitHubLabelDatabaseId => GitHubLabelDatabaseId.make(id)

/** A fixed 40-character sha. Nothing in development resolves it. */
export const headSha = GitHubCommitSha.make("0".repeat(40))

/** Timestamps are fixed so a re-seed produces byte-identical rows and the UI
 *  does not shuffle between runs. */
export const updatedAt = (number: number): string => `2026-09-0${(number % 9) + 1}T12:00:00.000Z`

export { GitHubIssueApi }

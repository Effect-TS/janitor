// Opt-in live GitHub feedback fixture. Native Git publication is exercised separately.
import { it, expect } from "vite-plus/test"
import { createSign, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Teammates, TeammatesConfig } from "../../src/Teammates.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { RepositoryAccess } from "../../src/Agent/RepositoryAccess.ts"
import { GitHubFeedback, GitHubFeedbackConfig } from "../../src/GitHub/Feedback.ts"
import { GitHubFeedbackHttpLayer } from "../../src/GitHub/FeedbackHttp.ts"
import { GitHubCommentApi } from "../../src/GitHub/FeedbackDelivery.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "../Agent/support.ts"

it.skipIf(process.env.JANITOR_RUN_GITHUB_REVIEW_FIXTURE !== "1")(
  "hydrates live reviews and replies with verifiable markers, then removes the fixture",
  async () => {
    const env = parseEnv(readFileSync(".env.github-review-fixture", "utf8"))
    const repository = env.FIXTURE_GITHUB_REPOSITORY!
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("Set FIXTURE_GITHUB_REPOSITORY to a disposable owner/repo")
    for (const key of ["JANITOR_GITHUB_APP_ID", "GITHUB_REVIEWER_TOKEN"])
      if (!env[key]) throw new Error(`Set ${key} in .env.github-review-fixture`)
    const privateKey = env.JANITOR_GITHUB_APP_PRIVATE_KEY
      ? env.JANITOR_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n")
      : env.JANITOR_GITHUB_APP_PRIVATE_KEY_FILE
        ? readFileSync(env.JANITOR_GITHUB_APP_PRIVATE_KEY_FILE, "utf8")
        : undefined
    if (!privateKey)
      throw new Error(
        "Set JANITOR_GITHUB_APP_PRIVATE_KEY or JANITOR_GITHUB_APP_PRIVATE_KEY_FILE in .env.github-review-fixture",
      )
    const now = Math.floor(Date.now() / 1000)
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: env.JANITOR_GITHUB_APP_ID })}`
    const jwt = `${payload}.${createSign("RSA-SHA256").update(payload).sign(privateKey, "base64url")}`
    const branch = `janitor-review-fixture-${randomUUID()}`
    let requests = 0
    const api = async (
      path: string,
      token: string,
      method = "GET",
      body?: unknown,
    ): Promise<any> => {
      if (++requests > 50)
        throw new Error("Live fixture exceeded its 50-request setup/cleanup budget")
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok)
        throw new Error(`GitHub fixture ${method} ${path} failed (${response.status})`)
      return response.status === 204 ? undefined : response.json()
    }
    const app = await api("/app", jwt)
    const installation = await api(`/repos/${repository}/installation`, jwt)
    const initial = await api(`/app/installations/${installation.id}/access_tokens`, jwt, "POST", {
      repositories: [repository.split("/")[1]],
      permissions: { contents: "write", pull_requests: "write" },
    })
    const token = initial.token
    const repo = await api(`/repos/${repository}`, token)
    const reviewer = await api("/user", env.GITHUB_REVIEWER_TOKEN!)
    if (reviewer.type !== "User")
      throw new Error("The reviewer token must identify a human account")
    let branchCreated = false
    let prNumber: number | undefined
    const report: Record<string, unknown> = {
      repository,
      branch,
      startedAt: new Date().toISOString(),
      limits:
        "Live GitHub REST reviews, production hydration/admission and App reply reconciliation against local PostgreSQL. Webhook callback transport and native Git publication are covered by separate controlled tests; no model calls or deployment.",
    }
    const reportPath = ".scratch/multiplayer-janitor-implementation/github-review-live.json"
    try {
      const base = await api(
        `/repos/${repository}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`,
        token,
      )
      await api(`/repos/${repository}/git/refs`, token, "POST", {
        ref: `refs/heads/${branch}`,
        sha: base.object.sha,
      })
      branchCreated = true
      const file = "janitor-review-fixture.md"
      const commit = await api(`/repos/${repository}/contents/${file}`, token, "PUT", {
        message: "Add disposable review fixture",
        branch,
        content: Buffer.from("# Fixture title\n\nFixture ending.\n").toString("base64"),
      })
      const pr = await api(`/repos/${repository}/pulls`, token, "POST", {
        head: branch,
        base: repo.default_branch,
        title: "Disposable Janitor review fixture",
        body: "Automated review validation. This PR will be closed and its branch deleted.",
      })
      prNumber = pr.number
      report.pr = pr.html_url
      const review = await api(
        `/repos/${repository}/pulls/${pr.number}/reviews`,
        env.GITHUB_REVIEWER_TOKEN!,
        "POST",
        {
          commit_id: commit.commit.sha,
          event: "COMMENT",
          body: "Improve the title and ending.",
          comments: [
            { path: file, line: 1, side: "RIGHT", body: "Make the title specific." },
            { path: file, line: 3, side: "RIGHT", body: "Explain the ending." },
          ],
        },
      )
      const comments = await api(
        `/repos/${repository}/pulls/${pr.number}/reviews/${review.id}/comments`,
        token,
      )
      expect(comments).toHaveLength(2)
      const services = GitHubFeedback.layer.pipe(
        Layer.provideMerge(
          GitHubFeedbackHttpLayer.pipe(
            Layer.provide(
              Layer.succeed(RepositoryAccess, {
                authorize: () =>
                  Effect.succeed({
                    owner: repo.owner.login,
                    repo: repo.name,
                    pullRequestNumber: pr.number,
                    appId: String(app.id),
                    token: Redacted.make(token),
                  }),
              }),
            ),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
        Layer.provide(Layer.succeed(GitHubFeedbackConfig, { botLogin: `${app.slug}[bot]` })),
        Layer.provideMerge(
          Teammates.layer.pipe(
            Layer.provide(Layer.succeed(TeammatesConfig, { initialAdmin: Option.none() })),
          ),
        ),
        Layer.provideMerge(agentLayers(fakeRunnerLayer(new FakeRunner()))),
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO github_installation (installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES (${String(installation.id)},${String(repo.owner.id)},${repo.owner.login},${repo.owner.type},'all','active',${repo.owner.html_url},1)`
          yield* sql`INSERT INTO github_repository (repository_id,installation_id,owner,repo,access,enabled,projected_sequence,automation_ready_at) VALUES (${String(repo.id)},${String(installation.id)},${repo.owner.login},${repo.name},'accessible',true,1,now())`
          const sessions = yield* AgentSessions
          yield* sessions.start({
            sessionId: "live-feedback",
            title: "Review fixture",
            repositoryId: String(repo.id),
          })
          yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,repository_id,pr_number,state) VALUES ('live-feedback','fixture','fixture','1','1',${String(repo.id)},${String(pr.number)},'ready')`
          const teammates = yield* Teammates
          const member = yield* teammates.admit({
            issuer: "fixture",
            subject: String(reviewer.id),
            email: undefined,
          })
          yield* teammates.link(member.teammate.teammateId, {
            platform: "github",
            workspaceId: "github.com",
            accountId: String(reviewer.id),
            displayName: reviewer.login,
          })
          const feedback = yield* GitHubFeedback
          const envelope = { repository: { id: repo.id }, pull_request: { number: pr.number } }
          yield* feedback.record("inline-first", "pull_request_review_comment", {
            ...envelope,
            action: "created",
            comment: comments[0],
          })
          yield* feedback.record("review", "pull_request_review", {
            ...envelope,
            action: "submitted",
            review,
          })
          yield* feedback.processDue
          yield* feedback.record("inline-overlap", "pull_request_review_comment", {
            ...envelope,
            action: "created",
            comment: comments[1],
          })
          expect((yield* sessions.view("live-feedback")).inputs).toHaveLength(1)
          const publisher = yield* GitHubCommentApi
          const marker = randomUUID()
          const id = yield* publisher.post(
            "live-feedback",
            String(comments[0].id),
            "Fixture verified grouped review admission. No product changes requested.",
            marker,
          )
          expect(
            (yield* publisher.reconcile("live-feedback", String(comments[0].id), marker, "")).id,
          ).toBe(id)
          report.reviewId = String(review.id)
          report.replyId = id
          report.acceptedInputs = 1
        }).pipe(Effect.provide(services)),
      )
      report.passed = true
    } finally {
      const cleanup: string[] = []
      if (prNumber !== undefined) {
        try {
          await api(`/repos/${repository}/pulls/${prNumber}`, token, "PATCH", { state: "closed" })
          cleanup.push("PR closed")
        } catch {
          cleanup.push("PR cleanup failed")
        }
      }
      if (branchCreated) {
        try {
          await api(`/repos/${repository}/git/refs/heads/${branch}`, token, "DELETE")
          cleanup.push("Branch deleted")
        } catch {
          cleanup.push("Branch cleanup failed")
        }
      }
      report.cleanup = cleanup
      report.finishedAt = new Date().toISOString()
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
      if (cleanup.some((item) => item.includes("failed")))
        throw new Error(`Fixture cleanup needs attention. See ${reportPath}`)
    }
  },
  180000,
)

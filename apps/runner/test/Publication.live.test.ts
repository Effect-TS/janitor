import { it, expect } from "vite-plus/test"
import { createHash, createSign } from "node:crypto"
import { readFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { Harness, uniqueSessionId, waitFor } from "./support/Harness.ts"

const repository = "Effect-TS/slopcop-sandbox"
const repositoryId = "1323166030"
// Explicit opt-in creates a branch and PR only in the established disposable fixture.
it.skipIf(process.env.FIXTURE_ALLOW_PUBLICATION !== repository)(
  "publishes SQLite edits to live GitHub and removes the fixture work",
  async () => {
    const env = parseEnv(readFileSync(process.env.FIXTURE_APP_ENV_FILE!, "utf8"))
    if (!env.JANITOR_GITHUB_APP_PRIVATE_KEY || !env.JANITOR_GITHUB_APP_ID)
      throw new Error("Fixture App credentials required")
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    const now = Math.floor(Date.now() / 1000)
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: env.JANITOR_GITHUB_APP_ID })}`
    const jwt = `${payload}.${createSign("RSA-SHA256").update(payload).sign(env.JANITOR_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"), "base64url")}`
    const api = async (path: string, token: string, method = "GET", body?: unknown) => {
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "Janitor-validation",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`Fixture GitHub request failed (${response.status})`)
      return response.status === 204 ? undefined : ((await response.json()) as any)
    }
    const installation = await api(`/repos/${repository}/installation`, jwt)
    const tokens: string[] = []
    const mint = async (permission: string) => {
      const result = await api(`/app/installations/${installation.id}/access_tokens`, jwt, "POST", {
        repository_ids: [Number(repositoryId)],
        permissions: {
          contents: permission === "read" ? "read" : "write",
          pull_requests: permission === "pull_request" ? "write" : "read",
        },
      })
      expect(result.repositories.map((repo: any) => String(repo.id))).toEqual([repositoryId])
      tokens.push(result.token)
      return result.token as string
    }
    const cleanupToken = await mint("pull_request")
    const sessionId = uniqueSessionId("live-sqlite")
    const operationId = createHash("sha256")
      .update(JSON.stringify({ sessionId, generation: 1, repositoryId }))
      .digest("hex")
    const expectedBranch = `janitor/${operationId}`
    let harness: Harness | undefined
    let number: number | undefined
    let branch: string | undefined
    try {
      harness = await Harness.start({
        secret: "controlled-model",
        bindings: { REPOSITORY_SERVICE_TOKEN: "fixture-authority" },
        serviceBindings: {
          REPOSITORY_AUTHORITY: async (request) => {
            const body = (await request.json()) as { permission: string }
            return Response.json({
              owner: "Effect-TS",
              repo: "slopcop-sandbox",
              token: await mint(body.permission),
            })
          },
        },
      })
      const session = harness.session(sessionId)
      await session.faults({ intervalMs: 100 })
      await session.model({
        mode: "repository-work",
        tools: [
          {
            name: "write",
            input: {
              path: "janitor-sqlite-validation.txt",
              content: `SQLite validation ${session.id}\n`,
            },
          },
          {
            name: "publish",
            input: {
              title: "Disposable SQLite runner validation",
              body: "Controlled runner validation; no project tests executed. This PR will be closed automatically.",
            },
          },
        ],
      })
      await session.create({ repositoryId })
      await session.admit({ inputId: "msg_live_sqlite", text: "Publish the fixture file." })
      await waitFor(
        () => session.inspect(),
        (state) => state.execution === "idle",
      )
      const events = (await session.allEvents()).events
      const publication = events
        .map((event: any) => event.data?.metadata?.publication)
        .find(Boolean)
      // Find the durable marker even if projection shape changes, so cleanup can still discover the PR.
      const pulls = await api(`/repos/${repository}/pulls?state=open&per_page=100`, cleanupToken)
      const candidate = publication
        ? pulls.find((pr: any) => pr.number === publication.number)
        : pulls.find(
            (pr: any) =>
              pr.head.ref === expectedBranch &&
              pr.body?.includes(`<!-- janitor-publication:${operationId} -->`),
          )
      if (!candidate) throw new Error("Runner did not create the fixture PR")
      number = candidate.number
      branch = candidate.head.ref
      expect(candidate.head.repo.id).toBe(Number(repositoryId))
      expect(candidate.body).toContain("no project tests executed")
      await session.cleanup(1)
    } finally {
      try {
        if (number)
          await api(`/repos/${repository}/pulls/${number}`, cleanupToken, "PATCH", {
            state: "closed",
          })
        if (branch)
          await api(`/repos/${repository}/git/refs/heads/${branch}`, cleanupToken, "DELETE")
      } finally {
        await harness?.dispose()
        for (const token of tokens) await api("/installation/token", token, "DELETE")
      }
    }
  },
)

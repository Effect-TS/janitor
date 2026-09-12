import { it } from "vitest"
import assert from "node:assert/strict"
import { createHash, createSign, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { Harness, waitFor } from "./support/Harness.ts"

// Explicit opt-in only. One branch and one PR in the established disposable repo.
const repository = "Effect-TS/slopcop-sandbox"
const repositoryId = "1323166030"
it.skipIf(process.env.FIXTURE_ALLOW_PUBLICATION !== repository)(
  "publishes through the durable runner to live GitHub and removes its remote work",
  async () => {
    const env = parseEnv(readFileSync(process.env.FIXTURE_APP_ENV_FILE!, "utf8"))
    const privateKey = env.JANITOR_GITHUB_APP_PRIVATE_KEY
    assert.ok(privateKey && env.JANITOR_GITHUB_APP_ID, "App credentials are required")
    const reportPath = process.env.FIXTURE_REPORT_PATH!
    assert.ok(reportPath?.startsWith("/"), "An absolute evidence path is required")
    const sessionId = `live-publication-${randomUUID()}`
    const operationId = createHash("sha256")
      .update(JSON.stringify({ sessionId, generation: 1, repositoryId }))
      .digest("hex")
    const branch = `janitor/${operationId}`
    const marker = `<!-- janitor-publication:${operationId} -->`
    const report: Record<string, unknown> = {
      repository,
      repositoryId,
      sessionId,
      branch,
      startedAt: new Date().toISOString(),
      limits:
        "Local Workerd/SQLite/R2 and production bridge image; scripted model and fixture authority. No deployed service bindings or Slack delivery exercised.",
    }
    const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
    save()
    const jwt = () => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
      const now = Math.floor(Date.now() / 1000)
      const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
        iat: now - 60,
        exp: now + 540,
        iss: env.JANITOR_GITHUB_APP_ID,
      })}`
      return `${payload}.${createSign("RSA-SHA256")
        .update(payload)
        .sign(privateKey.replaceAll("\\n", "\n"), "base64url")}`
    }
    async function api(path: string, token: string, method = "GET", body?: unknown) {
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      })
      const text = await response.text()
      return { status: response.status, value: text ? JSON.parse(text) : undefined }
    }
    const prefix = `/repos/${repository}`
    const tokens: string[] = []
    const credentials = new Map<string, string>()
    let harness: Harness | undefined
    const resources = new Map<string, { container: string; url: string }>()
    const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim()
    let creates = 0
    let pushes = 0
    let hidePR = true
    let writeToken: string | undefined
    let installationId: number
    let failed = false
    let closing = false
    const inFlight = new Set<Promise<unknown>>()
    const cleanupErrors: string[] = []
    async function mint(permissions: Record<string, string>) {
      const result = await api(
        `/app/installations/${installationId}/access_tokens`,
        jwt(),
        "POST",
        {
          repository_ids: [Number(repositoryId)],
          permissions,
        },
      )
      assert.equal(result.status, 201, "Scoped installation credential issuance failed")
      const token = result.value.token as string
      tokens.push(token)
      assert.deepEqual(
        result.value.repositories.map((repo: { id: number }) => repo.id),
        [Number(repositoryId)],
      )
      for (const [key, value] of Object.entries(permissions))
        assert.equal(result.value.permissions[key], value)
      return token
    }
    const lookup = (token: string) =>
      api(
        `${prefix}/pulls?state=all&head=${encodeURIComponent(`Effect-TS:${branch}`)}&per_page=100`,
        token,
      )
    try {
      const installation = await api(`${prefix}/installation`, jwt())
      assert.equal(installation.status, 200)
      installationId = installation.value.id
      report.installationId = installationId
      writeToken = await mint({ contents: "write", pull_requests: "write" })
      credentials.set("read", await mint({ contents: "read" }))
      credentials.set("push", await mint({ contents: "write" }))
      credentials.set("pull_request", await mint({ contents: "read", pull_requests: "write" }))
      const repo = await api(prefix, writeToken)
      assert.equal(repo.value.id, Number(repositoryId))
      assert.equal(repo.value.archived, false)
      const base = repo.value.default_branch as string
      report.base = base
      report.originalDefaultHead = (
        await api(`${prefix}/git/ref/heads/${base}`, writeToken)
      ).value.object.sha
      const protection = await api(`${prefix}/branches/${base}/protection`, writeToken)
      report.protectionRead = { status: protection.status, message: protection.value?.message }
      assert.equal((await lookup(writeToken)).value.length, 0)
      assert.equal((await api(`${prefix}/git/ref/heads/${branch}`, writeToken)).status, 404)
      report.scopedPermissionsVerified = true
      save()
      harness = await Harness.start({
        secret: "scripted-model",
        bindings: { REPOSITORY_SERVICE_TOKEN: "fixture-authority" },
        serviceBindings: {
          REPOSITORY_AUTHORITY: async (request) => {
            assert.equal(closing, false, "Fixture is closing")
            const input = (await request.json()) as {
              sessionId: string
              generation: number
              repositoryId: string
              token: boolean
              permission?: string
            }
            assert.equal(input.sessionId, sessionId)
            assert.equal(input.generation, 1)
            assert.equal(input.repositoryId, repositoryId)
            return Response.json({
              owner: "Effect-TS",
              repo: "slopcop-sandbox",
              token: input.token ? credentials.get(input.permission ?? "read") : undefined,
            })
          },
          GITHUB_PUBLICATION_API: async (request) => {
            assert.equal(closing, false, "Fixture is closing")
            const url = new URL(request.url)
            assert.equal(url.origin, "https://api.github.com")
            assert.ok(url.pathname.startsWith(prefix))
            const body = request.method === "POST" ? await request.text() : undefined
            if (body) {
              const input = JSON.parse(body)
              assert.equal(input.head, branch)
              assert.equal(input.base, base)
              assert.ok(input.body.includes(marker))
              assert.equal(++creates, 1, "Never repeat the PR POST")
              report.prCreateIntent = true
              save()
            }
            assert.equal(closing, false, "Fixture is closing")
            const pending = fetch(request.url, {
              method: request.method,
              headers: request.headers,
              body,
              redirect: "manual",
              signal: AbortSignal.timeout(20000),
            })
            inFlight.add(pending)
            const response = await pending
              .catch((error: unknown) => {
                report.transportFailure = tokens.reduce(
                  (text, token) => text.replaceAll(token, "[redacted]"),
                  `${String(error)}; cause: ${String((error as { cause?: unknown })?.cause)}`,
                )
                save()
                throw error
              })
              .finally(() => inFlight.delete(pending))
            if (body) {
              report.prCreateResponse = {
                status: response.status,
                acceptedPermissions: response.headers.get("x-accepted-github-permissions"),
              }
              save()
              if (response.status !== 201) {
                const rejection = (await response.clone().json()) as {
                  message?: string
                  errors?: unknown
                }
                report.prRejection = rejection.message
                report.prValidationErrors = rejection.errors
                save()
                return response
              }
              const pr = (await response.json()) as { number: number; html_url: string }
              report.pullRequest = pr.html_url
              report.pullRequestNumber = pr.number
              save()
              // Lose a real successful response at the transport boundary.
              return new Response(null, { status: 503 })
            }
            if (url.pathname.endsWith("/pulls") && hidePR) {
              await response.arrayBuffer()
              return Response.json([])
            }
            return response
          },
          REPOSITORY_TEST_TRANSPORT: async (request) => {
            assert.equal(closing, false, "Fixture is closing")
            const path = new URL(request.url).pathname
            if (path === "/start") {
              const input = (await request.json()) as {
                resource: string
                env: { JANITOR_BRIDGE_TOKEN: string }
              }
              if (!resources.has(input.resource)) {
                assert.equal(closing, false, "Fixture is closing")
                const container = docker(
                  "run",
                  "-d",
                  "--rm",
                  "-p",
                  "127.0.0.1::8788",
                  "--entrypoint",
                  "node",
                  "-e",
                  `JANITOR_BRIDGE_TOKEN=${input.env.JANITOR_BRIDGE_TOKEN}`,
                  "localhost/janitor-inspection:ticket05",
                  "--input-type=module",
                  "-e",
                  "import {startBridge} from '/opt/janitor/server.mjs'; await startBridge({token:process.env.JANITOR_BRIDGE_TOKEN,generation:1,cwd:'/workspace',journalPath:'/tmp/journal.sqlite',port:8788,host:'0.0.0.0'});",
                )
                resources.set(input.resource, { container, url: "" })
                const url = `http://${docker("port", container, "8788")}`
                resources.set(input.resource, { container, url })
                await waitFor(async () => {
                  try {
                    await fetch(url + "/meta")
                    return true
                  } catch {
                    return false
                  }
                }, Boolean)
              }
              return Response.json({ started: true })
            }
            if (path === "/destroy") return Response.json({ destroyed: true })
            const resource = resources.get(request.headers.get("x-test-resource")!)!
            if (path.startsWith("/git/")) {
              const input = (await request.clone().json()) as {
                branch: string
                owner: string
                repo: string
              }
              assert.equal(input.branch, branch)
              assert.equal(`${input.owner}/${input.repo}`, repository)
            }
            if (path === "/git/push") assert.equal(++pushes, 1, "Never repeat the successful push")
            const requestBody = request.method === "GET" ? undefined : await request.arrayBuffer()
            assert.equal(closing, false, "Fixture is closing")
            const response = await fetch(resource.url + path, {
              method: request.method,
              headers: request.headers,
              body: requestBody,
            })
            if (path === "/git/prepare") {
              const prepared = (await response.clone().json()) as {
                commit: string
                baseCommit: string
              }
              report.localCommit = prepared.commit
              report.baseCommit = prepared.baseCommit
              save()
              assert.notEqual(
                prepared.commit,
                prepared.baseCommit,
                "Fixture must commit new work before publication",
              )
            }
            if (path === "/git/push") {
              assert.equal(((await response.json()) as { status: string }).status, "pushed")
              report.pushResponseLost = true
              save()
              return new Response(null, { status: 503 })
            }
            return response
          },
        },
      })
      const session = harness.session(sessionId)
      await session.create({ repositoryId })
      await session.model({
        mode: "repository-work",
        tools: [
          {
            name: "shell",
            input: {
              command: `mkdir -p .janitor-fixture && printf 'Disposable ticket 07 acceptance. No merge intended.\\n' > .janitor-fixture/${sessionId}.txt && git add .janitor-fixture/${sessionId}.txt && git -c user.name='Janitor acceptance' -c user.email=fixture@example.invalid commit -m 'Verify ticket 07 publication'`,
            },
          },
          {
            name: "publish",
            input: {
              title: "Disposable ticket 07 publication acceptance",
              body: "Verifies durable publication through the production runner and bridge. A scripted model created one committed fixture file. This PR will be closed without merging and its branch deleted.",
              base,
            },
          },
        ],
      })
      await session.admit({
        inputId: "msg_live_publish",
        text: "Run the bounded publication acceptance",
      })
      await waitFor(
        async () =>
          (await session.allEvents()).events.some(
            (event: { type: string }) => event.type === "session.execution.succeeded",
          ),
        Boolean,
        { timeoutMs: 90000 },
      )
      assert.equal(creates, 1, "Publication did not reach live PR creation")
      assert.equal(typeof report.pullRequest, "string", "Live PR creation did not succeed")
      hidePR = false
      await harness.restart()
      await session.model({
        mode: "repository-work",
        tools: [
          {
            name: "publish",
            input: { title: "Recover", body: "Recover the existing publication" },
          },
        ],
      })
      await session.admit({
        inputId: "msg_live_recover",
        text: "Reconcile the existing PR after restart",
      })
      await waitFor(
        async () =>
          JSON.stringify((await session.allEvents()).events).includes(String(report.pullRequest)),
        Boolean,
        { timeoutMs: 30000 },
      )
      assert.equal(creates, 1)
      assert.equal(pushes, 1)
      assert.equal((await lookup(writeToken)).value.length, 1)
      const events = JSON.stringify((await session.allEvents()).events)
      for (const token of tokens)
        assert.ok(!events.includes(token), "Credential appeared in durable events")
      const bucket = await harness.mf.getR2Bucket("WORKSPACE_CHECKPOINTS")
      for (const object of (await bucket.list()).objects) {
        const text = await (await bucket.get(object.key))!.text()
        const bytes = Buffer.concat(
          text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((line) => line.data)
            .map((line) => Buffer.from(line.data, "base64")),
        )
        for (const token of tokens)
          assert.ok(
            !text.includes(token) && !bytes.includes(Buffer.from(token)),
            "Credential appeared in checkpoint",
          )
      }
      report.recoveredAfterRestart = true
      report.noDuplicateWrites = { pushes, creates }
      report.credentialsExcluded = true
      const readToken = credentials.get("read")!
      assert.equal((await api("/installation/token", readToken, "DELETE")).status, 204)
      assert.equal((await api("/installation/repositories", readToken)).status, 401)
      report.revokedCredentialRejected = true
      await session.cleanup()
    } catch (error) {
      failed = true
      report.failed = true
      report.error = tokens
        .reduce((text, token) => text.replaceAll(token, "[redacted]"), String(error))
        .replaceAll(privateKey, "[redacted]")
      // Avoid serializing assertion values, request headers, or credential-bearing responses.
      console.error(
        "Live publication acceptance failed; inspect the nonsecret evidence and stage markers.",
      )
    } finally {
      closing = true
      try {
        await harness?.dispose()
      } catch {
        cleanupErrors.push("Local durable storage cleanup failed")
      }
      for (const { container } of resources.values()) {
        try {
          docker("stop", "-t", "0", container)
        } catch {
          cleanupErrors.push("Container cleanup failed")
        }
      }
      await Promise.allSettled(inFlight)
      if (writeToken) {
        try {
          const found = await lookup(writeToken)
          assert.equal(found.status, 200)
          const rejected = report.prCreateResponse as { status: number } | undefined
          if (
            report.prCreateIntent &&
            ![400, 401, 403, 404, 422, 429].includes(rejected?.status ?? 0)
          )
            assert.equal(found.value.length, 1, "PR intent still requires reconciliation")
          for (const pr of found.value) {
            assert.equal(pr.head.ref, branch)
            assert.equal(pr.head.repo.id, Number(repositoryId))
            assert.ok(pr.body.includes(marker))
            assert.equal(pr.merged_at, null)
            assert.equal(
              (await api(`${prefix}/pulls/${pr.number}`, writeToken, "PATCH", { state: "closed" }))
                .status,
              200,
            )
            const closed = await api(`${prefix}/pulls/${pr.number}`, writeToken)
            assert.equal(closed.value.state, "closed")
            assert.equal(closed.value.merged, false)
            report.closedWithoutMerge = closed.value.html_url
          }
        } catch {
          cleanupErrors.push("PR cleanup or verification failed")
        }
        try {
          const ref = await api(`${prefix}/git/ref/heads/${branch}`, writeToken)
          assert.ok([200, 404].includes(ref.status))
          if (ref.status === 200)
            assert.equal(
              (await api(`${prefix}/git/refs/heads/${branch}`, writeToken, "DELETE")).status,
              204,
            )
          await waitFor(
            async () => (await api(`${prefix}/git/ref/heads/${branch}`, writeToken!)).status,
            (status) => status === 404,
            { timeoutMs: 20000, intervalMs: 500, label: "deleted branch absence" },
          )
          report.branchAbsent = true
          assert.equal(
            (await api(`${prefix}/git/ref/heads/${report.base}`, writeToken)).value.object.sha,
            report.originalDefaultHead,
          )
          report.defaultBranchUnchanged = true
        } catch {
          cleanupErrors.push("Branch cleanup or verification failed")
        }
      }
      for (const token of tokens) {
        try {
          assert.ok([204, 401].includes((await api("/installation/token", token, "DELETE")).status))
        } catch {
          cleanupErrors.push("Token revocation failed")
        }
      }
      report.cleanupErrors = cleanupErrors
      report.tokensRevoked = !cleanupErrors.includes("Token revocation failed")
      report.passed = !failed && cleanupErrors.length === 0
      report.finishedAt = new Date().toISOString()
      save()
    }
    assert.equal(
      report.passed,
      true,
      "Live acceptance or cleanup failed; inspect the evidence file",
    )
  },
  180000,
)

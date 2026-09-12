import { it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { Harness, waitFor } from "./support/Harness.ts"

it("native publication reconciles lost push and PR replies without duplicate writes after restart", async () => {
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim()
  const resources = new Map<string, { container: string; url: string }>()
  let pushes = 0
  let creates = 0
  let pr: any
  let lag = true
  let dropPrepare = true
  let recoveredPrepare = false
  let ready = true
  let pauseAfterPrepare = false
  let rejection: number | undefined
  const tokens: string[] = []
  const harness = await Harness.start({
    secret: "test-model",
    bindings: { REPOSITORY_SERVICE_TOKEN: "authority" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async (request) => {
        if (!ready) return new Response(null, { status: 423 })
        const input = (await request.json()) as { permission?: string; token: boolean }
        if (input.token) tokens.push(input.permission ?? "read")
        return Response.json({
          owner: "fixture",
          repo: "repo",
          token: input.token ? "scoped-secret" : undefined,
        })
      },
      GITHUB_PUBLICATION_API: async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer scoped-secret")
        if (new URL(request.url).pathname === "/repos/fixture/repo")
          return Response.json({ id: 123, default_branch: "main" })
        if (request.method === "POST") {
          if (rejection) return new Response(null, { status: rejection })
          creates++
          const input = (await request.json()) as any
          pr = {
            number: 7,
            html_url: "https://github.com/fixture/repo/pull/7",
            body: input.body,
            head: { ref: input.head, sha: "b".repeat(40), repo: { id: 123 } },
            base: { ref: "main", repo: { id: 123 } },
          }
          return new Response(null, { status: 503 })
        }
        return Response.json(lag ? [] : [pr])
      },
      REPOSITORY_TEST_TRANSPORT: async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/start") {
          const input = (await request.json()) as any
          if (!resources.has(input.resource)) {
            const source = `import {mkdirSync,writeFileSync} from 'node:fs';
            import {execFileSync} from 'node:child_process';
            import {startBridge} from '/opt/janitor/server.mjs';
            mkdirSync('/tmp/remotes/fixture',{recursive:true});
            const git=(...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.com',...args]);
            git('init','--bare','--initial-branch=main','/tmp/remotes/fixture/repo.git');
            git('clone','/tmp/remotes/fixture/repo.git','/workspace/repository');
            writeFileSync('/workspace/repository/README.md','base');
            git('-C','/workspace/repository','add','.');
            git('-C','/workspace/repository','commit','-m','base');
            git('-C','/workspace/repository','push','origin','main');
            writeFileSync('/workspace/repository/parser.txt','saved work');
            git('-C','/workspace/repository','add','.');
            git('-C','/workspace/repository','commit','-m','Repair parser');
            git('clone','/tmp/remotes/fixture/repo.git','/tmp/human');
            writeFileSync('/tmp/human/human.txt','concurrent human work');
            git('-C','/tmp/human','add','.');
            git('-C','/tmp/human','commit','-m','Human work');
            git('-C','/tmp/human','push','origin','main');
            await startBridge({token:process.env.JANITOR_BRIDGE_TOKEN,generation:1,cwd:'/workspace',journalPath:'/tmp/journal.sqlite',port:8788,host:'0.0.0.0',cloneOrigin:'/tmp/remotes'});`
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
              source,
            )
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
        if (path === "/repository") return Response.json({ ready: true })
        const resource = resources.get(request.headers.get("x-test-resource")!)!
        const response = await fetch(resource.url + path, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" ? undefined : await request.arrayBuffer(),
        })
        if (path === "/git/prepare") {
          const result = (await response.clone().json()) as { duplicate?: boolean }
          recoveredPrepare ||= result.duplicate === true
          if (dropPrepare) {
            dropPrepare = false
            await response.arrayBuffer()
            return new Response(null, { status: 503 })
          }
          if (pauseAfterPrepare) {
            pauseAfterPrepare = false
            ready = false
          }
        }
        if (path === "/git/push") {
          pushes++
          expect(await response.json()).toMatchObject({ status: "pushed" })
          return new Response(null, { status: 503 })
        }
        return response
      },
    },
  })
  try {
    const session = harness.session("publish-new")
    await session.create({ repositoryId: "123" })
    await session.model({
      mode: "repository-work",
      tools: [
        {
          name: "publish",
          input: { title: "Repair parser", body: "Fixes empty input. Parser tests pass." },
        },
        { name: "shell", input: { command: "touch /workspace/repository/forbidden" } },
        {
          name: "publish",
          input: { title: "Repair parser", body: "Fixes empty input. Parser tests pass." },
        },
      ],
    })
    await session.admit({ inputId: "msg_publish", text: "Publish the tested changes" })
    await waitFor(async () => {
      const events = (await session.allEvents()).events
      return events.some((event: any) => event.type === "session.execution.succeeded")
    }, Boolean)
    expect(creates, JSON.stringify((await session.allEvents()).events)).toBe(1)
    expect(pushes).toBe(1)
    expect(recoveredPrepare).toBe(true)
    expect(JSON.stringify((await session.allEvents()).events)).toContain("Publication is pending")
    lag = false
    await harness.restart()
    await session.model({
      mode: "repository-work",
      tools: [{ name: "publish", input: { title: "Retry", body: "Recover publication" } }],
    })
    await session.admit({ inputId: "msg_recover", text: "Recover the publication result" })
    await waitFor(
      async () =>
        JSON.stringify((await session.allEvents()).events).includes(
          "https://github.com/fixture/repo/pull/7",
        ),
      Boolean,
    )
    const events = JSON.stringify((await session.allEvents()).events)
    expect(events).not.toContain("scoped-secret")
    expect(events).toContain("Parser tests pass")
    expect(creates).toBe(1)
    expect(pushes).toBe(1)
    expect(tokens).toContain("push")
    expect(tokens).toContain("pull_request")
    await session.cleanup()
    const denied = harness.session("publish-denied")
    await denied.create({ repositoryId: "123" })
    pauseAfterPrepare = true
    for (const [index, status] of [undefined, 403, 422, undefined].entries()) {
      rejection = status
      const after = (await denied.allEvents()).next
      await denied.model({
        mode: "repository-work",
        tools: [{ name: "publish", input: { title: "Repair parser", body: "Parser tests pass." } }],
      })
      await denied.admit({ inputId: `msg_denied_${index}`, text: "Publish the tested changes" })
      await waitFor(
        async () =>
          (await denied.allEvents()).events.some(
            (event: any) => event.seq > after && event.type === "session.execution.succeeded",
          ),
        Boolean,
      )
      expect(creates).toBe(index === 3 ? 2 : 1)
      expect(pushes).toBe([1, 2, 2, 3][index])
      ready = true
    }
    const deniedEvents = JSON.stringify((await denied.allEvents()).events)
    expect(deniedEvents).toContain("GitHub denied PR creation")
    expect(deniedEvents).toContain("GitHub rejected PR validation")
    await denied.cleanup()

    const interrupted = harness.session("publish-checkpoint")
    await interrupted.create({ repositoryId: "123" })
    const incarnation = (await interrupted.state()).incarnation
    await interrupted.model({
      mode: "repository-work",
      tools: [
        {
          name: "publish",
          input: {
            title: "Checkpoint recovery",
            body: "Recover committed work after upload interruption.",
          },
        },
      ],
    })
    await interrupted.faults({ abortAfterArchiveUpload: true })
    await interrupted.admit({ inputId: "msg_checkpoint", text: "Publish committed work" })
    await waitFor(async () => (await interrupted.state()).incarnation !== incarnation, Boolean)
    await harness.restart()
    await interrupted.model({
      mode: "repository-work",
      tools: [
        {
          name: "publish",
          input: {
            title: "Checkpoint recovery",
            body: "Recover committed work after upload interruption.",
          },
        },
      ],
    })
    await interrupted.admit({ inputId: "msg_checkpoint_retry", text: "Recover publication" })
    await waitFor(
      async () =>
        JSON.stringify((await interrupted.allEvents()).events).includes(
          "https://github.com/fixture/repo/pull/7",
        ),
      Boolean,
    )
    expect(creates).toBe(3)
    const bucket = await harness.mf.getR2Bucket("WORKSPACE_CHECKPOINTS")
    for (const object of (await bucket.list()).objects) {
      const text = await (await bucket.get(object.key))!.text()
      expect(text).not.toContain("scoped-secret")
      const bytes = Buffer.concat(
        text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((line) => line.data)
          .map((line) => Buffer.from(line.data, "base64")),
      )
      expect(bytes.includes(Buffer.from("scoped-secret"))).toBe(false)
    }
    await interrupted.cleanup()
  } finally {
    await harness.dispose()
    for (const resource of resources.values()) docker("stop", "-t", "0", resource.container)
  }
}, 90000)

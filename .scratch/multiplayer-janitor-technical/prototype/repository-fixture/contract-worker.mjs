import { Effect } from "effect"
import { probeSDKSession, initializeSDKDatabase, removeSDKSession } from "./sdk-session.mjs"
import { DurableObject } from "cloudflare:workers"
import { getSandbox, Sandbox } from "@cloudflare/sandbox"
import fileProbe from "./worker-opencode.mjs"
export { Sandbox }
const digest = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

export class Contract extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.boot = crypto.randomUUID()
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS _janitor_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
      )
      await initializeSDKDatabase(ctx.storage)
      if (!this.read())
        this.write({
          active: true,
          generation: 1,
          sandboxID: `contract-${crypto.randomUUID()}`,
          token: crypto.randomUUID(),
          checkpoint: null,
          pending: null,
          operations: {},
        })
    })
  }
  read() {
    return this.ctx.storage.sql
      .exec("SELECT value FROM _janitor_state WHERE id=1")
      .toArray()
      .map((r) => JSON.parse(r.value))[0]
  }
  write(state) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO _janitor_state VALUES (1,?)",
      JSON.stringify(state),
    )
  }
  sandbox(state = this.read()) {
    return getSandbox(this.env.Sandbox, state.sandboxID)
  }
  async exec(command) {
    const result = await this.sandbox().exec(command, { timeout: 60000 })
    assert(result.exitCode === 0, `fixture command failed: ${result.stderr}`)
    return result.stdout
  }
  async raw(path, body, headers = {}) {
    const s = this.read()
    assert(s.active, "disconnected session")
    const response = await this.sandbox(s).containerFetch(
      `http://bridge${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${s.token}`,
          "x-bridge-epoch": s.epoch ?? "",
          ...headers,
        },
        body,
      },
      8788,
    )
    const latest = this.read()
    if (!latest.active || latest.generation !== s.generation) {
      await this.sandbox(s).destroy()
      throw new Error("late sandbox response fenced")
    }
    return response
  }
  async rpc(path, input) {
    const r = await this.raw(path, input === undefined ? undefined : JSON.stringify(input), {
      "content-type": "application/json",
    })
    const b = await r.json()
    assert(r.ok, JSON.stringify(b))
    return b
  }
  async connect() {
    const s = this.read()
    assert(s.active, "disconnected session")
    const process = await this.sandbox(s).startProcess(
      "node /opt/janitor-fixture/remote-bridge-server.mjs",
      { processId: "fixture-bridge", env: { FIXTURE_BRIDGE_TOKEN: s.token } },
    )
    await process.waitForPort(8788, { mode: "tcp" })
    const meta = await this.raw("/meta")
    assert(meta.ok, "bridge bootstrap failed")
    s.epoch = (await meta.json()).epoch
    this.write(s)
  }
  async fetch(request) {
    const route = new URL(request.url).pathname
    const input = request.method === "POST" ? await request.json() : {}
    try {
      let s = this.read()
      if (route === "/status")
        return Response.json({
          active: s.active,
          generation: s.generation,
          checkpoint: s.checkpoint,
          pending: s.pending,
          operations: s.operations,
          boot: this.boot,
        })
      if (route === "/start") {
        assert(s.active, "disconnected")
        const baseline = JSON.parse(await this.exec("node /opt/janitor-fixture/fixture.mjs"))
        assert(
          /^\/tmp\/janitor-repository-fixture-[a-zA-Z0-9]+$/.test(baseline.root),
          "unexpected fixture path",
        )
        await this.exec(
          `mkdir -p /workspace/fixture && cp -a ${baseline.root}/workspace/. /workspace/fixture/ && printf '\n/tool-capture-*.out\n/fixture-shell-output.out\n' >> /workspace/fixture/.git/info/exclude`,
        )
        await this.connect()
        const same = getSandbox(this.env.Sandbox, s.sandboxID)
        assert(
          (await same.exec("test -f /workspace/fixture/post.md")).exitCode === 0,
          "idempotent sandbox adoption failed",
        )
        const badAuth = await this.raw("/meta", undefined, { authorization: "Bearer wrong" })
        const badEpoch = await this.raw("/process/no-such", undefined, {
          "x-bridge-epoch": "wrong",
        })
        assert(
          badAuth.status === 401 && badEpoch.status === 409,
          "bridge authentication/fencing failed",
        )
        return Response.json({
          localGitCasesInsideSandbox: baseline.checks,
          idempotentAdoption: true,
          authRejected: 401,
          staleEpochRejected: 409,
        })
      }
      if (route === "/sdk") {
        const admitted = async (payload) => {
          const state = this.read()
          assert(state.active, "disconnected")
          assert(
            !state.operations["sdk-shell"],
            "existing operation must be reconciled before dispatch",
          )
          state.operations["sdk-shell"] = {
            state: "uncertain",
            generation: state.generation,
            payload,
          }
          this.write(state)
          await this.ctx.storage.sync()
        }
        const checkpoint = async () => {
          for (const [path, body] of [
            ["/stage", { op: "sdk-shell" }],
            ["/commit", {}],
          ]) {
            const r = await this.fetch(
              new Request("http://fixture" + path, { method: "POST", body: JSON.stringify(body) }),
            )
            const b = await r.json()
            assert(r.ok, JSON.stringify(b))
          }
          await this.rpc("/thaw", {})
        }
        const result = await Effect.runPromise(
          probeSDKSession(
            this.ctx.storage,
            (path, input) => this.rpc(path, input),
            admitted,
            checkpoint,
          ),
        )
        assert(
          this.read().operations["sdk-shell"]?.state === "complete",
          "native tool completed before checkpoint",
        )
        const latest = this.read()
        latest.sdkSessionID = result.sessionID
        this.write(latest)
        await this.rpc("/thaw", {})
        return Response.json(result)
      }
      if (route === "/github-network") {
        assert(s.active, "disconnected")
        assert(
          typeof input.token === "string" &&
            /^janitor-verification\/[0-9a-f]{8}-cloudflare$/.test(input.branch),
          "invalid GitHub fixture input",
        )
        const command = `set -e
mkdir -p /tmp/github-network
cd /tmp/github-network
git -c credential.helper= -c 'credential.helper=!f() { test "$1" = get || exit 0; printf "username=x-access-token\\npassword=%s\\n" "$GITHUB_FIXTURE_TOKEN"; }; f' clone --depth=1 --single-branch --branch main https://github.com/Effect-TS/slopcop-sandbox.git repo
cd repo
git config user.name 'Janitor Cloudflare Fixture'
git config user.email fixture@example.invalid
git checkout -b ${input.branch}
mkdir -p .janitor-fixture
printf 'Cloudflare Sandbox GitHub App publication fixture\\n' > .janitor-fixture/cloudflare.txt
git add .janitor-fixture/cloudflare.txt
git -c core.hooksPath=/dev/null commit -m 'Disposable Cloudflare publication fixture'
git -c core.hooksPath=/dev/null -c credential.helper= -c 'credential.helper=!f() { test "$1" = get || exit 0; printf "username=x-access-token\\npassword=%s\\n" "$GITHUB_FIXTURE_TOKEN"; }; f' push origin HEAD:refs/heads/${input.branch}
tar -cf /tmp/github-network.tar .
node -e 'const fs=require("fs");if(fs.readFileSync("/tmp/github-network.tar").includes(Buffer.from(process.env.GITHUB_FIXTURE_TOKEN)))process.exit(2)'
git rev-parse HEAD`
        const result = await this.sandbox().exec(command, {
          timeout: 60000,
          env: {
            GITHUB_FIXTURE_TOKEN: input.token,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
        })
        assert(result.exitCode === 0, "Cloudflare GitHub network fixture failed")
        const sha = result.stdout.trim().split("\n").at(-1)
        assert(/^[0-9a-f]{40}$/.test(sha), "missing published commit")
        await this.exec(
          'test -z "$GITHUB_FIXTURE_TOKEN" && rm -rf /tmp/github-network /tmp/github-network.tar',
        )
        return Response.json({
          branch: input.branch,
          sha,
          cloneAndPushThroughCloudflare: true,
          tokenAbsentFromArchive: true,
          tokenAbsentAfterExec: true,
        })
      }
      if (route === "/tools") {
        const result = await fileProbe.fetch(new Request("http://fixture/verify"), {
          WORKSPACE: "/workspace/fixture",
          BRIDGE: {
            fetch: async (req) => {
              const u = new URL(req.url)
              return this.raw(
                u.pathname + u.search,
                req.method === "GET" ? undefined : await req.text(),
                { "content-type": "application/json" },
              )
            },
          },
        })
        const body = await result.json()
        assert(result.ok, JSON.stringify(body))
        return Response.json({ ...body, cloudflareSandboxTested: true })
      }
      if (route === "/protocol") {
        const payload = {
          id: "lost-reply",
          argv: [
            "/bin/sh",
            "-c",
            "printf x >> starts; cat > binary-input; printf stderr >&2; exit 7",
          ],
        }
        let lostSpawn = false
        try {
          const r = await this.raw("/process", JSON.stringify(payload), {
            "x-fixture-drop-reply": "once",
          })
          lostSpawn = !r.ok
          await r.arrayBuffer()
        } catch {
          lostSpawn = true
        }
        assert(lostSpawn, "spawn response loss was not observed")
        assert((await this.rpc("/process", payload)).duplicate, "spawn was not reconciled")
        const input = { seq: 0, base64: "AP+ACg0=", end: true }
        let lostStdin = false
        try {
          const r = await this.raw("/process/lost-reply/stdin", JSON.stringify(input), {
            "x-fixture-drop-reply": "once",
          })
          lostStdin = !r.ok
          await r.arrayBuffer()
        } catch {
          lostStdin = true
        }
        assert(lostStdin, "stdin response loss was not observed")
        assert(
          (await this.rpc("/process/lost-reply/stdin", input)).duplicate,
          "stdin was not reconciled",
        )
        let result
        for (;;) {
          result = await this.rpc("/process/lost-reply")
          if (result.closed) break
          await new Promise((r) => setTimeout(r, 20))
        }
        assert(
          result.code === 7 && result.frames.some((f) => f.kind === "stderr"),
          "exit/stderr lost",
        )
        assert((await this.exec("cat /workspace/fixture/starts")) === "x", "duplicate spawn")
        assert(
          (await this.exec("base64 -w0 /workspace/fixture/binary-input")) === input.base64,
          "duplicate or corrupted stdin",
        )
        const escaped = await this.raw(
          "/process",
          JSON.stringify({ id: "outside", argv: ["pwd"], cwd: "/tmp" }),
        )
        assert(escaped.status === 400, "outside cwd admitted")
        await this.exec("mkdir -p /workspace/fixture/subdir")
        await this.rpc("/process", {
          id: "subdirectory",
          argv: ["/bin/sh", "-c", 'test -z "$FIXTURE_BRIDGE_TOKEN" && pwd'],
          cwd: "/workspace/fixture/subdir",
        })
        for (;;) {
          const r = await this.rpc("/process/subdirectory")
          if (r.closed) {
            assert(r.code === 0, "control token inherited")
            break
          }
          await new Promise((r) => setTimeout(r, 20))
        }
        return Response.json({
          lostSpawnAndStdinRepliesReconciled: true,
          binaryInput: true,
          nonzeroExit: true,
          stderr: true,
          outsideCwdRejected: true,
          subdirectoryCwd: true,
          controlCredentialNotInherited: true,
        })
      }
      if (route === "/prepare") {
        assert(s.active, "disconnected")
        await this.rpc("/thaw", {})
        await this.exec(
          "cd /workspace/fixture && head -c 8388608 /dev/zero > required-large.local && printf '\nrequired-large.local\n' >> .git/info/exclude && mkdir -p many && for n in $(seq 1 200); do printf 'fixture %s\n' $n > many/file-$n; done",
        )
        const id = "failed-edit"
        await this.rpc("/process", {
          id,
          argv: ["/bin/sh", "-c", "printf 'failed command edit\n' > failed-edit.md; exit 7"],
        })
        for (;;) {
          const p = await this.rpc("/process/" + id)
          if (p.closed) {
            assert(p.code === 7, "failed edit exit")
            break
          }
          await new Promise((r) => setTimeout(r, 20))
        }
        s = this.read()
        s.manifest = await this.exec("node /opt/janitor-fixture/workspace-manifest.mjs")
        this.write(s)
        return Response.json({
          manifestFiles: Object.keys(JSON.parse(s.manifest).files).length,
          failedEditPreserved: true,
        })
      }
      if (route === "/stage") {
        assert(s.active, "disconnected")
        assert(!s.pending, "pending checkpoint requires reconciliation")
        assert(typeof input.op === "string" && /^[a-z-]+$/.test(input.op), "invalid operation")
        const previous = s.operations[input.op]
        if (previous?.state === "complete")
          return Response.json({ duplicate: true, operation: previous })
        s.operations[input.op] ??= { state: "uncertain", generation: s.generation }
        const key = `${s.sandboxID}/${crypto.randomUUID()}.tar`
        s.pending = { key, op: input.op, generation: s.generation }
        this.write(s)
        if (input.fail === "before-upload") throw new Error("injected upload failure")
        const start = Date.now()
        const archive = await this.raw("/archive")
        assert(archive.ok, "archive freeze failed")
        const bytes = await archive.arrayBuffer()
        const sha256 = await digest(bytes)
        assert(
          !new TextDecoder().decode(bytes).includes(s.token),
          "bridge credential found in archive",
        )
        await this.env.CHECKPOINTS.put(key, bytes, { customMetadata: { sha256, format: "tar" } })
        s = this.read()
        if (!s.active || s.pending?.key !== key || s.pending.generation !== s.generation) {
          await this.env.CHECKPOINTS.delete(key)
          throw new Error("late checkpoint fenced")
        }
        s.pending = { ...s.pending, sha256, size: bytes.byteLength, elapsedMs: Date.now() - start }
        this.write(s)
        if (input.fail === "after-upload") {
          await this.ctx.storage.sync()
          this.ctx.abort("fixture crash after archive upload")
        }
        return Response.json(s.pending)
      }
      if (route === "/commit") {
        assert(s.active && s.pending?.generation === s.generation, "stale completion fenced")
        assert(s.pending && s.pending.sha256, "no uploaded checkpoint")
        const previous = s.checkpoint
        this.ctx.storage.transactionSync(() => {
          s.checkpoint = s.pending
          s.operations[s.pending.op] = {
            ...s.operations[s.pending.op],
            state: "complete",
            generation: s.generation,
            checkpoint: s.pending.key,
          }
          s.pending = null
          this.write(s)
        })
        if (previous) await this.env.CHECKPOINTS.delete(previous.key)
        if (input.fail === "after-commit") {
          await this.ctx.storage.sync()
          this.ctx.abort("fixture crash after atomic commit")
        }
        return Response.json({ checkpoint: s.checkpoint, operation: s.operations[s.checkpoint.op] })
      }
      if (route === "/reconcile") {
        if (s.pending) {
          await this.env.CHECKPOINTS.delete(s.pending.key)
          if (s.active)
            s.operations[s.pending.op] = { state: "uncertain", generation: s.pending.generation }
          s.pending = null
          this.write(s)
        }
        return Response.json({ checkpoint: s.checkpoint, orphanRemoved: true })
      }
      if (route === "/restore") {
        assert(s.active && s.checkpoint, "no restorable session")
        const oldEpoch = s.epoch
        await this.sandbox().destroy()
        await this.connect()
        assert(this.read().epoch !== oldEpoch, "bridge epoch was reused")
        const stale = await this.raw("/process/no-such", undefined, { "x-bridge-epoch": oldEpoch })
        assert(stale.status === 409, "stale retry admitted after restoration")
        await this.exec(
          "mkdir -p /workspace/fixture && touch /workspace/fixture/stale-overlay-file",
        )
        const start = Date.now()
        const obj = await this.env.CHECKPOINTS.get(s.checkpoint.key)
        assert(obj, "checkpoint missing")
        const bytes = await obj.arrayBuffer()
        assert((await digest(bytes)) === s.checkpoint.sha256, "checkpoint digest mismatch")
        const r = await this.raw("/restore", bytes)
        assert(r.ok, "restore failed")
        await r.arrayBuffer()
        await this.rpc("/thaw", {})
        const after = await this.exec("node /opt/janitor-fixture/workspace-manifest.mjs")
        assert(after === s.manifest, "restored manifest differs")
        await this.exec("cd /workspace/fixture && node check.mjs")
        return Response.json({
          identicalManifest: true,
          fixtureTestPassed: true,
          oldBridgeEpochRejected: true,
          staleOverlayFileRemoved: true,
          restoreMs: Date.now() - start,
          archiveBytes: bytes.byteLength,
        })
      }
      if (route === "/disconnect") {
        const sdkSessionID = s.sdkSessionID
        this.ctx.storage.transactionSync(() => {
          s = {
            active: false,
            generation: s.generation + 1,
            sandboxID: s.sandboxID,
            pending: s.pending,
            checkpoint: null,
            operations: {},
          }
          this.write(s)
        })
        await this.sandbox().destroy()
        if (sdkSessionID) {
          await removeSDKSession(this.ctx.storage, sdkSessionID)
          assert(
            this.ctx.storage.sql
              .exec("SELECT count(*) AS n FROM session_v2 WHERE id=?", sdkSessionID)
              .toArray()[0].n === 0,
            "native session data remained",
          )
        }
        const objects = await this.env.CHECKPOINTS.list({ prefix: s.sandboxID + "/" })
        await this.env.CHECKPOINTS.delete(objects.objects.map((o) => o.key))
        return Response.json({
          active: false,
          generation: s.generation,
          deletedObjects: objects.objects.length,
          nativeSessionDeleted: !!sdkSessionID,
        })
      }
      if (route === "/active-command") {
        await this.rpc("/thaw", {})
        await this.rpc("/process", {
          id: "disconnect-active",
          argv: ["/bin/sh", "-c", "sleep 30; touch forbidden-late-write"],
        })
        const freeze = await this.raw("/freeze", "{}")
        assert(freeze.status === 409, "snapshot admitted with active writer")
        return Response.json({ active: true, freezeRefusedWhileWriting: true })
      }
      if (route === "/cleanup") {
        await this.sandbox().destroy()
        const objects = await this.env.CHECKPOINTS.list({ prefix: s.sandboxID + "/" })
        if (objects.objects.length)
          await this.env.CHECKPOINTS.delete(objects.objects.map((o) => o.key))
        await this.ctx.storage.deleteAll()
        return Response.json({ cleaned: true })
      }
      return new Response("Not found", { status: 404 })
    } catch (error) {
      return Response.json({ error: String(error), route }, { status: 500 })
    }
  }
}
export default {
  async fetch(request, env) {
    if (request.headers.get("authorization") !== `Bearer ${env.FIXTURE_TOKEN}`)
      return new Response("Unauthorized", { status: 401 })
    const name = request.headers.get("x-fixture-instance") ?? "fixture"
    if (!/^[a-z0-9-]{1,48}$/.test(name))
      return new Response("Invalid fixture identity", { status: 400 })
    return env.CONTRACT.get(env.CONTRACT.idFromName(name)).fetch(request)
  },
}

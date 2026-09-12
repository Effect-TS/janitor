import { getSandbox, Sandbox } from "@cloudflare/sandbox"
export { Sandbox }

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>
  CHECKPOINTS: R2Bucket
  FIXTURE_TOKEN: string
}

// Disposable fixture only: one authenticated run, no arbitrary commands from
// callers, no repository/App credentials and no model-provider calls.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (
      !env.FIXTURE_TOKEN ||
      request.headers.get("authorization") !== `Bearer ${env.FIXTURE_TOKEN}`
    ) {
      return new Response("Unauthorized", { status: 401 })
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/verify") {
      return new Response("Not found", { status: 404 })
    }
    const id = `janitor-fixture-${crypto.randomUUID()}`
    const sandbox = getSandbox(env.Sandbox, id)
    const key = `fixture/${id}/workspace.tar`
    let recreated: ReturnType<typeof getSandbox> | undefined
    const checks: string[] = []
    try {
      const containment = await sandbox.exec("node /opt/janitor-fixture/probe-containment.mjs", {
        timeout: 30000,
      })
      if (containment.exitCode !== 0)
        throw new Error(`Containment probe failed: ${containment.stdout} ${containment.stderr}`)
      checks.push(
        "foreground PID namespace containment and cancellation passed inside Cloudflare Sandbox",
      )
      const bridge = await sandbox.exec("node /opt/janitor-fixture/probe-bridge.mjs", {
        timeout: 30000,
      })
      if (bridge.exitCode !== 0) throw new Error(`Bridge probe failed: ${bridge.stderr}`)
      checks.push("process bridge probe passed inside Cloudflare Sandbox")
      const setup = await sandbox.exec(
        "mkdir -p /workspace/fixture && cd /workspace/fixture && git init -b main && git config user.name Fixture && git config user.email fixture@example.invalid && printf 'base\\n' > post.md && git add post.md && git commit -m base && printf 'staged\\n' > post.md && git add post.md && printf 'unstaged\\n' >> post.md && printf 'untracked\\n' > notes.md && git status --porcelain=v1 > /tmp/fixture-status && git diff --binary > /tmp/fixture-diff && git diff --cached --binary > /tmp/fixture-index && tar -cf /tmp/workspace.tar -C /workspace/fixture . && base64 -w0 /tmp/workspace.tar",
        { timeout: 30000 },
      )
      if (setup.exitCode !== 0) throw new Error(`Setup failed: ${setup.stderr}`)
      // Git emits setup output; obtain only archive bytes through a separate call.
      const encoded = await sandbox.exec("base64 -w0 /tmp/workspace.tar")
      if (encoded.exitCode !== 0) throw new Error("Archive read failed")
      const bytes = Uint8Array.from(atob(encoded.stdout.trim()), (c) => c.charCodeAt(0))
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("")
      const before = await sandbox.exec(
        "cat /tmp/fixture-status /tmp/fixture-diff /tmp/fixture-index",
      )
      if (before.exitCode !== 0) throw new Error("Manifest read failed")
      await env.CHECKPOINTS.put(key, bytes, {
        customMetadata: { sha256, format: "tar", fixture: id },
      })
      checks.push("custom archive saved to R2 without SDK expiry metadata")
      await sandbox.destroy()
      recreated = getSandbox(env.Sandbox, `${id}-restored`)
      const object = await env.CHECKPOINTS.get(key)
      if (!object) throw new Error("R2 archive missing")
      const restoredBytes = new Uint8Array(await object.arrayBuffer())
      const restoredHash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", restoredBytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("")
      if (restoredHash !== sha256) throw new Error("R2 archive checksum mismatch")
      const encodedArchive = btoa(String.fromCharCode(...restoredBytes))
      // Fixture archive is deliberately tiny; base64 alphabet has no shell quotes.
      await recreated.writeFile("/tmp/restore.b64", encodedArchive)
      const restored = await recreated.exec(
        "mkdir -p /workspace/fixture && base64 -d /tmp/restore.b64 > /tmp/workspace.tar && tar -xf /tmp/workspace.tar -C /workspace/fixture && cd /workspace/fixture && git status --porcelain=v1 && git diff --binary && git diff --cached --binary",
        { timeout: 30000 },
      )
      if (restored.exitCode !== 0 || restored.stdout !== before.stdout)
        throw new Error("Restored Git state differs")
      checks.push("new sandbox restores identical staged, unstaged and untracked Git state")
      return Response.json({
        id,
        checks,
        archiveBytes: bytes.length,
        fullOpenCodeAdapterVerified: false,
        durablePointerTransactionVerified: false,
        githubPublicationVerified: false,
      })
    } catch (error) {
      return Response.json({ id, checks, error: String(error) }, { status: 500 })
    } finally {
      // Cleanup failures must remain visible in Worker logs and can be retried
      // using the fixture ID; resource-level teardown is documented separately.
      const cleanup = await Promise.allSettled([
        sandbox.destroy(),
        recreated?.destroy(),
        env.CHECKPOINTS.delete(key),
      ])
      for (const result of cleanup)
        if (result.status === "rejected")
          console.error("fixture cleanup failed", id, String(result.reason))
    }
  },
}

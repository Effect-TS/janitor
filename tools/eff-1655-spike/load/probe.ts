// Probes which node:* APIs used by clanka's AgentExecutor actually work in
// workerd (vs. merely importing). Each probe is isolated so one failure does
// not hide the others.
type Probe = { ok: true; detail?: unknown } | { ok: false; error: string }

const probe = async (f: () => Promise<unknown> | unknown): Promise<Probe> => {
  try {
    const detail = await f()
    return { ok: true, detail }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

export default {
  async fetch(_request: Request): Promise<Response> {
    const results: Record<string, Probe> = {}

    results["import node:vm"] = await probe(async () => Object.keys(await import("node:vm")).sort())
    results["import node:os"] = await probe(async () => Object.keys(await import("node:os")).sort())
    results["import node:stream"] = await probe(async () => Object.keys(await import("node:stream")).slice(0, 12))
    results["import node:console"] = await probe(async () => Object.keys(await import("node:console")).sort())

    // What makeLocal / compileScript do:
    results["new vm.Script"] = await probe(async () => {
      const vm = await import("node:vm")
      const s = new vm.Script("async function main() { return 1 + 1 }")
      return typeof s
    })
    results["vm.Script.runInNewContext"] = await probe(async () => {
      const vm = await import("node:vm")
      const s = new vm.Script("globalThis.__x = main()")
      const sandbox: Record<string, unknown> = { main: () => 42 }
      s.runInNewContext(sandbox, { timeout: 1000 })
      return sandbox
    })
    results["vm.runInNewContext"] = await probe(async () => {
      const vm = await import("node:vm")
      return vm.runInNewContext("a + b", { a: 1, b: 2 })
    })
    // What homeDirectory() does:
    results["os.homedir"] = await probe(async () => (await import("node:os")).homedir())
    // What makeConsole does: a Console writing to a custom Writable
    results["new console.Console({stdout: Writable})"] = await probe(async () => {
      const { Writable } = await import("node:stream")
      const NodeConsole = await import("node:console")
      const chunks: string[] = []
      const w = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk.toString())
          cb()
        },
      })
      const c = new NodeConsole.Console({ stdout: w, colorMode: false })
      c.log("hello", { a: 1 })
      await new Promise((r) => setTimeout(r, 10))
      return chunks
    })
    results["class extends Writable"] = await probe(async () => {
      const { Writable } = await import("node:stream")
      class Q extends Writable {
        out: string[] = []
        _write(chunk: any, _e: BufferEncoding, cb: (e?: Error | null) => void) {
          this.out.push(chunk.toString())
          cb()
        }
      }
      const q = new Q()
      q.write("x")
      return q.out
    })
    results["process.env / process.on"] = await probe(() => ({
      env: typeof process?.env,
      on: typeof process?.on,
      home: process?.env?.HOME ?? null,
    }))
    // Does the clanka module graph load at all when imported dynamically?
    results["import clanka/Agent"] = await probe(async () => Object.keys(await import("clanka/Agent")))
    results["import clanka/AgentExecutor"] = await probe(async () => Object.keys(await import("clanka/AgentExecutor")))

    return Response.json(results, { headers: { "content-type": "application/json" } })
  },
}

import { sandboxRunArgs } from "./SandboxContainer.ts"
// Disposable repository for native model validation. No GitHub credential or network Git operation.
import { execFileSync } from "node:child_process"

export const modelRepository = () => {
  const resources = new Map<string, { container: string; url: string }>()
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim()
  const stop = (resource: string) => {
    const running = resources.get(resource)
    if (running) {
      docker("stop", "-t", "0", running.container)
      resources.delete(resource)
    }
  }
  return {
    dispose: () => {
      for (const resource of resources.keys()) stop(resource)
    },
    bindings: { REPOSITORY_SERVICE_TOKEN: "model-test-authority" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async () => Response.json({ owner: "fixture", repo: "fixture" }),
      REPOSITORY_TEST_TRANSPORT: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname
        if (path === "/running")
          return Response.json({ running: resources.has(await request.text()) })
        if (path === "/destroy") {
          stop(await request.text())
          return Response.json({ destroyed: true })
        }
        if (path === "/start") {
          const input = (await request.json()) as { resource: string; env: Record<string, string> }
          const container = docker(
            "run",
            ...sandboxRunArgs,
            "-d",
            "--rm",
            "-p",
            "127.0.0.1::8788",
            "--entrypoint",
            "node",
            "-e",
            `JANITOR_BRIDGE_TOKEN=${input.env.JANITOR_BRIDGE_TOKEN}`,
            "localhost/janitor-runner-sandbox:dev",
            "--input-type=module",
            "-e",
            `
              import { mkdirSync, writeFileSync } from 'node:fs';
              import { execFileSync } from 'node:child_process';
              import { startBridge } from '/opt/janitor/server.mjs';
              mkdirSync('/workspace/repository', { recursive: true });
              execFileSync('git', ['init', '/workspace/repository']);
              writeFileSync('/workspace/repository/README.md', 'Validation code: apricot-47\\n');
              writeFileSync('/workspace/repository/NOTES.md', 'Validation code: cobalt-29\\n');
              await startBridge({ token: process.env.JANITOR_BRIDGE_TOKEN, generation: 1, cwd: '/workspace',
                journalPath: '/tmp/journal.sqlite', port: 8788, host: '0.0.0.0' });`,
          )
          const url = `http://${docker("port", container, "8788")}`
          resources.set(input.resource, { container, url })
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              await fetch(url + "/meta")
              return Response.json({ started: true })
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          }
          throw new Error("Model validation bridge did not start")
        }
        if (path === "/repository") return Response.json({ ready: true })
        const resource = resources.get(request.headers.get("x-test-resource")!)!
        return fetch(resource.url + path + new URL(request.url).search, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" ? undefined : await request.arrayBuffer(),
        })
      },
    },
  }
}

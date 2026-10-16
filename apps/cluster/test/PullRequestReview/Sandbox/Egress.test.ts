import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { handleEgress } from "../../../src/PullRequestReview/Sandbox/Egress.ts"

const props = {
  runId: "3f9b6c1e-2d4a-4e8b-9c7d-1a2b3c4d5e6f",
  repo: "Effect-TS/effect",
  prNumber: 7,
  token: "ghs_sandbox",
}

/** `Basic base64("x-access-token:ghs_sandbox")`. */
const BASIC = "Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NhbmRib3g="

type Outcome = "denied" | "anonymous" | "token"

const upload = "info/refs?service=git-upload-pack"

const table: ReadonlyArray<readonly [method: string, url: string, expected: Outcome]> = [
  ["GET", "https://example.com/", "denied"],
  ["GET", "https://api.github.com/repos/Effect-TS/effect", "denied"],
  ["GET", "https://github.com.evil.example/Effect-TS/effect/info/refs", "denied"],
  ["GET", "https://registry.npmjs.org/effect", "anonymous"],
  ["GET", "https://registry.yarnpkg.com/effect", "anonymous"],
  ["GET", "https://npm.jsr.io/~/11/@jsr/std__assert/1.0.19.tgz", "anonymous"],
  ["GET", "https://pypi.org/simple/requests/", "anonymous"],
  ["GET", "https://files.pythonhosted.org/packages/requests.whl", "anonymous"],
  ["GET", "https://github.com/Effect-TS/effect", "anonymous"],
  ["GET", `https://github.com/Effect-TS/effect/${upload}`, "token"],
  ["GET", `https://github.com/Effect-TS/effect.git/${upload}`, "token"],
  ["GET", `https://github.com/effect-ts/EFFECT.GIT/${upload}`, "token"],
  ["POST", "https://github.com/Effect-TS/effect/git-upload-pack", "token"],
  ["POST", "https://github.com/EFFECT-TS/Effect.git/git-upload-pack", "token"],
  ["GET", `https://github.com/someone/effect.git/${upload}`, "anonymous"],
  ["POST", "https://github.com/someone/effect.git/git-upload-pack", "anonymous"],
  ["POST", "https://github.com/Effect-TS/other/git-upload-pack", "anonymous"],
  [
    "GET",
    "https://github.com/Effect-TS/effect.git/info/refs?service=git-receive-pack",
    "anonymous",
  ],
  ["POST", "https://github.com/Effect-TS/effect.git/git-receive-pack", "anonymous"],
  ["GET", "http://github.com/Effect-TS/effect.git/" + upload, "anonymous"],
  ["GET", "https://codeload.github.com/Effect-TS/effect/tar.gz/main", "anonymous"],
  ["GET", "https://raw.githubusercontent.com/Effect-TS/effect/main/README.md", "anonymous"],
  ["GET", "https://objects.githubusercontent.com/github-production-release-asset", "anonymous"],
  ["POST", "https://github.com/Effect-TS/effect/../other/repo/git-upload-pack", "anonymous"],
  ["POST", "https://github.com/Effect-TS%2Feffect/git-upload-pack", "anonymous"],
  ["POST", "https://github.com/Effect-TS/effect%2Fgit-upload-pack", "anonymous"],
  ["POST", "https://github.com//Effect-TS/effect/git-upload-pack", "anonymous"],
]

/**
 * Sends one container request through the egress handler and classifies what
 * reached the upstream fetch. Every request carries a container-chosen
 * `Authorization` header, which must never be forwarded.
 */
const send = (method: string, url: string) =>
  Effect.promise(async (): Promise<string> => {
    const forwarded: Array<Request> = []
    const response = await handleEgress(
      new Request(url, {
        method,
        headers: { authorization: "Bearer from-the-container" },
        ...(method === "POST" ? { body: "0000" } : {}),
      }),
      props,
      async (request) => {
        forwarded.push(request)
        return new Response("upstream")
      },
    )
    const [request] = forwarded
    if (request === undefined) return response.status === 403 ? "denied" : `${response.status}`
    if (request.redirect !== "manual") return `redirect: ${request.redirect}`
    const authorization = request.headers.get("authorization")
    if (authorization === null) return "anonymous"
    return authorization === BASIC ? "token" : `authorization: ${authorization}`
  })

describe("PR review sandbox egress", () => {
  it.effect(
    "allows listed hosts, adds the token only to base-repo upload-pack requests, and never follows redirects",
    () =>
      Effect.gen(function* () {
        const outcomes = yield* Effect.forEach(table, ([method, url]) => send(method, url))
        assert.deepStrictEqual(
          table.map(([method, url], index) => `${method} ${url} -> ${outcomes[index]}`),
          table.map(([method, url, expected]) => `${method} ${url} -> ${expected}`),
        )
      }),
  )
})

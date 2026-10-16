import { RunId } from "@janitor/domain/PullRequestReview/Run"
import { RunPage, type RunEntry } from "@janitor/domain/PullRequestReview/Settings"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as UrlParams from "effect/http/UrlParams"
import { Scene } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { RepositoryOverview } from "@/components/labeling-wire"
import * as Reviews from "@/components/pull-request-reviews"
import { ApiClient } from "@/lib/api-client.prototype"

const repository: RepositoryOverview = {
  repositoryId: "701",
  owner: "effect",
  repo: "one",
  enabled: true,
  ruleCount: 0,
  policyCount: 0,
  access: "accessible",
  configuredRevision: 1,
  activeRevision: 1,
}

const id = (n: number) => RunId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`)

const run = (n: number, fields: Partial<RunEntry> = {}): RunEntry =>
  ({
    runId: id(n),
    number: 100 + n,
    title: `Change ${n}`,
    headSha: `${n}`.repeat(40).slice(0, 40),
    trigger: { _tag: "Automatic" },
    verdict: null,
    failedGates: [],
    review: null,
    checkRun: null,
    startedAt: DateTime.makeUnsafe("2026-10-16T06:00:00Z"),
    finishedAt: DateTime.makeUnsafe("2026-10-16T06:01:00Z"),
    blockers: 0,
    nits: 0,
    status: "commented",
    ...fields,
  }) as RunEntry

const activated = () =>
  Reviews.update(Reviews.init(), Reviews.Message.Activated({ repositoryId: "701", active: true }))

const loaded = (runs: ReadonlyArray<RunEntry>, cursor: RunId | null = null) => {
  const { model } = activated()
  return Reviews.update(
    model,
    Reviews.Message.Loaded({ generation: model.generation, older: false, page: { runs, cursor } }),
  ).model
}

describe("PR reviews", () => {
  it("shows a row for every outcome, with skip reasons, counts, gates, triggers and links", () => {
    const runs = [
      run(1, { status: "running", finishedAt: null }),
      run(2, {
        number: 12,
        title: "Fix flaky retry",
        headSha: "abc1234def5678abc1234def5678abc1234def56",
        status: "approved",
        verdict: "approve",
        startedAt: DateTime.makeUnsafe("2026-10-16T06:10:00Z"),
        finishedAt: DateTime.makeUnsafe("2026-10-16T06:13:20Z"),
        blockers: 2,
        nits: 3,
        review: { id: "9001", url: "https://github.com/effect/one/pull/12#pullrequestreview-9001" },
        checkRun: { id: "77", url: "https://github.com/effect/one/runs/77" },
      }),
      run(3, {
        status: "changes_requested",
        verdict: "request_changes",
        blockers: 1,
        nits: 1,
        failedGates: ["BlockingFindings", "SensitivePaths"],
        trigger: { _tag: "Rerun", invoker: "octocat", commentId: "55" },
      }),
      run(4, {
        status: "commented",
        trigger: { _tag: "Forced", invoker: "hubot", commentId: "56" },
      }),
      run(5, { status: "partial" }),
      run(6, { status: "failed" }),
      run(7, { status: "cancelled" }),
      run(8, { status: "skipped", reason: "oversized", finishedAt: null }),
      run(9, { status: "skipped", reason: "run_cap", finishedAt: null }),
    ]
    Scene.scene(
      {
        update: Reviews.update,
        view: Scene.withViewInputs(Reviews.view, { repository })(),
      },
      Scene.given(loaded(runs)),
      Scene.expect(Scene.text("Running")).toExist(),
      Scene.expect(Scene.text("Approved")).toExist(),
      Scene.expect(Scene.text("Changes requested")).toExist(),
      Scene.expect(Scene.text("Commented")).toExist(),
      Scene.expect(Scene.text("Partial")).toExist(),
      Scene.expect(Scene.text("Failed")).toExist(),
      Scene.expect(Scene.text("Cancelled")).toExist(),
      Scene.expect(Scene.text("Skipped · oversized")).toExist(),
      Scene.expect(Scene.text("Skipped · run cap")).toExist(),
      Scene.expect(Scene.role("link", { name: "#12 Fix flaky retry" })).toHaveAttr(
        "href",
        "https://github.com/effect/one/pull/12",
      ),
      Scene.expect(Scene.text("abc1234")).toExist(),
      Scene.expect(Scene.text("2026-10-16 06:10")).toExist(),
      Scene.expect(Scene.text("3m 20s")).toExist(),
      Scene.expect(Scene.text("2 blockers · 3 nits")).toExist(),
      Scene.expect(Scene.text("1 blocker · 1 nit")).toExist(),
      Scene.expect(Scene.text("Failed gates: blocking findings, sensitive paths")).toExist(),
      Scene.expect(Scene.text("Automatic")).toExist(),
      Scene.expect(Scene.text("/janitor by @octocat")).toExist(),
      Scene.expect(Scene.text("/janitor by @hubot · forced")).toExist(),
      Scene.expect(Scene.role("link", { name: "GitHub review" })).toHaveAttr(
        "href",
        "https://github.com/effect/one/pull/12#pullrequestreview-9001",
      ),
      Scene.expect(Scene.role("link", { name: "janitor/review" })).toHaveAttr(
        "href",
        "https://github.com/effect/one/runs/77",
      ),
    )
  })

  it("loads the newest page, then older pages by cursor until the last", async () => {
    const first = activated()
    expect(first.commands?.map((command) => command.args)).toEqual([
      { repositoryId: "701", generation: first.model.generation, cursor: null },
    ])
    const page = loaded([run(3), run(2)], id(2))
    const more = Reviews.update(page, Reviews.Message.ClickedMore())
    expect(more.commands?.map((command) => command.args)).toEqual([
      { repositoryId: "701", generation: page.generation, cursor: id(2) },
    ])
    const last = Reviews.update(
      more.model,
      Reviews.Message.Loaded({
        generation: page.generation,
        older: true,
        page: { runs: [run(2), run(1)], cursor: null },
      }),
    ).model
    expect(last.runs.map((entry) => entry.runId)).toEqual([id(3), id(2), id(1)])
    expect(last.cursor).toBeNull()
    expect(Reviews.update(last, Reviews.Message.ClickedMore()).commands ?? []).toEqual([])

    const requested: Array<string> = []
    const client = HttpClient.make((request) => {
      const url = new URL(request.url, "https://janitor.test")
      // The derived client keeps the query in `urlParams`, not in `url`.
      requested.push(`${url.pathname}?${UrlParams.toString(request.urlParams)}`)
      const body = Schema.encodeSync(Schema.toCodecJson(RunPage))({ runs: [run(1)], cursor: null })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })),
      )
    })
    const message = await Effect.runPromise(
      Reviews.FetchRuns({ repositoryId: "701", generation: 4, cursor: id(2) }).effect.pipe(
        // PROTOTYPE (EFF-2304): the real derived client over a stubbed
        // HttpClient, so the test still pins the path and query.
        Effect.provide(
          ApiClient.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
        ),
      ),
    )
    expect(requested).toEqual([`/api/v1/repositories/701/pull-request-review/runs?cursor=${id(2)}`])
    expect(message).toEqual(
      Reviews.Message.Loaded({
        generation: 4,
        older: true,
        page: { runs: [run(1)], cursor: null },
      }),
    )
  })

  it("refreshes without skipping runs when more than a page arrived meanwhile", () => {
    const left = Reviews.update(
      loaded([run(1)]),
      Reviews.Message.Activated({ repositoryId: "701", active: false }),
    ).model
    const back = Reviews.update(
      left,
      Reviews.Message.Activated({ repositoryId: "701", active: true }),
    ).model
    const newest = Array.from({ length: 50 }, (_, index) => run(52 - index))
    const refreshed = Reviews.update(
      back,
      Reviews.Message.Loaded({
        generation: back.generation,
        older: false,
        page: { runs: newest, cursor: id(3) },
      }),
    ).model
    const more = Reviews.update(refreshed, Reviews.Message.ClickedMore())
    expect(more.commands?.map((command) => command.args)).toEqual([
      { repositoryId: "701", generation: refreshed.generation, cursor: id(3) },
    ])
    const last = Reviews.update(
      more.model,
      Reviews.Message.Loaded({
        generation: refreshed.generation,
        older: true,
        page: { runs: [run(2), run(1)], cursor: null },
      }),
    ).model
    expect(last.runs.map((entry) => entry.runId)).toEqual([
      ...newest.map((entry) => entry.runId),
      id(2),
      id(1),
    ])
  })
})

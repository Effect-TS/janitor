import { RunId } from "@janitor/domain/PullRequestReview/Run"
import { RunPage, type RunEntry } from "@janitor/domain/PullRequestReview/Settings"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { Scene } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { RepositoryOverview } from "@/components/labeling-wire"
import * as Reviews from "@/components/pull-request-reviews"

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
      Scene.given({ ...loaded(runs), mode: "all" }),
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

  it("links a run to its transcript; a skipped run has none", () => {
    Scene.scene(
      {
        update: Reviews.update,
        view: Scene.withViewInputs(Reviews.view, { repository })(),
      },
      Scene.given({
        ...loaded([run(1), run(2, { status: "skipped", reason: "oversized", finishedAt: null })]),
        mode: "all",
      }),
      Scene.expect(Scene.role("link", { name: "Transcript" })).toHaveAttr(
        "href",
        `/repositories/701/pull-request-reviews/${id(1)}`,
      ),
      Scene.expectAll(Scene.all.role("link", { name: "Transcript" })).toHaveCount(1),
    )
  })

  it("loads the newest page, then older pages by cursor until the last", async () => {
    const first = activated()
    expect(first.commands?.map((command) => command.args)).toEqual([
      { repositoryId: "701", generation: first.model.generation, search: "", cursor: null },
    ])
    const page = loaded([run(3), run(2)], id(2))
    const more = Reviews.update(page, Reviews.Message.ClickedMore())
    expect(more.commands?.map((command) => command.args)).toEqual([
      { repositoryId: "701", generation: page.generation, search: "", cursor: id(2) },
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
      requested.push(url.pathname + url.search)
      const body = Schema.encodeSync(Schema.toCodecJson(RunPage))({ runs: [run(1)], cursor: null })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })),
      )
    })
    const message = await Effect.runPromise(
      Reviews.FetchRuns({
        repositoryId: "701",
        generation: 4,
        search: "",
        cursor: id(2),
      }).effect.pipe(Effect.provideService(HttpClient.HttpClient, client)),
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
      { repositoryId: "701", generation: refreshed.generation, search: "", cursor: id(3) },
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

  it("keeps loaded history on a live refresh, and Refresh starts again from the newest page", () => {
    const newest = Array.from({ length: 50 }, (_, index) => run(100 - index))
    const fetched = (step: ReturnType<typeof Reviews.update>) =>
      step.commands?.map((command) => command.args)
    const page = loaded(newest, id(51))
    const more = Reviews.update(page, Reviews.Message.ClickedMore())
    const older = Array.from({ length: 49 }, (_, index) => run(50 - index))
    const history = Reviews.update(
      more.model,
      Reviews.Message.Loaded({
        generation: page.generation,
        older: true,
        page: { runs: [...older, run(1, { status: "running", finishedAt: null })], cursor: null },
      }),
    ).model

    const polled = Reviews.update(history, Reviews.Message.Polled())
    expect(fetched(polled)).toEqual([
      { repositoryId: "701", generation: history.generation, search: "", cursor: null },
    ])
    const live = Reviews.update(
      polled.model,
      Reviews.Message.Loaded({
        generation: history.generation,
        older: false,
        page: { runs: newest, cursor: id(51) },
      }),
    ).model
    expect(live.runs).toHaveLength(100)
    expect(live.cursor).toBeNull()

    const clicked = Reviews.update(live, Reviews.Message.ClickedRefresh())
    expect(fetched(clicked)).toEqual([
      { repositoryId: "701", generation: live.generation, search: "", cursor: null },
    ])
    const refreshed = Reviews.update(
      clicked.model,
      Reviews.Message.Loaded({
        generation: live.generation,
        older: false,
        page: { runs: newest, cursor: id(51) },
      }),
    ).model
    expect(refreshed.runs.map((entry) => entry.runId)).toEqual(newest.map((entry) => entry.runId))
    expect(refreshed.cursor).toEqual(id(51))

    const again = Reviews.update(refreshed, Reviews.Message.ClickedMore())
    expect(fetched(again)).toEqual([
      { repositoryId: "701", generation: refreshed.generation, search: "", cursor: id(51) },
    ])
    const last = Reviews.update(
      again.model,
      Reviews.Message.Loaded({
        generation: refreshed.generation,
        older: true,
        page: { runs: [...older, run(1)], cursor: null },
      }),
    ).model
    expect(last.runs).toHaveLength(100)
    expect(last.runs.at(-1)).toMatchObject({ runId: id(1), status: "commented" })
  })

  it("groups runs by pull request, newest first, and shows a pull request's runs when opened", () => {
    const runs = [
      run(1, { number: 12, title: "Fix flaky retry", status: "approved" }),
      run(2, { number: 7, title: "Add cache" }),
      run(3, { number: 12, title: "Fix retry", status: "changes_requested" }),
    ]
    const model = loaded(runs)
    expect(model.mode).toBe("grouped")
    expect(Reviews.groups(model.runs).map((group) => [group.number, group.runs.length])).toEqual([
      [12, 2],
      [7, 1],
    ])
    Scene.scene(
      {
        update: Reviews.update,
        view: Scene.withViewInputs(Reviews.view, { repository })(),
      },
      Scene.given(model),
      Scene.expect(Scene.text("2 reviews")).toExist(),
      Scene.expect(Scene.text("1 review")).toExist(),
      Scene.expect(Scene.text("Approved")).toExist(),
      Scene.expect(Scene.text("Changes requested")).not.toExist(),
      Scene.click(Scene.role("button", { name: "#12 Fix flaky retry" })),
      Scene.expect(Scene.role("button", { name: "#12 Fix flaky retry" })).toHaveAttr(
        "aria-expanded",
        "true",
      ),
      Scene.expect(Scene.text("Changes requested")).toExist(),
      Scene.expect(Scene.role("link", { name: "#12 Fix retry" })).toExist(),
      Scene.click(Scene.role("button", { name: "All reviews" })),
      Scene.expect(Scene.role("link", { name: "#7 Add cache" })).toExist(),
    )
  })

  it("searches after the input settles and fences the earlier search", async () => {
    const page = loaded([run(1)])
    const typed = Reviews.update(page, Reviews.Message.ChangedSearch({ value: " #12 " })).model
    expect(typed.runs).toEqual([])
    expect(typed.searchPending).toBe(true)
    expect(Reviews.update(typed, Reviews.Message.Polled()).commands ?? []).toEqual([])
    expect(
      Reviews.update(typed, Reviews.Message.SettledSearch({ generation: page.generation }))
        .commands ?? [],
    ).toEqual([])
    const settled = Reviews.update(
      typed,
      Reviews.Message.SettledSearch({ generation: typed.generation }),
    )
    expect(settled.commands?.map((command) => command.args)).toEqual([
      { repositoryId: "701", generation: typed.generation, search: "#12", cursor: null },
    ])
    expect(
      Reviews.update(
        settled.model,
        Reviews.Message.Loaded({
          generation: page.generation,
          older: false,
          page: { runs: [run(1)], cursor: null },
        }),
      ).model.runs,
    ).toEqual([])

    const requested: Array<string> = []
    const client = HttpClient.make((request) => {
      const url = new URL(request.url, "https://janitor.test")
      requested.push(url.pathname + url.search)
      const body = Schema.encodeSync(Schema.toCodecJson(RunPage))({ runs: [], cursor: null })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })),
      )
    })
    await Effect.runPromise(
      Reviews.FetchRuns({
        repositoryId: "701",
        generation: 4,
        search: "#12",
        cursor: id(2),
      }).effect.pipe(Effect.provideService(HttpClient.HttpClient, client)),
    )
    expect(requested).toEqual([
      `/api/v1/repositories/701/pull-request-review/runs?search=%2312&cursor=${id(2)}`,
    ])
  })
})

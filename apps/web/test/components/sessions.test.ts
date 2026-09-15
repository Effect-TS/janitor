import type { SessionDetail, SessionSummary } from "@janitor/domain/Agent/Observation"
import * as DateTime from "effect/DateTime"
import { Scene } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import * as Live from "@/components/live"
import * as Sessions from "@/components/sessions"

const at = DateTime.makeUnsafe("2026-09-13T10:00:00.000Z")
const working: SessionSummary = {
  sessionId: "ses-working",
  title: "Fix the flaky test",
  repository: { repositoryId: "901", owner: "acme", repo: "widgets" },
  homeThread: { platform: "slack", url: "https://app.slack.com/archives/C1/p1" },
  pullRequests: [{ number: 17, url: "https://github.com/acme/widgets/pull/17" }],
  execution: "working",
  reason: "input pending",
  activityAt: at,
  usage: { input: 12000, output: 500 },
  deliveryWarning: "Janitor is no longer in the channel",
  freshness: { readAt: at, error: null },
}
const pending: SessionSummary = {
  sessionId: "ses-pending",
  title: "Slack conversation",
  repository: null,
  homeThread: { platform: "slack", url: "https://app.slack.com/archives/C2/p2" },
  pullRequests: [],
  execution: "blocked",
  reason: "Waiting for repository selection",
  activityAt: at,
  usage: null,
  deliveryWarning: null,
  freshness: { readAt: null, error: null },
}
const detail: SessionDetail = {
  ...working,
  execution: "failed",
  reason: "provider down",
  pendingInputs: 1,
  acceptedInputs: 3,
  lastInputAt: at,
  latestError: "provider down",
  pendingDelivery: [{ platform: "slack", state: "pending", error: "not_in_channel" }],
}

const loaded = (model: Sessions.Model, sessions: ReadonlyArray<SessionSummary>) =>
  Sessions.update(
    model,
    Sessions.Message.LoadedList({
      generation: model.generation,
      page: { sessions, cursor: null },
      append: false,
    }),
  ).model

const scene = (
  model: Sessions.Model,
  ...steps: Array<Scene.SceneStep<Sessions.Model, Sessions.Message, never>>
) =>
  Scene.scene(
    { update: Sessions.update, view: Scene.withViewInputs(Sessions.view, {})() },
    Scene.given(model),
    ...steps,
  )

describe("Sessions dashboard", () => {
  it("lists sessions with state, links, recorded usage and delivery health", () => {
    const entered = Sessions.enter(Sessions.init(), null)
    expect(entered.commands?.map((command) => command.name)).toEqual(["FetchSessions"])
    scene(
      loaded(entered.model, [working, pending]),
      Scene.expect(Scene.text("working")).toExist(),
      Scene.expect(Scene.text("2 · 1 working")).toExist(),
      Scene.expect(Scene.role("link", { name: "Fix the flaky test" })).toExist(),
      Scene.expect(Scene.text("acme/widgets")).toExist(),
      Scene.expect(Scene.text("input pending")).toExist(),
      Scene.expect(Scene.text("12,000 in · 500 out")).toExist(),
      Scene.expect(Scene.text("Delivery: Janitor is no longer in the channel")).toExist(),
      Scene.expect(Scene.role("link", { name: "Home thread" })).toExist(),
      Scene.expect(Scene.role("link", { name: "PR #17" })).toExist(),
      Scene.expect(Scene.text("blocked")).toExist(),
      Scene.expect(Scene.text("Waiting for repository selection")).toExist(),
      Scene.expect(Scene.text("No repository yet")).toExist(),
      Scene.expect(Scene.text("—")).toExist(),
      Scene.expect(Scene.text("Select a session to see its inputs and delivery.")).toExist(),
      Scene.expect(Scene.role("button", { name: "Load more" })).toBeAbsent(),
    )
  })

  it("shows a session's facts in the inspector, keeping the table on screen", () => {
    const entered = Sessions.enter(Sessions.init(), "ses-working")
    expect(entered.commands?.map((command) => command.name)).toEqual([
      "FetchSessions",
      "FetchSession",
    ])
    const model = Sessions.update(
      loaded(entered.model, [working, pending]),
      Sessions.Message.LoadedDetail({ generation: entered.model.generation, detail }),
    ).model
    scene(
      model,
      Scene.expect(Scene.role("link", { name: "Fix the flaky test" })).toExist(),
      Scene.expect(Scene.role("link", { name: "Slack conversation" })).toExist(),
      Scene.expect(Scene.text("failed")).toExist(),
      Scene.expect(Scene.text("Latest error: provider down")).toExist(),
      Scene.expect(Scene.text("Pending inputs")).toExist(),
      Scene.expect(Scene.text("Accepted")).toExist(),
      Scene.expect(Scene.text("Runner read")).toExist(),
      Scene.expect(Scene.text("Slack home thread")).toExist(),
      Scene.expect(Scene.text("Janitor is no longer in the channel")).toExist(),
      Scene.expect(Scene.text("Slack reply")).toExist(),
      Scene.expect(Scene.text("not_in_channel")).toExist(),
    )
  })

  it("filters the table by state without re-reading", () => {
    const model = loaded(Sessions.enter(Sessions.init(), null).model, [working, pending])
    const filtered = Sessions.update(model, Sessions.Message.ChangedFilter({ value: "blocked" }))
    expect(filtered.commands).toBeUndefined()
    scene(
      filtered.model,
      Scene.expect(Scene.role("link", { name: "Slack conversation" })).toExist(),
      Scene.expect(Scene.role("link", { name: "Fix the flaky test" })).toBeAbsent(),
    )
    const cleared = Sessions.update(filtered.model, Sessions.Message.ChangedFilter({ value: "" }))
    expect(cleared.model.filter).toBeNull()
    const refreshed = Sessions.update(cleared.model, Sessions.Message.ClickedRefresh())
    expect(refreshed.commands?.map((command) => command.name)).toEqual(["FetchSessions"])
    expect(refreshed.model.live.retry).toBe(cleared.model.live.retry)
  })

  it("keeps last known data and says so when a refresh fails", () => {
    const model = loaded(Sessions.enter(Sessions.init(), null).model, [working])
    const refreshed = Sessions.update(
      model,
      Sessions.Message.GotLiveMessage({
        message: Live.Message.Received({
          channel: "sessions",
          connected: false,
          topics: ["sessions"],
        }),
      }),
    )
    expect(refreshed.commands?.map((command) => command.name)).toEqual(["FetchSessions"])
    const failed = Sessions.update(
      refreshed.model,
      Sessions.Message.ListFailed({
        generation: refreshed.model.generation,
        reason: "Sessions could not be read.",
      }),
    ).model
    expect(failed.stale).toBe(true)
    scene(
      failed,
      Scene.expect(Scene.text("Showing last known data; the latest refresh failed.")).toExist(),
      Scene.expect(Scene.role("link", { name: "Fix the flaky test" })).toExist(),
    )
  })

  it("coalesces invalidations during a read, ignores other channels, and reports removal", () => {
    const entered = Sessions.enter(Sessions.init(), null)
    const during = Sessions.update(
      entered.model,
      Sessions.Message.GotLiveMessage({
        message: Live.Message.Received({
          channel: "sessions",
          connected: false,
          topics: ["sessions"],
        }),
      }),
    )
    expect(during.commands).toBeUndefined()
    expect(during.model.invalidated).toBe(true)
    const other = Sessions.update(
      during.model,
      Sessions.Message.GotLiveMessage({
        message: Live.Message.Received({ channel: "701", connected: false, topics: ["sessions"] }),
      }),
    )
    expect(other.model).toBe(during.model)
    const landed = Sessions.update(
      during.model,
      Sessions.Message.LoadedList({
        generation: during.model.generation,
        page: { sessions: [working], cursor: null },
        append: false,
      }),
    )
    expect(landed.commands?.map((command) => command.name)).toEqual(["FetchSessions"])
    expect(landed.model.invalidated).toBe(false)
    const stale = Sessions.update(
      landed.model,
      Sessions.Message.LoadedList({
        generation: entered.model.generation,
        page: { sessions: [], cursor: null },
        append: false,
      }),
    )
    expect(stale.model.sessions).toEqual([working])

    const denied = Sessions.update(
      landed.model,
      Sessions.Message.GotLiveMessage({
        message: Live.Message.Disconnected({ channel: "sessions", denied: true }),
      }),
    ).model
    scene(
      denied,
      Scene.expect(
        Scene.text(
          "Live updates unavailable. Your membership may have changed; reload to continue.",
        ),
      ).toExist(),
      Scene.expect(Scene.role("button", { name: "Reconnect" })).toExist(),
    )
  })

  it("reads again on reconnect and on the fallback tick, keeping loaded pages", () => {
    const entered = Sessions.enter(Sessions.init(), null)
    const firstPage = Sessions.update(
      entered.model,
      Sessions.Message.LoadedList({
        generation: entered.model.generation,
        page: { sessions: [working], cursor: { working: true, activityAt: "t", sessionId: "x" } },
        append: false,
      }),
    ).model
    const more = Sessions.update(firstPage, Sessions.Message.ClickedMore())
    expect(more.commands?.map((command) => command.name)).toEqual(["FetchSessions"])
    const twoPages = Sessions.update(
      more.model,
      Sessions.Message.LoadedList({
        generation: more.model.generation,
        page: {
          sessions: Array.from({ length: 30 }, (_, index) => ({
            ...pending,
            sessionId: `p${index}`,
          })),
          cursor: null,
        },
        append: true,
      }),
    ).model
    expect(twoPages.sessions).toHaveLength(31)
    const reconnected = Sessions.update(
      twoPages,
      Sessions.Message.GotLiveMessage({
        message: Live.Message.Received({ channel: "sessions", connected: true, topics: [] }),
      }),
    )
    expect(reconnected.model.live.status).toBe("connected")
    expect(reconnected.commands?.map((command) => command.name)).toEqual(["FetchSessions"])
    expect(JSON.stringify(reconnected.commands)).toContain('"limit":31')
    const fallback = Sessions.update(
      Sessions.update(
        reconnected.model,
        Sessions.Message.ListFailed({ generation: reconnected.model.generation, reason: "down" }),
      ).model,
      Sessions.Message.GotLiveMessage({ message: Live.Message.Fallback({ channel: "sessions" }) }),
    )
    expect(fallback.commands?.map((command) => command.name)).toEqual(["FetchSessions"])
    expect(fallback.model.sessions).toHaveLength(31)
    const unrelated = Sessions.update(
      reconnected.model,
      Sessions.Message.GotLiveMessage({
        message: Live.Message.Received({
          channel: "sessions",
          connected: false,
          topics: ["activity"],
        }),
      }),
    )
    expect(unrelated.commands).toBeUndefined()
  })

  it("stops watching the channel after leaving and reads again on return", () => {
    const entered = Sessions.enter(Sessions.init(), null)
    expect(Sessions.subscriptions.sessionsSocket.modelToDependencies(entered.model).channel).toBe(
      "sessions",
    )
    const left = Sessions.leave(loaded(entered.model, [working]))
    expect(Sessions.subscriptions.sessionsSocket.modelToDependencies(left).channel).toBe("")
    expect(left.sessions).toEqual([working])
    const back = Sessions.enter(left, null)
    expect(back.commands?.map((command) => command.name)).toEqual(["FetchSessions"])
  })
})

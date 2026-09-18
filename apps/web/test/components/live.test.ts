import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import * as Option from "effect/Option"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Url from "foldkit/url"
import { expect, it, vi } from "vite-plus/test"
import * as Live from "@/components/live"
import * as Main from "@/main"
import * as Workspace from "@/components/workspace"

it("fences old repositories and coalesces activity notifications during a fetch", () => {
  const initial = Main.init(
    { theme: { preferredTheme: "System", systemTheme: "Light" } },
    Option.getOrThrow(Url.fromString("https://janitor.test/repositories/701/activity")),
  ).model
  const message = (channel: string) =>
    Main.Message.GotLiveMessage({
      message: Live.Message.Received({ channel, connected: false, topics: ["activity"] }),
    })
  expect(Main.update(initial, message("other")).model).toBe(initial)
  const first = Main.update(initial, message("701"))
  const second = Main.update(first.model, message("701"))
  expect(second.model.workspace.liveTopics).toEqual(["activity"])
  expect(second.commands ?? []).toEqual([])
  const workspace = {
    ...second.model.workspace,
    maybeDetailRequest: Option.none<number>(),
    maybeConsentRequest: Option.none<number>(),
    activity: { ...second.model.workspace.activity, loading: false },
  }
  const flushed = Workspace.update(workspace, Workspace.Message.FlushLive())
  expect(flushed.model.liveTopics).toEqual([])
  expect(flushed.commands?.map((c) => c.name)).toEqual(["FetchActivity"])
  expect(flushed.model.activity.loading).toBe(true)
})

it("keeps an idle WebSocket live without polling and ignores duplicate change frames", async () => {
  vi.useFakeTimers()
  const sockets: FakeSocket[] = []
  class FakeSocket extends EventTarget {
    readyState = 1
    constructor() {
      super()
      sockets.push(this)
    }
    send(data: string) {
      if (data === "ping") this.dispatchEvent(new MessageEvent("message", { data: "pong" }))
    }
    close() {
      this.readyState = 3
    }
    frame(value: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }))
    }
  }
  const fetch = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", fetch)
  vi.stubGlobal("WebSocket", FakeSocket)
  const messages: Live.Message[] = []
  const fiber = Effect.runFork(
    Live.subscriptions.liveSocket
      .dependenciesToStream({
        channel: "701",
        endpoint: Live.repositoryEndpoint("701"),
        visible: true,
        retry: 0,
      })
      .pipe(
        Stream.runForEach((message) =>
          Effect.sync(() => {
            messages.push(message)
          }),
        ),
        Effect.provide(FetchHttpClient.layer),
      ),
  )
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(1)
    sockets[0].frame({ _tag: "Ready" })
    await vi.advanceTimersByTimeAsync(180000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
    expect(messages).toEqual([
      Live.Message.Received({ channel: "701", connected: true, topics: [] }),
    ])
    sockets[0].frame({ _tag: "Changed", revision: "10", topics: ["review"] })
    sockets[0].frame({ _tag: "Changed", revision: "10", topics: ["review"] })
    sockets[0].frame({ _tag: "Changed", revision: "9", topics: ["review", "activity"] })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(messages.slice(1)).toEqual([
      Live.Message.Received({ channel: "701", connected: false, topics: ["review"] }),
      Live.Message.Received({ channel: "701", connected: false, topics: ["activity"] }),
    ])
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

it.each([
  ["/repositories/connect", "connections", "LoadConnectionInventory"],
  ["/account/team", "account", "LoadAccount"],
] as const)("refreshes %s through the application channel", (path, topic, command) => {
  const initial = Main.init(
    { theme: { preferredTheme: "System", systemTheme: "Light" } },
    Option.getOrThrow(Url.fromString(`https://janitor.test${path}`)),
  ).model
  const notification = (channel: string) =>
    Main.Message.GotLiveMessage({
      message: Live.Message.Received({ channel, connected: false, topics: [topic] }),
    })
  expect(Main.update(initial, notification("701")).model).toBe(initial)
  const next = Main.update(initial, notification(Live.APPLICATION_CHANNEL))
  expect(next.commands?.map((entry) => entry.name)).toContain(command)
  expect(next.model.live.status).toBe("connected")
})

it("does not let socket readiness bypass the installation callback", () => {
  const initial = Main.init(
    { theme: { preferredTheme: "System", systemTheme: "Light" } },
    Option.getOrThrow(
      Url.fromString("https://janitor.test/repositories/connect/return?state=callback"),
    ),
  ).model
  const next = Main.update(
    initial,
    Main.Message.GotLiveMessage({
      message: Live.Message.Received({
        channel: Live.APPLICATION_CHANNEL,
        connected: true,
        topics: [],
      }),
    }),
  )
  expect(Option.isNone(next.model.connections.maybeLoadRequest)).toBe(true)
  expect(next.commands?.map((entry) => entry.name) ?? []).not.toContain("LoadConnectionInventory")
})

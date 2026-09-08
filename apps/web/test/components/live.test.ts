import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as Option from "effect/Option"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Url from "foldkit/url"
import { expect, it, vi } from "vite-plus/test"
import * as Live from "@/components/live"
import * as Main from "@/main"
import * as Workspace from "@/components/workspace"

it("never polls connected, hidden, or denied sessions", async () => {
  for (const state of [
    { visible: true, status: "connected" },
    { visible: false, status: "disconnected" },
    { visible: true, status: "denied" },
  ] as const) {
    const messages = await Effect.runPromise(
      Live.subscriptions.liveFallback
        .dependenciesToStream({ repositoryId: "701", ...state })
        .pipe(Stream.runCollect, Effect.provide(FetchHttpClient.layer)),
    )
    expect(messages).toEqual([])
  }
})
it("waits a minute before a disconnected fallback refresh", async () => {
  vi.useFakeTimers()
  try {
    const messages: Live.Message[] = []
    const done = Effect.runPromise(
      Live.subscriptions.liveFallback
        .dependenciesToStream({ repositoryId: "701", visible: true, status: "disconnected" })
        .pipe(
          Stream.take(1),
          Stream.runForEach((message) =>
            Effect.sync(() => {
              messages.push(message)
            }),
          ),
          Effect.provide(FetchHttpClient.layer),
        ),
    )
    await vi.advanceTimersByTimeAsync(59999)
    expect(messages).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(messages).toEqual([Live.Message.Fallback({ repositoryId: "701" })])
  } finally {
    vi.useRealTimers()
  }
})
it("fences old repositories and coalesces activity notifications during a fetch", () => {
  const initial = Main.init(
    { theme: { preferredTheme: "System", systemTheme: "Light" } },
    Option.getOrThrow(Url.fromString("https://janitor.test/repositories/701/activity")),
  ).model
  const message = (repositoryId: string) =>
    Main.Message.GotLiveMessage({
      message: Live.Message.Received({ repositoryId, connected: false, topics: ["activity"] }),
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

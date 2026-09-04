import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import * as SyncButton from "@/components/sync-button"

const now = DateTime.makeUnsafe("2026-09-03T12:00:00.000Z")

const summary = (state: SyncButton.SyncState, pendingTargets = 0): SyncButton.SyncSummary => ({
  state,
  lastVerifiedAt: DateTime.makeUnsafe("2026-09-03T11:55:00.000Z"),
  pendingTargets,
  blockedTargets: state === "blocked" ? 2 : 0,
  failedTargets: 0,
})

const idle = (): SyncButton.Model => {
  const { model } = SyncButton.init()
  return {
    ...model,
    isPolling: false,
    summary: Option.some(summary("idle")),
    observedAt: Option.some(now),
  }
}

describe("SyncButton", () => {
  it("fetches the summary on init", () => {
    const { commands } = SyncButton.init()
    expect(commands?.map((command) => command.name)).toEqual(["FetchSyncSummary"])
  })

  it("requests a sync on press and announces the start", () => {
    Story.story(
      SyncButton.update,
      Story.given(idle()),
      Story.message(SyncButton.Message.PressedSync()),
      Story.model((model) => expect(model.isRequesting).toBe(true)),
      Story.Command.expectExact(SyncButton.RequestSync),
      Story.Command.resolve(
        SyncButton.RequestSync,
        SyncButton.Message.GotRequestResult({ summary: summary("syncing", 4), receivedAt: now }),
      ),
      Story.model((model) => {
        expect(model.isRequesting).toBe(false)
        expect(SyncButton.isSyncing(model)).toBe(true)
      }),
      Story.expectOutMessage(SyncButton.OutMessage.SyncStarted({ pendingTargets: 4 })),
    )
  })

  it("ignores a press while a sync is running", () => {
    const running: SyncButton.Model = {
      ...idle(),
      summary: Option.some(summary("syncing", 4)),
    }
    Story.story(
      SyncButton.update,
      Story.given(running),
      Story.message(SyncButton.Message.PressedSync()),
      Story.Command.expectNone(),
      Story.expectNoOutMessage(),
    )
  })

  it("announces completion when a poll sees the sync end", () => {
    const running: SyncButton.Model = {
      ...idle(),
      summary: Option.some(summary("syncing", 4)),
    }
    Story.story(
      SyncButton.update,
      Story.given(running),
      Story.message(SyncButton.Message.Polled()),
      Story.Command.expectExact(SyncButton.FetchSyncSummary),
      Story.Command.resolve(
        SyncButton.FetchSyncSummary,
        SyncButton.Message.GotSummary({ summary: summary("blocked"), receivedAt: now }),
      ),
      Story.expectOutMessage(
        SyncButton.OutMessage.SyncFinished({
          state: "blocked",
          blockedTargets: 2,
          failedTargets: 0,
        }),
      ),
      Story.message(SyncButton.Message.GotSummary({ summary: summary("idle"), receivedAt: now })),
      // Idle after blocked is not a transition out of syncing.
      Story.expectNoOutMessage(),
    )
  })

  it("reports a failed request and re-enables the button", () => {
    Story.story(
      SyncButton.update,
      Story.given(idle()),
      Story.message(SyncButton.Message.PressedSync()),
      Story.Command.resolve(
        SyncButton.RequestSync,
        SyncButton.Message.FailedRequest({ reason: "503" }),
      ),
      Story.model((model) => {
        expect(model.isRequesting).toBe(false)
        expect(model.lastError).toEqual(Option.some("503"))
      }),
      Story.expectOutMessage(SyncButton.OutMessage.SyncFailed({ reason: "503" })),
    )
  })

  it("describes the last sync relative to when the summary arrived", () => {
    expect(SyncButton.tooltipText(idle())).toBe("Oldest verification 5 minutes ago")
    const running: SyncButton.Model = { ...idle(), summary: Option.some(summary("syncing", 3)) }
    expect(SyncButton.tooltipText(running)).toBe("Syncing 3 scopes")
    const blocked: SyncButton.Model = { ...idle(), summary: Option.some(summary("blocked")) }
    expect(SyncButton.tooltipText(blocked)).toBe("2 scopes blocked")
    const { model } = SyncButton.init()
    expect(SyncButton.tooltipText(model)).toBe("Checking sync status")
  })
  it("reports a failed run as failed completion", () => {
    const model = { ...idle(), summary: Option.some(summary("syncing", 1)) }
    const result = SyncButton.update(
      model,
      SyncButton.Message.GotSummary({
        summary: { ...summary("failed"), failedTargets: 1 },
        receivedAt: now,
      }),
    )
    expect(result.outMessage).toEqual(
      SyncButton.OutMessage.SyncFinished({ state: "failed", blockedTargets: 0, failedTargets: 1 }),
    )
    expect(SyncButton.tooltipText(result.model)).toContain("1 scopes failed")
  })

  it("does not overlap polling with a POST or another poll", () => {
    const posting = SyncButton.update(idle(), SyncButton.Message.PressedSync()).model
    expect(SyncButton.update(posting, SyncButton.Message.Polled()).commands).toBeUndefined()
    const polling = SyncButton.update(idle(), SyncButton.Message.Polled()).model
    expect(SyncButton.update(polling, SyncButton.Message.Polled()).commands).toBeUndefined()
    expect(SyncButton.update(polling, SyncButton.Message.PressedSync()).commands).toBeUndefined()
    const received = SyncButton.update(
      posting,
      SyncButton.Message.GotSummary({ summary: summary("idle"), receivedAt: now }),
    )
    expect(received.model.isRequesting).toBe(true)
  })
})

import * as Option from "effect/Option"
import { Scene } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import * as Connections from "@/components/repository-connections"
const candidate = {
  repositoryId: "701",
  installationId: "77",
  owner: "test",
  repo: "example",
  isPrivate: false,
  connected: true,
  enabled: true,
  reconnect: false,
  access: "accessible",
  installationStatus: "active",
  policyCount: 2,
  ruleCount: 3,
  syncState: "ready" as const,
}
const settings = { repositoryId: "701", state: "" }
describe("Repository connections", () => {
  it("shows cache failure apart from repository readiness and offers recovery", () => {
    const failed = { ...candidate, syncState: "failed" as const, syncError: "GitHub timeout" }
    Scene.scene(
      { update: Connections.update, view: Scene.withViewInputs(Connections.view, settings)() },
      Scene.given({ ...Connections.init(), inventory: Option.some({ repositories: [failed] }) }),
      Scene.Mount.resolve(
        Connections.LoadOnMount,
        Connections.Message.LoadRequested({ state: "" }),
      ),
      Scene.Command.resolve(
        Connections.Load,
        Connections.Message.Loaded({ requestId: 1, inventory: { repositories: [failed] } }),
      ),
      Scene.expect(Scene.text("test/example")).toExist(),
      Scene.expect(Scene.text("Ready")).toExist(),
      Scene.expect(Scene.text("Sync failed")).toExist(),
      Scene.expect(Scene.role("button", { name: "Retry sync" })).toExist(),
      Scene.expect(
        Scene.text(
          "GitHub timeout Automatic retries continue. Retry sync to refresh the cached facts now. Labeling and agent sessions read GitHub directly and keep working.",
        ),
      ).toExist(),
    )
  })
  it("offers one repository pause covering automation and synchronization", () => {
    Scene.scene(
      { update: Connections.update, view: Scene.withViewInputs(Connections.view, settings)() },
      Scene.given({ ...Connections.init(), inventory: Option.some({ repositories: [candidate] }) }),
      Scene.Mount.resolve(
        Connections.LoadOnMount,
        Connections.Message.LoadRequested({ state: "" }),
      ),
      Scene.Command.resolve(
        Connections.Load,
        Connections.Message.Loaded({ requestId: 1, inventory: { repositories: [candidate] } }),
      ),
      Scene.expect(Scene.role("button", { name: "Pause repository" })).toExist(),
      Scene.expect(
        Scene.text(
          "Pausing stops automation and synchronization. Configuration, stored facts and GitHub labels are kept.",
        ),
      ).toExist(),
    )
  })
  it("requires confirmation before disconnecting and allows cancellation", () => {
    const initial = { ...Connections.init(), inventory: Option.some({ repositories: [candidate] }) }
    const confirming = Connections.update(initial, Connections.Message.ClickedDisconnect())
    expect(confirming.model.dialog.isOpen).toBe(true)
    expect(confirming.commands?.[0]?.name).toBe("ShowDialog")
    const cancelled = Connections.update(
      confirming.model,
      Connections.Message.CancelledDisconnect(),
    )
    expect(cancelled.model.dialog.isOpen).toBe(false)
    const disconnected = Connections.update(
      initial,
      Connections.Message.ClickedChange({ id: "701", action: "disconnect" }),
    )
    expect(disconnected.commands?.[0]?.name).toBe("ChangeRepositoryConnection")
    expect(Option.isSome(disconnected.model.pending)).toBe(true)
    expect(
      Connections.update(
        disconnected.model,
        Connections.Message.ClickedChange({ id: "701", action: "disconnect" }),
      ).commands,
    ).toBeUndefined()
  })
  it("explains permanent deletion, fresh reconnection and retained GitHub labels", () => {
    Scene.scene(
      { update: Connections.update, view: Scene.withViewInputs(Connections.view, settings)() },
      Scene.given({
        ...Connections.update(Connections.init(), Connections.Message.ClickedDisconnect()).model,
        inventory: Option.some({ repositories: [candidate] }),
      }),
      Scene.Mount.resolve(
        Connections.LoadOnMount,
        Connections.Message.LoadRequested({ state: "" }),
      ),
      Scene.Command.resolve(
        Connections.Load,
        Connections.Message.Loaded({ requestId: 1, inventory: { repositories: [candidate] } }),
      ),
      Scene.expect(
        Scene.text(
          "Disconnect permanently deletes all policies, drafts, published history, labeling rules and groups, stored facts, event history and cached evaluations. GitHub labels stay unchanged. Reconnecting starts empty and requires synchronization. Pause and access loss retain your configuration.",
        ),
      ).toExist(),
      Scene.expect(Scene.role("button", { name: "Cancel" })).toExist(),
    )
  })
  it("offers GitHub access when inventory is empty", () => {
    Scene.scene(
      {
        update: Connections.update,
        view: Scene.withViewInputs(Connections.view, { ...settings, repositoryId: null })(),
      },
      Scene.given({ ...Connections.init(), inventory: Option.some({ repositories: [] }) }),
      Scene.Mount.resolve(
        Connections.LoadOnMount,
        Connections.Message.LoadRequested({ state: "" }),
      ),
      Scene.Command.resolve(
        Connections.Load,
        Connections.Message.Loaded({ requestId: 1, inventory: { repositories: [] } }),
      ),
      Scene.expect(Scene.role("button", { name: "Grant access on GitHub" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Back" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Connect repository" })).toBeAbsent(),
    )
  })
})

describe("connection result handling", () => {
  it("preserves inventory and search after pausing and fences older polls", () => {
    const initial = {
      ...Connections.init(),
      search: "example",
      inventory: Option.some({ repositories: [candidate] }),
    }
    const poll = Connections.update(initial, Connections.Message.LoadRequested({ state: "" }))
    const pending = Connections.update(
      poll.model,
      Connections.Message.ClickedChange({ id: "701", action: "pause" }),
    )
    expect(pending.model.pending).toEqual(
      Option.some({ operationId: 1, repositoryId: "701", action: "pause" }),
    )
    const completed = Connections.update(
      pending.model,
      Connections.Message.Changed({ id: "701", action: "pause", operationId: 1 }),
    )
    expect(completed.model.search).toBe("example")
    expect(Option.getOrThrow(completed.model.inventory).repositories[0]?.enabled).toBe(false)
    const stale = Connections.update(
      completed.model,
      Connections.Message.Loaded({ requestId: 1, inventory: { repositories: [candidate] } }),
    )
    expect(stale.model).toBe(completed.model)
    const failedRefresh = Connections.update(
      completed.model,
      Connections.Message.LoadFailed({
        requestId: Option.getOrThrow(completed.model.maybeLoadRequest),
        reason: "Offline",
      }),
    )
    expect(Option.getOrThrow(failedRefresh.model.inventory).repositories[0]?.enabled).toBe(false)
    expect(failedRefresh.model.loadError).toEqual(Option.some("Offline"))
  })

  it("reconnects a repository with synchronization enabled", () => {
    const initial = {
      ...Connections.init(),
      inventory: Option.some({
        repositories: [{ ...candidate, connected: false, enabled: false, reconnect: true }],
      }),
    }
    const pending = Connections.update(
      initial,
      Connections.Message.ClickedChange({ id: "701", action: "connect" }),
    ).model
    const completed = Connections.update(
      pending,
      Connections.Message.Changed({ id: "701", action: "connect", operationId: 1 }),
    )
    expect(Option.getOrThrow(completed.model.inventory).repositories[0]).toMatchObject({
      connected: true,
      enabled: true,
    })
    expect(
      Connections.update(
        completed.model,
        Connections.Message.Changed({ id: "701", action: "connect", operationId: 1 }),
      ).model,
    ).toBe(completed.model)
  })

  it("only announces a refreshed inventory after its read succeeds", () => {
    const pending = Connections.update(
      Connections.init(),
      Connections.Message.ClickedRefresh(),
    ).model
    const refreshed = Connections.update(
      pending,
      Connections.Message.Refreshed({ operationId: 1 }),
    ).model
    expect(refreshed.notice).toBe("Refreshing repository list…")
    const loaded = Connections.update(
      refreshed,
      Connections.Message.Loaded({
        requestId: Option.getOrThrow(refreshed.maybeLoadRequest),
        inventory: { repositories: [] },
      }),
    )
    expect(loaded.model.notice).toBe("Available repositories are up to date.")
  })
  it("shows the server's block reason for a paused repository", () => {
    const paused = {
      ...candidate,
      enabled: false,
      syncState: "paused" as const,
      blockReason: "This repository is paused in Janitor. Resume it to continue.",
    }
    Scene.scene(
      { update: Connections.update, view: Scene.withViewInputs(Connections.view, settings)() },
      Scene.given({ ...Connections.init(), inventory: Option.some({ repositories: [paused] }) }),
      Scene.Mount.resolve(
        Connections.LoadOnMount,
        Connections.Message.LoadRequested({ state: "" }),
      ),
      Scene.Command.resolve(
        Connections.Load,
        Connections.Message.Loaded({ requestId: 1, inventory: { repositories: [paused] } }),
      ),
      Scene.expect(Scene.text("Paused")).toExist(),
      Scene.expect(
        Scene.text("This repository is paused in Janitor. Resume it to continue."),
      ).toExist(),
      Scene.expect(Scene.text("Synchronizing")).not.toExist(),
    )
  })
})

describe("Live invalidation during a read", () => {
  it.each([false, true])("queues one follow-up and then stops, failed=%s", (failed) => {
    const loading = Connections.update(
      Connections.init(),
      Connections.Message.LoadRequested({ state: "" }),
    )
    const dirty = Connections.update(loading.model, Connections.Message.LiveChanged())
    const repeated = Connections.update(dirty.model, Connections.Message.LiveChanged())
    expect(repeated.commands ?? []).toHaveLength(0)
    const next = Connections.update(
      repeated.model,
      failed
        ? Connections.Message.LoadFailed({ requestId: 1, reason: "unavailable" })
        : Connections.Message.Loaded({ requestId: 1, inventory: { repositories: [candidate] } }),
    )
    expect(next.commands).toHaveLength(1)
    expect(next.model.liveRefresh).toBe(false)
    const settled = Connections.update(
      next.model,
      Connections.Message.Loaded({ requestId: 2, inventory: { repositories: [candidate] } }),
    )
    expect(settled.commands ?? []).toHaveLength(0)
    expect(Option.isNone(settled.model.maybeLoadRequest)).toBe(true)
  })
})

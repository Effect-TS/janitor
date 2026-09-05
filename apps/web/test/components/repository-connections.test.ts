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
  syncState: "ready",
}
const settings = { repositoryId: "701", state: "", cancelPath: "/" }
describe("Repository connections", () => {
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
    expect(disconnected.model.busy).toBe(true)
    expect(
      Connections.update(
        disconnected.model,
        Connections.Message.ClickedChange({ id: "701", action: "disconnect" }),
      ).commands,
    ).toBeUndefined()
  })
  it("explains retention and the rules affected by disconnecting", () => {
    Scene.scene(
      { update: Connections.update, view: Scene.withViewInputs(Connections.view, settings)() },
      Scene.given({
        ...Connections.update(Connections.init(), Connections.Message.ClickedDisconnect()).model,
        inventory: Option.some({ repositories: [candidate] }),
      }),
      Scene.Mount.resolve(Connections.Poll, Connections.Message.LoadRequested({ state: "" })),
      Scene.Command.resolve(
        Connections.Load,
        Connections.Message.Loaded({ inventory: { repositories: [candidate] } }),
      ),
      Scene.expect(
        Scene.text(
          "Janitor will stop syncing and applying 3 enabled rules. GitHub labels stay unchanged. Policies, rules and history are kept for reconnection.",
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
      Scene.Mount.resolve(Connections.Poll, Connections.Message.LoadRequested({ state: "" })),
      Scene.Command.resolve(
        Connections.Load,
        Connections.Message.Loaded({ inventory: { repositories: [] } }),
      ),
      Scene.expect(Scene.role("button", { name: "Grant access on GitHub" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Connect repository" })).toBeAbsent(),
    )
  })
})

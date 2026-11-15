import type { McpServer } from "@janitor/domain/Chat/McpServer"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { Scene } from "foldkit/test"
import { describe, it } from "vite-plus/test"
import * as McpServers from "@/components/mcp-servers"
import { ApiClient } from "@/lib/api-client"

/**
 * The MCP servers panel (EFF-3443), its own component on the chat sessions
 * page: each configured server with its status, and the add form.
 */

const server = (name: string, status: McpServer["status"]): McpServer => ({
  id: `srv-${name}`,
  name,
  url: `https://mcp.${name}.test/mcp`,
  auth: "oauth",
  private: true,
  enabled: true,
  status,
})

/** Each status, and the words the panel shows for it. */
const statuses: ReadonlyArray<readonly [McpServer, string]> = [
  [server("crm", "connected"), "Connected"],
  [server("tickets", "needs-consent"), "Needs consent"],
  [server("docs", "unavailable"), "Unavailable"],
  [server("wiki", "no-credential"), "No credential"],
]

const loaded = McpServers.update(
  McpServers.update(McpServers.init(), McpServers.Message.Activated({ active: true })).model,
  McpServers.Message.Loaded({ list: { servers: statuses.map(([server]) => server) } }),
).model

const panel = { update: McpServers.update, view: McpServers.view }

/** A server Connect asks for a client for, and the callback to register it with. */
const wiki = statuses[3]![0]
const redirectUri = `https://janitor.test/api/v1/chat/mcp-servers/${wiki.id}/oauth/callback`

describe("MCP servers panel", () => {
  it("shows each server with its status", () => {
    Scene.scene(
      panel,
      Scene.given(loaded),
      Scene.expect(Scene.text("MCP servers")).toExist(),
      ...statuses.flatMap(([server, status]) => [
        Scene.expect(Scene.text(server.name)).toExist(),
        Scene.expect(Scene.text(status)).toExist(),
      ]),
    )
  })

  it("adds a server as Private unless unchecked", () => {
    Scene.scene(
      panel,
      Scene.given(loaded),
      Scene.click(Scene.role("button", { name: "Add server" })),
      Scene.expect(Scene.role("switch", { name: "Private" })).toBeChecked(),
    )
  })

  it("asks for a registered client, with the callback to register, when Connect needs one", async () => {
    const refusal = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ _tag: "McpOAuthClientRequired", redirectUri }, { status: 409 }),
        ),
      ),
    )
    const message = await Effect.runPromise(
      McpServers.StartOAuth({ id: wiki.id }).effect.pipe(
        Effect.provide(
          ApiClient.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, refusal))),
        ),
      ),
    )
    Scene.scene(
      panel,
      Scene.given(McpServers.update(loaded, message).model),
      Scene.expect(Scene.role("alert")).toContainText(redirectUri),
      Scene.expect(Scene.label("Client ID")).toExist(),
      Scene.expect(Scene.label("Client secret")).toExist(),
    )
  })

  it("drops the client secret once sent, and offers Connect again once saved", () => {
    Scene.scene(
      panel,
      Scene.given(
        McpServers.update(loaded, McpServers.Message.NeedsOAuthClient({ id: wiki.id, redirectUri }))
          .model,
      ),
      Scene.type(Scene.label("Client ID"), "zoom-client"),
      Scene.type(Scene.label("Client secret"), "zoom-secret"),
      Scene.click(Scene.role("button", { name: "Save the OAuth client for wiki" })),
      Scene.expect(Scene.label("Client secret")).toHaveValue(""),
      Scene.Command.resolve(
        McpServers.SetOAuthClient,
        McpServers.Message.SavedServer({ server: wiki }),
      ),
      Scene.expect(Scene.label("Client ID")).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Connect wiki" })).toExist(),
    )
  })
})

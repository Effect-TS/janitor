import type { McpServer } from "@janitor/domain/Chat/McpServer"
import { Scene } from "foldkit/test"
import { describe, it } from "vite-plus/test"
import * as McpServers from "@/components/mcp-servers"

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
})

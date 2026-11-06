import type { McpServer } from "@janitor/domain/Chat/McpServer"
import { Scene } from "foldkit/test"
import { describe, it } from "vite-plus/test"
import * as ChatSessions from "@/components/chat-sessions"

/**
 * The chat sessions page's MCP servers panel (EFF-3443), next to the kill
 * switch: each configured server with its status, and the add form.
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

const loaded = ChatSessions.update(
  ChatSessions.update(ChatSessions.init(), ChatSessions.Message.Activated({ active: true })).model,
  ChatSessions.Message.LoadedMcpServers({
    list: { servers: statuses.map(([server]) => server) },
  }),
).model

const page = { update: ChatSessions.update, view: ChatSessions.view }

describe("MCP servers panel", () => {
  it("shows each server with its status", () => {
    Scene.scene(
      page,
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
      page,
      Scene.given(loaded),
      Scene.click(Scene.role("button", { name: "Add server" })),
      Scene.expect(Scene.role("switch", { name: "Private" })).toBeChecked(),
    )
  })
})

import type { McpServer } from "@janitor/domain/Chat/McpServer"
import { Scene, Story } from "foldkit/test"
import { describe, it } from "vite-plus/test"
import * as ChatSessions from "@/components/chat-sessions"
import * as McpServers from "@/components/mcp-servers"

/**
 * The chat sessions page embeds the MCP servers panel (EFF-3443), next to the
 * kill switch; the panel's own behaviour is in `mcp-servers.test.ts`.
 */

const crm: McpServer = {
  id: "srv-crm",
  name: "crm",
  url: "https://mcp.crm.test/mcp",
  auth: "oauth",
  private: true,
  enabled: true,
  status: "needs-consent",
}

const panel = (message: McpServers.Message) =>
  ChatSessions.Message.GotMcpServersMessage({ message })

const active = ChatSessions.update(
  ChatSessions.init(),
  ChatSessions.Message.Activated({ active: true }),
).model

const page = { update: ChatSessions.update, view: ChatSessions.view }

describe("Chat sessions page", () => {
  it("shows the MCP servers panel", () => {
    Scene.scene(
      page,
      Scene.given(
        ChatSessions.update(active, panel(McpServers.Message.Loaded({ list: { servers: [crm] } })))
          .model,
      ),
      Scene.expect(Scene.text("MCP servers")).toExist(),
      Scene.expect(Scene.text("crm")).toExist(),
      Scene.expect(Scene.text("Needs consent")).toExist(),
    )
  })

  it("sends the browser to the authorisation page the panel's Connect got", () => {
    const url = "https://auth.mcp.test/authorize?client_id=client-1&state=s"
    Story.story(
      ChatSessions.update,
      Story.given(active),
      Story.message(panel(McpServers.Message.GotAuthorization({ authorizationUrl: url }))),
      Story.expectOutMessage(ChatSessions.OutMessage.OpenAuthorization({ url })),
    )
  })
})

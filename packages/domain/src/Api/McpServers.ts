import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import {
  McpBearerToken,
  McpOAuthCallback,
  McpOAuthRefused,
  McpOAuthStart,
  McpOAuthUnavailable,
  McpServer,
  McpServerChange,
  McpServerList,
  McpServerNameTaken,
  McpServerNotFound,
  McpServerWrongAuth,
  NewMcpServer,
} from "../Chat/McpServer.ts"

const params = { id: Schema.String }

/**
 * The MCP servers chat turns can use (EFF-3443), behind Access like the kill
 * switch. No response carries a secret: a bearer token is written, never
 * read back.
 */
export class McpServersGroup extends HttpApiGroup.make("mcpServers")
  .add(HttpApiEndpoint.get("list", "/chat/mcp-servers", { success: McpServerList }))
  .add(
    HttpApiEndpoint.post("create", "/chat/mcp-servers", {
      payload: NewMcpServer,
      success: McpServer,
      error: McpServerNameTaken,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/chat/mcp-servers/:id", {
      params,
      payload: McpServerChange,
      success: McpServer,
      error: McpServerNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/chat/mcp-servers/:id", {
      params,
      error: McpServerNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.put("setBearer", "/chat/mcp-servers/:id/bearer", {
      params,
      payload: McpBearerToken,
      success: McpServer,
      error: [McpServerNotFound, McpServerWrongAuth],
    }),
  )
  .add(
    HttpApiEndpoint.post("startOAuth", "/chat/mcp-servers/:id/oauth/start", {
      params,
      success: McpOAuthStart,
      error: [McpServerNotFound, McpServerWrongAuth, McpOAuthUnavailable],
    }),
  )
  .add(
    // Where the authorisation server sends the browser back: a page that
    // says how it went and returns to the chat sessions page.
    HttpApiEndpoint.get("finishOAuth", "/chat/mcp-servers/:id/oauth/callback", {
      params,
      query: McpOAuthCallback,
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" })),
      error: [McpServerNotFound, McpOAuthRefused],
    }),
  ) {}

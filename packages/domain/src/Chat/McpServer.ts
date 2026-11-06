import * as Schema from "effect/Schema"

/**
 * The MCP servers chat turns can use, configured on the dashboard
 * (EFF-3443). A private server is offered only in Slack channels that hold
 * no one from outside the workspace; any other server in every thread. No
 * secret is part of any of these: bearer tokens and OAuth state stay in
 * each server's credential.
 */

/** What the model calls the server: `mcp.<name>.<tool>`. Fixed once created. */
export const McpServerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9_]{1,32}$/, {
    message: "Use 1 to 32 lowercase letters, digits or underscores",
  }),
)

/** An absolute `https` URL. */
export const McpServerUrl = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (!URL.canParse(value)) return "Enter an absolute URL"
      return new URL(value).protocol === "https:" || "Use an https URL"
    },
    { identifier: "McpServerUrl" },
  ),
)

/** How janitor authenticates to the server. */
export const McpServerAuth = Schema.Literals(["none", "bearer", "oauth"])
export type McpServerAuth = typeof McpServerAuth.Type

export const McpServerConfig = Schema.Struct({
  id: Schema.String,
  name: McpServerName,
  url: McpServerUrl,
  auth: McpServerAuth,
  /** Only for Slack channels that hold no one from outside the workspace. */
  private: Schema.Boolean,
  enabled: Schema.Boolean,
})
export type McpServerConfig = typeof McpServerConfig.Type

/**
 * Whether the server's credential can give a token now. `connected` for a
 * server with `auth: none`, which needs none.
 */
export const McpServerStatus = Schema.Literals([
  "connected",
  "needs-consent",
  "unavailable",
  "no-credential",
])
export type McpServerStatus = typeof McpServerStatus.Type

export const McpServer = Schema.Struct({ ...McpServerConfig.fields, status: McpServerStatus })
export type McpServer = typeof McpServer.Type

export const McpServerList = Schema.Struct({ servers: Schema.Array(McpServer) })
export type McpServerList = typeof McpServerList.Type

/** A new server: private and enabled unless said otherwise. */
export const NewMcpServer = Schema.Struct({
  name: McpServerName,
  url: McpServerUrl,
  auth: McpServerAuth,
  private: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
})
export type NewMcpServer = typeof NewMcpServer.Type

/** An edit; what's left out stays as it is. */
export const McpServerChange = Schema.Struct({
  private: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
})
export type McpServerChange = typeof McpServerChange.Type

export const McpBearerToken = Schema.Struct({ token: Schema.Redacted(Schema.NonEmptyString) })

export const McpOAuthStart = Schema.Struct({ authorizationUrl: Schema.String })

/** The query the authorisation server sends the browser back with. */
export const McpOAuthCallback = Schema.Struct({ code: Schema.String, state: Schema.String })

export class McpServerNotFound extends Schema.TaggedError<McpServerNotFound>()(
  "McpServerNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class McpServerNameTaken extends Schema.TaggedError<McpServerNameTaken>()(
  "McpServerNameTaken",
  { name: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The operation doesn't fit the server's authentication, such as a bearer token for `oauth`. */
export class McpServerWrongAuth extends Schema.TaggedError<McpServerWrongAuth>()(
  "McpServerWrongAuth",
  { auth: McpServerAuth },
  { httpApiStatus: 409 },
) {}

/**
 * **Connect** couldn't start: the deployment has no public origin, or the
 * server's authorisation server couldn't be discovered or registered with.
 */
export class McpOAuthUnavailable extends Schema.TaggedError<McpOAuthUnavailable>()(
  "McpOAuthUnavailable",
  {},
  { httpApiStatus: 502 },
) {}

/**
 * A callback that was refused: a `state` never issued, already used or more
 * than 10 minutes old, or a code the authorisation server wouldn't exchange.
 */
export class McpOAuthRefused extends Schema.TaggedError<McpOAuthRefused>()(
  "McpOAuthRefused",
  {},
  { httpApiStatus: 400 },
) {}

import {
  McpServer,
  McpServerAuth,
  McpServerChange,
  McpServerList,
  McpServerName,
  McpServerUrl,
  NewMcpServer,
} from "@janitor/domain/Chat/McpServer"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Command from "foldkit/command"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import * as Button from "./ui/button"
import { chip, type ChipVariant } from "./ui/chip"
import * as Input from "./ui/input"
import * as Page from "./ui/page"
import * as Select from "./ui/select"
import * as Switch from "./ui/switch"
import { ApiClient } from "@/lib/api-client"

/**
 * The MCP servers chat turns can use (EFF-3443), a panel on the chat sessions
 * page: each configured server with its status, its switches and credential,
 * and the add form.
 */

/** The add form. */
export const Draft = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  auth: McpServerAuth,
  private: Schema.Boolean,
})
export type Draft = typeof Draft.Type

export const Model = Schema.Struct({
  active: Schema.Boolean,
  servers: Schema.NullOr(Schema.Array(McpServer)),
  loading: Schema.Boolean,
  /** Set when a change starts, so a read already in flight never overwrites what it set. */
  stale: Schema.Boolean,
  /** The server a change is in flight for, `new` for an add; the others wait for it. */
  busy: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  /** Bearer tokens being typed, by server id; each is dropped once sent. */
  tokens: Schema.Record(Schema.String, Schema.String),
  draft: Schema.NullOr(Draft),
  draftError: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  /** The page showing the panel opened or closed. */
  Activated: { active: Schema.Boolean },
  /** The page's Refresh. */
  ClickedRefresh: {},
  Loaded: { list: McpServerList },
  Failed: { reason: Schema.String },
  ToggledServer: { id: Schema.String, change: McpServerChange },
  ClickedDeleteServer: { id: Schema.String },
  RemovedServer: { id: Schema.String },
  ChangedToken: { id: Schema.String, token: Schema.String },
  ClickedSetToken: { id: Schema.String },
  ClickedConnectServer: { id: Schema.String },
  GotAuthorization: { authorizationUrl: Schema.String },
  /** A change answered with the server as it is now. */
  SavedServer: { server: McpServer },
  FailedChange: { reason: Schema.String },
  ClickedAddServer: {},
  ChangedDraftName: { name: Schema.String },
  ChangedDraftUrl: { url: Schema.String },
  ChangedDraftAuth: { auth: McpServerAuth },
  ToggledDraftPrivate: { private: Schema.Boolean },
  ClickedCancelDraft: {},
  ClickedSaveDraft: {},
  CreatedServer: { server: McpServer },
  FailedCreateServer: { reason: Schema.String },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  /** Send the browser to an MCP server's authorisation page. */
  OpenAuthorization: { url: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

export const init = (): Model => ({
  active: false,
  servers: null,
  loading: false,
  stale: false,
  busy: null,
  error: null,
  tokens: {},
  draft: null,
  draftError: null,
})

export const FetchServers = Command.define("FetchChatMcpServers", {
  messages: [Message.Loaded, Message.Failed],
  execute: ApiClient.use((api) => api.mcpServers.list()).pipe(
    Effect.timeout("15 seconds"),
    Effect.map((list) => Message.Loaded({ list })),
    Effect.orElseSucceed(() => Message.Failed({ reason: "The MCP servers could not be loaded." })),
  ),
})

const changeFailed = () =>
  Message.FailedChange({ reason: "The MCP server didn't change. Please retry." })

export const UpdateServer = Command.define("UpdateChatMcpServer", {
  args: { id: Schema.String, change: McpServerChange },
  messages: [Message.SavedServer, Message.FailedChange],
  execute: ({ id, change }) =>
    ApiClient.use((api) => api.mcpServers.update({ params: { id }, payload: change })).pipe(
      Effect.timeout("15 seconds"),
      Effect.map((server) => Message.SavedServer({ server })),
      Effect.orElseSucceed(changeFailed),
    ),
})

export const RemoveServer = Command.define("RemoveChatMcpServer", {
  args: { id: Schema.String },
  messages: [Message.RemovedServer, Message.FailedChange],
  execute: ({ id }) =>
    ApiClient.use((api) => api.mcpServers.remove({ params: { id } })).pipe(
      Effect.timeout("15 seconds"),
      Effect.as(Message.RemovedServer({ id })),
      Effect.orElseSucceed(() =>
        Message.FailedChange({ reason: "The MCP server wasn't deleted. Please retry." }),
      ),
    ),
})

/** The token stays redacted from here on: the model no longer holds it. */
export const SetBearer = Command.define("SetChatMcpBearer", {
  args: { id: Schema.String, token: Schema.Redacted(Schema.String) },
  messages: [Message.SavedServer, Message.FailedChange],
  execute: ({ id, token }) =>
    ApiClient.use((api) => api.mcpServers.setBearer({ params: { id }, payload: { token } })).pipe(
      Effect.timeout("15 seconds"),
      Effect.map((server) => Message.SavedServer({ server })),
      Effect.orElseSucceed(() =>
        Message.FailedChange({ reason: "The token wasn't saved. Please enter it again." }),
      ),
    ),
})

export const StartOAuth = Command.define("StartChatMcpOAuth", {
  args: { id: Schema.String },
  messages: [Message.GotAuthorization, Message.FailedChange],
  execute: ({ id }) =>
    ApiClient.use((api) => api.mcpServers.startOAuth({ params: { id } })).pipe(
      Effect.timeout("15 seconds"),
      Effect.map(({ authorizationUrl }) => Message.GotAuthorization({ authorizationUrl })),
      Effect.catchTag("McpOAuthUnavailable", () =>
        Effect.succeed(
          Message.FailedChange({
            reason: "Connect couldn't start: the server's sign-in couldn't be reached.",
          }),
        ),
      ),
      Effect.orElseSucceed(() =>
        Message.FailedChange({ reason: "Connect couldn't start. Please retry." }),
      ),
    ),
})

export const CreateServer = Command.define("CreateChatMcpServer", {
  args: { server: NewMcpServer },
  messages: [Message.CreatedServer, Message.FailedCreateServer],
  execute: ({ server }) =>
    ApiClient.use((api) => api.mcpServers.create({ payload: server })).pipe(
      Effect.timeout("15 seconds"),
      Effect.map((created) => Message.CreatedServer({ server: created })),
      Effect.catchTag("McpServerNameTaken", () =>
        Effect.succeed(
          Message.FailedCreateServer({
            reason: `A server named ${server.name} already exists.`,
          }),
        ),
      ),
      Effect.orElseSucceed(() =>
        Message.FailedCreateServer({ reason: "The server wasn't added. Please retry." }),
      ),
    ),
})

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, ApiClient>

/** Reads the servers, unless a read or a change is in flight. */
const read = (model: Model): Return =>
  model.loading || model.busy !== null
    ? { model }
    : { model: { ...model, loading: true, stale: false }, commands: [FetchServers()] }

/** Starts a change to one server; the others wait for it. */
const beginChange = (
  model: Model,
  busy: string,
  command: Command.Command<Message, never, ApiClient>,
): Return =>
  model.busy !== null
    ? { model }
    : { model: { ...model, busy, stale: true, error: null }, commands: [command] }

const withoutToken = (tokens: Model["tokens"], id: string) =>
  Object.fromEntries(Object.entries(tokens).filter(([key]) => key !== id))

/** The add form as it opens: private unless unchecked. */
const emptyDraft: Draft = { name: "", url: "", auth: "none", private: true }

const editDraft = (model: Model, edit: Partial<Draft>): Return =>
  model.draft === null ? { model } : { model: { ...model, draft: { ...model.draft, ...edit } } }

/** Why the draft can't be added, in the API's words; `null` when it can. */
const draftError = (draft: Draft): string | null =>
  !Schema.is(McpServerName)(draft.name)
    ? "Name: use 1 to 32 lowercase letters, digits or underscores."
    : !Schema.is(McpServerUrl)(draft.url.trim())
      ? "URL: use an absolute https URL."
      : null

export const update = (model: Model, message: Message): Return =>
  Message.match(message, {
    Activated: ({ active }) => {
      if (model.active === active) return { model }
      // Read again on return.
      return active ? read({ ...model, active }) : { model: { ...model, active } }
    },
    ClickedRefresh: () => read(model),
    Loaded: ({ list }) =>
      model.stale || model.busy !== null
        ? { model: { ...model, loading: false } }
        : { model: { ...model, loading: false, servers: list.servers, error: null } },
    Failed: ({ reason }) =>
      model.stale || model.busy !== null
        ? { model: { ...model, loading: false } }
        : { model: { ...model, loading: false, error: reason } },
    ToggledServer: ({ id, change }) => beginChange(model, id, UpdateServer({ id, change })),
    ClickedDeleteServer: ({ id }) => beginChange(model, id, RemoveServer({ id })),
    RemovedServer: ({ id }) => ({
      model: {
        ...model,
        busy: null,
        servers: (model.servers ?? []).filter((server) => server.id !== id),
        tokens: withoutToken(model.tokens, id),
      },
    }),
    ChangedToken: ({ id, token }) => ({
      model: { ...model, tokens: { ...model.tokens, [id]: token } },
    }),
    ClickedSetToken: ({ id }) => {
      const token = (model.tokens[id] ?? "").trim()
      if (token === "" || model.busy !== null) return { model }
      const step = beginChange(model, id, SetBearer({ id, token: Redacted.make(token) }))
      return { ...step, model: { ...step.model, tokens: withoutToken(model.tokens, id) } }
    },
    ClickedConnectServer: ({ id }) => beginChange(model, id, StartOAuth({ id })),
    GotAuthorization: ({ authorizationUrl }): Return => ({
      model: { ...model, busy: null },
      outMessage: OutMessage.OpenAuthorization({ url: authorizationUrl }),
    }),
    SavedServer: ({ server }) => ({
      model: {
        ...model,
        busy: null,
        error: null,
        servers: (model.servers ?? []).map((each) => (each.id === server.id ? server : each)),
      },
    }),
    FailedChange: ({ reason }) => ({ model: { ...model, busy: null, error: reason } }),
    ClickedAddServer: () => ({ model: { ...model, draft: emptyDraft, draftError: null } }),
    ChangedDraftName: ({ name }) => editDraft(model, { name }),
    ChangedDraftUrl: ({ url }) => editDraft(model, { url }),
    ChangedDraftAuth: ({ auth }) => editDraft(model, { auth }),
    ToggledDraftPrivate: (change) => editDraft(model, { private: change.private }),
    ClickedCancelDraft: () =>
      model.busy === "new" ? { model } : { model: { ...model, draft: null, draftError: null } },
    ClickedSaveDraft: () => {
      const draft = model.draft
      if (draft === null || model.busy !== null) return { model }
      const error = draftError(draft)
      if (error !== null) return { model: { ...model, draftError: error } }
      const step = beginChange(
        model,
        "new",
        CreateServer({
          server: {
            name: draft.name,
            url: draft.url.trim(),
            auth: draft.auth,
            private: draft.private,
          },
        }),
      )
      return { ...step, model: { ...step.model, draftError: null } }
    },
    CreatedServer: ({ server }) => ({
      model: {
        ...model,
        busy: null,
        servers: [...(model.servers ?? []), server],
        draft: null,
        draftError: null,
      },
    }),
    FailedCreateServer: ({ reason }) => ({ model: { ...model, busy: null, draftError: reason } }),
  })

// VIEW

const statusChips: Record<McpServer["status"], { label: string; variant: ChipVariant }> = {
  connected: { label: "Connected", variant: "success" },
  "needs-consent": { label: "Needs consent", variant: "neutral" },
  unavailable: { label: "Unavailable", variant: "danger" },
  "no-credential": { label: "No credential", variant: "neutral" },
}

const authLabels: Record<McpServerAuth, string> = {
  none: "No authentication",
  bearer: "Bearer token",
  oauth: "OAuth",
}

const alert = (h: HtmlBuilder<Message>, error: string | null) =>
  error === null
    ? h.empty
    : h.p([h.Role("alert"), h.Class("text-body-sm text-destructive")], [error])

/** A switch on one server, named after it too: every row has a Private and an Enabled. */
const serverSwitch = (
  h: HtmlBuilder<Message>,
  model: Model,
  server: McpServer,
  key: "private" | "enabled",
) => {
  const id = `mcp-server-${server.id}-${key}`
  return Switch.view(h, {
    id,
    label: key === "private" ? "Private" : "Enabled",
    isChecked: server[key],
    isBusy: model.busy === server.id,
    isDisabled: model.busy !== null,
    labelClass: "text-body-sm",
    attributes: [h.AriaLabelledBy(`${id}-label mcp-server-${server.id}-name`)],
    onToggle: (on) => Message.ToggledServer({ id: server.id, change: { [key]: on } }),
  })
}

const credential = (h: HtmlBuilder<Message>, model: Model, server: McpServer) => {
  const isDisabled = model.busy !== null
  if (server.auth === "bearer") {
    const token = model.tokens[server.id] ?? ""
    return h.div(
      [h.Class("flex items-end gap-2")],
      [
        Input.input(h, {
          id: `mcp-server-${server.id}-token`,
          label: "Bearer token",
          type: "password",
          value: token,
          isDisabled,
          labelClass: "text-body-sm",
          attributes: [h.Autocomplete("off")],
          onInput: (value) => Message.ChangedToken({ id: server.id, token: value }),
        }),
        Button.view(h, {
          variant: "secondary",
          size: "sm",
          label: "Set token",
          isDisabled: isDisabled || token.trim() === "",
          attributes: [h.AriaLabel(`Set token for ${server.name}`)],
          onClick: Message.ClickedSetToken({ id: server.id }),
        }),
      ],
    )
  }
  if (server.auth === "oauth")
    return Button.view(h, {
      variant: "secondary",
      size: "sm",
      label: "Connect",
      isDisabled,
      attributes: [h.AriaLabel(`Connect ${server.name}`)],
      onClick: Message.ClickedConnectServer({ id: server.id }),
    })
  return h.empty
}

const serverItem = (h: HtmlBuilder<Message>, model: Model, server: McpServer) => {
  const { label, variant } = statusChips[server.status]
  return h.li(
    [
      h.Class("flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0"),
      h.DataAttribute("mcp-server", server.id),
    ],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-2")],
        [
          h.code(
            [h.Id(`mcp-server-${server.id}-name`), h.Class("font-mono text-mono-sm")],
            [server.name],
          ),
          chip(h, { variant, children: [label] }),
        ],
      ),
      h.p([h.Class("text-body-sm break-all text-ink-muted")], [server.url]),
      h.p([h.Class("text-body-sm text-ink-muted")], [authLabels[server.auth]]),
      h.div(
        [h.Class("flex flex-wrap gap-x-4 gap-y-2")],
        [serverSwitch(h, model, server, "private"), serverSwitch(h, model, server, "enabled")],
      ),
      credential(h, model, server),
      h.div(
        [h.Class("flex justify-end")],
        [
          Button.view(h, {
            variant: "destructive",
            size: "sm",
            label: "Delete",
            isDisabled: model.busy !== null,
            attributes: [h.AriaLabel(`Delete ${server.name}`)],
            onClick: Message.ClickedDeleteServer({ id: server.id }),
          }),
        ],
      ),
    ],
  )
}

const form = (h: HtmlBuilder<Message>, model: Model, draft: Draft) => {
  const isDisabled = model.busy !== null
  return h.div(
    [
      h.Role("group"),
      h.AriaLabel("New server"),
      h.Class("flex flex-col gap-2 rounded-md border border-border p-2"),
    ],
    [
      Input.input(h, {
        id: "mcp-server-new-name",
        label: "Name",
        value: draft.name,
        placeholder: "crm",
        description: "Lowercase letters, digits and underscores. Can't be changed later.",
        isDisabled,
        onInput: (name) => Message.ChangedDraftName({ name }),
      }),
      Input.input(h, {
        id: "mcp-server-new-url",
        label: "URL",
        type: "url",
        value: draft.url,
        placeholder: "https://",
        isDisabled,
        onInput: (url) => Message.ChangedDraftUrl({ url }),
      }),
      Select.view(h, {
        id: "mcp-server-new-auth",
        label: "Authentication",
        value: draft.auth,
        options: McpServerAuth.literals.map((auth) => [auth, authLabels[auth]] as const),
        isDisabled,
        onChange: (value) =>
          Message.ChangedDraftAuth({
            auth: value === "bearer" ? "bearer" : value === "oauth" ? "oauth" : "none",
          }),
      }),
      Switch.view(h, {
        id: "mcp-server-new-private",
        label: "Private",
        isChecked: draft.private,
        isDisabled,
        className: "justify-between",
        onToggle: (on) => Message.ToggledDraftPrivate({ private: on }),
      }),
      alert(h, model.draftError),
      h.div(
        [h.Class("flex justify-end gap-2")],
        [
          Button.view(h, {
            variant: "secondary",
            size: "sm",
            label: "Cancel",
            isDisabled: model.busy === "new",
            onClick: Message.ClickedCancelDraft(),
          }),
          Button.view(h, {
            size: "sm",
            label: "Save",
            isDisabled,
            onClick: Message.ClickedSaveDraft(),
          }),
        ],
      ),
    ],
  )
}

const content = (h: HtmlBuilder<Message>, model: Model) => {
  const servers = model.servers
  if (servers === null)
    return [
      model.error === null
        ? h.p([h.Class("text-body-md text-ink-muted")], ["Loading"])
        : alert(h, model.error),
    ]
  return [
    h.p(
      [h.Class("text-body-sm text-ink-muted")],
      [
        "Tools chat turns can use. A private server is offered only in internal Slack channels; any other in every thread, Discord included.",
      ],
    ),
    servers.length === 0
      ? h.p([h.Role("status"), h.Class("mt-2 text-body-sm text-ink-muted")], ["No servers yet."])
      : h.ul(
          [h.Class("mt-3 flex flex-col gap-3"), h.AriaLabel("MCP servers")],
          servers.map((server) => serverItem(h, model, server)),
        ),
    h.div(
      [h.Class("mt-3 flex flex-col gap-2")],
      [
        alert(h, model.error),
        model.draft === null
          ? Button.view(h, {
              variant: "secondary",
              size: "sm",
              label: "Add server",
              isDisabled: model.busy !== null,
              onClick: Message.ClickedAddServer(),
            })
          : form(h, model, model.draft),
      ],
    ),
  ]
}

/** The panel's inspector card. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  Page.inspectorCard(h, { heading: "MCP servers", children: content(h, model) }),
)

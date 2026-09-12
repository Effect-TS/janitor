import {
  AccountView,
  LinkedAccount,
  LinkPlatform,
  type RosterEntry,
  TeammateRole,
  type TeammateSummary,
} from "@janitor/domain/Team/Account"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Mount from "foldkit/mount"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import * as Icon from "@/lib/icons"
import { UserRound } from "lucide"

/**
 * The account page: who the signed-in teammate is, which Slack and GitHub
 * accounts they have proven, and, for admins, the team roster with role,
 * removal and restoration controls. Every change goes to the API and the
 * page reloads its view afterwards; nothing here decides authorization.
 */

export const Model = Schema.Struct({
  view: Schema.Option(AccountView),
  loadError: Schema.Option(Schema.String),
  error: Schema.Option(Schema.String),
  notice: Schema.String,
  nextOperationId: Schema.Int,
  pending: Schema.Option(
    Schema.Struct({ operationId: Schema.Int, action: Schema.String, subject: Schema.String }),
  ),
  nextRequestId: Schema.Int,
  maybeLoadRequest: Schema.Option(Schema.Int),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  view: Option.none(),
  loadError: Option.none(),
  error: Option.none(),
  notice: "",
  nextOperationId: 1,
  pending: Option.none(),
  nextRequestId: 1,
  maybeLoadRequest: Option.none(),
})

export const Message = defineMessageUnion({
  LoadRequested: {},
  Loaded: { view: AccountView, requestId: Schema.Int },
  LoadFailed: { reason: Schema.String, requestId: Schema.Int },
  ClickedConnect: { platform: LinkPlatform },
  GotPlatformUrl: { url: Schema.String, operationId: Schema.Int },
  ClickedDisconnect: { linkId: Schema.String },
  ClickedSetRole: { teammateId: Schema.String, role: TeammateRole },
  ClickedRemove: { teammateId: Schema.String },
  ClickedRestore: { teammateId: Schema.String },
  Changed: { operationId: Schema.Int, notice: Schema.String },
  Returned: { operationId: Schema.Int, linked: LinkedAccount },
  Failed: { reason: Schema.String, operationId: Schema.Int },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  OpenPlatform: { url: Schema.String },
  /** The platform callback was consumed; the page can drop its query string. */
  FinishedReturn: {},
})
export type OutMessage = typeof OutMessage.Type

/** What a platform sends back to the browser after authorization. */
export interface ReturnParams {
  readonly platform: LinkPlatform
  readonly state: string
  readonly code: string
}

const base = "/api/v1/account"
const request = (method: "POST" | "PUT" | "DELETE", url: string, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const req = yield* HttpClientRequest.make(method)(url).pipe(HttpClientRequest.bodyJson(body))
    const response = yield* client.execute(req)
    if (response.status >= 400) {
      const data = yield* HttpIncomingMessage.schemaBodyJson(
        Schema.Struct({ message: Schema.String }),
      )(response).pipe(
        Effect.orElseSucceed(() => ({ message: "The request failed. Please retry." })),
      )
      return yield* Effect.fail(new Error(data.message))
    }
    return response
  })
const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed. Please retry."
const failed = (error: unknown, operationId: number) =>
  Message.Failed({ operationId, reason: reasonOf(error) })

export const Load = Command.define("LoadAccount", {
  args: { requestId: Schema.Int },
  messages: [Message.Loaded, Message.LoadFailed],
  execute: ({ requestId }) =>
    HttpClient.get(base).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? HttpIncomingMessage.schemaBodyJson(AccountView)(response)
          : HttpIncomingMessage.schemaBodyJson(Schema.Struct({ message: Schema.String }))(
              response,
            ).pipe(
              Effect.orElseSucceed(() => ({
                message: "Could not load your account. Retry to continue.",
              })),
              Effect.flatMap((data) => Effect.fail(new Error(data.message))),
            ),
      ),
      Effect.map((view) => Message.Loaded({ view, requestId })),
      Effect.catch((error) =>
        Effect.succeed(Message.LoadFailed({ reason: reasonOf(error), requestId })),
      ),
    ),
})

export const Open = Mount.defineStream("OpenAccount", {
  args: {},
  messages: [Message.LoadRequested],
  execute: () => Stream.make(Message.LoadRequested()),
})

const Start = Command.define("StartAccountLink", {
  args: { platform: LinkPlatform, operationId: Schema.Int },
  messages: [Message.GotPlatformUrl, Message.Failed],
  execute: ({ platform, operationId }) =>
    request("POST", `${base}/links/${platform}/start`, {}).pipe(
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Schema.Struct({ url: Schema.String }))),
      Effect.map(({ url }) => Message.GotPlatformUrl({ url, operationId })),
      Effect.catch((error) => Effect.succeed(failed(error, operationId))),
    ),
})

const Return = Command.define("CompleteAccountLink", {
  args: {
    platform: LinkPlatform,
    state: Schema.String,
    code: Schema.String,
    operationId: Schema.Int,
  },
  messages: [Message.Returned, Message.Failed],
  execute: ({ platform, state, code, operationId }) =>
    request("POST", `${base}/links/${platform}/return`, { state, code }).pipe(
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(LinkedAccount)),
      Effect.map((linked) => Message.Returned({ linked, operationId })),
      Effect.catch((error) => Effect.succeed(failed(error, operationId))),
    ),
})

const Disconnect = Command.define("DisconnectAccountLink", {
  args: { linkId: Schema.String, operationId: Schema.Int },
  messages: [Message.Changed, Message.Failed],
  execute: ({ linkId, operationId }) =>
    request("DELETE", `${base}/links/${encodeURIComponent(linkId)}`, {}).pipe(
      Effect.as(Message.Changed({ operationId, notice: "Account disconnected." })),
      Effect.catch((error) => Effect.succeed(failed(error, operationId))),
    ),
})

const SetRole = Command.define("SetTeammateRole", {
  args: { teammateId: Schema.String, role: TeammateRole, operationId: Schema.Int },
  messages: [Message.Changed, Message.Failed],
  execute: ({ teammateId, role, operationId }) =>
    request("PUT", `/api/v1/team/${encodeURIComponent(teammateId)}/role`, { role }).pipe(
      Effect.as(
        Message.Changed({
          operationId,
          notice: role === "admin" ? "Teammate is now an admin." : "Teammate is now a member.",
        }),
      ),
      Effect.catch((error) => Effect.succeed(failed(error, operationId))),
    ),
})

const Remove = Command.define("RemoveTeammate", {
  args: { teammateId: Schema.String, operationId: Schema.Int },
  messages: [Message.Changed, Message.Failed],
  execute: ({ teammateId, operationId }) =>
    request("DELETE", `/api/v1/team/${encodeURIComponent(teammateId)}`, {}).pipe(
      Effect.as(
        Message.Changed({
          operationId,
          notice: "Teammate removed. Their accepted work and attribution are kept.",
        }),
      ),
      Effect.catch((error) => Effect.succeed(failed(error, operationId))),
    ),
})

const Restore = Command.define("RestoreTeammate", {
  args: { teammateId: Schema.String, operationId: Schema.Int },
  messages: [Message.Changed, Message.Failed],
  execute: ({ teammateId, operationId }) =>
    request("POST", `/api/v1/team/${encodeURIComponent(teammateId)}/restore`, {}).pipe(
      Effect.as(Message.Changed({ operationId, notice: "Teammate restored." })),
      Effect.catch((error) => Effect.succeed(failed(error, operationId))),
    ),
})

type Step = Update.ReturnWithOutMessage<Model, Message, OutMessage, HttpClient.HttpClient>

const isBusy = (model: Model): boolean => Option.isSome(model.pending)
const matchesOperation = (model: Model, operationId: number) =>
  Option.exists(model.pending, (pending) => pending.operationId === operationId)
const begin = (model: Model, action: string, subject: string): Model =>
  evo(model, {
    pending: () => Option.some({ operationId: model.nextOperationId, action, subject }),
    nextOperationId: (id) => id + 1,
    error: () => Option.none(),
    notice: () => "",
  })
const reload = (model: Model) => ({
  model: evo(model, {
    nextRequestId: (id) => id + 1,
    maybeLoadRequest: () => Option.some(model.nextRequestId),
  }),
  commands: [Load({ requestId: model.nextRequestId })],
})
const settle = (model: Model, notice: string) =>
  reload(evo(model, { pending: () => Option.none(), notice: () => notice }))

/** Entering the page from a platform callback completes the link before loading. */
export const returned = (model: Model, params: ReturnParams): Step => {
  const started = begin(model, "return", params.platform)
  return {
    model: started,
    commands: [Return({ ...params, operationId: model.nextOperationId })],
  }
}

export const update = (model: Model, message: Message): Step =>
  Message.match<Step>(message, {
    LoadRequested: () => (Option.isSome(model.maybeLoadRequest) ? { model } : reload(model)),
    Loaded: ({ view, requestId }) =>
      !Option.contains(model.maybeLoadRequest, requestId)
        ? { model }
        : {
            model: evo(model, {
              view: () => Option.some(view),
              loadError: () => Option.none(),
              maybeLoadRequest: () => Option.none(),
            }),
          },
    LoadFailed: ({ reason, requestId }) =>
      !Option.contains(model.maybeLoadRequest, requestId)
        ? { model }
        : {
            model: evo(model, {
              loadError: () => Option.some(reason),
              maybeLoadRequest: () => Option.none(),
            }),
          },
    ClickedConnect: ({ platform }) =>
      isBusy(model)
        ? { model }
        : {
            model: begin(model, "connect", platform),
            commands: [Start({ platform, operationId: model.nextOperationId })],
          },
    GotPlatformUrl: ({ url, operationId }) =>
      !matchesOperation(model, operationId)
        ? { model }
        : {
            model: evo(model, { pending: () => Option.none() }),
            outMessage: OutMessage.OpenPlatform({ url }),
          },
    ClickedDisconnect: ({ linkId }) =>
      isBusy(model)
        ? { model }
        : {
            model: begin(model, "disconnect", linkId),
            commands: [Disconnect({ linkId, operationId: model.nextOperationId })],
          },
    ClickedSetRole: ({ teammateId, role }) =>
      isBusy(model)
        ? { model }
        : {
            model: begin(model, "role", teammateId),
            commands: [SetRole({ teammateId, role, operationId: model.nextOperationId })],
          },
    ClickedRemove: ({ teammateId }) =>
      isBusy(model)
        ? { model }
        : {
            model: begin(model, "remove", teammateId),
            commands: [Remove({ teammateId, operationId: model.nextOperationId })],
          },
    ClickedRestore: ({ teammateId }) =>
      isBusy(model)
        ? { model }
        : {
            model: begin(model, "restore", teammateId),
            commands: [Restore({ teammateId, operationId: model.nextOperationId })],
          },
    Changed: ({ operationId, notice }) =>
      !matchesOperation(model, operationId) ? { model } : settle(model, notice),
    Returned: ({ operationId, linked }) =>
      !matchesOperation(model, operationId)
        ? { model }
        : {
            ...settle(model, `${platformName(linked.platform)} account connected.`),
            outMessage: OutMessage.FinishedReturn(),
          },
    Failed: ({ reason, operationId }) => {
      if (!matchesOperation(model, operationId)) return { model }
      const wasReturn = Option.exists(model.pending, (pending) => pending.action === "return")
      const next = reload(
        evo(model, { pending: () => Option.none(), error: () => Option.some(reason) }),
      )
      return wasReturn ? { ...next, outMessage: OutMessage.FinishedReturn() } : next
    },
  })

// VIEW

const platformName = (platform: LinkPlatform): string => (platform === "slack" ? "Slack" : "GitHub")

const displayName = (teammate: TeammateSummary): string => teammate.email ?? teammate.subject

const activeLink = (links: ReadonlyArray<LinkedAccount>, platform: LinkPlatform) =>
  links.find((link) => link.platform === platform && link.status === "active")

const platformRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  view: AccountView,
  platform: LinkPlatform,
): Html => {
  const link = activeLink(view.links, platform)
  const available = view.linking[platform]
  const name = platformName(platform)
  const busyWith = (action: string, subject: string) =>
    Option.exists(
      model.pending,
      (pending) => pending.action === action && pending.subject === subject,
    )
  return h.div(
    [h.Class("flex flex-wrap items-center justify-between gap-3 py-3")],
    [
      h.div(
        [h.Class("min-w-0")],
        [
          h.p([h.Class("text-sm font-medium")], [name]),
          h.p(
            [h.Class("text-xs text-muted-foreground")],
            [
              link === undefined
                ? available
                  ? `No ${name} account connected.`
                  : `${name} linking is not configured for this deployment.`
                : `Connected as ${link.displayName}${platform === "slack" ? ` in workspace ${link.workspaceId}` : ""}.`,
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("flex gap-2")],
        available
          ? [
              Button.view(h, {
                label: busyWith("connect", platform)
                  ? "Opening…"
                  : link === undefined
                    ? `Connect ${name}`
                    : `Replace ${name} account`,
                onClick: Message.ClickedConnect({ platform }),
                variant: link === undefined ? "default" : "outline",
                size: "sm",
                isDisabled: isBusy(model),
              }),
              link === undefined
                ? h.empty
                : Button.view(h, {
                    label: busyWith("disconnect", link.linkId) ? "Disconnecting…" : "Disconnect",
                    onClick: Message.ClickedDisconnect({ linkId: link.linkId }),
                    variant: "destructive",
                    size: "sm",
                    isDisabled: isBusy(model),
                  }),
            ]
          : [],
      ),
    ],
  )
}

const rosterRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  self: TeammateSummary,
  entry: RosterEntry,
): Html => {
  const isSelf = entry.teammateId === self.teammateId
  const removed = entry.status === "removed"
  const busyWith = (action: string) =>
    Option.exists(
      model.pending,
      (pending) => pending.action === action && pending.subject === entry.teammateId,
    )
  const connected = entry.links
    .filter((link) => link.status === "active")
    .map((link) => `${platformName(link.platform)}: ${link.displayName}`)
  return h.div(
    [h.Class("flex flex-wrap items-center justify-between gap-3 py-3")],
    [
      h.div(
        [h.Class("min-w-0")],
        [
          h.p([h.Class("text-sm font-medium")], [`${displayName(entry)}${isSelf ? " (you)" : ""}`]),
          h.p(
            [h.Class("text-xs text-muted-foreground")],
            [
              `${entry.role === "admin" ? "Admin" : "Member"} · ${removed ? "Removed" : "Active"}${connected.length > 0 ? ` · ${connected.join(", ")}` : ""}`,
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("flex gap-2")],
        removed
          ? [
              Button.view(h, {
                label: busyWith("restore") ? "Restoring…" : "Restore",
                onClick: Message.ClickedRestore({ teammateId: entry.teammateId }),
                variant: "outline",
                size: "sm",
                isDisabled: isBusy(model),
              }),
            ]
          : [
              Button.view(h, {
                label: busyWith("role")
                  ? "Updating…"
                  : entry.role === "admin"
                    ? "Make member"
                    : "Make admin",
                onClick: Message.ClickedSetRole({
                  teammateId: entry.teammateId,
                  role: entry.role === "admin" ? "member" : "admin",
                }),
                variant: "outline",
                size: "sm",
                isDisabled: isBusy(model),
              }),
              Button.view(h, {
                label: busyWith("remove") ? "Removing…" : "Remove",
                onClick: Message.ClickedRemove({ teammateId: entry.teammateId }),
                variant: "destructive",
                size: "sm",
                isDisabled: isBusy(model),
              }),
            ],
      ),
    ],
  )
}

const section = (h: HtmlBuilder<Message>, title: string, children: ReadonlyArray<Html>): Html =>
  h.section(
    [h.Class("rounded-lg border p-5 space-y-2")],
    [h.h2([h.Class("text-base font-semibold")], [title]), ...children],
  )

export const view = Submodel.defineView<Model, Message, Record<string, never>>(
  (model, _inputs, h) =>
    h.div(
      [h.Class("mx-auto w-full max-w-2xl p-6 space-y-5"), h.OnMount(Open({}))],
      [
        h.div(
          [h.Class("flex items-center gap-3")],
          [
            Icon.view(h, UserRound, "size-6 text-muted-foreground"),
            h.h1([h.Class("text-lg font-semibold")], ["Account"]),
          ],
        ),
        Option.isSome(model.error)
          ? h.p([h.Role("alert"), h.Class("text-sm text-destructive")], [model.error.value])
          : h.empty,
        Option.isSome(model.loadError)
          ? h.p([h.Role("alert"), h.Class("text-sm text-destructive")], [model.loadError.value])
          : h.empty,
        model.notice
          ? h.p([h.Role("status"), h.Class("text-sm text-muted-foreground")], [model.notice])
          : h.empty,
        Option.match(model.view, {
          onNone: () =>
            Option.isNone(model.loadError)
              ? h.p([h.Role("status")], ["Loading your account…"])
              : h.empty,
          onSome: (view) =>
            h.div(
              [h.Class("space-y-5")],
              [
                section(h, "You", [
                  h.p([h.Class("text-sm")], [displayName(view.teammate)]),
                  h.p(
                    [h.Class("text-xs text-muted-foreground")],
                    [
                      `${view.teammate.role === "admin" ? "Admin" : "Member"} · signed in through ${view.teammate.issuer}`,
                    ],
                  ),
                ]),
                section(h, "Connected accounts", [
                  h.p(
                    [h.Class("text-sm text-muted-foreground")],
                    [
                      "Connected accounts may direct Janitor from Slack and GitHub until you disconnect them, independently of this browser session.",
                    ],
                  ),
                  h.div(
                    [h.Class("divide-y")],
                    [platformRow(h, model, view, "slack"), platformRow(h, model, view, "github")],
                  ),
                ]),
                view.team === null
                  ? h.empty
                  : section(h, "Team", [
                      h.p(
                        [h.Class("text-sm text-muted-foreground")],
                        [
                          "Removing a teammate disables their connected accounts and sign-in; their accepted work and attribution are kept. The last active admin cannot be removed or demoted.",
                        ],
                      ),
                      h.div(
                        [h.Class("divide-y")],
                        view.team.map((entry) => rosterRow(h, model, view.teammate, entry)),
                      ),
                    ]),
              ],
            ),
        }),
      ],
    ),
)

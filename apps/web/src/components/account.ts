import {
  AccountView,
  LinkedAccount,
  LinkPlatform,
  type TeammateSummary,
} from "@janitor/domain/Team/Account"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Mount from "foldkit/mount"
import { modifyFields } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import { platformMark } from "@/components/ui/mark"
import { panel } from "@/components/ui/panel"
import { rack } from "@/components/ui/rack"
import { sign } from "@/components/ui/sign"
import { readFailure, reasonOf, request } from "@/lib/api"
import * as Routes from "@/routes"

/**
 * The account page: who the signed-in teammate is and which GitHub account
 * they have proven. Cloudflare Access decides who may use Janitor;
 * every change goes to the API and the page reloads its view afterwards.
 */

/** What the page is waiting on; the subject is the platform or link. */
const PendingAction = Schema.Literals(["connect", "return", "disconnect"])
type PendingAction = typeof PendingAction.Type

export const Model = Schema.Struct({
  view: Schema.Option(AccountView),
  loadError: Schema.Option(Schema.String),
  error: Schema.Option(Schema.String),
  notice: Schema.String,
  nextOperationId: Schema.Int,
  pending: Schema.Option(
    Schema.Struct({ operationId: Schema.Int, action: PendingAction, subject: Schema.String }),
  ),
  liveRefresh: Schema.Boolean,
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
  liveRefresh: false,
  nextRequestId: 1,
  maybeLoadRequest: Option.none(),
})

export const Message = defineMessageUnion({
  LoadRequested: {},
  LiveChanged: {},
  Loaded: { view: AccountView, requestId: Schema.Int },
  LoadFailed: { reason: Schema.String, requestId: Schema.Int },
  ClickedConnect: { platform: LinkPlatform },
  GotPlatformUrl: { url: Schema.String, operationId: Schema.Int },
  ClickedDisconnect: { linkId: Schema.String },
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
          : readFailure(response, "Could not load your account. Retry to continue."),
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

const CompleteLink = Command.define("CompleteAccountLink", {
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

type Step = Update.ReturnWithOutMessage<Model, Message, OutMessage, HttpClient.HttpClient>

const isBusy = (model: Model): boolean => Option.isSome(model.pending)
const matchesOperation = (model: Model, operationId: number) =>
  Option.exists(model.pending, (pending) => pending.operationId === operationId)
const begin = (model: Model, action: PendingAction, subject: string): Model =>
  modifyFields(model, {
    pending: () => Option.some({ operationId: model.nextOperationId, action, subject }),
    nextOperationId: (id) => id + 1,
    error: () => Option.none(),
    notice: () => "",
  })
const reload = (model: Model) => ({
  model: modifyFields(model, {
    liveRefresh: () => false,
    nextRequestId: (id) => id + 1,
    maybeLoadRequest: () => Option.some(model.nextRequestId),
  }),
  commands: [Load({ requestId: model.nextRequestId })],
})
const settle = (model: Model, notice: string) =>
  reload(modifyFields(model, { pending: () => Option.none(), notice: () => notice }))

/** The platform came back without a code: nothing was proven. */
export const declined = (model: Model, error: string | undefined): Model =>
  modifyFields(model, {
    error: () =>
      Option.some(
        error === undefined
          ? "The platform did not return an authorization. Start again."
          : `The platform declined the authorization (${error}).`,
      ),
  })

/** Entering the page from a platform callback completes the link before loading. */
export const returned = (model: Model, params: ReturnParams): Step => {
  const started = begin(model, "return", params.platform)
  return {
    model: started,
    commands: [CompleteLink({ ...params, operationId: model.nextOperationId })],
  }
}

export const update = (model: Model, message: Message): Step =>
  Message.match<Step>(message, {
    LoadRequested: () => (Option.isSome(model.maybeLoadRequest) ? { model } : reload(model)),
    LiveChanged: () =>
      Option.isSome(model.maybeLoadRequest)
        ? { model: { ...model, liveRefresh: true } }
        : reload(model),
    Loaded: ({ view, requestId }) =>
      !Option.contains(model.maybeLoadRequest, requestId)
        ? { model }
        : model.liveRefresh
          ? reload({
              ...model,
              view: Option.some(view),
              liveRefresh: false,
              maybeLoadRequest: Option.none(),
            })
          : {
              model: modifyFields(model, {
                view: () => Option.some(view),
                loadError: () => Option.none(),
                maybeLoadRequest: () => Option.none(),
              }),
            },
    LoadFailed: ({ reason, requestId }) =>
      !Option.contains(model.maybeLoadRequest, requestId)
        ? { model }
        : model.liveRefresh
          ? reload(model)
          : {
              model: modifyFields(model, {
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
            model: modifyFields(model, { pending: () => Option.none() }),
            outMessage: OutMessage.OpenPlatform({ url }),
          },
    ClickedDisconnect: ({ linkId }) =>
      isBusy(model)
        ? { model }
        : {
            model: begin(model, "disconnect", linkId),
            commands: [Disconnect({ linkId, operationId: model.nextOperationId })],
          },
    Changed: ({ operationId, notice }) =>
      !matchesOperation(model, operationId) ? { model } : settle(model, notice),
    Returned: ({ operationId, linked }) =>
      !matchesOperation(model, operationId)
        ? { model }
        : {
            ...settle(model, `${platformNames[linked.platform]} account connected.`),
            outMessage: OutMessage.FinishedReturn(),
          },
    Failed: ({ reason, operationId }) => {
      if (!matchesOperation(model, operationId)) return { model }
      const wasReturn = Option.exists(model.pending, (pending) => pending.action === "return")
      const next = reload(
        modifyFields(model, { pending: () => Option.none(), error: () => Option.some(reason) }),
      )
      return wasReturn ? { ...next, outMessage: OutMessage.FinishedReturn() } : next
    },
  })

// VIEW

const platformNames: Record<LinkPlatform, string> = { github: "GitHub" }

const displayName = (teammate: TeammateSummary): string => teammate.email ?? teammate.subject

const activeLink = (links: ReadonlyArray<LinkedAccount>, platform: LinkPlatform) =>
  links.find((link) => link.platform === platform && link.status === "active")

/** The newest link for a platform that is no longer active, if any. Links
 *  arrive active-first, newest-first, so the first non-active hit is it. */
const pastLink = (links: ReadonlyArray<LinkedAccount>, platform: LinkPlatform) =>
  links.find((link) => link.platform === platform && link.status !== "active")

const formatDay = (at: DateTime.Utc): string =>
  DateTime.formatUtc(at, { day: "numeric", month: "short", year: "numeric" })

const busyWith = (model: Model, action: PendingAction, subject: string): boolean =>
  Option.exists(
    model.pending,
    (pending) => pending.action === action && pending.subject === subject,
  )

export type ViewInputs = {
  readonly section: Routes.AccountSection
}

const sectionTitle: Record<Routes.AccountSection, string> = {
  you: "You",
  accounts: "Connected accounts",
}

const sectionNav = (h: HtmlBuilder<Message>, current: Routes.AccountSection): Html =>
  rack(h, {
    label: "Account settings",
    className: "shrink-0 md:w-sidebar",
    items: (["you", "accounts"] as const).map((section) => ({
      href: Routes.accountSection(section),
      label: sectionTitle[section],
      isCurrent: section === current,
    })),
  })

const pane = (
  h: HtmlBuilder<Message>,
  section: Routes.AccountSection,
  lede: string,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [h.Attribute("aria-labelledby", `account-${section}`), h.Class("flex flex-col gap-3")],
    [
      h.div(
        [h.Class("flex flex-col gap-1")],
        [
          sign(h, { id: `account-${section}`, children: [sectionTitle[section]] }),
          h.p([h.Class("text-body-sm text-ink-muted")], [lede]),
        ],
      ),
      ...children,
    ],
  )

/** A machine value: an identifier or a date. */
const mono = (h: HtmlBuilder<Message>, text: string): Html =>
  h.span([h.Class("font-mono text-mono-sm")], [text])

/** An error panel: what happened, in destructive on the title only. */
const alert = (h: HtmlBuilder<Message>, text: string): Html =>
  panel(h, {
    attributes: [h.Role("alert")],
    className: "border-destructive text-body-sm",
    children: [h.div([h.Class("font-medium text-destructive")], [text])],
  })

// YOU

const youRow = (h: HtmlBuilder<Message>, label: string, value: Html | string): Html =>
  h.div(
    [h.Class("flex items-center gap-4 border-b border-border-subtle px-4 py-1.5 last:border-b-0")],
    [
      h.dt([h.Class("w-32 shrink-0 text-body-sm text-ink-muted")], [label]),
      h.dd([h.Class("min-w-0 truncate text-body-md")], [value]),
    ],
  )

const youPane = (h: HtmlBuilder<Message>, view: AccountView): Html =>
  pane(h, "you", "How Janitor knows you. Sign-in is handled by Cloudflare Access.", [
    panel(h, {
      flush: true,
      children: [
        h.dl(
          [],
          [
            youRow(h, "Email", displayName(view.teammate)),
            youRow(h, "Teammate since", mono(h, formatDay(view.teammate.createdAt))),
          ],
        ),
      ],
    }),
  ])

// CONNECTED ACCOUNTS

const platformRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  view: AccountView,
  platform: LinkPlatform,
): Html => {
  const link = activeLink(view.links, platform)
  const past = pastLink(view.links, platform)
  const available = view.linking[platform]
  const name = platformNames[platform]
  const status =
    link !== undefined
      ? h.span([], ["Connected as ", mono(h, link.displayName)])
      : !available
        ? h.span([], ["Not available in this deployment"])
        : past === undefined
          ? h.span([], ["Not connected"])
          : h.span([], ["Disconnected · was ", mono(h, past.displayName)])
  const connectLabel = busyWith(model, "connect", platform) ? "Opening…" : `Connect ${name}`
  const actions =
    link === undefined
      ? [
          Button.view(h, {
            label: connectLabel,
            onClick: Message.ClickedConnect({ platform }),
            size: "sm",
            isDisabled: !available || isBusy(model),
          }),
        ]
      : [
          Button.view(h, {
            label: busyWith(model, "connect", platform) ? "Opening…" : "Replace",
            onClick: Message.ClickedConnect({ platform }),
            variant: "link",
            size: "sm",
            isDisabled: isBusy(model),
          }),
          Button.view(h, {
            label: busyWith(model, "disconnect", link.linkId) ? "Disconnecting…" : "Disconnect",
            onClick: Message.ClickedDisconnect({ linkId: link.linkId }),
            variant: "destructive",
            size: "sm",
            isDisabled: isBusy(model),
          }),
        ]
  return h.div(
    [
      h.Class("flex items-center gap-3 border-b border-border-subtle px-4 py-2.5 last:border-b-0"),
      h.DataAttribute("slot", "row"),
    ],
    [
      platformMark(h, platform),
      h.div(
        [h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
        [
          h.p([h.Class("text-h3 font-semibold")], [name]),
          h.p([h.Class("text-body-sm text-ink-muted")], [status]),
        ],
      ),
      h.div([h.Class("flex shrink-0 items-center gap-2")], actions),
    ],
  )
}

const accountsPane = (h: HtmlBuilder<Message>, model: Model, view: AccountView): Html =>
  pane(h, "accounts", "Accounts you have proven you own.", [
    panel(h, {
      flush: true,
      children: [platformRow(h, model, view, "github")],
    }),
  ])

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(
    [h.Class("flex flex-col gap-4 p-4 md:flex-row md:gap-8 lg:p-5"), h.OnMount(Open({}))],
    [
      sectionNav(h, inputs.section),
      h.div(
        [h.Class("flex min-w-0 max-w-2xl flex-1 flex-col gap-3")],
        [
          Option.isSome(model.error) ? alert(h, model.error.value) : h.empty,
          Option.isSome(model.loadError) ? alert(h, model.loadError.value) : h.empty,
          model.notice
            ? panel(h, {
                attributes: [h.Role("status")],
                className: "text-body-sm text-ink-muted",
                children: [model.notice],
              })
            : h.empty,
          Option.match(model.view, {
            onNone: () =>
              Option.isNone(model.loadError)
                ? h.p(
                    [h.Role("status"), h.Class("text-body-sm text-ink-muted")],
                    ["Loading your account…"],
                  )
                : h.empty,
            onSome: (view) => {
              switch (inputs.section) {
                case "you":
                  return youPane(h, view)
                case "accounts":
                  return accountsPane(h, model, view)
              }
            },
          }),
        ],
      ),
    ],
  ),
)

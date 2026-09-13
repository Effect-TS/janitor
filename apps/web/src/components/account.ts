import {
  AccountView,
  LinkedAccount,
  LinkPlatform,
  type RosterEntry,
  TeammateRole,
  type TeammateSummary,
} from "@janitor/domain/Team/Account"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Mount from "foldkit/mount"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import { chip } from "@/components/ui/chip"
import { avatar, platformMark } from "@/components/ui/mark"
import { emptyPanel, panel } from "@/components/ui/panel"
import { rack } from "@/components/ui/rack"
import { sign } from "@/components/ui/sign"
import { readFailure, reasonOf, request } from "@/lib/api"
import { cn } from "@/lib/utils"
import * as Routes from "@/routes"

/**
 * The account page: who the signed-in teammate is, which Slack and GitHub
 * accounts they have proven, and, for admins, the team roster with role,
 * removal and restoration controls. Every change goes to the API and the
 * page reloads its view afterwards; nothing here decides authorization.
 */

/** What the page is waiting on; the subject is the platform, link or teammate. */
const PendingAction = Schema.Literals([
  "connect",
  "return",
  "disconnect",
  "role",
  "remove",
  "restore",
])
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
  nextRequestId: Schema.Int,
  maybeLoadRequest: Schema.Option(Schema.Int),
  /** Whether the Team section lists removed teammates. View-local, not persisted. */
  showRemoved: Schema.Boolean,
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
  showRemoved: false,
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
  ToggledRemoved: {},
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
const begin = (model: Model, action: PendingAction, subject: string): Model =>
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

/** The platform came back without a code: nothing was proven. */
export const declined = (model: Model, error: string | undefined): Model =>
  evo(model, {
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
    ToggledRemoved: () => ({ model: evo(model, { showRemoved: (shown) => !shown }) }),
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
  team: "Team",
}

/** The section nav. Team is listed only for admins, who receive a roster. */
const sectionNav = (
  h: HtmlBuilder<Message>,
  current: Routes.AccountSection,
  hasTeam: boolean,
): Html =>
  rack(h, {
    label: "Account settings",
    className: "shrink-0 md:w-sidebar",
    items: (["you", "accounts", ...(hasTeam ? ["team" as const] : [])] as const).map((section) => ({
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

const roleChip = (h: HtmlBuilder<Message>, role: typeof TeammateRole.Type): Html =>
  chip(h, { children: [role === "admin" ? "admin" : "member"] })

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
            youRow(h, "Role", roleChip(h, view.teammate.role)),
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
  const name = platformName(platform)
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
  pane(h, "accounts", "Accounts that can give Janitor instructions on your behalf.", [
    panel(h, {
      flush: true,
      children: [platformRow(h, model, view, "github"), platformRow(h, model, view, "slack")],
    }),
    h.p(
      [h.Class("text-body-sm text-ink-muted")],
      [
        "Disconnecting stops new instructions from that account. Work it already contributed is kept.",
      ],
    ),
  ])

// TEAM

const rosterRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  self: TeammateSummary,
  entry: RosterEntry,
): Html => {
  const isSelf = entry.teammateId === self.teammateId
  const removed = entry.status === "removed"
  const actions = removed
    ? [
        chip(h, { variant: "danger", children: ["removed"] }),
        Button.view(h, {
          label: busyWith(model, "restore", entry.teammateId) ? "Restoring…" : "Restore",
          onClick: Message.ClickedRestore({ teammateId: entry.teammateId }),
          variant: "secondary",
          size: "sm",
          isDisabled: isBusy(model),
        }),
      ]
    : [
        roleChip(h, entry.role),
        ...(isSelf
          ? []
          : [
              Button.view(h, {
                label: busyWith(model, "role", entry.teammateId)
                  ? "Updating…"
                  : entry.role === "admin"
                    ? "Make member"
                    : "Make admin",
                onClick: Message.ClickedSetRole({
                  teammateId: entry.teammateId,
                  role: entry.role === "admin" ? "member" : "admin",
                }),
                variant: "secondary",
                size: "sm",
                isDisabled: isBusy(model),
              }),
              Button.view(h, {
                label: busyWith(model, "remove", entry.teammateId) ? "Removing…" : "Remove",
                onClick: Message.ClickedRemove({ teammateId: entry.teammateId }),
                variant: "destructive",
                size: "sm",
                isDisabled: isBusy(model),
              }),
            ]),
      ]
  return h.div(
    [
      h.Class(
        cn(
          "flex items-center gap-3 border-b border-border-subtle px-4 py-1.5 last:border-b-0",
          removed && "text-ink-muted",
        ),
      ),
      h.DataAttribute("slot", "row"),
    ],
    [
      avatar(h, displayName(entry)),
      h.div(
        [h.Class("min-w-0 flex-1")],
        [
          h.p(
            [h.Class("truncate text-body-md")],
            [
              displayName(entry),
              isSelf ? h.span([h.Class("ml-1 text-ink-muted")], ["(you)"]) : h.empty,
            ],
          ),
          entry.email === null && !removed
            ? h.p([h.Class("text-body-sm text-ink-muted")], ["No email on record"])
            : h.empty,
          removed && entry.removedAt !== null
            ? h.p([h.Class("text-body-sm")], ["Removed ", mono(h, formatDay(entry.removedAt))])
            : h.empty,
        ],
      ),
      h.div([h.Class("flex shrink-0 items-center gap-2")], actions),
    ],
  )
}

const teamPane = (h: HtmlBuilder<Message>, model: Model, view: AccountView): Html => {
  if (view.team === null)
    return pane(h, "team", "Only admins can manage the team.", [
      emptyPanel(h, {
        children: ["Ask an admin if you need a role change or to remove someone."],
      }),
    ])
  const active = view.team.filter((entry) => entry.status !== "removed")
  const removed = view.team.filter((entry) => entry.status === "removed")
  return pane(h, "team", "Everyone who has signed in. New teammates start as members.", [
    panel(h, {
      flush: true,
      children: [
        h.div(
          [],
          [
            ...active.map((entry) => rosterRow(h, model, view.teammate, entry)),
            ...(model.showRemoved
              ? removed.map((entry) => rosterRow(h, model, view.teammate, entry))
              : []),
          ],
        ),
        h.div(
          [
            h.Class(
              "flex min-h-8 items-center justify-between gap-3 border-t border-border bg-surface-muted px-4 py-1 text-body-sm text-ink-muted",
            ),
          ],
          [
            h.span([], [mono(h, String(active.length)), " active"]),
            removed.length === 0
              ? h.empty
              : Button.view(h, {
                  label: model.showRemoved ? "Hide removed" : `Show ${removed.length} removed`,
                  onClick: Message.ToggledRemoved(),
                  variant: "link",
                  size: "sm",
                  attributes: [h.AriaExpanded(model.showRemoved)],
                }),
          ],
        ),
      ],
    }),
  ])
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(
    [h.Class("flex flex-col gap-4 p-4 md:flex-row md:gap-8 lg:p-5"), h.OnMount(Open({}))],
    [
      sectionNav(
        h,
        inputs.section,
        Option.exists(model.view, (view) => view.team !== null),
      ),
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
                case "team":
                  return teamPane(h, model, view)
              }
            },
          }),
        ],
      ),
    ],
  ),
)

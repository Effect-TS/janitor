import { ConnectionInventory as Inventory } from "@janitor/domain/GitHub/Connection"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import * as Mount from "foldkit/mount"
import * as Dialog from "@foldkit/ui/dialog"
import type * as Update from "foldkit/update"
import * as Submodel from "foldkit/submodel"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Button from "@/components/ui/button"
import * as DialogChrome from "@/components/ui/dialog"
import { chip, type ChipVariant } from "@/components/ui/chip"
import { inputGroup, inputGroupAddon, inputGroupInput } from "@/components/ui/input-group"
import * as Page from "@/components/ui/page"
import { panel, panelHeader } from "@/components/ui/panel"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"
import { CircleAlert, RotateCw, Search } from "lucide"
import { reasonOf, request } from "@/lib/api"
import * as Routes from "@/routes"

export const Model = Schema.Struct({
  returnPath: Schema.String,
  inventory: Schema.Option(Inventory),
  error: Schema.Option(Schema.String),
  loadError: Schema.Option(Schema.String),
  search: Schema.String,
  nextOperationId: Schema.Int,
  pending: Schema.Option(
    Schema.Struct({
      operationId: Schema.Int,
      action: Schema.String,
      repositoryId: Schema.NullOr(Schema.String),
    }),
  ),
  nextRequestId: Schema.Int,
  maybeLoadRequest: Schema.Option(Schema.Int),
  dialog: Dialog.Model,
  notice: Schema.String,
})
export type Model = typeof Model.Type
export const init = (returnPath = Routes.home()): Model => ({
  returnPath,
  inventory: Option.none(),
  error: Option.none(),
  loadError: Option.none(),
  search: "",
  nextOperationId: 1,
  pending: Option.none(),
  nextRequestId: 1,
  maybeLoadRequest: Option.none(),
  dialog: Dialog.init({ id: "disconnect-repository", focusSelector: "#cancel-disconnect" }),
  notice: "",
})
/** Enter from a repository route, or retain the destination across the GitHub callback. */
export const enter = (model: Model, returnPath = model.returnPath): Model =>
  evo(model, { returnPath: () => returnPath })

export const Message = defineMessageUnion({
  ClickedCancel: {},
  GotDialogMessage: { message: Dialog.Message },
  LoadRequested: { state: Schema.String },
  Loaded: { inventory: Inventory, requestId: Schema.Int },
  LoadFailed: { reason: Schema.String, requestId: Schema.Int },
  Failed: { reason: Schema.String, operationId: Schema.Int },
  Searched: { value: Schema.String },
  ClickedRefresh: {},
  ClickedChange: {
    id: Schema.String,
    action: Schema.Literals(["connect", "disconnect", "resume", "pause"]),
  },
  Changed: { id: Schema.String, action: Schema.String, operationId: Schema.Int },
  ClickedGithub: { installationId: Schema.NullOr(Schema.String) },
  GotGithub: { url: Schema.String, operationId: Schema.Int },
  ClickedDisconnect: {},
  CancelledDisconnect: {},
  Refreshed: { operationId: Schema.Int },
})
export type Message = typeof Message.Type
export const OutMessage = defineMessageUnion({
  Cancelled: { path: Schema.String },
  Changed: { id: Schema.String, action: Schema.String },
  OpenGithub: { url: Schema.String },
})
const base = "/api/v1/repository-connections"
const failed = (error: unknown, operationId: number) =>
  Message.Failed({ operationId, reason: reasonOf(error) })
const load = (requestId: number) =>
  HttpClient.get(`${base}/available`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? HttpIncomingMessage.schemaBodyJson(Inventory)(response)
        : Effect.fail(new Error("Could not load repositories. Retry to continue.")),
    ),
    Effect.map((inventory) => Message.Loaded({ inventory, requestId })),
    Effect.catch((error) =>
      Effect.succeed(Message.LoadFailed({ reason: failed(error, 0).reason, requestId })),
    ),
  )
export const Load = Command.define("LoadConnectionInventory", {
  args: { state: Schema.String, requestId: Schema.Int },
  messages: [Message.Loaded, Message.LoadFailed, Message.Failed],
  execute: ({ state, requestId }) =>
    state
      ? request("POST", `${base}/return`, { state }).pipe(
          Effect.flatMap(() => load(requestId)),
          Effect.catch((error) =>
            Effect.succeed(Message.LoadFailed({ reason: failed(error, 0).reason, requestId })),
          ),
        )
      : load(requestId),
})
export const Poll = Mount.defineStream("PollRepositoryConnections", {
  args: { state: Schema.String, refresh: Schema.Boolean },
  messages: [Message.LoadRequested, Message.ClickedRefresh],
  execute: ({ state, refresh }) =>
    Stream.make(
      state || !refresh ? Message.LoadRequested({ state }) : Message.ClickedRefresh(),
    ).pipe(
      Stream.concat(
        Stream.tick("3 seconds").pipe(
          Stream.take(40),
          Stream.map(() => Message.LoadRequested({ state: "" })),
        ),
      ),
    ),
})
const Refresh = Command.define("RefreshConnectionInventory", {
  args: { operationId: Schema.Int },
  messages: [Message.Refreshed, Message.Failed],
  execute: ({ operationId }) =>
    request("POST", `${base}/refresh`, {}).pipe(
      Effect.as(Message.Refreshed({ operationId })),
      Effect.catch((error) => Effect.succeed(failed(error, operationId))),
    ),
})
const Change = Command.define("ChangeRepositoryConnection", {
  args: { id: Schema.String, action: Schema.String, operationId: Schema.Int },
  messages: [Message.Changed, Message.Failed],
  execute: ({ id, action, operationId }) =>
    request(
      action === "connect" ? "PUT" : action === "disconnect" ? "DELETE" : "PATCH",
      `/api/v1/repositories/${encodeURIComponent(id)}/connection`,
      { enabled: action === "resume" },
    ).pipe(
      Effect.as(Message.Changed({ id, action, operationId })),
      Effect.catch((error) => Effect.succeed(failed(error, operationId))),
    ),
})
const Github = Command.define("OpenGitHubInstallation", {
  args: { installationId: Schema.NullOr(Schema.String), operationId: Schema.Int },
  messages: [Message.GotGithub, Message.Failed],
  execute: ({ installationId, operationId }) =>
    request("POST", `${base}/github`, { installationId }).pipe(
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Schema.Struct({ url: Schema.String }))),
      Effect.map(({ url }) => Message.GotGithub({ url, operationId })),
      Effect.catch((error) => Effect.succeed(failed(error, operationId))),
    ),
})
const mapDialog = (model: Model, result: ReturnType<typeof Dialog.open>) => ({
  model: evo(model, { dialog: () => result.model }),
  commands: Command.mapMessages(result.commands, (message) =>
    Message.GotDialogMessage({ message }),
  ),
})
const isBusy = (model: Model): boolean => Option.isSome(model.pending)
const matchesOperation = (model: Model, operationId: number) =>
  Option.exists(model.pending, (pending) => pending.operationId === operationId)
const begin = (model: Model, action: string, repositoryId: string | null = null): Model =>
  evo(model, {
    pending: () => Option.some({ operationId: model.nextOperationId, action, repositoryId }),
    nextOperationId: (id) => id + 1,
    error: () => Option.none(),
    notice: () => "",
  })
const reload = (model: Model, state = "") => ({
  model: evo(model, {
    nextRequestId: (id) => id + 1,
    maybeLoadRequest: () => Option.some(model.nextRequestId),
  }),
  commands: [Load({ state, requestId: model.nextRequestId })],
})
export const update = (model: Model, message: Message) =>
  Message.match<
    Update.ReturnWithOutMessage<Model, Message, typeof OutMessage.Type, HttpClient.HttpClient>
  >(message, {
    ClickedCancel: () => ({ model, outMessage: OutMessage.Cancelled({ path: model.returnPath }) }),
    GotDialogMessage: ({ message }) =>
      isBusy(model) ? { model } : mapDialog(model, Dialog.update(model.dialog, message)),
    LoadRequested: ({ state }) =>
      Option.isSome(model.maybeLoadRequest) ? { model } : reload(model, state),
    Loaded: ({ inventory, requestId }) =>
      !Option.contains(model.maybeLoadRequest, requestId)
        ? { model }
        : {
            model: evo(model, {
              inventory: () => Option.some(inventory),
              loadError: () => Option.none(),
              maybeLoadRequest: () => Option.none(),
              notice: (current) =>
                current === "Refreshing repository list…"
                  ? "Available repositories are up to date."
                  : current,
            }),
          },
    LoadFailed: ({ reason, requestId }) =>
      !Option.contains(model.maybeLoadRequest, requestId)
        ? { model }
        : {
            model: evo(model, {
              loadError: () => Option.some(reason),
              maybeLoadRequest: () => Option.none(),
              notice: () => "",
            }),
          },
    Failed: ({ reason, operationId }) =>
      !matchesOperation(model, operationId)
        ? { model }
        : reload(evo(model, { pending: () => Option.none(), error: () => Option.some(reason) })),
    Searched: ({ value }) => ({ model: evo(model, { search: () => value }) }),
    ClickedRefresh: () =>
      isBusy(model)
        ? { model }
        : {
            model: begin(model, "refresh"),
            commands: [Refresh({ operationId: model.nextOperationId })],
          },
    Refreshed: ({ operationId }) =>
      !matchesOperation(model, operationId)
        ? { model }
        : reload(
            evo(model, {
              pending: () => Option.none(),
              notice: () => "Refreshing repository list…",
            }),
          ),
    ClickedChange: ({ id, action }) =>
      isBusy(model)
        ? { model }
        : {
            model: begin(model, action, id),
            commands: [Change({ id, action, operationId: model.nextOperationId })],
          },
    Changed: ({ id, action, operationId }) => {
      if (!matchesOperation(model, operationId)) return { model }
      const dialogClose = mapDialog(model, Dialog.close(model.dialog))
      const next = reload(
        evo(dialogClose.model, {
          pending: () => Option.none(),
          inventory: Option.map((inventory) => ({
            ...inventory,
            repositories: inventory.repositories.map((row) =>
              row.repositoryId !== id
                ? row
                : {
                    ...row,
                    connected: action !== "disconnect",
                    enabled: action === "resume" || action === "connect",
                    reconnect: row.reconnect || action === "disconnect",
                    policyCount: action === "disconnect" ? 0 : row.policyCount,
                    ruleCount: action === "disconnect" ? 0 : row.ruleCount,
                    syncState: action === "connect" || action === "resume" ? "syncing" : "paused",
                    syncError: null,
                    blockReason:
                      action === "disconnect"
                        ? "This repository is disconnected from Janitor."
                        : action === "pause"
                          ? "This repository is paused in Janitor. Resume it to continue."
                          : null,
                  },
            ),
          })),
        }),
      )
      return {
        model: next.model,
        commands: [...(dialogClose.commands ?? []), ...next.commands],
        outMessage: OutMessage.Changed({ id, action }),
      }
    },
    ClickedGithub: ({ installationId }) =>
      isBusy(model)
        ? { model }
        : {
            model: begin(model, "github"),
            commands: [Github({ installationId, operationId: model.nextOperationId })],
          },
    GotGithub: ({ url, operationId }) =>
      !matchesOperation(model, operationId)
        ? { model }
        : {
            model: evo(model, { pending: () => Option.none() }),
            outMessage: OutMessage.OpenGithub({ url }),
          },
    ClickedDisconnect: () =>
      isBusy(model) ? { model } : mapDialog(model, Dialog.open(model.dialog)),
    CancelledDisconnect: () =>
      isBusy(model) ? { model } : mapDialog(model, Dialog.close(model.dialog)),
  })
/** An error panel: what happened, in destructive on the title only. */
const alert = <M>(h: HtmlBuilder<M>, text: string): Html =>
  panel(h, {
    attributes: [h.Role("alert")],
    className: "border-destructive text-body-sm",
    children: [h.div([h.Class("font-medium text-destructive")], [text])],
  })

/** A warning is neutral text with an icon; there is no warning colour. */
const note = <M>(
  h: HtmlBuilder<M>,
  text: string,
  attributes: ReadonlyArray<Attribute<M> | ChildAttribute> = [],
): Html =>
  h.p(
    [...attributes, h.Class("flex items-start gap-1 text-body-sm text-ink-muted")],
    [Icon.view(h, CircleAlert, "mt-0.5 size-3.5 shrink-0"), h.span([], [text])],
  )

const repositoryName = <M>(h: HtmlBuilder<M>, owner: string, repo: string, className?: string) =>
  h.span([h.Class(cn("font-mono text-mono-md", className))], [`${owner}/${repo}`])

type Row = (typeof Inventory.Type)["repositories"][number]

const hasAccess = (row: Row) => row.access === "accessible" && row.installationStatus === "active"
const syncBlocked = (row: Row) => row.connected && row.enabled && row.syncState === "failed"
/** Whether repository work may run: connection, access and pause, never cache health. */
const eligible = (row: Row) => row.connected && hasAccess(row) && row.enabled

const status = (row: Row): { readonly label: string; readonly variant: ChipVariant } =>
  !row.connected
    ? { label: "Disconnected", variant: "danger" }
    : !hasAccess(row)
      ? { label: "Access lost", variant: "danger" }
      : !row.enabled
        ? { label: "Paused", variant: "neutral" }
        : { label: "Ready", variant: "success" }

/** Health of the synchronization cache, shown beside the connection state. */
const cacheHealth = (row: Row): { readonly label: string; readonly variant: ChipVariant } | null =>
  !eligible(row)
    ? null
    : row.syncState === "failed"
      ? { label: "Sync failed", variant: "danger" }
      : row.syncState === "syncing"
        ? { label: "Synchronizing", variant: "neutral" }
        : { label: "Synchronized", variant: "neutral" }

export const view = Submodel.defineView<
  Model,
  Message,
  { repositoryId: string | null; state: string }
>((model, inputs, h) => {
  const rows = Option.getOrElse(model.inventory, () => ({ repositories: [] })).repositories
  const current = rows.find((row) => row.repositoryId === inputs.repositoryId)
  const settings = inputs.repositoryId !== null
  const busy = isBusy(model)
  const button = (
    label: string,
    onClick: Message,
    variant: "secondary" | "default" | "destructive" = "secondary",
    size: "default" | "sm" = "default",
  ) =>
    Button.view(h, {
      label:
        Option.isSome(model.pending) &&
        onClick._tag === "ClickedChange" &&
        model.pending.value.repositoryId === onClick.id &&
        model.pending.value.action === onClick.action
          ? {
              connect: "Connecting…",
              disconnect: "Disconnecting…",
              pause: "Pausing…",
              resume: "Resuming…",
            }[onClick.action]
          : label,
      onClick,
      variant,
      size,
      isDisabled: busy,
    })
  const refreshing = Option.exists(model.pending, (pending) => pending.action === "refresh")
  const refreshButton = (label: string, icon = false) =>
    Button.view(h, {
      label: icon
        ? h.span(
            [h.Class("contents")],
            [Icon.view(h, RotateCw), refreshing ? "Refreshing…" : label],
          )
        : refreshing
          ? "Refreshing…"
          : label,
      onClick: Message.ClickedRefresh(),
      variant: "secondary",
      isDisabled: busy,
    })
  const alerts: ReadonlyArray<Html> = [
    Option.isSome(model.error) ? alert(h, model.error.value) : h.empty,
    Option.isSome(model.loadError) ? alert(h, model.loadError.value) : h.empty,
  ]
  const loading = Option.isNone(model.inventory) && Option.isNone(model.loadError)
  const mutedRow = (text: string, attributes: ReadonlyArray<Attribute<Message>> = []) =>
    h.p([...attributes, h.Class("px-4 py-3 text-body-sm text-ink-muted")], [text])

  /** One setting: label and description on the left, the control on the right. */
  const settingRow = (
    label: string,
    description: string,
    controls: ReadonlyArray<Html>,
    notices: ReadonlyArray<Html> = [],
  ) =>
    h.div(
      [h.Class("flex items-center justify-between gap-6 px-4 py-3")],
      [
        h.div(
          [h.Class("flex min-w-0 flex-col gap-1")],
          [
            h.p([h.Class("text-body-md font-medium")], [label]),
            h.p([h.Class("text-body-sm text-ink-muted")], [description]),
            ...notices,
          ],
        ),
        h.div([h.Class("flex shrink-0 flex-wrap items-center justify-end gap-2")], controls),
      ],
    )

  if (settings) {
    const attributes = [h.OnMount(Poll({ state: inputs.state, refresh: false }))]
    if (!current) {
      return h.div(
        [h.Class("flex flex-col gap-6"), ...attributes],
        [
          ...alerts,
          panel(h, {
            flush: true,
            children: [
              panelHeader(h, { title: "Connection" }),
              loading
                ? mutedRow("Loading repositories…", [h.Role("status")])
                : Option.isSome(model.inventory)
                  ? mutedRow("This repository is not in the installation's inventory.")
                  : h.empty,
            ],
          }),
        ],
      )
    }
    const state = status(current)
    const health = cacheHealth(current)
    const connection = panel(h, {
      flush: true,
      children: [
        panelHeader(h, {
          title: "Connection",
          meta: `${current.owner}/${current.repo}`,
          actions: [
            chip(h, { variant: state.variant, children: [state.label] }),
            health === null
              ? h.empty
              : chip(h, { variant: health.variant, children: [health.label] }),
          ],
        }),
        h.div(
          [h.Class("flex flex-col divide-y divide-border-subtle")],
          [
            settingRow(
              "Automation",
              "Pausing stops automation and synchronization. Configuration, stored facts and GitHub labels are kept.",
              [
                syncBlocked(current)
                  ? button(
                      "Retry sync",
                      Message.ClickedChange({ id: current.repositoryId, action: "resume" }),
                    )
                  : h.empty,
                current.connected
                  ? button(
                      current.enabled ? "Pause repository" : "Resume repository",
                      Message.ClickedChange({
                        id: current.repositoryId,
                        action: current.enabled ? "pause" : "resume",
                      }),
                    )
                  : button(
                      "Reconnect",
                      Message.ClickedChange({ id: current.repositoryId, action: "connect" }),
                    ),
              ],
              [
                syncBlocked(current)
                  ? h.p(
                      [h.Role("status"), h.Class("text-body-sm")],
                      [
                        h.span(
                          [h.Class("text-destructive")],
                          [current.syncError ?? "Synchronization could not complete."],
                        ),
                        h.span(
                          [h.Class("text-ink-muted")],
                          [
                            " Automatic retries continue. Retry sync to refresh facts now. Agent sessions keep working; labeling waits for new webhook events after recovery.",
                          ],
                        ),
                      ],
                    )
                  : h.empty,
                current.blockReason ? note(h, current.blockReason, [h.Role("status")]) : h.empty,
                !current.enabled && current.reconnect
                  ? h.p(
                      [h.Class("text-body-sm text-ink-muted")],
                      [
                        "Pausing retains your configuration and stored data. Resume to synchronize before automation runs.",
                      ],
                    )
                  : h.empty,
              ],
            ),
            settingRow(
              "GitHub access",
              "Installation permissions and repository selection live on GitHub.",
              [
                button(
                  "Manage GitHub access",
                  Message.ClickedGithub({ installationId: current.installationId }),
                ),
              ],
              [current.accessError ? note(h, current.accessError, [h.Role("status")]) : h.empty],
            ),
            settingRow(
              "Repository list",
              "Re-read which repositories the installation can reach.",
              [refreshButton("Refresh repositories")],
            ),
          ],
        ),
      ],
    })
    const danger = current.connected
      ? panel(h, {
          flush: true,
          className: "border-destructive/40",
          children: [
            panelHeader(h, { title: "Danger zone", className: "border-destructive/40" }),
            settingRow(
              "Disconnect repository",
              "Deletes policies, drafts, rules, stored facts and history. GitHub labels stay unchanged.",
              [button("Disconnect repository", Message.ClickedDisconnect(), "destructive")],
            ),
          ],
        })
      : h.empty
    const dialog = h.submodel({
      slotId: "disconnect-dialog",
      model: model.dialog,
      view: Dialog.view,
      toParentMessage: (message) => Message.GotDialogMessage({ message }),
      viewInputs: {
        toView: (render) =>
          DialogChrome.view(h, {
            dialog: render.dialog,
            backdrop: render.backdrop,
            panel: render.panel,
            title: render.title,
            description: render.description,
            isVisible: render.isVisible,
            titleText: `Disconnect ${current.owner}/${current.repo}?`,
            descriptionText: h.span(
              [h.Class("flex flex-col gap-2")],
              [
                h.span(
                  [],
                  [
                    "Disconnect permanently deletes all policies, drafts, published history, labeling rules and groups, stored facts, event history and cached evaluations. GitHub labels stay unchanged. Reconnecting starts empty and requires synchronization. Pause and access loss retain your configuration.",
                  ],
                ),
                Option.isSome(model.error)
                  ? h.span(
                      [h.Role("alert"), h.Class("font-medium text-destructive")],
                      [model.error.value],
                    )
                  : h.empty,
              ],
            ),
            actions: [
              Button.view(h, {
                label: "Cancel",
                variant: "secondary",
                size: "sm",
                attributes: [h.Id("cancel-disconnect")],
                onClick: Message.CancelledDisconnect(),
                isDisabled: busy,
              }),
              button(
                "Disconnect repository",
                Message.ClickedChange({ id: current.repositoryId, action: "disconnect" }),
                "destructive",
                "sm",
              ),
            ],
          }),
      },
    })
    return h.div(
      [h.Class("flex flex-col gap-6"), ...attributes],
      [...alerts, connection, danger, dialog],
    )
  }

  const visible = rows.filter((row) =>
    `${row.owner}/${row.repo}`.toLowerCase().includes(model.search.toLowerCase()),
  )
  const ownerHeading = (row: Row) =>
    h.div(
      [h.Class("flex h-10 items-center justify-between gap-3 bg-surface-muted px-4")],
      [
        h.h2([h.Class("min-w-0 truncate font-mono text-mono-sm font-medium")], [row.owner]),
        button(
          "Manage access",
          Message.ClickedGithub({ installationId: row.installationId }),
          "secondary",
          "sm",
        ),
      ],
    )
  const repositoryRow = (row: Row) =>
    h.div(
      [h.Class("flex min-h-12 items-center justify-between gap-4 px-4 py-2")],
      [
        h.div(
          [h.Class("flex min-w-0 flex-col gap-0.5")],
          [
            repositoryName(h, row.owner, row.repo, "truncate"),
            h.p(
              [h.Class("text-caption text-ink-subtle")],
              [
                `${row.isPrivate === null ? "Visibility unknown" : row.isPrivate ? "Private" : "Public"} · ${row.connected ? "Connected" : !hasAccess(row) ? "Access unavailable" : row.reconnect ? "Previously disconnected · reconnect fresh" : "Available"}`,
              ],
            ),
            row.accessError ? note(h, row.accessError) : h.empty,
          ],
        ),
        row.connected
          ? h.a(
              [
                h.Href(Routes.policies({ repositoryId: row.repositoryId })),
                h.Class("shrink-0 text-body-sm"),
              ],
              ["Open"],
            )
          : hasAccess(row)
            ? button(
                row.reconnect ? "Reconnect" : "Connect repository",
                Message.ClickedChange({ id: row.repositoryId, action: "connect" }),
                row.reconnect ? "secondary" : "default",
                "sm",
              )
            : button(
                "Repair access",
                Message.ClickedGithub({ installationId: row.installationId }),
                "secondary",
                "sm",
              ),
      ],
    )
  const list = h.div(
    [h.Class("flex flex-col divide-y divide-border-subtle")],
    [
      ...visible.flatMap((row, index) => [
        ...(index === 0 || visible[index - 1]?.owner !== row.owner ? [ownerHeading(row)] : []),
        repositoryRow(row),
      ]),
      loading ? mutedRow("Loading repositories…", [h.Role("status")]) : h.empty,
      rows.length > 0 && visible.length === 0
        ? mutedRow("No repositories match your search.")
        : h.empty,
      rows.length === 0 && Option.isSome(model.inventory)
        ? mutedRow(
            "No repositories are available yet. Grant access on GitHub, then refresh this list. Organization approval may be required.",
          )
        : h.empty,
    ],
  )
  const search = h.form(
    [h.Class("w-64"), h.OnSubmit(Message.Searched({ value: model.search }))],
    [
      inputGroup(h, {
        children: [
          inputGroupAddon(h, { children: [Icon.view(h, Search)] }),
          inputGroupInput(h, {
            id: "connection-search",
            type: "search",
            value: model.search,
            placeholder: "Find a repository…",
            ariaLabel: "Find a repository",
            onInput: (value) => Message.Searched({ value }),
          }),
        ],
      }),
    ],
  )
  return Page.layout(h, {
    attributes: [h.OnMount(Poll({ state: inputs.state, refresh: true }))],
    main: [
      Page.header(h, {
        title: "Connect a repository",
        lede: "Choose a repository already accessible to The Janitor, or grant access on GitHub.",
        actions: [refreshButton("Refresh", true)],
      }),
      ...alerts,
      panel(h, {
        flush: true,
        children: [
          panelHeader(h, {
            title: "Repositories",
            meta: `${rows.length} available`,
            actions: [search],
          }),
          list,
        ],
      }),
      h.div(
        [],
        [Button.view(h, { label: "Back", variant: "link", onClick: Message.ClickedCancel() })],
      ),
    ],
    inspector: [
      Page.inspectorCard(h, {
        heading: "GitHub access",
        className: "flex flex-col gap-3",
        children: [
          h.p(
            [h.Class("text-body-sm text-ink-muted")],
            [
              "Grant The Janitor access to more repositories on GitHub. Organization owners may need to approve the request.",
            ],
          ),
          h.div(
            [],
            [
              button(
                "Grant access on GitHub",
                Message.ClickedGithub({ installationId: null }),
                "default",
              ),
            ],
          ),
        ],
      }),
      model.notice
        ? Page.inspectorCard(h, {
            heading: "Status",
            children: [
              h.p([h.Role("status"), h.Class("text-body-sm text-ink-muted")], [model.notice]),
            ],
          })
        : h.empty,
    ],
  })
})

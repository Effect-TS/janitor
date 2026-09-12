import { ConnectionInventory as Inventory } from "@janitor/domain/GitHub/Connection"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import * as Mount from "foldkit/mount"
import * as Dialog from "@foldkit/ui/dialog"
import type * as Update from "foldkit/update"
import * as Submodel from "foldkit/submodel"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Button from "@/components/ui/button"
import { input } from "@/components/ui/input"
import * as Icon from "@/lib/icons"
import { FolderGit2 } from "lucide"
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
export const view = Submodel.defineView<
  Model,
  Message,
  { repositoryId: string | null; state: string }
>((model, inputs, h) => {
  const rows = Option.getOrElse(model.inventory, () => ({ repositories: [] })).repositories
  const current = rows.find((row) => row.repositoryId === inputs.repositoryId)
  const settings = inputs.repositoryId !== null
  const button = (
    label: string,
    onClick: Message,
    variant: "outline" | "default" | "destructive" = "outline",
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
      size: "sm",
      isDisabled: isBusy(model),
    })
  return h.section(
    [
      h.Class(
        settings ? "rounded-lg border p-5 space-y-4" : "mx-auto w-full max-w-2xl p-6 space-y-5",
      ),
      h.OnMount(Poll({ state: inputs.state, refresh: !settings })),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-3")],
        [
          Icon.view(h, FolderGit2, "size-6 text-muted-foreground"),
          h.h1(
            [h.Class("text-lg font-semibold")],
            [settings ? "Connection" : "Connect a repository"],
          ),
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
      Option.isNone(model.inventory) && Option.isNone(model.loadError)
        ? h.p([h.Role("status")], ["Loading repositories…"])
        : h.empty,
      settings && current
        ? h.div(
            [h.Class("space-y-4")],
            [
              h.p(
                [h.Class("text-sm")],
                [
                  `${current.owner}/${current.repo} · ${!current.connected ? "Disconnected" : current.access !== "accessible" || current.installationStatus !== "active" ? "Access lost" : !current.enabled ? "Paused" : current.syncState === "failed" ? "Automation blocked by synchronization failure" : current.syncState === "syncing" ? "Synchronizing before automation becomes ready…" : "Automation ready"}`,
                ],
              ),
              h.div(
                [h.Class("flex flex-wrap gap-2")],
                [
                  current.accessError
                    ? h.p(
                        [h.Role("status"), h.Class("text-sm text-muted-foreground")],
                        [current.accessError],
                      )
                    : h.empty,
                  current.connected && current.enabled && current.syncState === "failed"
                    ? button(
                        "Retry sync",
                        Message.ClickedChange({ id: current.repositoryId, action: "resume" }),
                      )
                    : h.empty,
                  current.connected && current.enabled && current.syncState === "failed"
                    ? h.p(
                        [h.Role("status"), h.Class("text-sm text-muted-foreground")],
                        [
                          `${current.syncError ?? "Synchronization could not complete."} Automatic retries continue. Retry sync to refresh facts now. Recovery waits for new webhook events before labeling.`,
                        ],
                      )
                    : h.empty,
                  h.p(
                    [h.Class("text-sm text-muted-foreground")],
                    [
                      "Pausing stops automation and synchronization. Configuration, stored facts and GitHub labels are kept.",
                    ],
                  ),
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
                  button(
                    "Manage GitHub access",
                    Message.ClickedGithub({ installationId: current.installationId }),
                  ),
                  current.connected
                    ? button("Disconnect repository", Message.ClickedDisconnect(), "destructive")
                    : h.empty,
                ],
              ),
              !current.enabled && current.reconnect
                ? h.p(
                    [h.Class("text-sm text-muted-foreground")],
                    [
                      "Pausing retains your configuration and stored data. Resume to synchronize before automation runs.",
                    ],
                  )
                : h.empty,
              h.submodel({
                slotId: "disconnect-dialog",
                model: model.dialog,
                view: Dialog.view,
                toParentMessage: (message) => Message.GotDialogMessage({ message }),
                viewInputs: {
                  toView: (render) =>
                    h.dialog(
                      [
                        ...render.dialog,
                        h.Class(
                          "fixed inset-0 m-0 h-dvh w-screen max-h-none max-w-none bg-transparent p-0 text-foreground",
                        ),
                      ],
                      render.isVisible
                        ? [
                            h.div([...render.backdrop, h.Class("fixed inset-0 bg-black/40")], []),
                            h.div(
                              [
                                ...render.panel,
                                h.Class(
                                  "relative mx-auto mt-[20vh] w-[calc(100%-2rem)] max-w-md rounded-xl border bg-background p-5 shadow-xl space-y-4",
                                ),
                              ],
                              [
                                h.h2(
                                  [...render.title, h.Class("font-semibold")],
                                  [`Disconnect ${current.owner}/${current.repo}?`],
                                ),
                                h.p(
                                  [...render.description, h.Class("text-sm text-muted-foreground")],
                                  [
                                    `Disconnect permanently deletes all policies, drafts, published history, labeling rules and groups, stored facts, event history and cached evaluations. GitHub labels stay unchanged. Reconnecting starts empty and requires synchronization. Pause and access loss retain your configuration.`,
                                  ],
                                ),
                                Option.isSome(model.error)
                                  ? h.p(
                                      [h.Role("alert"), h.Class("text-sm text-destructive")],
                                      [model.error.value],
                                    )
                                  : h.empty,
                                h.div(
                                  [h.Class("flex justify-end gap-2")],
                                  [
                                    Button.view(h, {
                                      label: "Cancel",
                                      variant: "outline",
                                      size: "sm",
                                      attributes: [h.Id("cancel-disconnect")],
                                      onClick: Message.CancelledDisconnect(),
                                      isDisabled: isBusy(model),
                                    }),
                                    button(
                                      "Disconnect repository",
                                      Message.ClickedChange({
                                        id: current.repositoryId,
                                        action: "disconnect",
                                      }),
                                      "destructive",
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ]
                        : [],
                    ),
                },
              }),
            ],
          )
        : !settings
          ? h.div(
              [h.Class("space-y-4")],
              [
                h.p(
                  [h.Class("text-sm text-muted-foreground")],
                  ["Choose a repository already accessible to Janitor, or grant access on GitHub."],
                ),
                input(h, {
                  id: "connection-search",
                  label: "Find a repository",
                  labelClass: "sr-only",
                  value: model.search,
                  onInput: (value) => Message.Searched({ value }),
                  placeholder: "Find a repository…",
                }),
                h.div(
                  [h.Class("divide-y rounded-lg border")],
                  rows
                    .filter((row) =>
                      `${row.owner}/${row.repo}`.toLowerCase().includes(model.search.toLowerCase()),
                    )
                    .flatMap((row, index, visible) => [
                      ...(index === 0 || visible[index - 1]?.owner !== row.owner
                        ? [
                            h.div(
                              [
                                h.Class(
                                  "bg-muted/40 px-3 py-2 flex items-center justify-between gap-3",
                                ),
                              ],
                              [
                                h.h2(
                                  [h.Class("text-xs font-medium text-muted-foreground")],
                                  [row.owner],
                                ),
                                button(
                                  "Manage access",
                                  Message.ClickedGithub({ installationId: row.installationId }),
                                ),
                              ],
                            ),
                          ]
                        : []),
                      h.div(
                        [h.Class("flex items-center justify-between gap-3 p-3")],
                        [
                          h.div(
                            [h.Class("min-w-0")],
                            [
                              h.p(
                                [h.Class("text-sm font-medium truncate")],
                                [`${row.owner}/${row.repo}`],
                              ),
                              row.accessError
                                ? h.p([h.Class("text-xs text-muted-foreground")], [row.accessError])
                                : h.empty,
                              h.p(
                                [h.Class("text-xs text-muted-foreground")],
                                [
                                  `${row.isPrivate === null ? "Visibility unknown" : row.isPrivate ? "Private" : "Public"} · ${row.connected ? "Connected" : row.access !== "accessible" || row.installationStatus !== "active" ? "Access unavailable" : row.reconnect ? "Previously disconnected · reconnect fresh" : "Available"}`,
                                ],
                              ),
                            ],
                          ),
                          row.connected
                            ? h.a(
                                [
                                  h.Href(Routes.policies({ repositoryId: row.repositoryId })),
                                  h.Class("text-sm underline"),
                                ],
                                ["Open"],
                              )
                            : row.access === "accessible" && row.installationStatus === "active"
                              ? button(
                                  row.reconnect ? "Reconnect" : "Connect repository",
                                  Message.ClickedChange({
                                    id: row.repositoryId,
                                    action: "connect",
                                  }),
                                  "default",
                                )
                              : button(
                                  "Repair access",
                                  Message.ClickedGithub({ installationId: row.installationId }),
                                ),
                        ],
                      ),
                    ]),
                ),
                rows.length > 0 &&
                !rows.some((row) =>
                  `${row.owner}/${row.repo}`.toLowerCase().includes(model.search.toLowerCase()),
                )
                  ? h.p(
                      [h.Class("text-sm text-muted-foreground")],
                      ["No repositories match your search."],
                    )
                  : h.empty,
                rows.length === 0 && Option.isSome(model.inventory)
                  ? h.p(
                      [h.Class("text-sm text-muted-foreground")],
                      [
                        "No repositories are available yet. Grant access on GitHub, then refresh this list. Organization approval may be required.",
                      ],
                    )
                  : h.empty,
                h.div(
                  [h.Class("flex flex-wrap items-center gap-3")],
                  [
                    button(
                      "Grant access on GitHub",
                      Message.ClickedGithub({ installationId: null }),
                      "default",
                    ),
                    Button.view(h, {
                      label: "Cancel",
                      variant: "link",
                      className: "px-0 text-sm underline",
                      onClick: Message.ClickedCancel(),
                    }),
                  ],
                ),
              ],
            )
          : h.empty,
      button(
        isBusy(model) ? "Updating repositories…" : "Refresh repositories",
        Message.ClickedRefresh(),
      ),
    ],
  )
})

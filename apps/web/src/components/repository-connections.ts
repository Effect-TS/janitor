import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
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
import * as Routes from "@/routes"

const Candidate = Schema.Struct({
  repositoryId: Schema.String,
  installationId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  isPrivate: Schema.NullOr(Schema.Boolean),
  connected: Schema.Boolean,
  enabled: Schema.Boolean,
  reconnect: Schema.Boolean,
  access: Schema.String,
  installationStatus: Schema.String,
  policyCount: Schema.Int,
  ruleCount: Schema.Int,
  syncState: Schema.String,
})
const Inventory = Schema.Struct({ repositories: Schema.Array(Candidate) })
export const Model = Schema.Struct({
  inventory: Schema.Option(Inventory),
  error: Schema.Option(Schema.String),
  loadError: Schema.Option(Schema.String),
  search: Schema.String,
  busy: Schema.Boolean,
  dialog: Dialog.Model,
  notice: Schema.String,
})
export type Model = typeof Model.Type
export const init = (): Model => ({
  inventory: Option.none(),
  error: Option.none(),
  loadError: Option.none(),
  search: "",
  busy: false,
  dialog: Dialog.init({ id: "disconnect-repository", focusSelector: "#cancel-disconnect" }),
  notice: "",
})
export const Message = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  LoadRequested: { state: Schema.String },
  Loaded: { inventory: Inventory },
  LoadFailed: { reason: Schema.String },
  Failed: { reason: Schema.String },
  Searched: { value: Schema.String },
  ClickedRefresh: {},
  ClickedChange: {
    id: Schema.String,
    action: Schema.Literals(["connect", "disconnect", "resume", "pause"]),
  },
  Changed: { id: Schema.String, action: Schema.String },
  ClickedGithub: { installationId: Schema.NullOr(Schema.String) },
  GotGithub: { url: Schema.String },
  ClickedDisconnect: {},
  CancelledDisconnect: {},
  Refreshed: {},
})
export type Message = typeof Message.Type
export const OutMessage = defineMessageUnion({
  Changed: { id: Schema.String, action: Schema.String },
  OpenGithub: { url: Schema.String },
})
const base = "/api/v1/repository-connections"
const request = (method: "POST" | "PUT" | "DELETE" | "PATCH", url: string, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const req = yield* HttpClientRequest.make(method)(url).pipe(HttpClientRequest.bodyJson(body))
    const response = yield* client.execute(req)
    if (response.status >= 400) {
      const data = yield* HttpIncomingMessage.schemaBodyJson(
        Schema.Struct({ message: Schema.String }),
      )(response)
      return yield* Effect.fail(new Error(data.message))
    }
    return response
  })
const failed = (error: unknown) =>
  Message.Failed({
    reason: error instanceof Error ? error.message : "The request failed. Please retry.",
  })
const load = HttpClient.get(`${base}/available`).pipe(
  Effect.flatMap((response) =>
    response.status === 200
      ? HttpIncomingMessage.schemaBodyJson(Inventory)(response)
      : Effect.fail(new Error("Could not load repositories. Retry to continue.")),
  ),
  Effect.map((inventory) => Message.Loaded({ inventory })),
  Effect.catch((error) => Effect.succeed(Message.LoadFailed({ reason: failed(error).reason }))),
)
export const Load = Command.define("LoadConnectionInventory", {
  args: { state: Schema.String },
  messages: [Message.Loaded, Message.LoadFailed, Message.Failed],
  execute: ({ state }) =>
    state
      ? request("POST", `${base}/return`, { state }).pipe(
          Effect.flatMap(() => load),
          Effect.catch((error) => Effect.succeed(failed(error))),
        )
      : load,
})
export const Poll = Mount.defineStream("PollRepositoryConnections", {
  args: { state: Schema.String },
  messages: [Message.LoadRequested],
  execute: ({ state }) =>
    Stream.make(Message.LoadRequested({ state })).pipe(
      Stream.concat(
        Stream.tick("3 seconds").pipe(
          Stream.take(40),
          Stream.map(() => Message.LoadRequested({ state: "" })),
        ),
      ),
    ),
})
const Refresh = Command.define("RefreshConnectionInventory", {
  args: {},
  messages: [Message.Refreshed, Message.Failed],
  execute: () =>
    request("POST", `${base}/refresh`, {}).pipe(
      Effect.as(Message.Refreshed()),
      Effect.catch((error) => Effect.succeed(failed(error))),
    ),
})
const Change = Command.define("ChangeRepositoryConnection", {
  args: { id: Schema.String, action: Schema.String },
  messages: [Message.Changed, Message.Failed],
  execute: ({ id, action }) =>
    request(
      action === "connect" ? "PUT" : action === "disconnect" ? "DELETE" : "PATCH",
      `/api/v1/repositories/${encodeURIComponent(id)}/connection`,
      { enabled: action === "resume" },
    ).pipe(
      Effect.as(Message.Changed({ id, action })),
      Effect.catch((error) => Effect.succeed(failed(error))),
    ),
})
const Github = Command.define("OpenGitHubInstallation", {
  args: { installationId: Schema.NullOr(Schema.String) },
  messages: [Message.GotGithub, Message.Failed],
  execute: ({ installationId }) =>
    request("POST", `${base}/github`, { installationId }).pipe(
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Schema.Struct({ url: Schema.String }))),
      Effect.map(({ url }) => Message.GotGithub({ url })),
      Effect.catch((error) => Effect.succeed(failed(error))),
    ),
})
const mapDialog = (model: Model, result: ReturnType<typeof Dialog.open>) => ({
  model: evo(model, { dialog: () => result.model }),
  commands: Command.mapMessages(result.commands, (message) =>
    Message.GotDialogMessage({ message }),
  ),
})
export const update = (model: Model, message: Message) =>
  Message.match<
    Update.ReturnWithOutMessage<Model, Message, typeof OutMessage.Type, HttpClient.HttpClient>
  >(message, {
    GotDialogMessage: ({ message }) =>
      model.busy ? { model } : mapDialog(model, Dialog.update(model.dialog, message)),
    LoadRequested: ({ state }) => ({ model, commands: [Load({ state })] }),
    Loaded: ({ inventory }) => ({
      model: evo(model, {
        inventory: () => Option.some(inventory),
        loadError: () => Option.none(),
      }),
    }),
    LoadFailed: ({ reason }) => ({ model: evo(model, { loadError: () => Option.some(reason) }) }),
    Failed: ({ reason }) => ({
      model: evo(model, { busy: () => false, error: () => Option.some(reason) }),
    }),
    Searched: ({ value }) => ({ model: evo(model, { search: () => value }) }),
    ClickedRefresh: () => ({
      model: evo(model, { busy: () => true, error: () => Option.none() }),
      commands: [Refresh({})],
    }),
    Refreshed: () => ({
      commands: [Load({ state: "" })],
      model: evo(model, {
        busy: () => false,
        notice: () => "Refreshing GitHub access. Available repositories will update shortly.",
      }),
    }),
    ClickedChange: ({ id, action }) =>
      model.busy
        ? { model }
        : {
            model: evo(model, { busy: () => true, error: () => Option.none() }),
            commands: [Change({ id, action })],
          },
    Changed: ({ id, action }) => ({
      model: init(),
      commands: [Load({ state: "" })],
      outMessage: OutMessage.Changed({ id, action }),
    }),
    ClickedGithub: ({ installationId }) => ({
      model: evo(model, { busy: () => true, error: () => Option.none() }),
      commands: [Github({ installationId })],
    }),
    GotGithub: ({ url }) => ({
      model: evo(model, { busy: () => false }),
      outMessage: OutMessage.OpenGithub({ url }),
    }),
    ClickedDisconnect: () => mapDialog(model, Dialog.open(model.dialog)),
    CancelledDisconnect: () => mapDialog(model, Dialog.close(model.dialog)),
  })
export const view = Submodel.defineView<
  Model,
  Message,
  { repositoryId: string | null; state: string; cancelPath: string }
>((model, inputs, h) => {
  const rows = Option.getOrElse(model.inventory, () => ({ repositories: [] })).repositories
  const current = rows.find((row) => row.repositoryId === inputs.repositoryId)
  const settings = inputs.repositoryId !== null
  const button = (
    label: string,
    onClick: Message,
    variant: "outline" | "default" | "destructive" = "outline",
  ) => Button.view(h, { label, onClick, variant, size: "sm", isDisabled: model.busy })
  return h.section(
    [
      h.Class(
        settings ? "rounded-lg border p-5 space-y-4" : "mx-auto w-full max-w-2xl p-6 space-y-5",
      ),
      h.OnMount(Poll({ state: inputs.state })),
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
                  `${current.owner}/${current.repo} · ${!current.connected ? "Disconnected" : current.access !== "accessible" || current.installationStatus !== "active" ? "Access lost" : !current.enabled ? "Paused" : current.syncState === "paused" ? "GitHub sync paused" : current.syncState === "failed" ? "Sync failed" : current.syncState === "syncing" ? "Syncing repository…" : "Connected"}`,
                ],
              ),
              h.div(
                [h.Class("flex flex-wrap gap-2")],
                [
                  current.connected && current.enabled && current.syncState === "failed"
                    ? button(
                        "Retry sync",
                        Message.ClickedChange({ id: current.repositoryId, action: "resume" }),
                      )
                    : h.empty,
                  current.connected
                    ? button(
                        current.enabled ? "Pause automation" : "Resume automation",
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
                      "Your policies and rules are retained. Review them before resuming automation.",
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
                                    `Janitor will stop syncing and applying ${current.ruleCount} enabled rules. GitHub labels stay unchanged. Policies, rules and history are kept for reconnection.`,
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
                                      isDisabled: model.busy,
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
                              h.p(
                                [h.Class("text-xs text-muted-foreground")],
                                [
                                  `${row.isPrivate === null ? "Visibility unknown" : row.isPrivate ? "Private" : "Public"} · ${row.connected ? "Connected" : row.access !== "accessible" || row.installationStatus !== "active" ? "Access unavailable" : row.reconnect ? "Saved configuration · reconnect paused" : "Available"}`,
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
                    h.a([h.Href(inputs.cancelPath), h.Class("text-sm underline")], ["Cancel"]),
                  ],
                ),
              ],
            )
          : h.empty,
      button(model.notice ? "Refresh again" : "Refresh repositories", Message.ClickedRefresh()),
    ],
  )
})

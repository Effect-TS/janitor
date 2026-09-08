import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Mount from "foldkit/mount"
import * as Command from "foldkit/command"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import { FactDescription } from "@/components/labeling-wire"
import { parse } from "./format"

export { parse } from "./format"

/**
 * The policy source editor as a Submodel. CodeMirror owns the DOM inside
 * one element mounted through Foldkit's mount seam; every document change
 * flows back as a Message, so the Model always holds the current source.
 */

// MODEL

export const MountStatus = Schema.Literals(["Mounting", "Ready", "Failed"])

const ReferencePolicy = Schema.Struct({ name: Schema.String, target: Schema.String })

export const Model = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  /** A YAML parse error, if the source is not a mapping right now. */
  maybeParseError: Schema.Option(Schema.String),
  mountStatus: MountStatus,
  catalog: Schema.Array(FactDescription),
  referencePolicies: Schema.Array(ReferencePolicy),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedFormat: {},
  CompletedFormat: {},
  FailedFormat: { reason: Schema.String },
  MountedEditor: {},
  FailedToMountEditor: { reason: Schema.String },
  EditedSource: { source: Schema.String },
})
export type Message = typeof Message.Type

export const FormatEditor = Command.define("FormatPolicyYaml", {
  args: { id: Schema.String },
  messages: [Message.CompletedFormat, Message.FailedFormat],
  execute: ({ id }) =>
    Effect.tryPromise({
      try: async () => {
        const { formatEditor } = await import("./editor")
        formatEditor(id)
        return Message.CompletedFormat()
      },
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(Effect.catch((reason) => Effect.succeed(Message.FailedFormat({ reason })))),
})

// MOUNT

export const MountPolicySourceEditor = Mount.defineStream("MountPolicySourceEditor", {
  args: {
    id: Schema.String,
    initialSource: Schema.String,
    catalog: Schema.Array(FactDescription),
    referencePolicies: Schema.Array(ReferencePolicy),
  },
  messages: [Message.MountedEditor, Message.FailedToMountEditor, Message.EditedSource],
  execute: ({ element, initialSource, catalog, referencePolicies }) =>
    Stream.callback((queue) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            if (!(element instanceof HTMLElement)) {
              throw new Error("The policy editor host must be an HTMLElement")
            }
            const { createPolicySourceEditor } = await import("./editor")
            const editor = createPolicySourceEditor({
              element,
              initialSource,
              context: {
                catalog,
                referencePolicies,
              },
              onChange: (source) => {
                Queue.offerUnsafe(queue, Message.EditedSource({ source }))
              },
            })
            Queue.offerUnsafe(queue, Message.MountedEditor())
            return editor
          },
          catch: (error) =>
            error instanceof Error ? error.message : "The policy editor failed to mount",
        }),
        (editor) => Effect.sync(() => editor.destroy()),
      ).pipe(
        Effect.flatMap(() => Effect.never),
        Effect.catch((reason) =>
          Effect.sync(() => {
            Queue.offerUnsafe(queue, Message.FailedToMountEditor({ reason }))
          }),
        ),
      ),
    ),
})

// INIT

export const init = (input: {
  readonly id: string
  readonly source: string
  readonly catalog: ReadonlyArray<FactDescription>
  readonly referencePolicies: ReadonlyArray<typeof ReferencePolicy.Type>
}): Model =>
  Model.make(
    {
      id: input.id,
      source: input.source,
      maybeParseError: parseError(input.source),
      mountStatus: "Mounting",
      catalog: input.catalog,
      referencePolicies: input.referencePolicies,
    },
    { disableChecks: true },
  )

export const parseError = (source: string): Option.Option<string> =>
  Result.getFailure(parse(source))

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    CompletedFormat: () => ({ model }),
    ClickedFormat: () =>
      model.mountStatus === "Ready" && Option.isNone(model.maybeParseError)
        ? { model, commands: [FormatEditor({ id: model.id })] }
        : { model },
    FailedFormat: ({ reason }) => ({
      model: evo(model, { maybeParseError: () => Option.some(reason) }),
    }),
    MountedEditor: () => ({ model: evo(model, { mountStatus: () => "Ready" as const }) }),
    FailedToMountEditor: ({ reason }) => ({
      model: evo(model, {
        mountStatus: () => "Failed" as const,
        maybeParseError: () => Option.some(reason),
      }),
    }),
    EditedSource: ({ source }) => ({
      model: evo(model, { source: () => source, maybeParseError: () => parseError(source) }),
    }),
  })

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.div(
    [
      h.Id(model.id),
      h.Class(
        "overflow-hidden rounded-md border bg-background transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
      ),
      h.OnMount(
        MountPolicySourceEditor({
          id: model.id,
          initialSource: model.source,
          catalog: model.catalog,
          referencePolicies: model.referencePolicies,
        }),
      ),
    ],
    [],
  ),
)

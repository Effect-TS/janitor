import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Result from "effect/Result"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as FoldkitCommand from "foldkit/command"
import * as Mount from "foldkit/mount"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import * as Disclosure from "@foldkit/ui/disclosure"
import * as Menu from "@foldkit/ui/menu"
import * as Icon from "@/lib/icons"
import {
  X,
  Upload,
  Save,
  ChevronRight,
  CodeXml,
  Pencil,
  Ellipsis,
  Trash2,
  CircleCheck,
  CircleAlert,
  CircleHelp,
  LoaderCircle,
} from "lucide"
import { input } from "@/components/ui/input"
import * as PolicySource from "@/components/policy-source"
import * as TestBench from "@/components/test-bench"
import * as Routes from "@/routes"
import * as PolicyStatus from "@/components/policy-status"
import {
  ConfigurationView,
  TestCandidates,
  FactDescription,
  labelName,
  formatSource,
  Manifest,
  PolicyDetail,
  policiesEndpoint,
  policyEndpoint,
  ProgramSource,
  publishEndpoint,
  validateEndpoint,
  ValidatePolicyResponse,
} from "@/components/labeling-wire"

/**
 * The policy editor (plan: "User interface"). Name, description, and the
 * source editor. Validate asks the server to compile the draft and shows
 * the manifest. Save keeps a draft; Publish saves then publishes.
 */

// MODEL

export const ActionsMenu = Menu.create<"Close editor" | "Delete policy" | "Confirm delete">()

export const Identity = Schema.Union([
  Schema.TaggedStruct("New", {}),
  Schema.TaggedStruct("Existing", { policyId: Schema.String, version: Schema.Int }),
])
export type Identity = typeof Identity.Type

export const Validation = Schema.Union([
  Schema.TaggedStruct("NotValidated", {}),
  Schema.TaggedStruct("Validating", { requestId: Schema.Int }),
  Schema.TaggedStruct("Valid", { manifest: Manifest }),
  Schema.TaggedStruct("Invalid", { message: Schema.String }),
])
export type Validation = typeof Validation.Type

export const Submission = Schema.Union([
  Schema.TaggedStruct("NotSubmitted", {}),
  Schema.TaggedStruct("Submitting", {
    publish: Schema.Boolean,
    name: Schema.String,
    description: Schema.String,
    sourceText: Schema.String,
  }),
  Schema.TaggedStruct("Conflicted", {}),
  Schema.TaggedStruct("SubmitError", {
    message: Schema.String,
    draftSaved: Schema.optionalKey(Schema.Boolean),
  }),
])
export type Submission = typeof Submission.Type

const SavedFields = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  sourceText: Schema.String,
})

export const Model = Schema.Struct({
  actionsMenu: Menu.Model,
  repositoryId: Schema.String,
  configuration: ConfigurationView,
  maybeTestBench: Schema.Option(TestBench.Model),
  testGeneration: Schema.Int,
  identity: Identity,
  name: Schema.String,
  description: Schema.String,
  source: PolicySource.Model,
  metadataEdits: Schema.Struct({
    name: Schema.NullOr(Schema.String),
    description: Schema.NullOr(Schema.String),
  }),
  validation: Validation,
  validationRequestId: Schema.Int,
  submission: Submission,
  savedFields: SavedFields,
  hasBeenPublished: Schema.Boolean,
  publishedRevision: Schema.NullOr(Schema.Int),
  publishedSource: Schema.Option(ProgramSource),
  usedByOpen: Schema.Boolean,
  testCandidates: TestCandidates,
  testNumber: Schema.NullOr(Schema.Int),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  FocusedMetadataInput: {},
  GotActionsMenuMessage: { message: Menu.Message },
  ClickedEditMetadata: { field: Schema.Literals(["name", "description"]) },
  UpdatedMetadataDraft: { field: Schema.Literals(["name", "description"]), value: Schema.String },
  ClickedSaveMetadata: { field: Schema.Literals(["name", "description"]) },
  ClickedCancelMetadata: { field: Schema.Literals(["name", "description"]) },
  SelectedTestItem: { number: Schema.Int },
  ToggledUsedBy: { isOpen: Schema.Boolean },
  UpdatedName: { value: Schema.String },
  UpdatedDescription: { value: Schema.String },
  GotSourceMessage: { message: PolicySource.Message },
  ClickedValidate: {},
  ClickedTestDraft: {},
  GotTestBenchMessage: { message: TestBench.Message, generation: Schema.Int },
  CompletedValidate: { response: ValidatePolicyResponse, requestId: Schema.Int },
  FailedValidate: { reason: Schema.String, requestId: Schema.Int },
  ClickedSave: {},
  ClickedPublish: {},
  SucceededSavePolicy: { detail: PolicyDetail, published: Schema.Boolean },
  SavedDraftWithPublishError: { detail: PolicyDetail, reason: Schema.String },
  ConflictedSavePolicy: { detail: PolicyDetail },
  RejectedSavePolicy: { message: Schema.String },
  FailedSavePolicy: { reason: Schema.String },
  ClickedCancel: {},
})
export type Message = typeof Message.Type

export const FocusMetadataInput = Mount.define("FocusPolicyMetadataInput", {
  messages: [Message.FocusedMetadataInput],
  execute: ({ element }) =>
    Effect.sync(() => {
      if (element instanceof HTMLInputElement) element.focus()
      return Message.FocusedMetadataInput()
    }),
})

export const OutMessage = defineMessageUnion({
  RequestedDelete: { policyId: Schema.String, version: Schema.Int },
  Saved: { detail: PolicyDetail, published: Schema.Boolean },
  Cancelled: {},
  SaveFailed: { reason: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// DOMAIN

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(
        ([key, entry]) =>
          !(
            (key === "caseSensitive" && entry === false && "fact" in value) ||
            (key === "minimumConfidence" &&
              entry === 0.8 &&
              "prompt" in value &&
              "evidence" in value)
          ),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

const publishedSourceOf = (detail: PolicyDetail): Option.Option<ProgramSource> =>
  Option.fromNullishOr(detail.publishedSource ?? (!detail.draftDiffers ? detail.draft : null))

export const hasChangesToPublish = (model: Model): boolean =>
  Option.exists(
    parsedSource(model),
    (source) =>
      !model.hasBeenPublished ||
      Option.match(model.publishedSource, {
        onNone: () => true,
        onSome: (published) => canonical(source) !== canonical(published),
      }),
  )

export const testItems = (model: Model) =>
  model.testCandidates._tag === "Ready"
    ? model.testCandidates.items.filter((item) =>
        Option.exists(parsedSource(model), (source) => source.target === item.kind),
      )
    : []

export const selectedTestItem = (model: Model) => {
  const items = testItems(model)
  return items.find((item) => item.number === model.testNumber) ?? items[0]
}

export const withTestCandidates = (model: Model, candidates: TestCandidates): Model => {
  const next = evo(model, { testCandidates: () => candidates })
  return selectedTestItem(model)?.number === selectedTestItem(next)?.number
    ? next
    : evo(next, {
        testNumber: () => selectedTestItem(next)?.number ?? null,
        maybeTestBench: () => Option.none(),
        testGeneration: (current) => current + 1,
      })
}

export const isDirty = (model: Model): boolean =>
  model.name !== model.savedFields.name ||
  model.description !== model.savedFields.description ||
  model.source.source !== model.savedFields.sourceText

export const hasUnsavedInput = (model: Model): boolean =>
  isDirty(model) ||
  (model.metadataEdits.name !== null && model.metadataEdits.name !== model.name) ||
  (model.metadataEdits.description !== null &&
    model.metadataEdits.description !== model.description)

export const publicationStatus = (model: Model): PolicyStatus.Publication => ({
  published: model.hasBeenPublished,
  revision: model.publishedRevision,
  // Invalid edited YAML must never imply that the editor matches the published program.
  changes: Option.isNone(parsedSource(model)) || hasChangesToPublish(model),
})

export const saveStatus = (model: Model): string => {
  if (model.submission._tag === "Submitting")
    return model.submission.publish ? "Saving and publishing…" : "Saving…"
  if (model.submission._tag === "Conflicted") return "Save conflict"
  if (model.submission._tag === "SubmitError" && !model.submission.draftSaved) return "Save failed"
  if (model.identity._tag === "New") return "Not saved yet"
  return hasUnsavedInput(model) ? "Unsaved changes" : "Saved"
}

const savedFields = (model: Model, detail: PolicyDetail): typeof SavedFields.Type => ({
  name: detail.policy.name,
  description: detail.policy.description,
  sourceText:
    model.submission._tag === "Submitting"
      ? model.submission.sourceText
      : formatSource(detail.draft),
})

/** The source parsed as the authoring shape, when it parses at all. */
export const parsedSource = (model: Model): Option.Option<ProgramSource> =>
  PolicySource.parse(model.source.source).pipe(
    Result.getSuccess,
    Option.flatMap(Schema.decodeUnknownOption(ProgramSource, { onExcessProperty: "error" })),
  )

export const draftIssues = (model: Model): ReadonlyArray<string> => [
  ...(model.name.trim().length === 0 ? ["Name is required"] : []),
  ...Option.match(model.source.maybeParseError, {
    onNone: () =>
      Option.match(parsedSource(model), {
        onNone: () => [
          "Use target, optional appliesWhen, and exactly one of matchesWhen or classify. Remove any unrecognized keys.",
        ],
        onSome: (source) =>
          (source.matchesWhen === undefined) === (source.classify === undefined)
            ? ["The program needs exactly one of matchesWhen or classify"]
            : [],
      }),
    onSome: (message) => [message],
  }),
]

const isSubmitting = (model: Model) => model.submission._tag === "Submitting"

// COMMAND

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

const MessageBody = Schema.Struct({ message: Schema.String })

export const ValidateDraft = FoldkitCommand.define("ValidateDraft", {
  args: {
    repositoryId: Schema.String,
    source: ProgramSource,
    requestId: Schema.Int,
    policyId: Schema.optionalKey(Schema.String),
  },
  messages: [Message.CompletedValidate, Message.FailedValidate],
  execute: ({ repositoryId, source, requestId, policyId }) =>
    HttpClientRequest.post(validateEndpoint(repositoryId)).pipe(
      HttpClientRequest.bodyJson({ source, ...(policyId === undefined ? {} : { policyId }) }),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(ValidatePolicyResponse)),
      Effect.map((response) => Message.CompletedValidate({ response, requestId })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedValidate({ reason: describe(error), requestId })),
      ),
    ),
})

const SavePayload = Schema.Struct({
  repositoryId: Schema.String,
  identity: Identity,
  name: Schema.String,
  description: Schema.String,
  source: ProgramSource,
  publish: Schema.Boolean,
})

/** Creates or saves the draft, then publishes when asked. Each answer is one Message. */
export const SavePolicy = FoldkitCommand.define("SavePolicy", {
  args: SavePayload.fields,
  messages: [
    Message.SucceededSavePolicy,
    Message.SavedDraftWithPublishError,
    Message.ConflictedSavePolicy,
    Message.RejectedSavePolicy,
    Message.FailedSavePolicy,
  ],
  execute: ({ repositoryId, identity, name, description, source, publish }) =>
    Effect.gen(function* () {
      const request =
        identity._tag === "New"
          ? HttpClientRequest.post(policiesEndpoint(repositoryId)).pipe(
              HttpClientRequest.bodyJson({ name, description, source }),
            )
          : HttpClientRequest.put(policyEndpoint(repositoryId, identity.policyId)).pipe(
              HttpClientRequest.bodyJson({ version: identity.version, name, description, source }),
            )
      const saved = yield* Effect.flatMap(request, HttpClient.execute)
      switch (saved.status) {
        case 200:
        case 201:
          break
        case 409: {
          const conflict = yield* HttpIncomingMessage.schemaBodyJson(
            Schema.Union([PolicyDetail, MessageBody]),
          )(saved)
          return "policy" in conflict
            ? Message.ConflictedSavePolicy({ detail: conflict })
            : Message.RejectedSavePolicy({ message: conflict.message })
        }
        case 422: {
          const { message } = yield* HttpIncomingMessage.schemaBodyJson(MessageBody)(saved)
          return Message.RejectedSavePolicy({ message })
        }
        default:
          return Message.FailedSavePolicy({ reason: `Server answered ${saved.status}` })
      }
      const detail = yield* HttpIncomingMessage.schemaBodyJson(PolicyDetail)(saved)
      if (!publish) return Message.SucceededSavePolicy({ detail, published: false })
      return yield* Effect.gen(function* () {
        const published = yield* HttpClientRequest.post(
          publishEndpoint(repositoryId, detail.policy.policyId),
        ).pipe(
          HttpClientRequest.bodyJson({ version: detail.policy.version }),
          Effect.flatMap(HttpClient.execute),
        )
        if (published.status === 200) {
          return Message.SucceededSavePolicy({
            detail: yield* HttpIncomingMessage.schemaBodyJson(PolicyDetail)(published),
            published: true,
          })
        }
        const reason =
          published.status === 422
            ? (yield* HttpIncomingMessage.schemaBodyJson(MessageBody)(published)).message
            : `Publish answered ${published.status}`
        return Message.SavedDraftWithPublishError({ detail, reason })
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(Message.SavedDraftWithPublishError({ detail, reason: describe(error) })),
        ),
      )
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedSavePolicy({ reason: describe(error) })),
      ),
    ),
})

// INIT

export type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  HttpClient.HttpClient
>

export interface InitInput {
  readonly configuration: ConfigurationView
  readonly repositoryId: string
  readonly catalog: ReadonlyArray<FactDescription>
  readonly existing: Option.Option<PolicyDetail>
  readonly testCandidates?: TestCandidates | undefined
}

const starter: ProgramSource = {
  target: "pull_request",
  matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
}

export const init = ({
  repositoryId,
  configuration,
  catalog,
  existing,
  testCandidates,
}: InitInput): Model =>
  Model.make(
    {
      repositoryId,
      actionsMenu: Menu.init({ id: "policy-actions-menu" }),
      testCandidates: testCandidates ?? { _tag: "Ready", items: [] },
      testNumber: null,
      configuration,
      publishedSource: Option.flatMap(existing, publishedSourceOf),
      publishedRevision: Option.match(existing, {
        onNone: () => null,
        onSome: (detail) => detail.policy.publishedRevision,
      }),
      usedByOpen: false,
      hasBeenPublished: Option.exists(
        existing,
        (detail) => detail.policy.publishedVersionId !== null,
      ),
      savedFields: Option.match(existing, {
        onNone: () => ({ name: "", description: "", sourceText: formatSource(starter) }),
        onSome: (detail) => ({
          name: detail.policy.name,
          description: detail.policy.description,
          sourceText: formatSource(detail.draft),
        }),
      }),
      maybeTestBench: Option.none(),
      metadataEdits: { name: null, description: null },
      testGeneration: 0,
      identity: Option.match(existing, {
        onNone: () => ({ _tag: "New" as const }),
        onSome: (detail) => ({
          _tag: "Existing" as const,
          policyId: detail.policy.policyId,
          version: detail.policy.version,
        }),
      }),
      name: Option.map(existing, (detail) => detail.policy.name).pipe(Option.getOrElse(() => "")),
      description: Option.map(existing, (detail) => detail.policy.description).pipe(
        Option.getOrElse(() => ""),
      ),
      source: PolicySource.init({
        id: "policy-source",
        source: formatSource(
          Option.map(existing, (detail) => detail.draft).pipe(Option.getOrElse(() => starter)),
        ),
        catalog,
        referencePolicies: configuration.policies
          .filter(
            (policy) =>
              policy.publishedVersionId !== null &&
              policy.publishedEvaluator === "Conditions" &&
              !Option.exists(existing, (detail) => detail.policy.policyId === policy.policyId),
          )
          .map((policy) => ({ name: policy.name, target: policy.target })),
      }),
      validation: { _tag: "NotValidated" },
      validationRequestId: 0,
      submission: { _tag: "NotSubmitted" },
    },
    { disableChecks: true },
  )

// UPDATE

const foldSource = Update.foldChild({
  update: PolicySource.update,
  read: (model: Model) => Option.some(model.source),
  write: (model, nextSource) =>
    evo(model, {
      source: () => nextSource,
      maybeTestBench: () =>
        model.source.source === nextSource.source ? model.maybeTestBench : Option.none(),
      validation: () =>
        model.source.source === nextSource.source
          ? model.validation
          : { _tag: "NotValidated" as const },
    }),
  toParentMessage: (message) => Message.GotSourceMessage({ message }),
})

const foldTestBench = (generation: number) =>
  Update.foldChild({
    update: TestBench.update,
    read: (model: Model) =>
      model.testGeneration === generation ? model.maybeTestBench : Option.none(),
    write: (model, bench) => evo(model, { maybeTestBench: () => Option.some(bench) }),
    toParentMessage: (message) => Message.GotTestBenchMessage({ message, generation }),
    foldOutMessage: () => (model) => ({
      model: evo(model, { maybeTestBench: () => Option.none() }),
    }),
  })

const testDraft = (model: Model): UpdateReturn =>
  Option.match(parsedSource(model), {
    onNone: () => ({ model }),
    onSome: (source) => {
      const item = selectedTestItem(model)
      if (item === undefined) return { model }
      if (Option.exists(model.maybeTestBench, (bench) => bench.run._tag === "Running"))
        return { model }
      const generation = model.testGeneration + 1
      const bench = TestBench.init({
        repositoryId: model.repositoryId,
        configuration: model.configuration,
        title: model.name.trim() || "Untitled draft",
        numbers: [item.number],
        subject: {
          _tag: "Draft",
          source,
          ...(model.identity._tag === "Existing" ? { policyId: model.identity.policyId } : {}),
        },
      })
      return {
        model: evo(model, {
          maybeTestBench: () => Option.some(bench.model),
          testGeneration: () => generation,
        }),
        commands: FoldkitCommand.mapMessages(bench.commands, (message) =>
          Message.GotTestBenchMessage({ message, generation }),
        ),
      }
    },
  })

const submit = (model: Model, publish: boolean): UpdateReturn =>
  Option.match(parsedSource(model), {
    onNone: () => ({ model }),
    onSome: (source) =>
      isSubmitting(model) || draftIssues(model).length > 0
        ? { model }
        : {
            model: evo(model, {
              submission: () => ({
                _tag: "Submitting" as const,
                publish,
                name: model.name,
                description: model.description,
                sourceText: model.source.source,
              }),
            }),
            commands: [
              SavePolicy({
                repositoryId: model.repositoryId,
                identity: model.identity,
                name: model.name.trim(),
                description: model.description,
                source,
                publish,
              }),
            ],
          },
  })

const foldActionsMenu = Update.foldChild({
  update: ActionsMenu.update,
  read: (model: Model) => Option.some(model.actionsMenu),
  write: (model, actionsMenu) => evo(model, { actionsMenu: () => actionsMenu }),
  toParentMessage: (message) => Message.GotActionsMenuMessage({ message }),
  foldOutMessage:
    ({ value }) =>
    (model): UpdateReturn => {
      if (isSubmitting(model)) return { model }
      if (value === "Close editor") return { model, outMessage: OutMessage.Cancelled() }
      return model.identity._tag === "Existing"
        ? {
            model,
            outMessage: OutMessage.RequestedDelete({
              policyId: model.identity.policyId,
              version: model.identity.version,
            }),
          }
        : { model }
    },
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    FocusedMetadataInput: () => ({ model }),
    GotActionsMenuMessage: ({ message }) =>
      message._tag === "SelectedItem" &&
      message.item === "Delete policy" &&
      model.identity._tag === "Existing" &&
      !isSubmitting(model)
        ? {
            model,
            outMessage: OutMessage.RequestedDelete({
              policyId: model.identity.policyId,
              version: model.identity.version,
            }),
          }
        : foldActionsMenu(model, message),
    SelectedTestItem: ({ number }) => ({
      model: evo(model, {
        testNumber: () => number,
        maybeTestBench: () => Option.none(),
        testGeneration: (current) => current + 1,
      }),
    }),
    ToggledUsedBy: ({ isOpen }) => ({ model: evo(model, { usedByOpen: () => isOpen }) }),
    UpdatedName: ({ value }) => ({
      model: evo(model, {
        name: () => value,
        submission: (submission) =>
          submission._tag === "Submitting" ? submission : { _tag: "NotSubmitted" as const },
      }),
    }),
    UpdatedDescription: ({ value }) => ({ model: evo(model, { description: () => value }) }),
    ClickedEditMetadata: ({ field }) => ({
      model: evo(model, {
        metadataEdits: (edits) => ({ ...edits, [field]: model[field] }),
      }),
    }),
    UpdatedMetadataDraft: ({ field, value }) => ({
      model: evo(model, {
        metadataEdits: (edits) => (edits[field] === null ? edits : { ...edits, [field]: value }),
      }),
    }),
    ClickedCancelMetadata: ({ field }) => ({
      model: evo(model, {
        metadataEdits: (edits) => ({ ...edits, [field]: null }),
      }),
    }),
    ClickedSaveMetadata: ({ field }) => {
      const value = model.metadataEdits[field]
      if (value === null || (field === "name" && value.trim().length === 0)) return { model }
      return {
        model: evo(model, {
          name: (name) => (field === "name" ? value.trim() : name),
          description: (description) => (field === "description" ? value : description),
          metadataEdits: (edits) => ({ ...edits, [field]: null }),
        }),
      }
    },
    GotSourceMessage: ({ message }) => foldSource(model, message),

    ClickedTestDraft: () => testDraft(model),
    GotTestBenchMessage: ({ message, generation }) => foldTestBench(generation)(model, message),

    ClickedValidate: () =>
      model.validation._tag === "Validating"
        ? { model }
        : Option.match(parsedSource(model), {
            onNone: () => ({ model }),
            onSome: (source) => ({
              model: evo(model, {
                validationRequestId: (requestId) => requestId + 1,
                validation: () => ({
                  _tag: "Validating" as const,
                  requestId: model.validationRequestId + 1,
                }),
              }),
              commands: [
                ValidateDraft({
                  repositoryId: model.repositoryId,
                  source,
                  requestId: model.validationRequestId + 1,
                  ...(model.identity._tag === "Existing"
                    ? { policyId: model.identity.policyId }
                    : {}),
                }),
              ],
            }),
          }),
    CompletedValidate: ({ response, requestId }) =>
      model.validation._tag !== "Validating" || model.validation.requestId !== requestId
        ? { model }
        : {
            model: evo(model, {
              validation: () =>
                response._tag === "Valid"
                  ? ({ _tag: "Valid", manifest: response.manifest } as const)
                  : ({ _tag: "Invalid", message: response.message } as const),
            }),
          },
    FailedValidate: ({ reason, requestId }) =>
      model.validation._tag !== "Validating" || model.validation.requestId !== requestId
        ? { model }
        : {
            model: evo(model, {
              validation: () => ({ _tag: "Invalid" as const, message: reason }),
            }),
          },

    ClickedSave: () => submit(model, false),
    ClickedPublish: () => (hasChangesToPublish(model) ? submit(model, true) : { model }),

    SucceededSavePolicy: ({ detail, published }) => ({
      model: evo(model, {
        publishedRevision: () => detail.policy.publishedRevision,
        publishedSource: (current) =>
          published
            ? Option.some(detail.draft)
            : Option.orElse(publishedSourceOf(detail), () => current),
        savedFields: () => savedFields(model, detail),
        hasBeenPublished: (current) =>
          current || published || detail.policy.publishedVersionId !== null,
        identity: () => ({
          _tag: "Existing" as const,
          policyId: detail.policy.policyId,
          version: detail.policy.version,
        }),
        submission: () => ({ _tag: "NotSubmitted" as const }),
      }),
      ...(model.submission._tag === "Submitting" &&
      (model.submission.name !== model.name ||
        model.submission.description !== model.description ||
        model.submission.sourceText !== model.source.source)
        ? {}
        : { outMessage: OutMessage.Saved({ detail, published }) }),
    }),
    SavedDraftWithPublishError: ({ detail, reason }) => ({
      model: evo(model, {
        publishedRevision: () => detail.policy.publishedRevision,
        publishedSource: (current) => Option.orElse(publishedSourceOf(detail), () => current),
        savedFields: () => savedFields(model, detail),
        identity: () => ({
          _tag: "Existing" as const,
          policyId: detail.policy.policyId,
          version: detail.policy.version,
        }),
        submission: () => ({
          _tag: "SubmitError" as const,
          draftSaved: true,
          message: `Saved as a draft, not published: ${reason}`,
        }),
      }),
    }),
    // The draft stays; the base version moves forward so the next save lands on top.
    ConflictedSavePolicy: ({ detail }) => ({
      model: evo(model, {
        publishedRevision: () => detail.policy.publishedRevision,
        hasBeenPublished: () => detail.policy.publishedVersionId !== null,
        publishedSource: () => publishedSourceOf(detail),
        identity: () => ({
          _tag: "Existing" as const,
          policyId: detail.policy.policyId,
          version: detail.policy.version,
        }),
        submission: () => ({ _tag: "Conflicted" as const }),
      }),
    }),
    RejectedSavePolicy: ({ message }) => ({
      model: evo(model, { submission: () => ({ _tag: "SubmitError" as const, message }) }),
    }),
    FailedSavePolicy: ({ reason }) => ({
      model: evo(model, { submission: () => ({ _tag: "SubmitError" as const, message: reason }) }),
      outMessage: OutMessage.SaveFailed({ reason }),
    }),
    ClickedCancel: () =>
      isSubmitting(model) ? { model } : { model, outMessage: OutMessage.Cancelled() },
  })

// VIEW

const validationView = (h: HtmlBuilder<Message>, validation: Validation): Html => {
  const status =
    validation._tag === "Valid"
      ? "valid"
      : validation._tag === "Invalid"
        ? "invalid"
        : validation._tag === "Validating"
          ? "checking"
          : "unchecked"
  const icon =
    validation._tag === "Valid"
      ? CircleCheck
      : validation._tag === "Invalid"
        ? CircleAlert
        : validation._tag === "Validating"
          ? LoaderCircle
          : CircleHelp
  const title =
    validation._tag === "Valid"
      ? "Policy is valid."
      : validation._tag === "Invalid"
        ? "Policy is invalid"
        : validation._tag === "Validating"
          ? "Checking policy…"
          : "Not validated"
  return h.div(
    [
      h.Class("policy-validation"),
      h.DataAttribute("validation", status),
      h.Role(status === "invalid" ? "alert" : "status"),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-2 font-medium")],
        [Icon.view(h, icon, status === "checking" ? "size-4 animate-spin" : "size-4"), title],
      ),
      validation._tag === "Invalid" ? h.p([h.Class("text-xs")], [validation.message]) : h.empty,
    ],
  )
}

const submissionView = (h: HtmlBuilder<Message>, submission: Submission): Html => {
  switch (submission._tag) {
    case "NotSubmitted":
    case "Submitting":
      return h.empty
    case "Conflicted":
      return h.div(
        [h.Class("text-xs text-amber-600 dark:text-amber-400"), h.Role("alert")],
        [
          "Someone saved this policy meanwhile. Your draft is intact; saving again writes over theirs.",
        ],
      )
    case "SubmitError":
      return h.div([h.Class("text-destructive text-xs"), h.Role("alert")], [submission.message])
  }
}

const disclosure = (
  h: HtmlBuilder<Message>,
  id: string,
  isOpen: boolean,
  title: string,
  summary: string,
  onToggle: (isOpen: boolean) => Message,
  children: ReadonlyArray<Html>,
): Html =>
  Disclosure.view(
    {
      id,
      isOpen,
      onToggle,
      toView: ({ button, panel }) =>
        h.section(
          [h.Class("policy-disclosure")],
          [
            h.button(
              [...button, h.Class("policy-disclosure-toggle")],
              [
                Icon.view(h, ChevronRight, isOpen ? "size-3 rotate-90" : "size-3"),
                h.span([], [title]),
                h.span([h.Class("ml-auto text-muted-foreground")], [summary]),
              ],
            ),
            isOpen ? h.div([...panel, h.Class("policy-disclosure-content")], children) : h.empty,
          ],
        ),
    },
    h,
  )

export const view = Submodel.defineView<Model, Message, { readonly confirmingDelete: boolean }>(
  (model, { confirmingDelete }, h): Html => {
    const issues = draftIssues(model)
    const busy = isSubmitting(model)
    const canSubmit = issues.length === 0 && !busy
    const identity = model.identity
    const bound =
      identity._tag === "Existing"
        ? model.configuration.rules.filter((rule) => rule.policyId === identity.policyId).length
        : 0
    return h.keyed("div")(
      identity._tag === "Existing" ? identity.policyId : "new-policy",
      [h.Class("policy-document"), h.DataAttribute("editor", "policy")],
      [
        h.div(
          [h.Class("policy-document-body")],
          [
            h.section(
              [h.Class("policy-document-center"), h.AriaLabel("Policy document")],
              [
                h.div(
                  [h.Class("policy-document-heading")],
                  [
                    h.div(
                      [h.Class("policy-document-menu")],
                      [
                        h.submodel({
                          slotId: "policy-actions",
                          model: model.actionsMenu,
                          view: ActionsMenu.view,
                          toParentMessage: (message) => Message.GotActionsMenuMessage({ message }),
                          viewInputs: {
                            items:
                              identity._tag === "New"
                                ? ["Close editor"]
                                : [
                                    "Close editor",
                                    confirmingDelete ? "Confirm delete" : "Delete policy",
                                  ],
                            ariaLabel: "Policy actions",
                            isButtonDisabled: busy,
                            buttonContent: Icon.view(h, Ellipsis, "size-4"),
                            buttonClassName:
                              "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 cursor-pointer",
                            anchor: { placement: "bottom-end", gap: 4, padding: 8 },
                            itemsClassName: "z-50 w-44 rounded-md border bg-popover p-1 shadow-md",
                            backdropClassName: "fixed inset-0 z-40",
                            itemToConfig: (item, { isActive }) => ({
                              className: `cursor-pointer rounded-sm px-2 py-1.5 text-xs outline-none ${isActive ? "bg-accent " : ""}${item === "Close editor" ? "text-foreground" : "text-destructive"}`,
                              content: h.span(
                                [h.Class("flex items-center gap-2")],
                                [
                                  Icon.view(h, item === "Close editor" ? X : Trash2, "size-3.5"),
                                  item,
                                ],
                              ),
                            }),
                          },
                        }),
                      ],
                    ),
                    ...(["name", "description"] as const).map((field) => {
                      const draft = model.metadataEdits[field]
                      const label = field === "name" ? "title" : "description"
                      return h.div(
                        [h.Class("policy-metadata-field")],
                        [
                          draft === null
                            ? h.keyed("div")(
                                `metadata-display-${field}`,
                                [h.Class("policy-metadata-display")],
                                [
                                  field === "name"
                                    ? h.h1(
                                        [h.Class("policy-document-title")],
                                        [
                                          h.button(
                                            [
                                              h.Type("button"),
                                              h.Class("policy-metadata-text"),
                                              h.Disabled(busy),
                                              h.OnClick(Message.ClickedEditMetadata({ field })),
                                            ],
                                            [model.name || "Untitled policy"],
                                          ),
                                        ],
                                      )
                                    : h.p(
                                        [h.Class("policy-document-description")],
                                        [
                                          h.button(
                                            [
                                              h.Type("button"),
                                              h.Class("policy-metadata-text"),
                                              h.Disabled(busy),
                                              h.OnClick(Message.ClickedEditMetadata({ field })),
                                            ],
                                            [model.description || "Add a description"],
                                          ),
                                        ],
                                      ),
                                  Button.view(h, {
                                    variant: "ghost",
                                    size: "icon-xs",
                                    isDisabled: busy,
                                    label: Icon.view(h, Pencil, "size-3"),
                                    onClick: Message.ClickedEditMetadata({ field }),
                                    attributes: [
                                      h.AriaLabel(`Edit ${label}`),
                                      h.Title(`Edit ${label}`),
                                    ],
                                  }),
                                ],
                              )
                            : h.keyed("div")(
                                `metadata-edit-${field}`,
                                [
                                  h.Class("policy-metadata-form"),
                                  h.OnFocusLeave(Message.ClickedCancelMetadata({ field })),
                                ],
                                [
                                  input(h, {
                                    id: `policy-${field}`,
                                    label: field === "name" ? "Title" : "Description",
                                    value: draft,
                                    onInput: (value) =>
                                      Message.UpdatedMetadataDraft({ field, value }),
                                    labelClass: "sr-only",
                                    wrapperClass: "gap-0",
                                    attributes: [
                                      h.OnMount(FocusMetadataInput()),
                                      h.OnKeyDownPreventDefault((key) =>
                                        key === "Escape"
                                          ? Option.some(Message.ClickedCancelMetadata({ field }))
                                          : Option.none(),
                                      ),
                                    ],
                                    className:
                                      field === "name"
                                        ? "policy-title-input"
                                        : "policy-description-input",
                                  }),
                                  h.div(
                                    [h.Class("flex items-center gap-1")],
                                    [
                                      Button.view(h, {
                                        size: "xs",
                                        label: "Save",
                                        onClick: Message.ClickedSaveMetadata({ field }),
                                        isDisabled: field === "name" && draft.trim().length === 0,
                                        attributes: [h.AriaLabel(`Save ${label}`)],
                                      }),
                                      Button.view(h, {
                                        variant: "ghost",
                                        size: "xs",
                                        label: "Cancel",
                                        onClick: Message.ClickedCancelMetadata({ field }),
                                        attributes: [h.AriaLabel(`Cancel ${label} edit`)],
                                      }),
                                    ],
                                  ),
                                ],
                              ),
                        ],
                      )
                    }),
                  ],
                ),
                h.div(
                  [h.Class("policy-source-toolbar")],
                  [
                    h.span(
                      [h.Class("flex items-center gap-2")],
                      [
                        Icon.view(h, CodeXml, "size-3.5"),
                        h.span([h.Class("text-muted-foreground")], ["YAML"]),
                      ],
                    ),
                    Button.view(h, {
                      variant: "ghost",
                      size: "xs",
                      label: "Format",
                      isDisabled:
                        model.source.mountStatus !== "Ready" ||
                        Option.isSome(model.source.maybeParseError),
                      onClick: Message.GotSourceMessage({
                        message: PolicySource.Message.ClickedFormat(),
                      }),
                    }),
                  ],
                ),
                h.div(
                  [h.Class("policy-document-source")],
                  [
                    h.submodel({
                      slotId: "policy-source",
                      model: model.source,
                      view: PolicySource.view,
                      toParentMessage: (message) => Message.GotSourceMessage({ message }),
                    }),
                  ],
                ),
                h.div(
                  [h.Class("policy-document-feedback")],
                  [
                    issues.length === 0
                      ? h.empty
                      : h.ul(
                          [
                            h.Class("text-destructive flex flex-col gap-0.5 text-xs"),
                            h.Role("alert"),
                          ],
                          issues.map((issue) => h.li([], [issue])),
                        ),
                    submissionView(h, model.submission),
                  ],
                ),
              ],
            ),
            h.aside(
              [h.Class("policy-inspector"), h.AriaLabel("Policy test bench and information")],
              [
                isDirty(model) || (canSubmit && hasChangesToPublish(model))
                  ? h.section(
                      [h.Class("policy-sidebar-actions"), h.AriaLabel("Policy controls")],
                      [
                        h.div(
                          [h.Class("policy-publish-actions")],
                          [
                            isDirty(model)
                              ? Button.view(h, {
                                  variant: "outline",
                                  size: "sm",
                                  onClick: Message.ClickedSave(),
                                  isDisabled: !canSubmit,
                                  label: h.span(
                                    [h.Class("flex items-center gap-1.5")],
                                    [Icon.view(h, Save, "size-3.5"), "Save draft"],
                                  ),
                                })
                              : h.empty,
                            canSubmit && hasChangesToPublish(model)
                              ? Button.view(h, {
                                  size: "sm",
                                  onClick: Message.ClickedPublish(),
                                  isDisabled: !canSubmit || !hasChangesToPublish(model),
                                  label: h.span(
                                    [h.Class("flex items-center gap-1.5")],
                                    [Icon.view(h, Upload, "size-3.5"), "Publish"],
                                  ),
                                  attributes: [h.DataAttribute("action", "publish")],
                                })
                              : h.empty,
                          ],
                        ),
                      ],
                    )
                  : h.empty,
                h.section(
                  [
                    h.Class("policy-inspector-section flex flex-col gap-3"),
                    h.AriaLabel("Versions"),
                  ],
                  [
                    h.div(
                      [h.Class("flex items-center justify-between gap-2 flex-wrap")],
                      [
                        h.h2([h.Class("text-sm font-semibold")], ["Versions"]),
                        PolicyStatus.view(h, publicationStatus(model)),
                      ],
                    ),
                    h.div(
                      [h.Class("policy-property")],
                      [
                        h.span([], ["Published"]),
                        h.span(
                          [],
                          [
                            model.publishedRevision === null
                              ? "Not published"
                              : `v${model.publishedRevision}`,
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
                h.div(
                  [h.Class("policy-inspector-section flex flex-col gap-3")],
                  [
                    h.h2([h.Class("text-sm font-semibold")], ["Test bench"]),
                    model.testCandidates._tag === "Failed"
                      ? h.p(
                          [h.Class("text-xs text-destructive"), h.Role("alert")],
                          ["Could not load test items. Retrying with the next repository refresh."],
                        )
                      : testItems(model).length === 0
                        ? h.p(
                            [h.Class("text-xs text-muted-foreground")],
                            ["No open items are available for this policy's target."],
                          )
                        : h.div(
                            [h.Class("flex flex-col gap-1.5")],
                            [
                              h.label(
                                [
                                  h.For("policy-test-choice"),
                                  h.Class("text-xs text-muted-foreground"),
                                ],
                                [
                                  Option.exists(
                                    parsedSource(model),
                                    (source) => source.target === "issue",
                                  )
                                    ? "Issues"
                                    : "Pull Requests",
                                ],
                              ),
                              h.select(
                                [
                                  h.Id("policy-test-choice"),
                                  h.Class("policy-test-select"),
                                  h.Value(String(selectedTestItem(model)?.number ?? "")),
                                  h.OnChange((value) =>
                                    Message.SelectedTestItem({ number: Number(value) }),
                                  ),
                                ],
                                testItems(model).map((item) =>
                                  h.option(
                                    [h.Value(String(item.number))],
                                    [`#${item.number} · ${item.title}`],
                                  ),
                                ),
                              ),
                            ],
                          ),
                    Option.match(model.maybeTestBench, {
                      onNone: () =>
                        h.div(
                          [h.Class("flex flex-col gap-3")],
                          [
                            Button.view(h, {
                              variant: "outline",
                              size: "sm",
                              onClick: Message.ClickedTestDraft(),
                              isDisabled:
                                Option.isNone(parsedSource(model)) ||
                                selectedTestItem(model) === undefined,
                              label: "Test draft",
                            }),
                          ],
                        ),
                      onSome: (bench) =>
                        h.submodel({
                          slotId: "draft-test-bench",
                          model: bench,
                          view: TestBench.view,
                          toParentMessage: (message) =>
                            Message.GotTestBenchMessage({
                              message,
                              generation: model.testGeneration,
                            }),
                        }),
                    }),
                  ],
                ),
                h.div(
                  [h.Class("policy-inspector-section flex flex-col gap-3")],
                  [
                    h.div(
                      [h.Class("flex items-center justify-between gap-2")],
                      [
                        h.h2([h.Class("text-xs font-semibold")], ["Validation"]),
                        Button.view(h, {
                          variant: "ghost",
                          size: "xs",
                          onClick: Message.ClickedValidate(),
                          isDisabled:
                            Option.isNone(parsedSource(model)) ||
                            model.validation._tag === "Validating",
                          label: "Validate",
                        }),
                      ],
                    ),
                    validationView(
                      h,
                      Option.isNone(parsedSource(model))
                        ? {
                            _tag: "Invalid",
                            message: Option.getOrElse(
                              model.source.maybeParseError,
                              () => "Fix the program structure before validating.",
                            ),
                          }
                        : model.validation,
                    ),
                  ],
                ),
                disclosure(
                  h,
                  "policy-used-by",
                  model.usedByOpen,
                  "Used by",
                  `${bound} rule${bound === 1 ? "" : "s"}`,
                  (isOpen) => Message.ToggledUsedBy({ isOpen }),
                  bound === 0
                    ? [h.p([], ["No rules use this policy yet."])]
                    : model.configuration.rules
                        .filter(
                          (rule) =>
                            identity._tag === "Existing" && rule.policyId === identity.policyId,
                        )
                        .map((rule) =>
                          h.a(
                            [
                              h.Href(
                                Routes.rule({ repositoryId: model.repositoryId, ruleId: rule.id }),
                              ),
                              h.Class("policy-rule-card"),
                              h.AriaLabel(
                                `Rule for ${labelName(model.configuration.labels, rule.labelId)}`,
                              ),
                            ],
                            [
                              h.div(
                                [h.Class("flex items-center justify-between gap-2")],
                                [
                                  h.strong(
                                    [h.Class("text-foreground")],
                                    [labelName(model.configuration.labels, rule.labelId)],
                                  ),
                                  h.span(
                                    [
                                      h.Class(
                                        rule.enabled
                                          ? "text-emerald-600 dark:text-emerald-400"
                                          : "text-muted-foreground",
                                      ),
                                    ],
                                    [rule.enabled ? "Enabled" : "Disabled"],
                                  ),
                                ],
                              ),
                              h.p([], ["On match: add label"]),
                              h.p(
                                [],
                                [
                                  rule.onNoMatch === "ensure-absent"
                                    ? "On no match: remove label"
                                    : "On no match: leave label unchanged",
                                ],
                              ),
                              rule.group === null
                                ? h.empty
                                : h.p([], [`Group: ${rule.group} · Priority ${rule.priority}`]),
                            ],
                          ),
                        ),
                ),
              ],
            ),
          ],
        ),
      ],
    )
  },
)

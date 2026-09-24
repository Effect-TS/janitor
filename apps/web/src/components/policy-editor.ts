import { describeResultAction } from "@janitor/domain/Labeling/Policy/Plan"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Result from "effect/Result"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as FoldkitCommand from "foldkit/command"
import * as Mount from "foldkit/mount"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import { selectClass } from "@/components/ui/select"
import * as DialogChrome from "@/components/ui/dialog"
import * as Inspector from "@/components/ui/inspector"
import * as Disclosure from "@foldkit/ui/disclosure"
import * as Dialog from "@foldkit/ui/dialog"
import * as Icon from "@/lib/icons"
import { Check, ChevronDown, ChevronRight, Info, LoaderCircle, Pencil } from "lucide"
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
  deleteDialog: Dialog.Model,
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
  ClickedDelete: {},
  CancelledDelete: {},
  ConfirmedDelete: {},
  GotDeleteDialogMessage: { message: Dialog.Message },
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
  PersistedDraft: { detail: PolicyDetail },
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
  const next = modifyFields(model, { testCandidates: () => candidates })
  return selectedTestItem(model)?.number === selectedTestItem(next)?.number
    ? next
    : modifyFields(next, {
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
      deleteDialog: Dialog.init({ id: "delete-policy", focusSelector: "#cancel-delete-policy" }),
      repositoryId,
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
    modifyFields(model, {
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
    write: (model, bench) => modifyFields(model, { maybeTestBench: () => Option.some(bench) }),
    toParentMessage: (message) => Message.GotTestBenchMessage({ message, generation }),
    foldOutMessage: () => (model) => ({
      model: modifyFields(model, { maybeTestBench: () => Option.none() }),
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
      return Update.foldChildInit(bench, {
        toParentModel: (bench) =>
          modifyFields(model, {
            maybeTestBench: () => Option.some(bench),
            testGeneration: () => generation,
          }),
        toParentMessage: (message) => Message.GotTestBenchMessage({ message, generation }),
        toParentOutMessage: (): OutMessage | undefined => undefined,
      })
    },
  })

const submit = (model: Model, publish: boolean): UpdateReturn =>
  Option.match(parsedSource(model), {
    onNone: () => ({ model }),
    onSome: (source) =>
      isSubmitting(model) || draftIssues(model).length > 0
        ? { model }
        : {
            model: modifyFields(model, {
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

const mapDeleteDialog = (model: Model, result: ReturnType<typeof Dialog.open>): UpdateReturn => ({
  model: modifyFields(model, { deleteDialog: () => result.model }),
  commands: FoldkitCommand.mapMessages(result.commands, (message) =>
    Message.GotDeleteDialogMessage({ message }),
  ),
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    FocusedMetadataInput: () => ({ model }),
    GotDeleteDialogMessage: ({ message }) =>
      mapDeleteDialog(model, Dialog.update(model.deleteDialog, message)),
    CancelledDelete: () => mapDeleteDialog(model, Dialog.close(model.deleteDialog)),
    ClickedDelete: () =>
      model.identity._tag === "Existing" && !isSubmitting(model)
        ? mapDeleteDialog(model, Dialog.open(model.deleteDialog))
        : { model },
    ConfirmedDelete: () =>
      model.deleteDialog.isOpen && model.identity._tag === "Existing" && !isSubmitting(model)
        ? {
            ...mapDeleteDialog(model, Dialog.close(model.deleteDialog)),
            outMessage: OutMessage.RequestedDelete({
              policyId: model.identity.policyId,
              version: model.identity.version,
            }),
          }
        : { model },
    SelectedTestItem: ({ number }) => ({
      model: modifyFields(model, {
        testNumber: () => number,
        maybeTestBench: () => Option.none(),
        testGeneration: (current) => current + 1,
      }),
    }),
    ToggledUsedBy: ({ isOpen }) => ({ model: modifyFields(model, { usedByOpen: () => isOpen }) }),
    UpdatedName: ({ value }) => ({
      model: modifyFields(model, {
        name: () => value,
        submission: (submission) =>
          submission._tag === "Submitting" ? submission : { _tag: "NotSubmitted" as const },
      }),
    }),
    UpdatedDescription: ({ value }) => ({
      model: modifyFields(model, { description: () => value }),
    }),
    ClickedEditMetadata: ({ field }) => ({
      model: modifyFields(model, {
        metadataEdits: (edits) => ({ ...edits, [field]: model[field] }),
      }),
    }),
    UpdatedMetadataDraft: ({ field, value }) => ({
      model: modifyFields(model, {
        metadataEdits: (edits) => (edits[field] === null ? edits : { ...edits, [field]: value }),
      }),
    }),
    ClickedCancelMetadata: ({ field }) => ({
      model: modifyFields(model, {
        metadataEdits: (edits) => ({ ...edits, [field]: null }),
      }),
    }),
    ClickedSaveMetadata: ({ field }) => {
      const value = model.metadataEdits[field]
      if (value === null || (field === "name" && value.trim().length === 0)) return { model }
      return {
        model: modifyFields(model, {
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
              model: modifyFields(model, {
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
            model: modifyFields(model, {
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
            model: modifyFields(model, {
              validation: () => ({ _tag: "Invalid" as const, message: reason }),
            }),
          },

    ClickedSave: () => submit(model, false),
    ClickedPublish: () => (hasChangesToPublish(model) ? submit(model, true) : { model }),

    SucceededSavePolicy: ({ detail, published }) => ({
      model: modifyFields(model, {
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
      outMessage: OutMessage.Saved({ detail, published }),
    }),
    SavedDraftWithPublishError: ({ detail, reason }) => ({
      model: modifyFields(model, {
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
      outMessage: OutMessage.PersistedDraft({ detail }),
    }),
    // The draft stays; the base version moves forward so the next save lands on top.
    ConflictedSavePolicy: ({ detail }) => ({
      model: modifyFields(model, {
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
      model: modifyFields(model, { submission: () => ({ _tag: "SubmitError" as const, message }) }),
    }),
    FailedSavePolicy: ({ reason }) => ({
      model: modifyFields(model, {
        submission: () => ({ _tag: "SubmitError" as const, message: reason }),
      }),
      outMessage: OutMessage.SaveFailed({ reason }),
    }),
    ClickedCancel: () =>
      isSubmitting(model) ? { model } : { model, outMessage: OutMessage.Cancelled() },
  })

// VIEW

/** An inspector section that keeps its own attributes (the `Versions`
 *  region is named for assistive tech, and Validation carries an action in
 *  its heading). Same markup as `Inspector.section`. */
const inspectorSection = (
  h: HtmlBuilder<Message>,
  config: {
    readonly heading: string
    readonly action?: Html
    readonly attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
    readonly children: ReadonlyArray<Html | string>
  },
): Html =>
  h.section(
    [h.DataAttribute("slot", "inspector-section"), ...(config.attributes ?? [])],
    [
      config.action === undefined
        ? h.h3([h.DataAttribute("slot", "inspector-heading")], [config.heading])
        : h.div(
            [h.Class("mb-2 flex items-center justify-between gap-2")],
            [
              h.h3(
                [h.DataAttribute("slot", "inspector-heading"), h.Class("mb-0")],
                [config.heading],
              ),
              config.action,
            ],
          ),
      ...config.children,
    ],
  )

const validationView = (h: HtmlBuilder<Message>, validation: Validation): Html => {
  const status =
    validation._tag === "Valid"
      ? "valid"
      : validation._tag === "Invalid"
        ? "invalid"
        : validation._tag === "Validating"
          ? "checking"
          : "unchecked"
  const title =
    validation._tag === "Valid"
      ? "Valid"
      : validation._tag === "Invalid"
        ? "Invalid"
        : validation._tag === "Validating"
          ? "Checking…"
          : "Not validated"
  const tone =
    validation._tag === "Valid"
      ? "text-success"
      : validation._tag === "Invalid"
        ? "text-destructive"
        : "text-foreground"
  return h.div(
    [
      h.Class("flex flex-col gap-1 text-body-sm wrap-anywhere"),
      h.DataAttribute("validation", status),
      h.Role(status === "invalid" ? "alert" : "status"),
    ],
    [
      h.div(
        [h.Class(`flex items-center gap-1.5 font-medium ${tone}`)],
        [
          validation._tag === "Valid"
            ? Icon.view(h, Check)
            : validation._tag === "Validating"
              ? Icon.view(h, LoaderCircle, "animate-spin")
              : h.empty,
          title,
        ],
      ),
      validation._tag === "Invalid"
        ? h.p([h.Class("text-body-sm text-ink-muted")], [validation.message])
        : h.empty,
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
        [h.Class("flex items-start gap-1.5 text-body-sm text-foreground"), h.Role("alert")],
        [
          Icon.view(h, Info, "mt-0.5 shrink-0"),
          h.span(
            [],
            [
              "Someone saved this policy meanwhile. Your draft is intact; saving again writes over theirs.",
            ],
          ),
        ],
      )
    case "SubmitError":
      return h.div(
        [h.Class("text-body-sm text-destructive"), h.Role("alert")],
        [submission.message],
      )
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
          [h.DataAttribute("slot", "inspector-section")],
          [
            h.button(
              [
                ...button,
                h.Class(
                  "flex w-full cursor-pointer items-center gap-1.5 rounded-xs text-left text-caption font-medium text-ink-subtle transition-colors duration-120 ease-ui hover:text-foreground",
                ),
              ],
              [
                Icon.view(h, isOpen ? ChevronDown : ChevronRight, "size-3"),
                h.span([], [title]),
                h.span([h.Class("ml-auto font-mono text-mono-xs")], [summary]),
              ],
            ),
            isOpen
              ? h.div(
                  [...panel, h.Class("mt-2 flex flex-col gap-2 text-body-sm wrap-anywhere")],
                  children,
                )
              : h.empty,
          ],
        ),
    },
    h,
  )

const metadataTextClass =
  "-mx-1 cursor-text rounded-xs border border-transparent px-1 text-left transition-colors duration-120 ease-ui hover:border-border focus-visible:border-primary focus-visible:outline-none disabled:cursor-default disabled:hover:border-transparent wrap-anywhere"

interface ViewInputs {
  readonly isDeleting?: boolean
}

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { isDeleting = false }, h): Html => {
    const issues = draftIssues(model)
    const busy = isSubmitting(model) || isDeleting
    const canSubmit = issues.length === 0 && !busy
    const identity = model.identity
    const bound =
      identity._tag === "Existing"
        ? model.configuration.rules.filter((rule) => rule.policyId === identity.policyId).length
        : 0
    const showActions =
      identity._tag === "New" || isDirty(model) || (canSubmit && hasChangesToPublish(model))
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
                  [h.Class("flex flex-col gap-1 px-5 pt-4 pb-3")],
                  [
                    isDeleting
                      ? h.p(
                          [h.Role("status"), h.Class("text-body-sm text-ink-muted")],
                          ["Deleting policy…"],
                        )
                      : h.empty,
                    ...(["name", "description"] as const).map((field) => {
                      const draft = model.metadataEdits[field]
                      const label = field === "name" ? "title" : "description"
                      return h.div(
                        [h.Class("policy-metadata-field")],
                        [
                          draft === null
                            ? h.keyed("div")(
                                `metadata-display-${field}`,
                                [h.Class("group flex min-h-6 items-center gap-2")],
                                [
                                  field === "name"
                                    ? h.h1(
                                        [h.Class("min-w-0 text-h1")],
                                        [
                                          h.button(
                                            [
                                              h.Type("button"),
                                              h.Class(metadataTextClass),
                                              h.Disabled(busy),
                                              h.OnClick(Message.ClickedEditMetadata({ field })),
                                            ],
                                            [model.name || "Untitled policy"],
                                          ),
                                        ],
                                      )
                                    : h.p(
                                        [h.Class("min-w-0 text-body-sm text-ink-muted")],
                                        [
                                          h.button(
                                            [
                                              h.Type("button"),
                                              h.Class(metadataTextClass),
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
                                    className:
                                      "shrink-0 text-ink-subtle opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
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
                                  h.Class("policy-metadata-form flex items-center gap-1.5"),
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
                                    wrapperClass: "min-w-0 flex-1 gap-0",
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
                                        ? "h-8 text-h1 font-semibold"
                                        : "text-body-sm",
                                  }),
                                  h.div(
                                    [h.Class("flex shrink-0 items-center gap-1")],
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
                  [
                    h.Class(
                      "flex h-7 shrink-0 items-center justify-between gap-2 border-y border-border bg-surface-muted px-5 text-caption font-medium text-ink-subtle",
                    ),
                  ],
                  [
                    h.span([h.Class("font-mono text-mono-xs")], ["YAML"]),
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
                            h.Class("flex flex-col gap-0.5 text-body-sm text-destructive"),
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
                showActions
                  ? h.section(
                      [
                        h.Class(
                          "flex flex-wrap items-center gap-1.5 border-b border-border px-3.5 py-3",
                        ),
                        h.AriaLabel("Policy controls"),
                      ],
                      [
                        identity._tag === "New" || (canSubmit && hasChangesToPublish(model))
                          ? Button.view(h, {
                              size: "sm",
                              onClick: Message.ClickedPublish(),
                              isDisabled: !canSubmit || !hasChangesToPublish(model),
                              label: identity._tag === "New" ? "Save & publish" : "Publish",
                              attributes: [h.DataAttribute("action", "publish")],
                            })
                          : h.empty,
                        identity._tag === "New" || isDirty(model)
                          ? Button.view(h, {
                              variant: "secondary",
                              size: "sm",
                              onClick: Message.ClickedSave(),
                              isDisabled: !canSubmit,
                              label: "Save draft",
                            })
                          : h.empty,
                        identity._tag === "New"
                          ? Button.view(h, {
                              variant: "ghost",
                              size: "sm",
                              label: "Cancel",
                              attributes: [h.DataAttribute("action", "cancel-creation")],
                              onClick: Message.ClickedCancel(),
                              isDisabled: busy,
                            })
                          : h.empty,
                      ],
                    )
                  : h.empty,
                inspectorSection(h, {
                  heading: "Status",
                  children: [
                    Inspector.row(h, "Publication", PolicyStatus.view(h, publicationStatus(model))),
                  ],
                }),
                inspectorSection(h, {
                  heading: "Versions",
                  attributes: [h.AriaLabel("Versions")],
                  children: [
                    Inspector.row(
                      h,
                      "Published",
                      model.publishedRevision === null
                        ? "Not published"
                        : `v${model.publishedRevision}`,
                    ),
                  ],
                }),
                inspectorSection(h, {
                  heading: "Test bench",
                  children: [
                    h.div(
                      [h.Class("flex flex-col gap-2")],
                      [
                        model.testCandidates._tag === "Failed"
                          ? h.p(
                              [h.Class("text-body-sm"), h.Role("alert")],
                              [
                                h.span(
                                  [h.Class("text-destructive")],
                                  ["Could not load test items."],
                                ),
                                " Retrying with the next repository refresh.",
                              ],
                            )
                          : testItems(model).length === 0
                            ? h.p(
                                [h.Class("text-body-sm text-ink-muted")],
                                ["No open items are available for this policy's target."],
                              )
                            : h.div(
                                [h.Class("flex flex-col gap-1")],
                                [
                                  h.label(
                                    [
                                      h.For("policy-test-choice"),
                                      h.Class("text-body-sm text-ink-muted"),
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
                                      h.Class(selectClass),
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
                              [],
                              [
                                Button.view(h, {
                                  variant: "secondary",
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
                  ],
                }),
                inspectorSection(h, {
                  heading: "Validation",
                  action: Button.view(h, {
                    variant: "ghost",
                    size: "xs",
                    onClick: Message.ClickedValidate(),
                    isDisabled:
                      Option.isNone(parsedSource(model)) || model.validation._tag === "Validating",
                    label: "Validate",
                  }),
                  children: [
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
                }),
                disclosure(
                  h,
                  "policy-used-by",
                  model.usedByOpen,
                  "Used by",
                  `${bound} rule${bound === 1 ? "" : "s"}`,
                  (isOpen) => Message.ToggledUsedBy({ isOpen }),
                  bound === 0
                    ? [h.p([h.Class("text-ink-muted")], ["No rules use this policy yet."])]
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
                              h.Class(
                                "flex flex-col gap-0.5 rounded-md border border-border bg-card p-2 text-body-sm text-ink-muted transition-colors duration-120 ease-ui hover:bg-surface-muted hover:border-primary-line",
                              ),
                              h.AriaLabel(
                                `Rule for ${labelName(model.configuration.labels, rule.labelId)}`,
                              ),
                            ],
                            [
                              h.div(
                                [h.Class("flex items-center justify-between gap-2")],
                                [
                                  h.span(
                                    [h.Class("font-mono text-mono-sm text-foreground")],
                                    [labelName(model.configuration.labels, rule.labelId)],
                                  ),
                                  h.span(
                                    [
                                      h.Class(
                                        rule.enabled
                                          ? "text-caption font-medium text-success"
                                          : "text-caption font-medium text-ink-subtle",
                                      ),
                                    ],
                                    [rule.enabled ? "Enabled" : "Disabled"],
                                  ),
                                ],
                              ),
                              h.p([], [`On match: ${describeResultAction(rule.onMatch)}`]),
                              h.p([], [`On non-match: ${describeResultAction(rule.onNoMatch)}`]),
                              rule.group === null
                                ? h.empty
                                : h.p(
                                    [],
                                    [
                                      "Group: ",
                                      h.span([h.Class("font-mono text-mono-sm")], [rule.group]),
                                      " · Priority ",
                                      h.span(
                                        [h.Class("font-mono text-mono-sm")],
                                        [String(rule.priority)],
                                      ),
                                    ],
                                  ),
                            ],
                          ),
                        ),
                ),
                identity._tag === "Existing"
                  ? inspectorSection(h, {
                      heading: "Delete",
                      children: [
                        Button.view(h, {
                          variant: "destructive",
                          size: "sm",
                          isDisabled: busy,
                          onClick: Message.ClickedDelete(),
                          label: isDeleting ? "Deleting policy…" : "Delete policy",
                        }),
                      ],
                    })
                  : h.empty,
              ],
            ),
          ],
        ),
        h.submodel({
          slotId: "delete-policy-dialog",
          model: model.deleteDialog,
          view: Dialog.view,
          toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
          viewInputs: {
            hasDescription: true,
            toView: (render) =>
              DialogChrome.view(h, {
                dialog: render.dialog,
                backdrop: render.backdrop,
                panel: render.panel,
                title: render.title,
                description: render.description,
                isVisible: render.isVisible,
                titleText: "Delete policy?",
                descriptionText: 'Delete "' + model.name + '"? This cannot be undone.',
                actions: [
                  Button.view(h, {
                    label: "Cancel",
                    variant: "secondary",
                    attributes: [h.Id("cancel-delete-policy")],
                    onClick: Message.CancelledDelete(),
                  }),
                  Button.view(h, {
                    label: "Delete policy",
                    variant: "destructive",
                    isDisabled: busy,
                    onClick: Message.ConfirmedDelete(),
                  }),
                ],
              }),
          },
        }),
      ],
    )
  },
)

/** Refresh shared configuration without replacing the author's draft. */
export const reflectConfiguration = (model: Model, configuration: ConfigurationView): Model =>
  modifyFields(model, {
    configuration: () => configuration,
    source: (source) =>
      modifyFields(source, {
        referencePolicies: () =>
          configuration.policies
            .filter(
              (policy) =>
                policy.publishedVersionId !== null &&
                policy.publishedEvaluator === "Conditions" &&
                !(
                  model.identity._tag === "Existing" && model.identity.policyId === policy.policyId
                ),
            )
            .map((policy) => ({ name: policy.name, target: policy.target })),
      }),
  })

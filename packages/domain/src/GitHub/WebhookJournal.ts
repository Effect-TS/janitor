import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

const JournalSequenceString = Schema.NonEmptyString.check(
  Schema.isPattern(/^(0|[1-9][0-9]*)$/),
).annotate({ identifier: "GitHubWebhookJournalSequenceString" })

const JournalSequenceNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  identifier: "GitHubWebhookJournalSequenceNumber",
})

/**
 * Monotonic receipt sequence assigned by the journal. Postgres returns BIGINT
 * as a decimal string, so the canonical form is a string.
 */
export const GitHubWebhookJournalSequence = JournalSequenceString.pipe(
  Schema.brand("GitHubWebhookJournalSequence"),
).annotate({ identifier: "GitHubWebhookJournalSequence" })
export type GitHubWebhookJournalSequence = typeof GitHubWebhookJournalSequence.Type

/**
 * Journal rows start at 1. Zero is the fence for observations no webhook
 * motivated, such as scheduled scans, so any later webhook fence wins.
 */
export const GitHubWebhookJournalSequenceZero = GitHubWebhookJournalSequence.make("0")

export const GitHubWebhookJournalSequenceFromNumber = JournalSequenceNumber.pipe(
  Schema.decodeTo(JournalSequenceString, SchemaTransformation.numberFromString.flip()),
  Schema.brand("GitHubWebhookJournalSequence"),
).annotate({ identifier: "GitHubWebhookJournalSequenceFromNumber" })

export const GitHubWebhookJournalSequenceFromStringOrNumber = Schema.Union([
  GitHubWebhookJournalSequenceFromNumber,
  GitHubWebhookJournalSequence,
]).annotate({ identifier: "GitHubWebhookJournalSequenceFromStringOrNumber" })

/**
 * `unsupported` records a signature-valid delivery whose payload does not
 * decode against the domain schemas, such as an action the schema does not
 * model. It stays journaled for repair. `failed` records an infrastructure
 * or decryption failure.
 */
export const GitHubWebhookProjectionStatus = Schema.Literals([
  "pending",
  "projected",
  "unsupported",
  "failed",
]).annotate({ identifier: "GitHubWebhookProjectionStatus" })
export type GitHubWebhookProjectionStatus = typeof GitHubWebhookProjectionStatus.Type

/**
 * Written to the dead-letter queue when a queue message cannot be journaled.
 * `body` is the original message body, which only ever holds ciphertext.
 */
export const GitHubWebhookDeadLetterV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  messageId: Schema.NonEmptyString,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reason: Schema.NonEmptyString,
  body: Schema.Unknown,
}).annotate({ identifier: "GitHubWebhookDeadLetterV1" })
export type GitHubWebhookDeadLetterV1 = typeof GitHubWebhookDeadLetterV1.Type

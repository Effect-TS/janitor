import type { LinkPlatform } from "@janitor/domain/Team/Account"
import * as Data from "effect/Data"

/** An account a platform has just vouched for, in that platform's own identifiers. */
export interface ProvenAccount {
  readonly workspaceId: string
  readonly accountId: string
  readonly displayName: string
}

export type LinkProofReason =
  | "exchange-failed"
  | "token-rejected"
  | "nonce-mismatch"
  | "wrong-workspace"
  | "lookup-failed"

/** The platform did not prove ownership. Never carries tokens or codes. */
export class LinkProofFailed extends Data.TaggedError("LinkProofFailed")<{
  readonly platform: LinkPlatform
  readonly reason: LinkProofReason
  readonly message: string
  readonly cause?: unknown
}> {}

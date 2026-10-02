import * as Schema from "effect/Schema"

export const TeammateId = Schema.NonEmptyString.pipe(Schema.brand("TeammateId")).annotate({
  identifier: "TeammateId",
})
export type TeammateId = typeof TeammateId.Type

/** The platforms a teammate can prove an account on. */
export const LinkPlatform = Schema.Literals(["slack", "github"])
export type LinkPlatform = typeof LinkPlatform.Type

/** GitHub has one namespace of numeric user IDs; Slack accounts are per workspace. */
export const GITHUB_WORKSPACE_ID = "github.com"

export const LinkStatus = Schema.Literals(["active", "disconnected", "replaced"])
export type LinkStatus = typeof LinkStatus.Type

export const LinkId = Schema.NonEmptyString.pipe(Schema.brand("LinkId")).annotate({
  identifier: "LinkId",
})
export type LinkId = typeof LinkId.Type

/** A platform account as a platform identifies it: exact strings, never display names. */
export const PlatformAccount = Schema.Struct({
  platform: LinkPlatform,
  workspaceId: Schema.String,
  accountId: Schema.String,
})
export type PlatformAccount = typeof PlatformAccount.Type

export const LinkedAccount = Schema.Struct({
  linkId: LinkId,
  platform: LinkPlatform,
  workspaceId: Schema.String,
  accountId: Schema.String,
  displayName: Schema.String,
  status: LinkStatus,
  linkedAt: Schema.DateTimeUtcFromString,
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
})
export type LinkedAccount = typeof LinkedAccount.Type

export const TeammateSummary = Schema.Struct({
  teammateId: TeammateId,
  issuer: Schema.String,
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
})
export type TeammateSummary = typeof TeammateSummary.Type

/** Which platform links the deployment can start; unconfigured ones show as unavailable. */
export const LinkingAvailability = Schema.Struct({
  slack: Schema.Boolean,
  github: Schema.Boolean,
})
export type LinkingAvailability = typeof LinkingAvailability.Type

export const AccountView = Schema.Struct({
  teammate: TeammateSummary,
  links: Schema.Array(LinkedAccount),
  linking: LinkingAvailability,
})
export type AccountView = typeof AccountView.Type

/** What the browser brings back from a platform's authorization page. */
export const LinkReturnRequest = Schema.Struct({
  state: Schema.String,
  code: Schema.String,
})
export type LinkReturnRequest = typeof LinkReturnRequest.Type

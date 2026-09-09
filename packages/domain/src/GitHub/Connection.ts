import * as Schema from "effect/Schema"
export const ConnectionCandidate = Schema.Struct({
  repositoryId: Schema.String,
  installationId: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  isPrivate: Schema.NullOr(Schema.Boolean),
  connected: Schema.Boolean,
  enabled: Schema.Boolean,
  reconnect: Schema.Boolean,
  access: Schema.String,
  accessError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  installationStatus: Schema.String,
  policyCount: Schema.Int,
  ruleCount: Schema.Int,
  syncState: Schema.String,
  syncError: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type ConnectionCandidate = typeof ConnectionCandidate.Type
export const ConnectionInventory = Schema.Struct({
  repositories: Schema.Array(ConnectionCandidate),
})

import * as Schema from "effect/Schema"
import { Plan } from "./Policy/Plan.ts"

export const ActivityCursor = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  generation: Schema.String.check(Schema.isPattern(/^[0-9]{1,18}$/)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ActivityCursor = typeof ActivityCursor.Type
export const ActivityAction = Schema.Struct({
  labelId: Schema.String,
  name: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  ruleId: Schema.String,
  action: Schema.Literals(["add", "remove"]),
  status: Schema.Literals(["planned", "applied", "failed"]),
  detail: Schema.NullOr(Schema.String),
})
export const ActivityEntry = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  title: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.Literals(["issue", "pull_request"])),
  createdAt: Schema.DateTimeUtc,
  outcome: Schema.NullOr(Schema.Literals(["evaluated", "superseded", "not-qualified", "failed"])),
  detail: Schema.NullOr(Schema.String),
  revision: Schema.Int,
  plan: Schema.NullOr(Plan),
  actions: Schema.Array(ActivityAction),
})
export type ActivityEntry = typeof ActivityEntry.Type
export const ActivityPage = Schema.Struct({
  entries: Schema.Array(ActivityEntry),
  cursor: Schema.NullOr(ActivityCursor),
})
export type ActivityPage = typeof ActivityPage.Type

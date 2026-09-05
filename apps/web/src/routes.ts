import { pipe } from "effect/Function"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Route from "foldkit/route"
import type * as Url from "foldkit/url"

const repository = { repositoryId: Schema.String }
const policyQuery = {
  q: Schema.optionalKey(Schema.String),
  item: Schema.optionalKey(Schema.String),
}
export const AppRoute = Route.defineRouteUnion({
  Home: {},
  Repository: repository,
  Policies: { ...repository, ...policyQuery },
  NewPolicy: { ...repository, ...policyQuery },
  Policy: { ...repository, policyId: Schema.String, ...policyQuery },
  Rules: repository,
  NewRule: repository,
  Rule: { ...repository, ruleId: Schema.String },
  TestRules: repository,
  Activity: repository,
  Settings: repository,
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

const idSegment = <K extends string>(name: K) =>
  Route.param<Record<K, string>>(
    name,
    (segment) =>
      Effect.try({
        try: () => ({ [name]: decodeURIComponent(segment) }) as Record<K, string>,
        catch: () => new Route.ParseError({ message: `Invalid ${name}` }),
      }),
    (value) => encodeURIComponent(value[name]),
  )
const base = pipe(Route.literal("repositories"), Route.slash(idSegment("repositoryId")))
const policyBase = pipe(base, Route.slash(Route.literal("policies")))
const ruleBase = pipe(base, Route.slash(Route.literal("rules")))
const query = Route.query(Schema.Struct(policyQuery))
export const home = pipe(Route.root, Route.mapTo(AppRoute.Home))
export const repositoryHome = pipe(base, Route.mapTo(AppRoute.Repository))
export const policies = pipe(policyBase, query, Route.mapTo(AppRoute.Policies))
export const newPolicy = pipe(
  policyBase,
  Route.slash(Route.literal("new")),
  query,
  Route.mapTo(AppRoute.NewPolicy),
)
export const policy = pipe(
  policyBase,
  Route.slash(idSegment("policyId")),
  query,
  Route.mapTo(AppRoute.Policy),
)
export const rules = pipe(ruleBase, Route.mapTo(AppRoute.Rules))
export const newRule = pipe(
  ruleBase,
  Route.slash(Route.literal("new")),
  Route.mapTo(AppRoute.NewRule),
)
export const rule = pipe(ruleBase, Route.slash(idSegment("ruleId")), Route.mapTo(AppRoute.Rule))
export const testRules = pipe(
  ruleBase,
  Route.slash(Route.literal("test")),
  Route.mapTo(AppRoute.TestRules),
)
export const activity = pipe(
  base,
  Route.slash(Route.literal("activity")),
  Route.mapTo(AppRoute.Activity),
)
export const settings = pipe(
  base,
  Route.slash(Route.literal("settings")),
  Route.mapTo(AppRoute.Settings),
)
export const parse = Route.parseUrlWithFallback(
  Route.oneOf(
    home,
    repositoryHome,
    policies,
    newPolicy,
    policy,
    rules,
    newRule,
    testRules,
    rule,
    activity,
    settings,
  ),
  AppRoute.NotFound,
)
export const path = (route: AppRoute): string =>
  AppRoute.match(route, {
    Home: home,
    Repository: repositoryHome,
    Policies: policies,
    NewPolicy: newPolicy,
    Policy: policy,
    Rules: rules,
    NewRule: newRule,
    Rule: rule,
    TestRules: testRules,
    Activity: activity,
    Settings: settings,
    NotFound: ({ path }) => path,
  })
export const section = (route: AppRoute): "Policies" | "Rules" | "Activity" | "Settings" => {
  switch (route._tag) {
    case "Rules":
    case "NewRule":
    case "Rule":
    case "TestRules":
      return "Rules"
    case "Activity":
      return "Activity"
    case "Settings":
      return "Settings"
    default:
      return "Policies"
  }
}
export const sectionPath = (
  repositoryId: string,
  section: "Policies" | "Rules" | "Activity" | "Settings",
): string =>
  ({ Policies: policies, Rules: rules, Activity: activity, Settings: settings })[section]({
    repositoryId,
  })
export const urlPath = (url: Url.Url): string => path(parse(url))
export const documentPath = (route: AppRoute): string => {
  switch (route._tag) {
    case "Policies":
      return policies({ repositoryId: route.repositoryId })
    case "NewPolicy":
      return newPolicy({ repositoryId: route.repositoryId })
    case "Policy":
      return policy({ repositoryId: route.repositoryId, policyId: route.policyId })
    default:
      return path(route)
  }
}

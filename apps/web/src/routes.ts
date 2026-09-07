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
  Connect: {},
  ConnectReturn: {
    state: Schema.optionalKey(Schema.String),
    setup_action: Schema.optionalKey(Schema.String),
  },
  Repository: repository,
  Policies: { ...repository, ...policyQuery },
  NewPolicy: { ...repository, ...policyQuery },
  Policy: { ...repository, policyId: Schema.String, ...policyQuery },
  Rules: repository,
  NewRule: repository,
  Rule: { ...repository, ruleId: Schema.String },
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
export const connect = pipe(
  Route.literal("repositories"),
  Route.slash(Route.literal("connect")),
  Route.mapTo(AppRoute.Connect),
)
export const connectReturn = pipe(
  Route.literal("repositories"),
  Route.slash(Route.literal("connect")),
  Route.slash(Route.literal("return")),
  Route.query(
    Schema.Struct({
      state: Schema.optionalKey(Schema.String),
      setup_action: Schema.optionalKey(Schema.String),
    }),
  ),
  Route.mapTo(AppRoute.ConnectReturn),
)
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
// Old bookmarks open the rules table instead of treating "test" as a rule ID.
const legacyRuleTest = pipe(
  ruleBase,
  Route.slash(Route.literal("test")),
  Route.mapTo(AppRoute.Rules),
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
    connectReturn,
    connect,
    repositoryHome,
    policies,
    newPolicy,
    policy,
    rules,
    newRule,
    legacyRuleTest,
    rule,
    activity,
    settings,
  ),
  AppRoute.NotFound,
)
export const path = (route: AppRoute): string =>
  AppRoute.match(route, {
    Home: home,
    Connect: connect,
    ConnectReturn: connectReturn,
    Repository: repositoryHome,
    Policies: policies,
    NewPolicy: newPolicy,
    Policy: policy,
    Rules: rules,
    NewRule: newRule,
    Rule: rule,
    Activity: activity,
    Settings: settings,
    NotFound: ({ path }) => path,
  })
export const section = (
  route: AppRoute,
): "Overview" | "Policies" | "Rules" | "Activity" | "Settings" => {
  switch (route._tag) {
    case "Repository":
      return "Overview"
    case "Rules":
    case "NewRule":
    case "Rule":
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
  section: "Overview" | "Policies" | "Rules" | "Activity" | "Settings",
): string =>
  ({
    Overview: repositoryHome,
    Policies: policies,
    Rules: rules,
    Activity: activity,
    Settings: settings,
  })[section]({
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

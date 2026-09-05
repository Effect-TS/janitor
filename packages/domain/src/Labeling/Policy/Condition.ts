import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"
import { GitHubLabelDatabaseId } from "../../GitHub/Id.ts"
import { FactCatalog, type FactName, FactName as FactNameSchema, factNames } from "./Facts.ts"

/**
 * Conditions (plan: "Conditions", "One program schema"). The runtime form
 * is tagged; the authoring form people type is keyed by shape. One
 * transformation, `conditionFromSource`, joins them and needs only a way
 * to resolve policy names to IDs.
 */

export const PolicyId = Schema.String.check(Schema.isMinLength(1))
  .pipe(Schema.brand("PolicyId"))
  .annotate({ identifier: "PolicyId" })
export type PolicyId = typeof PolicyId.Type

export const MAX_GROUP_SIZE = 32

// OPERATORS, once per fact type

export const TextValueOperator = Schema.Literals(["equals", "notEquals", "contains", "matchesGlob"])
export const TextSetOperator = Schema.Literal("in")
export const EmptyOperator = Schema.Literals(["isEmpty", "notEmpty"])
export const FlagOperator = Schema.Literal("is")
export const LabelSetOperator = Schema.Literal("has")
export const Quantifier = Schema.Literals(["some", "every", "none"])
export type Quantifier = typeof Quantifier.Type

const caseSensitive = Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))
const Group = <A, I>(schema: Schema.Codec<A, I>) =>
  Schema.Array(schema).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_GROUP_SIZE))

// RUNTIME FORM

export type TextPredicate<Field extends string> =
  | {
      readonly _tag: "Fact"
      readonly fact: Field
      readonly operator: "equals" | "notEquals" | "contains" | "matchesGlob"
      readonly value: string
      readonly caseSensitive: boolean
    }
  | {
      readonly _tag: "Fact"
      readonly fact: Field
      readonly operator: "in"
      readonly value: ReadonlyArray<string>
      readonly caseSensitive: boolean
    }
  | { readonly _tag: "Fact"; readonly fact: Field; readonly operator: "isEmpty" | "notEmpty" }

export type FlagPredicate<Field extends string> = {
  readonly _tag: "Fact"
  readonly fact: Field
  readonly operator: "is"
  readonly value: boolean
}

export type LabelSetPredicate<Field extends string> =
  | {
      readonly _tag: "Fact"
      readonly fact: Field
      readonly operator: "has"
      readonly value: GitHubLabelDatabaseId
    }
  | { readonly _tag: "Fact"; readonly fact: Field; readonly operator: "isEmpty" | "notEmpty" }

export type ItemCondition =
  | { readonly _tag: "All" | "Any"; readonly conditions: ReadonlyArray<ItemCondition> }
  | { readonly _tag: "Not"; readonly condition: ItemCondition }
  | TextPredicate<string>
  | FlagPredicate<string>

export type Condition =
  | { readonly _tag: "All" | "Any"; readonly conditions: ReadonlyArray<Condition> }
  | { readonly _tag: "Not"; readonly condition: Condition }
  | TextPredicate<FactName>
  | FlagPredicate<FactName>
  | LabelSetPredicate<FactName>
  | {
      readonly _tag: "Collection"
      readonly fact: FactName
      readonly quantifier: Quantifier
      readonly where: ItemCondition
    }
  | { readonly _tag: "Policy"; readonly policyId: PolicyId }

/** Generated schemas are typed loosely; the hand-written types above are the contract. */
type AnyStruct = Schema.Struct<Schema.Struct.Fields>

const textPredicates = <F extends Schema.Codec<string, string>>(fact: F): Array<AnyStruct> => [
  Schema.Struct({
    _tag: Schema.Literal("Fact"),
    fact,
    operator: TextValueOperator,
    value: Schema.String,
    caseSensitive,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Fact"),
    fact,
    operator: TextSetOperator,
    value: Schema.NonEmptyArray(Schema.String),
    caseSensitive,
  }),
  Schema.Struct({ _tag: Schema.Literal("Fact"), fact, operator: EmptyOperator }),
]

const flagPredicate = <F extends Schema.Codec<string, string>>(fact: F) =>
  Schema.Struct({
    _tag: Schema.Literal("Fact"),
    fact,
    operator: FlagOperator,
    value: Schema.Boolean,
  })

const labelSetPredicates = <F extends Schema.Codec<string, string>>(fact: F): Array<AnyStruct> => [
  Schema.Struct({
    _tag: Schema.Literal("Fact"),
    fact,
    operator: LabelSetOperator,
    value: GitHubLabelDatabaseId,
  }),
  Schema.Struct({ _tag: Schema.Literal("Fact"), fact, operator: EmptyOperator }),
]

/** Item predicates are typed by the collection's declared fields. */
const itemPredicatesFor = (fields: Readonly<Record<string, "Text" | "Flag">>): Array<AnyStruct> =>
  Object.entries(fields).flatMap(([field, type]): Array<AnyStruct> =>
    type === "Text"
      ? textPredicates(Schema.Literal(field))
      : [flagPredicate(Schema.Literal(field))],
  )

const itemConditionFor = (fields: Readonly<Record<string, "Text" | "Flag">>) => {
  const self: Schema.Codec<ItemCondition, unknown> = Schema.suspend(
    () =>
      Schema.Union([
        Schema.Struct({ _tag: Schema.Literals(["All", "Any"]), conditions: Group(self) }),
        Schema.Struct({ _tag: Schema.Literal("Not"), condition: self }),
        ...itemPredicatesFor(fields),
      ]) as unknown as Schema.Codec<ItemCondition, unknown>,
  )
  return self
}

/** Every fact predicate the catalog admits, generated from fact types. */
const factPredicates: Array<AnyStruct> = factNames.flatMap((name): Array<AnyStruct> => {
  const definition = FactCatalog[name]
  const fact = Schema.Literal(name)
  switch (definition.type._tag) {
    case "Text":
      return textPredicates(fact)
    case "Flag":
      return [flagPredicate(fact)]
    case "LabelSet":
      return labelSetPredicates(fact)
    case "Collection":
      return [
        Schema.Struct({
          _tag: Schema.Literal("Collection"),
          fact,
          quantifier: Quantifier,
          where: itemConditionFor(definition.type.fields),
        }),
      ]
  }
})

export const Condition: Schema.Codec<Condition, unknown> = Schema.suspend(
  () =>
    Schema.Union([
      Schema.Struct({ _tag: Schema.Literals(["All", "Any"]), conditions: Group(Condition) }),
      Schema.Struct({ _tag: Schema.Literal("Not"), condition: Condition }),
      ...factPredicates,
      Schema.Struct({ _tag: Schema.Literal("Policy"), policyId: PolicyId }),
    ]) as unknown as Schema.Codec<Condition, unknown>,
).annotate({ identifier: "Condition" })

// AUTHORING FORM

/** Distributes over a union, unlike a bare `Omit`, and makes the defaulted key optional. */
type Authored<T> = T extends { readonly _tag: string }
  ? T extends { readonly caseSensitive: boolean }
    ? Omit<T, "_tag" | "caseSensitive"> & { readonly caseSensitive?: boolean }
    : Omit<T, "_tag">
  : never

export type ItemConditionSource =
  | { readonly all: ReadonlyArray<ItemConditionSource> }
  | { readonly any: ReadonlyArray<ItemConditionSource> }
  | { readonly not: ItemConditionSource }
  | Authored<TextPredicate<string>>
  | Authored<FlagPredicate<string>>

export type ConditionSource =
  | { readonly all: ReadonlyArray<ConditionSource> }
  | { readonly any: ReadonlyArray<ConditionSource> }
  | { readonly not: ConditionSource }
  | Authored<TextPredicate<FactName>>
  | Authored<FlagPredicate<FactName>>
  | Authored<LabelSetPredicate<FactName>>
  | { readonly some: FactName; readonly where: ItemConditionSource }
  | { readonly every: FactName; readonly where: ItemConditionSource }
  | { readonly none: FactName; readonly where: ItemConditionSource }
  | { readonly policy: string }

const untagged = (struct: AnyStruct): AnyStruct => {
  const { _tag: _, ...fields } = struct.fields
  return Schema.Struct(fields)
}

const itemSourceFor = (fields: Readonly<Record<string, "Text" | "Flag">>) => {
  const self: Schema.Codec<ItemConditionSource, unknown> = Schema.suspend(
    () =>
      Schema.Union([
        Schema.Struct({ all: Group(self) }),
        Schema.Struct({ any: Group(self) }),
        Schema.Struct({ not: self }),
        ...itemPredicatesFor(fields).map(untagged),
      ]) as unknown as Schema.Codec<ItemConditionSource, unknown>,
  )
  return self
}

const factSources: Array<AnyStruct> = factNames.flatMap((name): Array<AnyStruct> => {
  const definition = FactCatalog[name]
  const fact = Schema.Literal(name)
  switch (definition.type._tag) {
    case "Text":
      return textPredicates(fact).map(untagged)
    case "Flag":
      return [untagged(flagPredicate(fact))]
    case "LabelSet":
      return labelSetPredicates(fact).map(untagged)
    case "Collection": {
      const where = itemSourceFor(definition.type.fields)
      return [
        Schema.Struct({ some: fact, where }),
        Schema.Struct({ every: fact, where }),
        Schema.Struct({ none: fact, where }),
      ]
    }
  }
})

export const ConditionSource: Schema.Codec<ConditionSource, unknown> = Schema.suspend(
  () =>
    Schema.Union([
      Schema.Struct({ all: Group(ConditionSource) }),
      Schema.Struct({ any: Group(ConditionSource) }),
      Schema.Struct({ not: ConditionSource }),
      ...factSources,
      Schema.Struct({ policy: Schema.String.check(Schema.isMinLength(1)) }),
    ]) as unknown as Schema.Codec<ConditionSource, unknown>,
).annotate({
  identifier: "ConditionSource",
  parseOptions: { onExcessProperty: "error" },
})

// TRANSFORMATION

export interface PolicyNames {
  /** Resolves an authored policy name to its ID. */
  readonly resolve: (name: string) => PolicyId | undefined
  /** Formats an ID as the name people see. */
  readonly format: (policyId: PolicyId) => string
}

const itemFromSource = (source: ItemConditionSource): ItemCondition => {
  if ("all" in source) return { _tag: "All", conditions: source.all.map(itemFromSource) }
  if ("any" in source) return { _tag: "Any", conditions: source.any.map(itemFromSource) }
  if ("not" in source) return { _tag: "Not", condition: itemFromSource(source.not) }
  return { _tag: "Fact", ...source } as ItemCondition
}

const itemToSource = (item: ItemCondition): ItemConditionSource => {
  switch (item._tag) {
    case "All":
      return { all: item.conditions.map(itemToSource) }
    case "Any":
      return { any: item.conditions.map(itemToSource) }
    case "Not":
      return { not: itemToSource(item.condition) }
    case "Fact": {
      const { _tag: _, ...source } = item
      return source as ItemConditionSource
    }
  }
}

export class UnknownPolicyName extends Data.TaggedError("UnknownPolicyName")<{
  readonly name: string
}> {}

export const conditionFromSource = (
  source: ConditionSource,
  names: PolicyNames,
): Condition | UnknownPolicyName => {
  if ("all" in source) {
    const conditions = source.all.map((child) => conditionFromSource(child, names))
    const failed = conditions.find((child) => child instanceof UnknownPolicyName)
    return failed ?? { _tag: "All", conditions: conditions as Array<Condition> }
  }
  if ("any" in source) {
    const conditions = source.any.map((child) => conditionFromSource(child, names))
    const failed = conditions.find((child) => child instanceof UnknownPolicyName)
    return failed ?? { _tag: "Any", conditions: conditions as Array<Condition> }
  }
  if ("not" in source) {
    const condition = conditionFromSource(source.not, names)
    return condition instanceof UnknownPolicyName ? condition : { _tag: "Not", condition }
  }
  if ("policy" in source) {
    const policyId = names.resolve(source.policy)
    return policyId === undefined
      ? new UnknownPolicyName({ name: source.policy })
      : { _tag: "Policy", policyId }
  }
  if ("some" in source)
    return {
      _tag: "Collection",
      fact: source.some,
      quantifier: "some",
      where: itemFromSource(source.where),
    }
  if ("every" in source)
    return {
      _tag: "Collection",
      fact: source.every,
      quantifier: "every",
      where: itemFromSource(source.where),
    }
  if ("none" in source)
    return {
      _tag: "Collection",
      fact: source.none,
      quantifier: "none",
      where: itemFromSource(source.where),
    }
  return { _tag: "Fact", ...source } as Condition
}

export const conditionToSource = (condition: Condition, names: PolicyNames): ConditionSource => {
  switch (condition._tag) {
    case "All":
      return { all: condition.conditions.map((child) => conditionToSource(child, names)) }
    case "Any":
      return { any: condition.conditions.map((child) => conditionToSource(child, names)) }
    case "Not":
      return { not: conditionToSource(condition.condition, names) }
    case "Policy":
      return { policy: names.format(condition.policyId) }
    case "Collection": {
      const where = itemToSource(condition.where)
      switch (condition.quantifier) {
        case "some":
          return { some: condition.fact, where }
        case "every":
          return { every: condition.fact, where }
        case "none":
          return { none: condition.fact, where }
      }
    }
    // eslint-disable-next-line no-fallthrough -- exhaustive above
    case "Fact": {
      const { _tag: _, ...source } = condition
      return source as ConditionSource
    }
  }
}

/** A schema that decodes the authoring form into the runtime form for one repository's policy names. */
export const ConditionFromSource = (names: PolicyNames) =>
  ConditionSource.pipe(
    Schema.decodeTo(Condition, {
      decode: SchemaGetter.transformOrFail(
        (source: ConditionSource): Effect.Effect<unknown, SchemaIssue.Issue> => {
          const condition = conditionFromSource(source, names)
          return condition instanceof UnknownPolicyName
            ? Effect.fail(
                new SchemaIssue.InvalidValue({
                  message: `Policy '${condition.name}' does not exist in this repository`,
                }),
              )
            : Effect.succeed(condition)
        },
      ),
      encode: SchemaGetter.transform((condition: unknown) =>
        conditionToSource(condition as Condition, names),
      ),
    }),
  )

/** Facts a condition reads, without following policy references. */
export const conditionFacts = (condition: Condition): ReadonlyArray<FactName> => {
  switch (condition._tag) {
    case "All":
    case "Any":
      return condition.conditions.flatMap(conditionFacts)
    case "Not":
      return conditionFacts(condition.condition)
    case "Fact":
    case "Collection":
      return [condition.fact]
    case "Policy":
      return []
  }
}

export const conditionReferences = (condition: Condition): ReadonlyArray<PolicyId> => {
  switch (condition._tag) {
    case "All":
    case "Any":
      return condition.conditions.flatMap(conditionReferences)
    case "Not":
      return conditionReferences(condition.condition)
    case "Policy":
      return [condition.policyId]
    case "Fact":
    case "Collection":
      return []
  }
}

export const isFactName = (value: string): value is FactName =>
  FactNameSchema.literals.some((name) => name === value)

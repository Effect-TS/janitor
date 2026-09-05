import type { Condition, ItemCondition, PolicyId } from "./Condition.ts"
import type { FactSnapshot, FactValue, ItemValue } from "./Facts.ts"
import {
  type Evaluation,
  formatNodeLocation,
  MAX_TRACE,
  type NodeLocation,
  type NodeRoot,
  type NodeTrace,
  type Program,
  type Truth,
} from "./Program.ts"

/**
 * Pure evaluation (plan: "Three-valued logic, stated once"). Truth values
 * combine under Kleene's tables: `unknown` is absorbed by a decisive
 * sibling and propagates otherwise. There is no confidence and no I/O.
 */

export interface Resolved {
  readonly program: Program
}

/** Referenced policies at the versions the configuration was compiled with. */
export type Resolver = (policyId: PolicyId) => Resolved | undefined

export const MAX_REFERENCE_DEPTH = 4

// TRUTH TABLES

export const not = (truth: Truth): Truth =>
  truth === "match" ? "no-match" : truth === "no-match" ? "match" : "unknown"

export const all = (truths: ReadonlyArray<Truth>): Truth =>
  truths.includes("no-match") ? "no-match" : truths.includes("unknown") ? "unknown" : "match"

export const any = (truths: ReadonlyArray<Truth>): Truth =>
  truths.includes("match") ? "match" : truths.includes("unknown") ? "unknown" : "no-match"

// PREDICATES

const fold = (value: string, caseSensitive: boolean) =>
  caseSensitive ? value : value.toLowerCase()

/** `*` and `?` only, bounded so a pattern cannot be made expensive. */
export const matchesGlob = (pattern: string, value: string): boolean => {
  if (pattern.length > 200 || value.length > 1_000) return false
  let patternIndex = 0
  let valueIndex = 0
  let star = -1
  let mark = 0
  while (valueIndex < value.length) {
    const current = pattern[patternIndex]
    if (patternIndex < pattern.length && (current === "?" || current === value[valueIndex])) {
      patternIndex++
      valueIndex++
    } else if (patternIndex < pattern.length && current === "*") {
      star = patternIndex++
      mark = valueIndex
    } else if (star >= 0) {
      patternIndex = star + 1
      valueIndex = ++mark
    } else return false
  }
  while (pattern[patternIndex] === "*") patternIndex++
  return patternIndex === pattern.length
}

const textTruth = (
  actual: string | null,
  predicate: Extract<Condition, { readonly _tag: "Fact" }>,
): Truth => {
  switch (predicate.operator) {
    case "isEmpty":
      return actual === null || actual === "" ? "match" : "no-match"
    case "notEmpty":
      return actual !== null && actual !== "" ? "match" : "no-match"
    case "is":
    case "has":
      return "unknown"
    case "equals":
      return actual !== null &&
        fold(actual, predicate.caseSensitive) === fold(predicate.value, predicate.caseSensitive)
        ? "match"
        : "no-match"
    case "notEquals":
      return actual !== null &&
        fold(actual, predicate.caseSensitive) !== fold(predicate.value, predicate.caseSensitive)
        ? "match"
        : "no-match"
    case "contains":
      return actual !== null &&
        fold(actual, predicate.caseSensitive).includes(
          fold(predicate.value, predicate.caseSensitive),
        )
        ? "match"
        : "no-match"
    case "matchesGlob":
      return actual !== null &&
        matchesGlob(
          fold(predicate.value, predicate.caseSensitive),
          fold(actual, predicate.caseSensitive),
        )
        ? "match"
        : "no-match"
    case "in":
      return actual !== null &&
        predicate.value.some(
          (candidate) =>
            fold(candidate, predicate.caseSensitive) === fold(actual, predicate.caseSensitive),
        )
        ? "match"
        : "no-match"
  }
}

/** A fact's typed value against a predicate; a type mismatch is unknown, not an error. */
const factTruth = (
  value: FactValue,
  predicate: Extract<Condition, { readonly _tag: "Fact" }>,
): Truth => {
  switch (value._tag) {
    case "Text":
      return textTruth(value.value, predicate)
    case "Flag":
      return predicate.operator === "is"
        ? value.value === predicate.value
          ? "match"
          : "no-match"
        : "unknown"
    case "LabelSet":
      switch (predicate.operator) {
        case "has":
          return value.value.includes(predicate.value) ? "match" : "no-match"
        case "isEmpty":
          return value.value.length === 0 ? "match" : "no-match"
        case "notEmpty":
          return value.value.length > 0 ? "match" : "no-match"
        default:
          return "unknown"
      }
    case "Collection":
      return "unknown"
  }
}

const itemTruth = (item: ItemValue, condition: ItemCondition): Truth => {
  switch (condition._tag) {
    case "All":
      return all(condition.conditions.map((child) => itemTruth(item, child)))
    case "Any":
      return any(condition.conditions.map((child) => itemTruth(item, child)))
    case "Not":
      return not(itemTruth(item, condition.condition))
    case "Fact": {
      const field = item[condition.fact]
      if (field === undefined) return "unknown"
      if (typeof field === "boolean") {
        return condition.operator === "is"
          ? field === condition.value
            ? "match"
            : "no-match"
          : "unknown"
      }
      return textTruth(field, condition as Extract<Condition, { readonly _tag: "Fact" }>)
    }
  }
}

const quantify = (quantifier: "some" | "every" | "none", truths: ReadonlyArray<Truth>): Truth => {
  switch (quantifier) {
    case "some":
      return any(truths)
    case "every":
      return all(truths)
    case "none":
      return not(any(truths))
  }
}

// EVALUATION

const child = (location: NodeLocation, index: number): NodeLocation => ({
  ...location,
  path: [...location.path, { _tag: "Child", index }],
})
const negated = (location: NodeLocation): NodeLocation => ({
  ...location,
  path: [...location.path, { _tag: "Not" }],
})
const referenced = (location: NodeLocation, policyId: PolicyId, root: NodeRoot): NodeLocation => ({
  ...location,
  path: [...location.path, { _tag: "Policy", policyId, root }],
})

export interface EvaluateInput {
  readonly program: Program
  readonly snapshot: FactSnapshot
  readonly resolve: Resolver
}

/**
 * Evaluates a program against a snapshot. A referenced policy that does
 * not apply contributes `unknown` to the condition using it, since
 * "out of scope" is not evidence either way.
 */
const runEvaluation = (
  { program, snapshot, resolve }: EvaluateInput,
  applicabilityOnly: boolean,
): Evaluation => {
  const trace: Array<NodeTrace> = []
  const active = new Set<PolicyId>()

  const record = (location: NodeLocation, outcome: Truth, reason: string): Truth => {
    if (trace.length < MAX_TRACE) trace.push({ location, outcome, reason })
    return outcome
  }

  const condition = (node: Condition, location: NodeLocation): Truth => {
    switch (node._tag) {
      case "All": {
        const truth = all(
          node.conditions.map((entry, index) => condition(entry, child(location, index))),
        )
        return record(location, truth, `all of ${node.conditions.length}`)
      }
      case "Any": {
        const truth = any(
          node.conditions.map((entry, index) => condition(entry, child(location, index))),
        )
        return record(location, truth, `any of ${node.conditions.length}`)
      }
      case "Not":
        return record(location, not(condition(node.condition, negated(location))), "negated")
      case "Fact": {
        const value = snapshot.facts[node.fact]
        if (value === undefined) return record(location, "unknown", `${node.fact} is unavailable`)
        return record(location, factTruth(value, node), `${node.fact} ${node.operator}`)
      }
      case "Collection": {
        const value = snapshot.facts[node.fact]
        if (value === undefined || value._tag !== "Collection") {
          return record(location, "unknown", `${node.fact} is unavailable`)
        }
        const truths = value.value.map((item) => itemTruth(item, node.where))
        return record(
          location,
          quantify(node.quantifier, truths),
          `${node.quantifier} of ${truths.length} ${node.fact}`,
        )
      }
      case "Policy": {
        if (active.has(node.policyId) || active.size >= MAX_REFERENCE_DEPTH) {
          return record(location, "unknown", `policy ${node.policyId} reference cycle or depth`)
        }
        const resolved = resolve(node.policyId)
        if (resolved === undefined)
          return record(location, "unknown", `policy ${node.policyId} is unavailable`)
        active.add(node.policyId)
        const outcome = evaluateProgram(
          resolved.program,
          referenced(location, node.policyId, "appliesWhen"),
          referenced(location, node.policyId, "matchesWhen"),
        )
        active.delete(node.policyId)
        const truth: Truth = outcome === "not-applicable" ? "unknown" : outcome
        return record(location, truth, `policy ${node.policyId} ${outcome}`)
      }
    }
  }

  const evaluateProgram = (
    current: Program,
    appliesLocation: NodeLocation,
    matchesLocation: NodeLocation,
    evaluateMatches = true,
  ): Evaluation["outcome"] => {
    if (current.target !== snapshot.kind) return "not-applicable"
    if (current.appliesWhen !== null) {
      const applies = condition(current.appliesWhen, appliesLocation)
      if (applies === "no-match") return "not-applicable"
      if (applies === "unknown") return "unknown"
    }
    if (!evaluateMatches) return "match"
    if (current.evaluator._tag === "Classifier") {
      // A provider evaluates classifiers; without one the answer is unknown.
      record(matchesLocation, "unknown", "classifier needs a provider")
      return "unknown"
    }
    return condition(current.evaluator.matchesWhen, matchesLocation)
  }

  const outcome = evaluateProgram(
    program,
    { root: "appliesWhen", path: [] },
    { root: "matchesWhen", path: [] },
    !applicabilityOnly,
  )
  const last = trace[trace.length - 1]
  const reason =
    outcome === "not-applicable"
      ? program.target !== snapshot.kind
        ? `targets ${program.target}`
        : "applicability did not match"
      : last === undefined
        ? outcome
        : `${formatNodeLocation(last.location)}: ${last.reason}`
  return { outcome, reason, trace }
}

export const evaluate = (input: EvaluateInput): Evaluation => runEvaluation(input, false)

/** Checks target and applicability, including full evaluation of referenced policies. */
export const evaluateApplicability = (input: EvaluateInput): Evaluation =>
  runEvaluation(input, true)

import * as Data from "effect/Data"
import * as Schema from "effect/Schema"
import type { Condition, ItemCondition, PolicyId } from "./Condition.ts"
import {
  FactCatalog,
  type FactName,
  FactName as FactNameSchema,
  FactTrack,
  tracksFor,
} from "./Facts.ts"
import { MAX_REFERENCE_DEPTH, type Resolver } from "./Evaluate.ts"
import {
  formatNodeLocation,
  type NodeLocation,
  type NodeRoot,
  PolicyTarget,
  type Program,
} from "./Program.ts"

/**
 * Compilation (plan: "Compilation"). Publishing runs this once. It checks
 * what evaluation would otherwise discover late, and its manifest tells
 * activation which synchronization tracks the program needs.
 */

export const MAX_DEPTH = 8
export const MAX_NODES = 64
export const MAX_EXPANDED_NODES = 256
export const MAX_REFERENCES = 8

export const CompileIssueCode = Schema.Literals([
  "fact-kind-mismatch",
  "limit-exceeded",
  "missing-reference",
  "reference-cycle",
  "reference-target-mismatch",
  "classifier-reference",
]).annotate({ identifier: "CompileIssueCode" })
export type CompileIssueCode = typeof CompileIssueCode.Type

export class CompileIssue extends Data.TaggedError("CompileIssue")<{
  readonly code: CompileIssueCode
  readonly message: string
  readonly location: NodeLocation
}> {}

/** What a published version records about itself. */
export const Manifest = Schema.Struct({
  facts: Schema.Array(FactNameSchema),
  tracks: Schema.Array(FactTrack),
  references: Schema.Array(Schema.String),
  nodeCount: Schema.Int,
  expandedNodeCount: Schema.Int,
}).annotate({ identifier: "Manifest" })
export type Manifest = typeof Manifest.Type

export interface CompileInput {
  readonly program: Program
  readonly resolve: Resolver
  /** The policy being compiled, so a self-reference is a cycle. */
  readonly policyId?: PolicyId
}

export type CompileResult =
  | { readonly _tag: "Compiled"; readonly manifest: Manifest }
  | { readonly _tag: "Rejected"; readonly issue: CompileIssue }

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

const itemDepth = (item: ItemCondition): number => {
  switch (item._tag) {
    case "All":
    case "Any":
      return 1 + Math.max(0, ...item.conditions.map(itemDepth))
    case "Not":
      return 1 + itemDepth(item.condition)
    case "Fact":
      return 1
  }
}

const itemNodes = (item: ItemCondition): number => {
  switch (item._tag) {
    case "All":
    case "Any":
      return 1 + item.conditions.reduce((sum, entry) => sum + itemNodes(entry), 0)
    case "Not":
      return 1 + itemNodes(item.condition)
    case "Fact":
      return 1
  }
}

export const compile = ({ program, resolve, policyId }: CompileInput): CompileResult => {
  const facts = new Set<FactName>()
  const references = new Set<PolicyId>()
  let nodes = 0
  let expanded = 0

  const reject = (code: CompileIssueCode, message: string, location: NodeLocation): CompileIssue =>
    new CompileIssue({ code, message: `${message} at ${formatNodeLocation(location)}`, location })

  const count = (
    local: boolean,
    depth: number,
    extra: number,
    location: NodeLocation,
  ): CompileIssue | undefined => {
    expanded += extra
    if (local) nodes += extra
    if (depth > MAX_DEPTH || nodes > MAX_NODES || expanded > MAX_EXPANDED_NODES) {
      return reject(
        "limit-exceeded",
        `Program exceeds depth ${MAX_DEPTH}, ${MAX_NODES} nodes, or ${MAX_EXPANDED_NODES} expanded nodes`,
        location,
      )
    }
    return undefined
  }

  const visit = (
    node: Condition,
    target: PolicyTarget,
    local: boolean,
    depth: number,
    stack: ReadonlySet<PolicyId>,
    location: NodeLocation,
  ): CompileIssue | undefined => {
    const limit = count(local, depth, 1, location)
    if (limit !== undefined) return limit
    switch (node._tag) {
      case "All":
      case "Any":
        for (const [index, entry] of node.conditions.entries()) {
          const issue = visit(entry, target, local, depth + 1, stack, child(location, index))
          if (issue !== undefined) return issue
        }
        return undefined
      case "Not":
        return visit(node.condition, target, local, depth + 1, stack, negated(location))
      case "Fact":
      case "Collection": {
        if (!FactCatalog[node.fact].kinds.includes(target)) {
          return reject(
            "fact-kind-mismatch",
            `Fact '${node.fact}' does not exist for ${target}`,
            location,
          )
        }
        facts.add(node.fact)
        if (node._tag === "Collection") {
          return count(local, depth + itemDepth(node.where), itemNodes(node.where), location)
        }
        return undefined
      }
      case "Policy": {
        if (stack.has(node.policyId) || node.policyId === policyId) {
          return reject(
            "reference-cycle",
            `Policy reference cycle includes '${node.policyId}'`,
            location,
          )
        }
        if (
          stack.size >= MAX_REFERENCE_DEPTH ||
          (!references.has(node.policyId) && references.size >= MAX_REFERENCES)
        ) {
          return reject(
            "limit-exceeded",
            `Program references more than ${MAX_REFERENCES} policies or deeper than ${MAX_REFERENCE_DEPTH}`,
            location,
          )
        }
        references.add(node.policyId)
        const resolved = resolve(node.policyId)
        if (resolved === undefined) {
          return reject("missing-reference", `Policy '${node.policyId}' is not published`, location)
        }
        if (resolved.program.evaluator._tag === "Classifier") {
          return reject(
            "classifier-reference",
            `Policy '${node.policyId}' is a classifier and cannot be referenced by a condition`,
            location,
          )
        }
        if (resolved.program.target !== target) {
          return reject(
            "reference-target-mismatch",
            `Policy '${node.policyId}' targets ${resolved.program.target}, expected ${target}`,
            location,
          )
        }
        const next = new Set(stack)
        next.add(node.policyId)
        return visitProgram(resolved.program, false, depth + 1, next, location, node.policyId)
      }
    }
  }

  const visitProgram = (
    current: Program,
    local: boolean,
    depth: number,
    stack: ReadonlySet<PolicyId>,
    parent: NodeLocation | undefined,
    via: PolicyId | undefined,
  ): CompileIssue | undefined => {
    const applies: NodeLocation =
      parent === undefined || via === undefined
        ? { root: "appliesWhen", path: [] }
        : referenced(parent, via, "appliesWhen")
    const matches: NodeLocation =
      parent === undefined || via === undefined
        ? { root: "matchesWhen", path: [] }
        : referenced(parent, via, "matchesWhen")
    if (current.appliesWhen !== null) {
      const issue = visit(current.appliesWhen, current.target, local, depth, stack, applies)
      if (issue !== undefined) return issue
    }
    if (current.evaluator._tag === "Classifier") {
      for (const fact of current.evaluator.evidence) {
        if (!FactCatalog[fact].kinds.includes(current.target)) {
          return reject(
            "fact-kind-mismatch",
            `Fact '${fact}' does not exist for ${current.target}`,
            matches,
          )
        }
        facts.add(fact)
      }
      return count(local, depth, 1, matches)
    }
    return visit(current.evaluator.matchesWhen, current.target, local, depth, stack, matches)
  }

  const issue = visitProgram(program, true, 1, new Set(), undefined, undefined)
  if (issue !== undefined) return { _tag: "Rejected", issue }
  const sortedFacts = [...facts].sort()
  return {
    _tag: "Compiled",
    manifest: {
      facts: sortedFacts,
      tracks: tracksFor(sortedFacts),
      references: [...references].sort(),
      nodeCount: nodes,
      expandedNodeCount: expanded,
    },
  }
}

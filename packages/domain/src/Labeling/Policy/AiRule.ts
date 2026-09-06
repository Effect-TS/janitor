import * as Schema from "effect/Schema"
import { inspectAiPrompt } from "./PromptReferences.ts"
import { describeCatalog, type FactName } from "./Facts.ts"
import { ClassifierPrompt, Confidence, PolicyTarget, type Program } from "./Program.ts"
export const AiRuleDefinition = Schema.Struct({
  target: PolicyTarget,
  prompt: ClassifierPrompt,
  minimumConfidence: Confidence,
})
export type AiRuleDefinition = typeof AiRuleDefinition.Type
export const inspectAiRule = (definition: AiRuleDefinition) =>
  inspectAiPrompt(definition.prompt, definition.target, describeCatalog())
/** Call only after inspectAiRule reports no diagnostics. */
export const aiRuleProgram = (definition: AiRuleDefinition): Program => ({
  target: definition.target,
  appliesWhen: null,
  evaluator: {
    _tag: "Classifier",
    prompt: definition.prompt,
    evidence: inspectAiRule(definition).references as [FactName, ...Array<FactName>],
    minimumConfidence: definition.minimumConfidence,
  },
})

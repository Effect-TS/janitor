/** Inspect the plan Alchemy will actually apply, including binding removals. */
export const destructiveChanges = (plan: {
  resources: Record<
    string,
    { action: string; bindings: readonly { action: string; sid: string }[] }
  >
  deletions: Record<string, unknown>
}): string[] => [
  ...Object.keys(plan.deletions).map((id) => `${id}: delete`),
  ...Object.entries(plan.resources).flatMap(([id, node]) => [
    ...(node.action === "replace" ? [`${id}: replace`] : []),
    ...node.bindings
      .filter((binding) => binding.action === "delete")
      .map((binding) => `${id}/${binding.sid}: delete binding`),
  ]),
]

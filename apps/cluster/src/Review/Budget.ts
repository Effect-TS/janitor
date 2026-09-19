/** Reserve time within the original deadline to assess evidence and write a conclusion. */
export const CONCLUSION_RESERVE_MS = 120_000
const FINISH_RESERVE_MS = 60_000

export const reviewBudget = (remainingMs: number) => ({
  remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
  investigationMs: Math.max(0, remainingMs - CONCLUSION_RESERVE_MS),
  phase:
    remainingMs <= FINISH_RESERVE_MS
      ? ("finish" as const)
      : remainingMs <= CONCLUSION_RESERVE_MS
        ? ("assess" as const)
        : ("investigate" as const),
})
export type ReviewBudget = ReturnType<typeof reviewBudget>

// Per-turn timing and token figures derived from clanka's output events.
//
// One model turn is: the model streams reasoning and a script (`ScriptStart`
// marks the script's arrival), the executor runs it (`ScriptOutput`), and the
// model stream's `finish` part arrives last (`Usage`), because clanka runs the
// `execute` tool inside the model stream. The next turn starts at `Usage`.

export interface TurnEvent {
  readonly at: number
  readonly _tag?: string
  readonly contextTokens?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

export interface TurnTiming {
  readonly turn: number
  readonly startedAt: number
  readonly scriptStartedAt: number | undefined
  readonly scriptEndedAt: number | undefined
  readonly endedAt: number | undefined
  /** time from the turn's start to the script's arrival (or to the end) */
  readonly modelMs: number | undefined
  readonly scriptMs: number | undefined
  readonly totalMs: number | undefined
  readonly contextTokens: number | undefined
  readonly outputTokens: number | undefined
  readonly cacheRead: number | undefined
  readonly cacheWrite: number | undefined
}

export const deriveTurns = (events: ReadonlyArray<TurnEvent>, startedAt: number): Array<TurnTiming> => {
  const turns: Array<TurnTiming> = []
  let turn = 1
  let turnStart = startedAt
  let scriptStartedAt: number | undefined
  let scriptEndedAt: number | undefined
  let cumulativeOutput = 0
  let cumulativeCacheRead = 0
  let cumulativeCacheWrite = 0
  for (const event of events) {
    switch (event._tag) {
      case "AgentStart":
        turnStart = event.at
        break
      case "ScriptStart":
        if (scriptStartedAt === undefined) scriptStartedAt = event.at
        break
      case "ScriptOutput":
        scriptEndedAt = event.at
        break
      case "Usage": {
        const outputTokens = (event.outputTokens ?? 0) - cumulativeOutput
        const cacheRead = (event.cacheRead ?? 0) - cumulativeCacheRead
        const cacheWrite = (event.cacheWrite ?? 0) - cumulativeCacheWrite
        cumulativeOutput = event.outputTokens ?? cumulativeOutput
        cumulativeCacheRead = event.cacheRead ?? cumulativeCacheRead
        cumulativeCacheWrite = event.cacheWrite ?? cumulativeCacheWrite
        turns.push({
          turn,
          startedAt: turnStart,
          scriptStartedAt,
          scriptEndedAt,
          endedAt: event.at,
          modelMs: (scriptStartedAt ?? event.at) - turnStart,
          scriptMs:
            scriptStartedAt === undefined || scriptEndedAt === undefined ? undefined : scriptEndedAt - scriptStartedAt,
          totalMs: event.at - turnStart,
          contextTokens: event.contextTokens,
          outputTokens,
          cacheRead,
          cacheWrite,
        })
        turn++
        turnStart = event.at
        scriptStartedAt = undefined
        scriptEndedAt = undefined
        break
      }
    }
  }
  // A turn that was cut off (failure, interruption) before its `finish` part.
  if (scriptStartedAt !== undefined || scriptEndedAt !== undefined) {
    turns.push({
      turn,
      startedAt: turnStart,
      scriptStartedAt,
      scriptEndedAt,
      endedAt: undefined,
      modelMs: scriptStartedAt === undefined ? undefined : scriptStartedAt - turnStart,
      scriptMs:
        scriptStartedAt === undefined || scriptEndedAt === undefined ? undefined : scriptEndedAt - scriptStartedAt,
      totalMs: undefined,
      contextTokens: undefined,
      outputTokens: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    })
  }
  return turns
}

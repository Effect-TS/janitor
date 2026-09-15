import { Stream } from "effect"
import type { LLMEvent } from "@opencode/ai"

type Delta = Extract<LLMEvent, { type: "text-delta" | "reasoning-delta" | "tool-input-delta" }>

/** Redact decoded output before native event recording and tool execution. */
export const redactModelEvents = <E, R>(
  events: Stream.Stream<LLMEvent, E, R>,
  credential: string | undefined,
): Stream.Stream<LLMEvent, E, R> => {
  if (!credential) return events
  const patterns = [...new Set([credential, JSON.stringify(credential).slice(1, -1)])]
  const redact = (value: string) =>
    patterns.reduce((text, key) => text.replaceAll(key, "[REDACTED]"), value)
  const sanitize = <T>(value: T): T => {
    if (typeof value === "string") return redact(value) as T
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map(sanitize) as T
    const entries = Object.entries(value)
    const cleaned = entries.map(([key, item]) => [redact(key), sanitize(item)] as const)
    if (
      entries.every(([key, item], index) => cleaned[index][0] === key && cleaned[index][1] === item)
    )
      return value
    return Object.assign(
      Object.create(Object.getPrototypeOf(value)),
      Object.fromEntries(cleaned),
    ) as T
  }
  return Stream.suspend(() => {
    const pending = new Map<string, Delta>()
    return events.pipe(
      Stream.map((event): ReadonlyArray<LLMEvent> => {
        if (
          event.type === "text-delta" ||
          event.type === "reasoning-delta" ||
          event.type === "tool-input-delta"
        ) {
          const id = `${event.type}:${event.id}`
          const text = redact((pending.get(id)?.text ?? "") + event.text)
          // Hold only a suffix that could become a credential in the next event.
          let held = 0
          for (const pattern of patterns)
            for (let size = 1; size < pattern.length && size <= text.length; size++)
              if (text.endsWith(pattern.slice(0, size))) held = Math.max(held, size)
          const safe = sanitize(event)
          pending.set(id, { ...safe, text: text.slice(text.length - held) })
          return [{ ...safe, text: text.slice(0, text.length - held) }]
        }
        if (
          event.type === "text-end" ||
          event.type === "reasoning-end" ||
          event.type === "tool-input-end"
        ) {
          const id = `${event.type.replace(/-end$/, "-delta")}:${event.id}`
          const tail = pending.get(id)
          pending.delete(id)
          return tail?.text ? [tail, sanitize(event)] : [sanitize(event)]
        }
        // Final parsed tool inputs and provider metadata can contain the complete
        // value even when incremental text was withheld. Sanitize those too.
        return [sanitize(event)]
      }),
      Stream.flattenIterable,
    )
  })
}

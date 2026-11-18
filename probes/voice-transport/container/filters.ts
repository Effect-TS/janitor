/**
 * What the probe counts and what it lets out of the process, apart from
 * probe.ts (which starts the bot on import) so it can be tested.
 */
import { createHmac } from "node:crypto"
import { ERROR_MESSAGES, UNCLASSIFIED, allowedCode } from "./codes.ts"

const RTP_OPUS = 120

/**
 * True for an RTP version 2 packet carrying Opus (payload type 120): voice
 * media. The IP discovery reply (version bits 0) and RTCP don't count.
 */
export const isRtpOpus = (packet: Uint8Array): boolean =>
  packet.length > 12 && packet[0]! >> 6 === 2 && (packet[1]! & 0x7f) === RTP_OPUS

/**
 * An error as one allowlisted code: its `code` (discord.js, Discord API or
 * Node), its name, or its whole message if that is a known fixed one.
 * Anything else is "unclassified"; no part of the error's text is kept.
 */
export const errorCode = (error: unknown): string => {
  const { code, name, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown
    name?: unknown
    message?: unknown
  }
  const candidates = [
    typeof code === "number" ? String(code) : code,
    name,
    typeof message === "string" ? ERROR_MESSAGES.get(message) : undefined,
  ]
  return (
    (candidates.find((candidate) => allowedCode(candidate) !== UNCLASSIFIED) as
      | string
      | undefined) ?? UNCLASSIFIED
  )
}

/**
 * The DAVE debug messages of @discordjs/voice 0.19.2, by their fixed
 * opening. A message is stored as the matching entry, never as its own
 * text, and as "other" if none matches.
 */
const DAVE_MESSAGES = [
  "Session reinitialized",
  "Session initialized",
  "Session reset",
  "Session downgraded",
  "Session upgraded",
  "Set MLS external sender",
  "Preparing for transition",
  "Executing transition",
  "Received execute transition, but we don't have a pending transition",
  "Transition executed",
  "Preparing for epoch",
  "Invalidating transition",
  "MLS proposals processed",
  "MLS commit processed",
  "MLS commit errored",
  "MLS welcome processed",
  "MLS welcome errored",
] as const

export const daveMessage = (text: string): string =>
  DAVE_MESSAGES.find((known) => text.startsWith(known)) ?? "other"

/** An IPv4 address with its last octet and port dropped: "203.0.113.x". */
export const maskAddress = (address: string): string =>
  address.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}(:\d+)?$/)?.[1]?.concat(".x") ?? "hidden"

/**
 * A stable pseudonym for a Discord user within one run: the same person gets
 * the same alias across container restarts (the salt comes from the run),
 * and the id itself never leaves the process.
 */
export const aliaser = (salt: string) => {
  const aliases = new Map<string, string>()
  return (userId: string): string => {
    let alias = aliases.get(userId)
    if (!alias) {
      alias = "u" + createHmac("sha256", salt).update(userId).digest("hex").slice(0, 10)
      aliases.set(userId, alias)
    }
    return alias
  }
}

export type DecryptOutcome = "authenticated" | "passthrough" | "failed"

/**
 * Runs one decrypt and classifies it by davey's own per-sender success
 * counter: it went up means the frame was authenticated and decrypted; a
 * result without that is plaintext let through. Reading the counter never
 * throws (davey throws for a sender it has no decryptor for yet), so it can't
 * stop the library's decrypt or its recovery from running. Errors from
 * `decrypt` itself propagate.
 */
export const classifyDecrypt = <A>(
  decrypt: () => A | null,
  successes: () => number | undefined,
): { readonly result: A | null; readonly outcome: DecryptOutcome } => {
  const read = () => {
    try {
      return successes() ?? 0
    } catch {
      return 0
    }
  }
  const before = read()
  const result = decrypt()
  if (result === null) return { result, outcome: "failed" }
  return { result, outcome: read() > before ? "authenticated" : "passthrough" }
}

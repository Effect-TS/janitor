/**
 * What the probe counts and what it lets out of the process, apart from
 * probe.ts (which starts the bot on import) so it can be tested.
 */
import { createHmac } from "node:crypto"

const RTP_OPUS = 120

/**
 * True for an RTP version 2 packet carrying Opus (payload type 120): voice
 * media. The IP discovery reply (version bits 0) and RTCP don't count.
 */
export const isRtpOpus = (packet: Uint8Array): boolean =>
  packet.length > 12 && packet[0]! >> 6 === 2 && (packet[1]! & 0x7f) === RTP_OPUS

/**
 * The fixed opening words of a library message: letters and spaces up to the
 * first digit or punctuation, at most 60 characters. Library messages put
 * their variable parts (ids, addresses, transition numbers, nested errors)
 * after that point, so what is left is the message's template, not its data.
 */
export const phrase = (text: string): string =>
  text
    .match(/^[A-Za-z][A-Za-z ]*/)?.[0]
    .trim()
    .slice(0, 60) || "unrecognised"

/** An error as a code and the fixed opening of its message, e.g. "TokenInvalid: An invalid token was provided". */
export const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  const name = error instanceof Error ? error.name : ""
  const label =
    typeof code === "string" && /^[A-Za-z_]{1,40}$/.test(code)
      ? code
      : /^[A-Za-z]{1,40}$/.test(name)
        ? name
        : "Error"
  return error instanceof Error ? `${label}: ${phrase(error.message)}` : label
}

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

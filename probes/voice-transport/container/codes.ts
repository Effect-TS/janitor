/**
 * The only error codes the probe stores or shows. An error is logged as the
 * first of its code or name found here, and as "unclassified" otherwise, so
 * no part of an error's own text (which can be a Discord API response) is
 * kept. Pure, so the report can filter with the same list.
 */
export const ERROR_CODES: ReadonlySet<string> = new Set([
  // discord.js
  "TokenInvalid",
  "TokenMissing",
  "DisallowedIntents",
  "ClientNotReady",
  "GuildVoiceChannelResolve",
  "VoiceNotStageChannel",
  // Discord API (https://discord.com/developers/docs/topics/opcodes-and-status-codes)
  "0",
  "10003",
  "10004",
  "10013",
  "40001",
  "50001",
  "50013",
  "50035",
  // Node network errors
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ERR_SOCKET_DGRAM_NOT_RUNNING",
  "UND_ERR_CONNECT_TIMEOUT",
  "AbortError",
  "TimeoutError",
  // @discordjs/voice, by exact message (see ERROR_MESSAGES)
  "IpDiscoverySocketClosed",
  "IpDiscoveryMalformedAddress",
  "PacketParseFailed",
  "DaveSessionUnavailable",
  "NoEncryptionMode",
  // The probe's own
  "NotVoiceChannel",
  "NoReply",
])

export const UNCLASSIFIED = "unclassified"

/** @discordjs/voice 0.19.2 errors that have no code, by their whole fixed message. */
export const ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["Cannot perform IP discovery - socket closed", "IpDiscoverySocketClosed"],
  ["Malformed IP address", "IpDiscoveryMalformedAddress"],
  ["Failed to parse packet", "PacketParseFailed"],
  ["No session available", "DaveSessionUnavailable"],
  ["Session not available", "DaveSessionUnavailable"],
])

/** `value` if it is an allowed code, otherwise "unclassified". */
export const allowedCode = (value: unknown): string =>
  typeof value === "string" && ERROR_CODES.has(value) ? value : UNCLASSIFIED

/**
 * What the probe counts and stores, apart from probe.ts (which starts the bot
 * on import) so it can be tested.
 */

const RTP_OPUS = 120

/**
 * True for an RTP version 2 packet carrying Opus (payload type 120): voice
 * media. The IP discovery reply (version bits 0) and RTCP don't count.
 */
export const isRtpOpus = (packet: Uint8Array): boolean =>
  packet.length > 12 && packet[0]! >> 6 === 2 && (packet[1]! & 0x7f) === RTP_OPUS

/**
 * Library text as it may be stored: the secret and anything shaped like a
 * token or key (24 or more URL-safe base64 characters) replaced, and cut to
 * 200 characters. Discord ids are shorter and stay.
 */
export const scrub = (text: string, secret: string): string =>
  (secret ? text.split(secret).join("[redacted]") : text)
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, "[redacted]")
    .slice(0, 200)

import { createSocket } from "node:dgram"
import { randomBytes } from "node:crypto"

/**
 * STUN servers outside Cloudflare's network. A reply from one of them shows
 * that a deployed container can send UDP to a third-party host and receive
 * the answer on the same flow, which is what Discord voice needs.
 */
export const STUN_SERVERS = [
  { host: "stun.l.google.com", port: 19302 },
  { host: "stun1.l.google.com", port: 19302 },
  { host: "global.stun.twilio.com", port: 3478 },
] as const

const MAGIC_COOKIE = 0x2112a442
const BINDING_SUCCESS = 0x0101
const MAPPED_ADDRESS = 0x0001
const XOR_MAPPED_ADDRESS = 0x0020

/** An RFC 5389 binding request with a fresh transaction id. */
export const bindingRequest = (): Buffer => {
  const message = Buffer.alloc(20)
  message.writeUInt16BE(0x0001, 0)
  message.writeUInt16BE(0, 2)
  message.writeUInt32BE(MAGIC_COOKIE, 4)
  randomBytes(12).copy(message, 8)
  return message
}

/**
 * The IPv4 address and port a binding success response reports, preferring
 * XOR-MAPPED-ADDRESS. Undefined for anything else.
 */
export const mappedAddress = (message: Buffer): string | undefined => {
  if (message.length < 20 || message.readUInt16BE(0) !== BINDING_SUCCESS) return undefined
  if (message.readUInt32BE(4) !== MAGIC_COOKIE) return undefined
  const end = Math.min(message.length, 20 + message.readUInt16BE(2))
  let fallback: string | undefined
  for (let offset = 20; offset + 4 <= end;) {
    const type = message.readUInt16BE(offset)
    const length = message.readUInt16BE(offset + 2)
    const value = message.subarray(offset + 4, offset + 4 + length)
    if ((type === XOR_MAPPED_ADDRESS || type === MAPPED_ADDRESS) && length >= 8 && value[1] === 1) {
      const xor = type === XOR_MAPPED_ADDRESS
      const port = value.readUInt16BE(2) ^ (xor ? MAGIC_COOKIE >>> 16 : 0)
      const address = (value.readUInt32BE(4) ^ (xor ? MAGIC_COOKIE : 0)) >>> 0
      const ip = [24, 16, 8, 0].map((shift) => (address >>> shift) & 0xff).join(".")
      if (xor) return `${ip}:${port}`
      fallback = `${ip}:${port}`
    }
    offset += 4 + Math.ceil(length / 4) * 4
  }
  return fallback
}

export type StunResult =
  | { readonly server: string; readonly ok: true; readonly mapped: string; readonly ms: number }
  | { readonly server: string; readonly ok: false; readonly error: string }

/** Sends binding requests to one server, three tries, and reports the first answer. */
export const probeStun = (host: string, port: number, timeoutMs = 2_000): Promise<StunResult> =>
  new Promise((resolve) => {
    const server = `${host}:${port}`
    const socket = createSocket("udp4")
    const started = Date.now()
    let tries = 0
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (result: StunResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.close()
      resolve(result)
    }
    const send = () => {
      if (tries++ === 3) return finish({ server, ok: false, error: "no reply" })
      socket.send(bindingRequest(), port, host, (error) => {
        if (error) finish({ server, ok: false, error: error.message })
      })
      timer = setTimeout(send, timeoutMs)
    }
    socket.on("message", (message) => {
      const mapped = mappedAddress(message)
      if (mapped) finish({ server, ok: true, mapped, ms: Date.now() - started })
    })
    socket.on("error", (error) => finish({ server, ok: false, error: error.message }))
    send()
  })

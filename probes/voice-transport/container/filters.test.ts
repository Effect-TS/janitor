import assert from "node:assert/strict"
import { test } from "node:test"
import { isRtpOpus, scrub } from "./filters.ts"

test("only RTP Opus counts as voice media, not the IP discovery reply", () => {
  // Discord's 74-byte discovery reply: type 2, length 70, SSRC, address, port.
  const discovery = new Uint8Array(74)
  discovery.set([0x00, 0x02, 0x00, 0x46, 0x00, 0x00, 0x00, 0x01])
  const rtcp = new Uint8Array(32)
  rtcp.set([0x81, 0xc9])
  const opus = new Uint8Array(60)
  opus.set([0x90, 0x78])
  assert.deepEqual([discovery, rtcp, opus].map(isRtpOpus), [false, false, true])
})

test("stored library text loses the token and anything key-shaped", () => {
  const token = "MTI3.bot-token"
  const text = `Error: bad ${token} key=0123456789abcdefABCDEF0123456789 for user 123456789012345678 ${"x ".repeat(200)}`
  const stored = scrub(text, token)
  assert.ok(!stored.includes(token) && !stored.includes("0123456789abcdef"))
  assert.match(stored, /user 123456789012345678/)
  assert.equal(stored.length, 200)
})

import assert from "node:assert/strict"
import { test } from "node:test"
import {
  aliaser,
  classifyDecrypt,
  daveMessage,
  errorCode,
  isRtpOpus,
  maskAddress,
} from "./filters.ts"

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

test("an unknown sender doesn't stop the library decrypt, and their first authenticated packet counts", () => {
  // davey throws NoDecryptorForUser until the sender's key arrives.
  let decryptor: { successes: number } | undefined
  let libraryCalls = 0
  const stats = () => {
    if (!decryptor) throw new Error("Failed to get decryption stats: NoDecryptorForUser")
    return decryptor.successes
  }
  const unknown = classifyDecrypt(() => {
    libraryCalls++
    return null
  }, stats)
  decryptor = { successes: 0 }
  const authenticated = classifyDecrypt(() => {
    libraryCalls++
    decryptor!.successes++
    return "frame"
  }, stats)
  const plaintext = classifyDecrypt(() => "frame", stats)
  assert.equal(libraryCalls, 2)
  assert.deepEqual(
    [unknown.outcome, authenticated.outcome, plaintext.outcome],
    ["failed", "authenticated", "passthrough"],
  )
})

test("nothing that leaves the container carries an id, address or the error's own words", () => {
  const id = "123456789012345678"
  // Discord REST puts the response's message in Error.message; an alphabetic one must not survive.
  const rest = Object.assign(new Error("Alice Smith may not join Coffee Chat"), {
    name: "DiscordAPIError[50001]",
    code: 50001,
  })
  const unknownRest = Object.assign(new Error("Alice Smith may not join"), { code: 99_999 })
  const named = Object.assign(new Error("Alice Smith"), { name: "Alice Smith" })
  assert.deepEqual(
    [
      errorCode(rest),
      errorCode(unknownRest),
      errorCode(named),
      errorCode(new Error(`Unknown member ${id}`)),
      errorCode(new Error("Cannot perform IP discovery - socket closed")),
      errorCode("Alice Smith"),
    ],
    [
      "50001",
      "unclassified",
      "unclassified",
      "unclassified",
      "IpDiscoverySocketClosed",
      "unclassified",
    ],
  )
  assert.equal(
    daveMessage(`MLS commit errored from transition 3: Error: ${id}`),
    "MLS commit errored",
  )
  assert.equal(daveMessage("Alice Smith joined"), "other")
  assert.equal(maskAddress("203.0.113.7:50000"), "203.0.113.x")
  assert.equal(maskAddress(id), "hidden")
  assert.match(aliaser("run-1")(id), /^u[0-9a-f]{10}$/)
  assert.equal(aliaser("run-1")(id), aliaser("run-1")(id))
  assert.notEqual(aliaser("run-1")(id), aliaser("run-2")(id))
})

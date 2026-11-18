import assert from "node:assert/strict"
import { test } from "node:test"
import { aliaser, classifyDecrypt, errorCode, isRtpOpus, maskAddress, phrase } from "./filters.ts"

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

test("nothing that leaves the container carries an id, address or library payload", () => {
  const id = "123456789012345678"
  const error = Object.assign(
    new Error(`Unknown member ${id} at 203.0.113.7:50000 with token MTI3.abc.def`),
    { code: "UnknownMember" },
  )
  const leaks = [
    errorCode(error),
    errorCode(new Error(`${id} timed out`)),
    phrase(`MLS commit errored from transition 3: Error: bad ${id} 203.0.113.7`),
    maskAddress("203.0.113.7:50000"),
    maskAddress(`${id}`),
    aliaser("run-1")(id),
  ].join(" ")
  assert.ok(!/\d{4,}|113\.7|MTI3/.test(leaks), leaks)
  assert.equal(phrase("Preparing for transition (4, v1)"), "Preparing for transition")
  assert.equal(aliaser("run-1")(id), aliaser("run-1")(id))
  assert.notEqual(aliaser("run-1")(id), aliaser("run-2")(id))
})

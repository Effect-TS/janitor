import assert from "node:assert/strict"
import { test } from "node:test"
import { mappedAddress } from "./stun.ts"

test("reads the mapped address from the RFC 5769 IPv4 sample response", () => {
  const response = Buffer.from(
    "0101003c2112a442b7e7a701bc34d686fa87dfae" +
      "8022000b7465737420766563746f7220" +
      "002000080001a147e112a643" +
      "000800142b91f599fd9e90c38c7489f92af9ba53f06be7d7" +
      "80280004c07d4c96",
    "hex",
  )
  assert.equal(mappedAddress(response), "192.0.2.1:32853")
})

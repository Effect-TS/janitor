import * as PgTypes from "@effect/sql-pg/PgTypes"
import * as Result from "effect/Result"

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/**
 * Decodes `bigint` columns as decimal strings, the way the text-protocol
 * driver did before the binary one arrived. Sequence numbers and GitHub
 * database ids travel as strings through every schema and API in the cluster,
 * so the wire format stays the one those schemas already expect.
 */
const int8AsText: PgTypes.Codec<string> = {
  decode: (bytes) =>
    bytes.byteLength === 8
      ? Result.succeed(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0).toString())
      : Result.fail(
          new PgTypes.CodecError({ message: `int8 expects 8 bytes, got ${bytes.byteLength}` }),
        ),
  encode: (value) => {
    let big: bigint
    try {
      big = BigInt(value as string | number | bigint)
    } catch {
      return Result.fail(
        new PgTypes.CodecError({ message: `Expected an integer for int8, got ${String(value)}` }),
      )
    }
    if (big < INT64_MIN || big > INT64_MAX)
      return Result.fail(new PgTypes.CodecError({ message: `int8 out of range: ${big}` }))
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigInt64(0, big)
    return Result.succeed(bytes)
  },
}

/** The cluster's Postgres codecs: built-ins plus textual `bigint` values. */
export const types: PgTypes.Registry = PgTypes.makeRegistry()
types.register(PgTypes.OID.int8, int8AsText, { arrayOid: PgTypes.OID.int8Array })

import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveCheckpoint, restoreCheckpoint } from "./checkpoint.mjs"

const root = await mkdtemp(join(tmpdir(), "janitor-owned-checkpoint-"))
const dir = await mkdtemp(join(root, "workspace-"))
await writeFile(join(dir, "unfinished.txt"), "Accepted unfinished work\n")
const objects = new Map()
const bucket = {
  put: async (key, bytes) => {
    objects.set(key, Buffer.from(bytes))
  },
  get: async (key) => {
    if (!objects.has(key)) throw new Error("object missing")
    return Buffer.from(objects.get(key))
  },
  delete: async (key) => {
    objects.delete(key)
  },
}
let pointer
const commit = async (next) => {
  pointer = next
}
const first = await saveCheckpoint({ dir, bucket, commit })
const previous = { ...pointer }
await writeFile(join(dir, "unfinished.txt"), "Later unacknowledged change\n")
await assert.rejects(
  saveCheckpoint({ dir, bucket, commit, failBeforeCommit: true }),
  /before checkpoint pointer/,
)
assert.deepEqual(pointer, previous)
await restoreCheckpoint({ target: join(root, "restored"), bucket, pointer })
assert.equal(
  await readFile(join(root, "restored", "unfinished.txt"), "utf8"),
  "Accepted unfinished work\n",
)
assert.equal(Object.hasOwn(first, "expiresAt"), false)
assert.equal(Object.hasOwn(first, "ttl"), false)
objects.set(first.archiveKey, Buffer.from("corrupted archive"))
await assert.rejects(
  restoreCheckpoint({ target: join(root, "corrupt"), bucket, pointer }),
  /checksum mismatch/,
)
console.log(
  JSON.stringify(
    {
      kind: "checkpoint-protocol-local-fixture",
      root,
      checks: [
        "archive and manifest written before pointer commit",
        "failure before commit preserves previous restore point",
        "restore uses recorded pointer rather than newest orphan archive",
        "checksum mismatch rejected before extraction",
        "manifest and restore have no time-based expiration",
      ],
      r2Tested: false,
      durablePointerTransactionTested: false,
      writerQuiescenceTested: false,
      productionArchiveSafetyTested: false,
    },
    null,
    2,
  ),
)

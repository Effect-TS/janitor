import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DeliveryQueue, parts } from "./delivery-queue.mjs"
test("unicode output splits losslessly within conservative Slack size", () => {
  const text = "a😀".repeat(4000)
  const p = parts(text)
  assert.equal(p.join(""), text)
  assert(p.every((s) => Buffer.byteLength(s) <= 3900))
  assert(p.every((s) => !s.endsWith("\ud83d")))
})
test("durable ordered output, channel throttling, access restore, progress and uncertainty", () => {
  const dir = mkdtempSync(join(tmpdir(), "janitor-outbox-"))
  let q = new DeliveryQueue(join(dir, "test.sqlite"))
  try {
    q.add("p1", "s1", "c1", "t1", "progress", "old")
    q.add("p2", "s1", "c1", "t1", "progress", "new")
    q.add("a", "s1", "c1", "t1", "substantive", "first")
    q.add("done", "s1", "c1", "t1", "terminal", "final")
    q.add("b", "s2", "c1", "t2", "substantive", "second session")
    q.add("other", "s3", "c2", "t3", "substantive", "other channel")
    assert.equal(q.next(0).id, "a")
    q.sent("a", 0)
    assert.equal(q.next(0).id, "other")
    q.sent("other", 0)
    assert.equal(q.next(999), undefined)
    assert.equal(q.next(1000).id, "done")
    q.throttle("c1", 1000, 10)
    q.close()
    q = new DeliveryQueue(join(dir, "test.sqlite"))
    assert.equal(q.next(10999), undefined)
    q.access("c1", false)
    assert.equal(q.next(12000), undefined)
    q.access("c1", true)
    assert.equal(q.next(12000).id, "done")
    q.uncertain("done")
    assert.equal(q.next(12000).id, "b")
    q.add("later", "s1", "c1", "t4", "substantive", "must wait")
    q.sent("b", 12000)
    assert.equal(q.next(14000), undefined)
    assert.equal(q.db.prepare("SELECT count(*) AS n FROM item WHERE kind='terminal'").get().n, 1)
  } finally {
    q.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

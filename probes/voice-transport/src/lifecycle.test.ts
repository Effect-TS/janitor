import assert from "node:assert/strict"
import { test } from "node:test"
import { type Desired, alarmAction, endContainer } from "./lifecycle.ts"

const NOW = 1_000_000

test("a stop that can't confirm the container is off keeps retrying until it is", async () => {
  // Ignores SIGTERM, and its first destroy hangs.
  let destroys = 0
  const container = {
    running: true,
    signal: () => {},
    destroy: () => {
      destroys++
      if (destroys === 1) return new Promise<void>(() => {})
      container.running = false
      return Promise.resolve()
    },
  }
  const stopped: Desired = { running: false, until: NOW + 60_000, transitionZeroFix: false }
  const end = () =>
    endContainer(container, { signal: 15, exited: new Promise(() => {}), exitMs: 5, destroyMs: 5 })

  assert.equal(await end(), false)
  assert.equal(alarmAction(stopped, container.running, NOW), "teardown")
  assert.equal(await end(), true)
  assert.equal(alarmAction(stopped, container.running, NOW), "done")
})

test("the time limit ends a running probe nobody stopped", () => {
  const expired: Desired = { running: true, until: NOW - 1, transitionZeroFix: false }
  assert.equal(alarmAction(expired, true, NOW), "teardown")
  assert.equal(alarmAction(expired, false, NOW), "done")
})

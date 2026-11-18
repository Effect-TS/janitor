import assert from "node:assert/strict"
import { test } from "node:test"
import { type Desired, type Host, Lifecycle, alarmAction, endContainer } from "./lifecycle.ts"

const NOW = 1_000_000
const off: Desired = {
  running: false,
  until: NOW + 60_000,
  transitionZeroFix: false,
  aliasSalt: "s",
}

/** A container that exits when `exit` is called; `onSignal` decides what a signal does. */
const fakeContainer = (onSignal: (exit: () => void) => void) => {
  let exit = () => {}
  let exited: Promise<void> = Promise.resolve()
  const container = {
    running: false,
    starts: 0,
    start: () => {
      container.running = true
      container.starts++
      exited = new Promise((resolve) => {
        exit = () => {
          container.running = false
          resolve()
        }
      })
    },
    signal: () => onSignal(() => exit()),
    destroy: async () => exit(),
    monitor: () => exited,
    health: async () => (container.running ? `boot${container.starts}` : undefined),
  }
  return container
}

const fakeHost = (container: Host["container"]) => {
  const storage = new Map<string, unknown>()
  const recorded: Array<{ kind: string } & Record<string, unknown>> = []
  const host: Host & { alarmAt: number | null } = {
    container,
    alarmAt: null,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    get: async <A>(key: string) => storage.get(key) as A | undefined,
    put: async (key, value) => void storage.set(key, value),
    setAlarm: async (at) => void (host.alarmAt = at),
    deleteAlarm: async () => void (host.alarmAt = null),
    record: (kind, detail) => void recorded.push({ kind, ...detail }),
    poll: async () => ({ bootId: "boot1", presentUserIds: ["u1"] }),
  }
  return { host, recorded }
}

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
  const end = () =>
    endContainer(container, { signal: 15, exited: new Promise(() => {}), exitMs: 5, destroyMs: 5 })

  assert.equal(await end(), "running")
  assert.equal(alarmAction(off, container.running, NOW), "teardown")
  assert.equal(await end(), "destroyed")
  assert.equal(alarmAction(off, container.running, NOW), "done")
})

test("the time limit ends a running probe nobody stopped", () => {
  const expired: Desired = { ...off, running: true, until: NOW - 1 }
  assert.equal(alarmAction(expired, true, NOW), "teardown")
  assert.equal(alarmAction(expired, false, NOW), "done")
})

test("a restart in flight when /stop arrives doesn't bring the container back", async () => {
  // SIGTERM takes effect only when the test lets it.
  let letExit = () => {}
  const container = fakeContainer((exit) => (letExit = exit))
  const { host, recorded } = fakeHost(container)
  const lifecycle = new Lifecycle(host, { start: 1_000, exit: 1_000, destroy: 100 })
  await lifecycle.start(1, false, "salt")
  assert.equal(container.running, true)

  const restarting = lifecycle.restart(15, undefined)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const stopping = lifecycle.stop("operator")
  letExit()
  await restarting

  assert.deepEqual(await stopping, { stopped: true })
  assert.equal(container.running, false)
  assert.equal(container.starts, 1)
  assert.equal(host.alarmAt, null)
  assert.equal(await lifecycle.alarm(), undefined)
  assert.equal(container.starts, 1)
  assert.ok(recorded.some((e) => e.kind === "container-end" && e.outcome === "exited"))
})

test("a container that ignores SIGTERM is recorded as destroyed, not as having exited", async () => {
  const container = fakeContainer(() => {})
  const { host, recorded } = fakeHost(container)
  const lifecycle = new Lifecycle(host, { start: 1_000, exit: 10, destroy: 100 })
  await lifecycle.start(1, false, "salt")
  await lifecycle.restart(15, undefined)
  const end = recorded.find((e) => e.kind === "container-end")
  assert.deepEqual([end?.bootId, end?.outcome], ["boot1", "destroyed"])
  assert.equal(container.starts, 2)
})

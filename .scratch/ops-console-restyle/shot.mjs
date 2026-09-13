// Headless Chrome via CDP. No dependencies; Node 22+ (global WebSocket).
// node shot.mjs <url> <out.png> [--width 1440] [--height 900] [--dark]
//   [--reduced-motion] [--full] [--eval "<js>"] [--tab N] [--wait ms]
//   [--json]   (with --eval: print the result as JSON and skip the screenshot)
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHROME = process.env.CHROME ?? "/nix/store/xsrddymgg12bq9gza3srqnxxxvvzi7s9-playwright-chromium/chrome-linux64/chrome"

const args = process.argv.slice(2)
const url = args[0]
const out = args[1]
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const has = (name) => args.includes(`--${name}`)
const width = Number(flag("width", 1440))
const height = Number(flag("height", 900))
const port = 9222 + Math.floor(Math.random() * 500)

// Chrome writes a profile per run; keep it off the small root filesystem.
const profile = mkdtempSync(join(process.env.SHOT_TMP ?? tmpdir(), "shot-"))
const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, "about:blank",
], { stdio: "ignore" })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const wsUrl = async () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      return (await response.json()).webSocketDebuggerUrl
    } catch {
      await sleep(100)
    }
  }
  throw new Error("chrome did not start")
}

const ws = new WebSocket(await wsUrl())
await new Promise((resolve) => (ws.onopen = resolve))
let id = 0
const pending = new Map()
const events = []
ws.onmessage = (message) => {
  const data = JSON.parse(message.data)
  if (data.id !== undefined) {
    const { resolve, reject } = pending.get(data.id)
    pending.delete(data.id)
    data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result)
  } else events.push(data)
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    id += 1
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

const { targetId } = await send("Target.createTarget", { url: "about:blank" })
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
const call = (method, params) => send(method, params, sessionId)

await call("Page.enable")
await call("Runtime.enable")
await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 820 })
const features = []
if (has("dark")) features.push({ name: "prefers-color-scheme", value: "dark" })
if (has("reduced-motion")) features.push({ name: "prefers-reduced-motion", value: "reduce" })
if (features.length > 0) await call("Emulation.setEmulatedMedia", { features })
await call("Page.navigate", { url })
await sleep(Number(flag("wait", 1500)))

const tabs = Number(flag("tab", 0))
for (let index = 0; index < tabs; index++) {
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 })
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 })
  await sleep(30)
}

let result
const expression = flag("eval")
if (expression !== undefined) {
  result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (has("json")) console.log(JSON.stringify(result.result.value ?? result.exceptionDetails, null, 2))
  await sleep(Number(flag("settle", 200)))
}

if (!has("json") && out !== undefined) {
  const params = { format: "png" }
  const clipY = flag("clip-y")
  if (clipY !== undefined) {
    // Grow the viewport to include the clip; capturing beyond it paints blank.
    await call("Emulation.setDeviceMetricsOverride", { width, height: Number(clipY) + height, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    params.clip = { x: 0, y: Number(clipY), width, height, scale: 1 }
  } else if (has("full")) {
    const { cssContentSize } = await call("Page.getLayoutMetrics")
    params.captureBeyondViewport = true
    params.clip = { x: 0, y: 0, width, height: Math.min(cssContentSize.height, 20000), scale: 1 }
  }
  const { data } = await call("Page.captureScreenshot", params)
  writeFileSync(out, Buffer.from(data, "base64"))
  console.log(`${out} ${width}x${has("full") ? "full" : height}`)
}
chrome.kill()
await sleep(200)
rmSync(profile, { recursive: true, force: true })
process.exit(0)

import { mkdirSync } from "node:fs"
import { startBridge } from "./server.mjs"
mkdirSync("/workspace", { recursive: true })
mkdirSync("/var/lib/janitor", { recursive: true, mode: 0o700 })
const bridge = await startBridge({
  token: process.env.JANITOR_BRIDGE_TOKEN,
  generation: Number(process.env.JANITOR_GENERATION),
  cwd: "/workspace",
  journalPath: "/var/lib/janitor/operations.sqlite",
  port: 8788,
  host: "0.0.0.0",
})
process.once("SIGTERM", async () => {
  await bridge.close()
  process.exit(0)
})

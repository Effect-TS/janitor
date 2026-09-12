import { readFileSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { createSign } from "node:crypto"

// GET only. Output deliberately excludes keys, JWTs, webhook URLs and event payloads.
const env = parseEnv(readFileSync(process.env.FIXTURE_APP_ENV_FILE, "utf8"))
const privateKey = env.JANITOR_GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n")
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
const now = Math.floor(Date.now() / 1000)
const unsigned =
  encode({ alg: "RS256", typ: "JWT" }) +
  "." +
  encode({ iat: now - 60, exp: now + 540, iss: env.JANITOR_GITHUB_APP_ID })
const jwt = unsigned + "." + createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")
async function get(path) {
  const response = await fetch("https://api.github.com" + path, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`)
  return response.json()
}
const app = await get("/app")
const installation = await get("/app/installations/158746421")
const hook = await get("/app/hook/config")
const deliveries = await get("/app/hook/deliveries?per_page=1")
const report = {
  checkedAt: new Date().toISOString(),
  mode: "read-only",
  app: { id: app.id, slug: app.slug, permissions: app.permissions, events: app.events },
  installation: {
    id: installation.id,
    account: installation.account.login,
    permissions: installation.permissions,
    events: installation.events,
    suspended: installation.suspended_at !== null,
  },
  webhookConfigured: Boolean(hook.url),
  deliveryListAccessible: Array.isArray(deliveries),
  mutations: 0,
}
if (process.env.FIXTURE_REPORT_PATH)
  writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))

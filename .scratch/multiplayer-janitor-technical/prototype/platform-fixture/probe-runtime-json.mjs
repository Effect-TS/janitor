import { pathToFileURL } from "node:url"
import { readFileSync, writeFileSync } from "node:fs"
import assert from "node:assert/strict"
const { Miniflare, convertV4MiniflareOptions } = await import(
  pathToFileURL(process.env.FIXTURE_MINIFLARE_MODULE).href
)
const helper = readFileSync(new URL("./github-json.mjs", import.meta.url), "utf8").replace(
  "export function",
  "function",
)
const script =
  helper +
  '\nexport default { fetch(){ return Response.json(parseGitHubJSON(\'{"id":3842322426589347840,"next":3842322426589347841}\')) } }'
const mf = new Miniflare(
  convertV4MiniflareOptions({ modules: true, script, compatibilityDate: "2026-09-11" }),
)
try {
  const v = await (await mf.dispatchFetch("http://fixture")).json()
  assert.equal(v.id, "3842322426589347840")
  assert.equal(v.next, "3842322426589347841")
  const report = {
    checkedAt: new Date().toISOString(),
    workerd: true,
    compatibilityDate: "2026-09-11",
    losslessJSON: v,
    remoteCalls: 0,
  }
  writeFileSync(process.env.FIXTURE_REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report))
} finally {
  await mf.dispose()
}

// Alchemy's independent build publishes one image and bundles its matching Worker.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRIDGE_SOURCES, bridgeSourceHash } from "./bridge-source.mjs"

const manifest = JSON.parse(
  readFileSync(new URL("../release-manifest.json", import.meta.url), "utf8"),
)
const bridge = new URL("../bridge/", import.meta.url)
const sourceHash = bridgeSourceHash(bridge)
if (
  sourceHash !== manifest.bridge.sourceHash ||
  sourceHash !== JSON.parse(readFileSync(new URL("build.json", bridge), "utf8")).sourceHash
)
  throw new Error(
    "Bridge sources changed: update and review the bridge release records before deploying",
  )
// Only local validation supplies a previously built image. CI always builds and publishes.
let image = process.env.JANITOR_DEPLOY_IMAGE
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
const temporary = mkdtempSync(join(tmpdir(), "janitor-deploy-"))
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const registryAuth = async (permissions) => {
  if (!account || !token)
    throw new Error("Publishing or pulling the deployment image requires Cloudflare credentials")
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/containers/registries/registry.cloudflare.com/credentials`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ permissions, expiration_minutes: 30 }),
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!response.ok) throw new Error(`Container registry authorization failed (${response.status})`)
  const { result } = await response.json().catch(() => {
    throw new Error("Invalid registry authorization response")
  })
  const username = result?.username ?? result?.user
  if (!username || !result?.password) throw new Error("Container registry returned no credential")
  writeFileSync(
    join(temporary, "config.json"),
    JSON.stringify({
      auths: {
        "registry.cloudflare.com": {
          auth: Buffer.from(`${username}:${result.password}`).toString("base64"),
        },
      },
    }),
    { mode: 0o600 },
  )
}
try {
  if (!image) {
    if (!account || !token) throw new Error("Deployment requires Cloudflare account credentials")
    const repository = `registry.cloudflare.com/${account}/janitor-agent-sandbox`
    const tag = `${repository}:${sourceHash}`
    docker("build", "--platform", "linux/amd64", "-t", tag, "bridge")
    await registryAuth(["pull", "push"])
    const pushed = docker("--config", temporary, "push", "--platform", "linux/amd64", tag)
    const digest = pushed.match(/digest:\s+(sha256:[a-f0-9]{64})/i)?.[1]
    if (!digest) throw new Error("Container push returned no immutable digest")
    image = `${repository}@${digest}`
  }
  if (!/@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Deployment image must be an immutable digest reference")
  try {
    docker("image", "inspect", image)
  } catch {
    if (!account || !image.startsWith(`registry.cloudflare.com/${account}/`))
      throw new Error(
        "Deployment image is unavailable locally and is not in the configured registry",
      )
    await registryAuth(["pull"])
    docker("--config", temporary, "pull", image)
  }
  const inspected = JSON.parse(docker("image", "inspect", image))[0]
  const provenance = JSON.parse(
    docker(
      "run",
      "--rm",
      "--network=none",
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      `
      import { readFileSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import { createHash } from 'node:crypto';
      const hash = createHash('sha256');
      for (const name of ${JSON.stringify(BRIDGE_SOURCES)}) {
        hash.update(name); hash.update('\\0');
        hash.update(readFileSync('/opt/janitor/' + name)); hash.update('\\0');
      }
      console.log(JSON.stringify({
        sourceHash: hash.digest('hex'),
        declaredSourceHash: JSON.parse(readFileSync('/opt/janitor/build.json', 'utf8')).sourceHash,
        node: process.version,
        packages: execFileSync('dpkg-query', ['-W', 'coreutils', 'findutils', 'ripgrep', 'git', 'util-linux', 'ca-certificates'], { encoding: 'utf8' }),
      }));
    `,
    ),
  )
  if (provenance.sourceHash !== sourceHash || provenance.declaredSourceHash !== sourceHash)
    throw new Error("Published container sources do not match the runner release manifest")
  manifest.bridge.imageDigest = image.split("@")[1]
  manifest.bridge.imageId = inspected.Id
  manifest.bridge.tools = { node: provenance.node, packages: provenance.packages }
  const manifestPath = join(temporary, "release-manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  execFileSync(process.execPath, ["scripts/build.mjs"], {
    stdio: "inherit",
    env: { ...process.env, JANITOR_DEPLOY_MANIFEST: manifestPath },
  })
  copyFileSync(manifestPath, "dist/release-manifest.json")
  writeFileSync("dist/image-reference.txt", image)
  writeFileSync(
    "dist/image-provenance.json",
    JSON.stringify({ image, imageId: inspected.Id, ...provenance }, null, 2) + "\n",
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

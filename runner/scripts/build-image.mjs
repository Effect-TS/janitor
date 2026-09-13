import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { bridgeSourceHash } from "./bridge-source.mjs"
const root = new URL("..", import.meta.url)
const bridge = new URL("bridge/", root)
const image = "localhost/janitor-inspection:ticket05"
// The image carries its own source identity so a running bridge can advertise it.
const sourceHash = bridgeSourceHash(bridge)
writeFileSync(new URL("build.json", bridge), JSON.stringify({ sourceHash }, null, 2) + "\n")
execFileSync("docker", ["build", "-t", image, "bridge"], { cwd: root.pathname, stdio: "inherit" })
if (process.argv.includes("--record")) {
  const inspect = JSON.parse(
    execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }),
  )[0]
  const versions = JSON.parse(
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        `import {execFileSync} from 'node:child_process';
    console.log(JSON.stringify({node:process.version,packages:execFileSync('dpkg-query',
    ['-W','coreutils','findutils','ripgrep','git','util-linux','ca-certificates'],{encoding:'utf8'})}))`,
      ],
      { encoding: "utf8" },
    ),
  )
  writeFileSync(
    new URL("release.json", bridge),
    JSON.stringify(
      {
        bridgeProtocol: 1,
        sandboxSdk: "0.12.9",
        baseImage:
          "cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe",
        sourceHash,
        imageDigest: inspect.Digest,
        imageId: inspect.Id,
        buildEngine: execFileSync("docker", ["version", "--format", "{{.Client.Version}}"], {
          encoding: "utf8",
        }).trim(),
        ...versions,
      },
      null,
      2,
    ) + "\n",
  )
}

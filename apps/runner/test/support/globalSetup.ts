// Builds the test bundle once before the suite runs.
import { execFileSync } from "node:child_process"
import { sandboxRunArgs } from "./SandboxContainer.ts"

export default function setup() {
  execFileSync("node", ["scripts/build-image.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: "inherit",
  })
  // Fail before model scenarios if the host cannot run the bridge's isolation primitive.
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      ...sandboxRunArgs,
      "--user",
      "1000:1000",
      "--entrypoint",
      "/usr/bin/unshare",
      "localhost/janitor-runner-sandbox:dev",
      "--user",
      "--map-root-user",
      "--pid",
      "--fork",
      "/bin/true",
    ],
    { stdio: "inherit" },
  )
  execFileSync("node", ["scripts/build.mjs", "--test"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: "inherit",
  })
}

// Builds the test bundle once before the suite runs.
import { execFileSync } from "node:child_process"

export default function setup() {
  execFileSync("node", ["scripts/build-image.mjs"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: "inherit",
  })
  execFileSync("node", ["scripts/build.mjs", "--test"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: "inherit",
  })
}

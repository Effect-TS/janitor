import { SandboxContainerImage } from "./SandboxContainer.ts"
import { SANDBOX_DOCKERFILE, sandboxContainerGuest } from "./SandboxContainerGuest.ts"

/** Existing Slack container identity, preserved across review deployment changes. */
export const SandboxContainerRuntime = SandboxContainerImage.make(
  { main: import.meta.url, runtime: "node", dockerfile: SANDBOX_DOCKERFILE },
  sandboxContainerGuest,
)

export default SandboxContainerRuntime

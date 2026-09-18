import { ReviewSandboxContainerImage } from "./ReviewSandboxContainer.ts"
import { SANDBOX_DOCKERFILE, sandboxContainerGuest } from "./SandboxContainerGuest.ts"

export const ReviewSandboxContainerRuntime = ReviewSandboxContainerImage.make(
  { main: import.meta.url, runtime: "node", dockerfile: SANDBOX_DOCKERFILE },
  sandboxContainerGuest,
)

export default ReviewSandboxContainerRuntime

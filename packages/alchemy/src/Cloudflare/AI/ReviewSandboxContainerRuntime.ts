import { ReviewSandboxContainerImage } from "./ReviewSandboxContainer.ts"
import { SANDBOX_DOCKERFILE, sandboxContainerGuest } from "./SandboxContainerGuest.ts"

export const ReviewSandboxContainerRuntime = ReviewSandboxContainerImage.make(
  {
    main: import.meta.url,
    runtime: "node",
    dockerfile: SANDBOX_DOCKERFILE,
    // Cloudflare requires at least 3 GiB of memory per custom vCPU.
    vcpu: 2,
    memoryMib: 6144,
    disk: { size_mb: 8000 },
  },
  sandboxContainerGuest,
)

export default ReviewSandboxContainerRuntime

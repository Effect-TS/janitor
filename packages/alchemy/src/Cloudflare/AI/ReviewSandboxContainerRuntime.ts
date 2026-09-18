import { ReviewSandboxContainerImage } from "./ReviewSandboxContainer.ts"
import { SANDBOX_DOCKERFILE, sandboxContainerGuest } from "./SandboxContainerGuest.ts"

export const ReviewSandboxContainerRuntime = ReviewSandboxContainerImage.make(
  {
    main: import.meta.url,
    runtime: "node",
    dockerfile: SANDBOX_DOCKERFILE,
    // Cloudflare requires at least 3 GiB of memory per custom vCPU.
    vcpu: 2,
    memory: "6GiB",
    disk: { size: "8GB" },
  },
  sandboxContainerGuest,
)

export default ReviewSandboxContainerRuntime

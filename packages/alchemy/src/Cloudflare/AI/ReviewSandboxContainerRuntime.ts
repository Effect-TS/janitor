import { ReviewSandboxContainerImage } from "./ReviewSandboxContainer.ts"
import { SANDBOX_DOCKERFILE, sandboxContainerGuest } from "./SandboxContainerGuest.ts"

export const ReviewSandboxContainerRuntime = ReviewSandboxContainerImage.make(
  {
    main: import.meta.url,
    runtime: "node",
    dockerfile: SANDBOX_DOCKERFILE,
    // Package installation and test runners exceed the default lite allocation.
    instanceType: "standard-1",
  },
  sandboxContainerGuest,
)

export default ReviewSandboxContainerRuntime

import * as Container from "alchemy/Cloudflare/Containers"
import { makeSandboxContainerLayers, type SandboxContainerShape } from "./SandboxContainer.ts"

/** Review workspaces cannot share Slack's container application namespace. */
export class ReviewSandboxContainerImage extends Container.Container<
  ReviewSandboxContainerImage,
  SandboxContainerShape
>()("ReviewSandboxContainer") {}

export const { layerContainer, layerContainerSession } = makeSandboxContainerLayers(
  ReviewSandboxContainerImage,
)

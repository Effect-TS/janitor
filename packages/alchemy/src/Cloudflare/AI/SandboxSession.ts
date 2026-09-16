import type * as Container from "alchemy/Cloudflare/Containers"
import * as Layer from "effect/Layer"
import type { CheckoutOptions } from "../../Git/Checkouts.ts"
import { layerSandbox } from "../../Git/CheckoutsSandbox.ts"
import { layerSession } from "../../Workspace/SessionWorkspace.ts"
import { layerContainerSession } from "./SandboxContainer.ts"

/** The caller supplies one Durable Object instance per session. */
export const layerContainerWorkspace = (
  options: Omit<CheckoutOptions, "fresh">,
  startup?: Container.ContainerStartupOptions,
) => {
  const sandbox = layerContainerSession(startup)
  return layerSession(options).pipe(
    Layer.provide(Layer.mergeAll(sandbox, layerSandbox.pipe(Layer.provide(sandbox)))),
  )
}

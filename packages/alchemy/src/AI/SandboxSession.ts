import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { CheckoutOptions } from "../Git/Checkouts.ts"
import { layerWorkspace } from "../Git/CheckoutsWorkspace.ts"
import { layerSession } from "../Workspace/SessionWorkspace.ts"
import { layerHttp } from "./SandboxHttp.ts"

export const layerDevSession = (
  options: Omit<CheckoutOptions, "fresh"> & {
    readonly url: string | Effect.Effect<string | undefined>
  },
) =>
  layerSession({
    key: options.key,
    remote: options.remote,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
  }).pipe(Layer.provide(Layer.mergeAll(layerHttp(options), layerWorkspace(options.url))))

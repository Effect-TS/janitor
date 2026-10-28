import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { tailnetEgressConfig } from "../Config.ts"
import { EGRESS_PORT } from "./TailnetEgress.ts"

/**
 * The tailnet egress container: the Go program in
 * `apps/cluster/containers/tailnet-egress`, built from its own Dockerfile. It
 * joins the tailnet as an ephemeral node with `TAILSCALE_TAGS` and forwards
 * to the model endpoint's origin only. One instance serves every run; the
 * second slot lets a deploy replace it.
 */
export class TailnetEgressContainer extends Cloudflare.Container<TailnetEgressContainer>()(
  "PullRequestReviewTailnetProxy",
  Effect.gen(function* () {
    const config = yield* tailnetEgressConfig
    return {
      context: decodeURIComponent(
        new URL("../../../containers/tailnet-egress", import.meta.url).pathname,
      ),
      instanceType: "lite" as const,
      maxInstances: 2,
      env: {
        LISTEN_ADDR: `0.0.0.0:${EGRESS_PORT}`,
        TS_HOSTNAME: "janitor",
        TS_TAGS: config.tags.join(","),
        ...Option.match(config.upstreamOrigin, {
          onNone: () => ({}),
          onSome: (origin) => ({ UPSTREAM_ORIGIN: origin }),
        }),
        ...Option.match(config.authKey, {
          onNone: () => ({}),
          onSome: (authKey) => ({ TS_AUTHKEY: authKey }),
        }),
      },
    }
  }),
) {}

import { JanitorApi } from "@janitor/domain/Api"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { AccountLinking } from "../AccountLinking.ts"
import { Teammates } from "../Teammates.ts"
import { CurrentTeammate } from "./Middleware.ts"

/**
 * The account page: the signed-in teammate's identity and connected accounts.
 * `Teammates` and `AccountLinking` fail with the domain errors the endpoints
 * declare, so the handlers only pick the teammate and call through.
 */
export const AccountGroupLayer = HttpApiBuilder.group(JanitorApi, "account", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.gen(function* () {
        const teammate = yield* CurrentTeammate
        const linking = yield* AccountLinking
        return yield* Teammates.use((teammates) =>
          teammates.account(teammate.teammateId, linking.availability),
        )
      }),
    )
    .handle("startLink", ({ params }) =>
      Effect.gen(function* () {
        const teammate = yield* CurrentTeammate
        const url = yield* AccountLinking.use((linking) =>
          linking.start(teammate.teammateId, params.platform),
        )
        return { url }
      }),
    )
    .handle("completeLink", ({ params, payload }) =>
      Effect.flatMap(CurrentTeammate, (teammate) =>
        AccountLinking.use((linking) =>
          linking.complete(teammate.teammateId, params.platform, payload),
        ),
      ),
    )
    .handle("unlink", ({ params }) =>
      Effect.flatMap(CurrentTeammate, (teammate) =>
        Teammates.use((teammates) => teammates.disconnect(teammate.teammateId, params.linkId)),
      ),
    ),
)

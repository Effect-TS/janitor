import { GitHubRepositoryDatabaseIdFromStringOrNumber } from "@janitor/domain/GitHub/Id"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"

/** Attribution also covers supported events that do not yet update facts. */
export const repositoryOfPayload = (plaintext: Uint8Array) =>
  Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        repository: Schema.optionalKey(
          Schema.Struct({ id: GitHubRepositoryDatabaseIdFromStringOrNumber }),
        ),
      }),
    ),
  )(new TextDecoder().decode(plaintext)).pipe(
    Option.flatMap((payload) => Option.fromUndefinedOr(payload.repository?.id)),
  )

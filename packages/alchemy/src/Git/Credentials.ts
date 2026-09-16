import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import type { GitError } from "./Checkouts.ts"
import type { Remote } from "./Remote.ts"

export interface RemoteCredentials {
  readonly username: string
  readonly password: Redacted.Redacted<string>
}

/** Optional credentials, resolved afresh for network operations. */
export class Credentials extends Context.Service<
  Credentials,
  { readonly for: (remote: Remote) => Effect.Effect<Option.Option<RemoteCredentials>, GitError> }
>()("@janitor/alchemy/Git/Credentials") {}

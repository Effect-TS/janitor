import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { Sandbox } from "../AI/Sandbox.ts"
import { GitError, failure } from "./Checkouts.ts"
import { Credentials } from "./Credentials.ts"
import type { Remote } from "./Remote.ts"

/** Per-process authentication: no credentials in command arguments or .git/config. */
export const makeEnvironment = Effect.gen(function* () {
  const provider = yield* Effect.serviceOption(Credentials)
  return Effect.fnUntraced(function* (remote: Remote) {
    const credentials = Option.isSome(provider) ? yield* provider.value.for(remote) : Option.none()

    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" }

    if (Option.isSome(credentials)) {
      const url = yield* Effect.try({
        try: () => new URL(remote.url),
        catch: failure("authenticate"),
      })

      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return yield* failure("authenticate")("HTTP credentials require an HTTP(S) remote")
      }

      const encoded = yield* Effect.sync(() => {
        const text = `${credentials.value.username}:${Redacted.value(credentials.value.password)}`
        return btoa(
          Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""),
        )
      })

      env.GIT_CONFIG_COUNT = "1"
      env.GIT_CONFIG_KEY_0 = `http.${url.href}/.extraHeader`
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${encoded}`
    }

    return env
  })
})

export const makeGit = Effect.gen(function* () {
  const sandbox = yield* Sandbox

  return Effect.fnUntraced(function* (args: ReadonlyArray<string>, env?: Record<string, string>) {
    const result = yield* sandbox
      .exec("git", args, {
        timeout: 120_000,
        env: { GIT_TERMINAL_PROMPT: "0", ...env },
      })
      .pipe(Effect.mapError(failure(args.join(" "))))

    if (!result.success) {
      return yield* new GitError({
        command: args.join(" "),
        exitCode: result.exitCode,
        stderr: result.stderr,
      })
    }

    return result.stdout.trim()
  })
})

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { expect, it } from "vite-plus/test"
import { makeEnvironment } from "../../src/Git/Command.ts"
import { Credentials } from "../../src/Git/Credentials.ts"

it("captures the credential provider while refreshing credentials for each operation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let lookups = 0
      const environment = yield* makeEnvironment.pipe(
        Effect.provideService(Credentials, {
          for: () =>
            Effect.sync(() => {
              lookups += 1
              return Option.some({
                username: "test",
                password: Redacted.make(`fixture-${lookups}`),
              })
            }),
        }),
      )
      const remote = { url: "https://example.test/owner/repo.git" }
      const first = yield* environment(remote)
      const second = yield* environment(remote)
      expect(lookups).toBe(2)
      expect(first.GIT_CONFIG_KEY_0).toBe("http.https://example.test/owner/repo.git/.extraHeader")
      expect(first.GIT_CONFIG_VALUE_0).not.toBe(second.GIT_CONFIG_VALUE_0)
      expect(first.GIT_TERMINAL_PROMPT).toBe("0")
    }),
  ))

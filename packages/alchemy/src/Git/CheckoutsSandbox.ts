import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import { Sandbox } from "../AI/Sandbox.ts"
import { Checkout, CheckoutOptions, Checkouts, failure } from "./Checkouts.ts"
import { makeEnvironment, makeGit } from "./Command.ts"
import { defaultBranch } from "./Remote.ts"
import { CheckoutRecord, CheckoutRecordJson } from "./CheckoutRecord.ts"

const marker = ".git/janitor-checkout.json"

/** One checkout per sandbox. Construct this layer inside its owning session. */
export const makeCheckoutsSandbox = Effect.gen(function* () {
  const sandbox = yield* Sandbox
  const git = yield* makeGit
  const environment = yield* makeEnvironment
  const lock = yield* Semaphore.make(1)
  const locked = Semaphore.withPermits(lock, 1)

  const read = Effect.gen(function* () {
    if (!(yield* sandbox.exists(marker))) {
      return Option.none<CheckoutRecord>()
    }
    const text = yield* sandbox.readFile(marker)
    const checkout = yield* Schema.decodeEffect(CheckoutRecordJson)(text)
    return Option.some(checkout)
  }).pipe(Effect.mapError(failure("checkout marker")))

  const checkout = Effect.fnUntraced(function* (input: CheckoutOptions) {
    const options = yield* Schema.decodeEffect(CheckoutOptions, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(failure("checkout")))
    const current = yield* read
    const ref = options.ref ?? defaultBranch(options.remote)
    if (Option.isSome(current)) {
      if (
        current.value.checkout.key !== options.key ||
        current.value.checkout.remote.url !== options.remote.url
      ) {
        return yield* failure("checkout")(
          "sandbox already belongs to another checkout; release it before changing key or repository",
        )
      }
      if (!options.fresh && current.value.state === "Ready") {
        if (current.value.checkout.ref !== ref)
          return yield* failure("checkout")(
            "checkout ref changed; explicitly request fresh to discard local changes",
          )
        return current.value.checkout
      }
    } else {
      const entries = yield* sandbox.listFiles().pipe(Effect.mapError(failure("checkout")))
      if (entries.length > 0)
        return yield* failure("checkout")(
          "workspace is not empty and has no checkout marker; preserve or remove its files before acquiring it",
        )
    }

    const env = yield* environment(options.remote)
    const location = yield* sandbox
      .exec("pwd", ["-P"])
      .pipe(Effect.mapError(failure("workspace root")))
    if (!location.success) return yield* failure("workspace root")(location.stderr)
    const value: Checkout = {
      key: options.key,
      remote: options.remote,
      ref,
      root: location.stdout.trim(),
      path: ".",
      branch: "janitor/session",
    }
    const pending = yield* Schema.encodeEffect(CheckoutRecordJson)({
      state: "Pending",
      checkout: value,
    }).pipe(Effect.mapError(failure("checkout marker")))
    yield* sandbox.writeFile(marker, pending).pipe(Effect.mapError(failure("checkout marker")))
    yield* git(["init", "."])
    yield* git(["config", "remote.origin.url", options.remote.url])
    yield* git(["fetch", "--depth", "1", "origin", ref], env)
    yield* git(["checkout", "--force", "-B", "janitor/session", "FETCH_HEAD"])
    yield* git(["reset", "--hard", "FETCH_HEAD"])
    if (options.fresh) yield* git(["clean", "-fd"])
    const text = yield* Schema.encodeEffect(CheckoutRecordJson)({
      state: "Ready",
      checkout: value,
    }).pipe(Effect.mapError(failure("checkout marker")))
    yield* sandbox.writeFile(marker, text).pipe(Effect.mapError(failure("checkout marker")))
    return value
  }, locked)

  const get = Effect.fnUntraced(function* (key: string) {
    return (yield* read).pipe(
      Option.filter((record) => record.state === "Ready" && record.checkout.key === key),
      Option.map((record) => record.checkout),
    )
  }, locked)

  const release = Effect.fnUntraced(function* (key: string) {
    const current = yield* read
    if (Option.isNone(current)) return
    if (current.value.checkout.key !== key)
      return yield* failure("release")("sandbox belongs to a different checkout key")
    const result = yield* sandbox
      .exec(
        "find",
        [".", "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "--", "{}", "+"],
        { timeout: 120_000 },
      )
      .pipe(Effect.mapError(failure("release")))
    if (!result.success) return yield* failure("release")(result.stderr)
  }, locked)

  return Checkouts.of({ checkout, get, release })
})

export const layerSandbox = Layer.effect(Checkouts, makeCheckoutsSandbox)

import { JanitorApi } from "@janitor/domain/Api"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as HttpApiClient from "effect/http-api/HttpApiClient"

/**
 * The client derived from `JanitorApi`, built once from the app's
 * `HttpClient`. Commands `yield* ApiClient` and map each endpoint's typed
 * errors to their own copy.
 */
export class ApiClient extends Context.Service<
  ApiClient,
  HttpApiClient.ForApi<typeof JanitorApi>
>()("@janitor/web/lib/api-client/ApiClient") {
  /** Needs `HttpClient`; `entry.ts` stacks it on `FetchHttpClient.layer`. */
  static readonly layer = Layer.effect(ApiClient, HttpApiClient.make(JanitorApi))
}

/**
 * PROTOTYPE (EFF-2304): the web app's derived `HttpApiClient`, built once
 * from the app's `HttpClient` and provided through `AppServices`. Commands
 * `yield* ApiClient` and map the endpoint's typed errors to their own copy,
 * which replaces `lib/api.ts`'s `request`, `readFailure` and `reasonOf`.
 */
import { JanitorApi } from "@janitor/domain/Api/PullRequestReview.prototype"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as HttpApiClient from "effect/http-api/HttpApiClient"

export class ApiClient extends Context.Service<
  ApiClient,
  HttpApiClient.ForApi<typeof JanitorApi>
>()("web/ApiClient") {
  /** Needs `HttpClient`; `entry.ts` stacks it on `FetchHttpClient.layer`. */
  static readonly layer = Layer.effect(ApiClient, HttpApiClient.make(JanitorApi))
}

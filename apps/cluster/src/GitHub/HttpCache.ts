import { GITHUB_API_VERSION } from "@janitor/domain/GitHub/Api"
import { GitHubWebhookDeliveryId, type GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEncryptionKeyId } from "@janitor/domain/GitHub/WebhookEnvelope"
import { PayloadCipher } from "../PayloadCipher.ts"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"

export class GitHubHttpCacheError extends Schema.TaggedError<GitHubHttpCacheError>()(
  "@janitor/cluster/GitHub/HttpCache/GitHubHttpCacheError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface CacheKey {
  /** Authorization scope, from `gitHubApiScopeKey`. */
  readonly scopeKey: string
  readonly method: string
  readonly url: string
}

export interface CachedPage {
  readonly etag: string
  readonly body: unknown
  readonly next: Option.Option<string>
}

export interface PutRequest extends CacheKey {
  readonly etag: string
  readonly body: unknown
  readonly next: Option.Option<string>
  /** Lets access-loss purges find pages that hold this repository's content. */
  readonly repositoryId: Option.Option<GitHubRepositoryDatabaseId>
}

/** Exact request identity: method, full URL, media type, and API version. */
export const requestKey = (key: CacheKey): string =>
  `${key.method} ${key.url} application/vnd.github+json ${GITHUB_API_VERSION}`

const CacheRow = Schema.Struct({
  etag: Schema.String,
  next_url: Schema.NullOr(Schema.String),
  encryption_key_id: GitHubWebhookEncryptionKeyId,
  encryption_iv: Schema.instanceOf(Uint8Array),
  body: Schema.instanceOf(Uint8Array),
})

/**
 * Stored representations for conditional requests. Bodies are ciphertext
 * because cached pages can hold private repository content; the request key
 * is bound as authenticated data so a page cannot be replayed for another URL.
 */
export class GitHubHttpCache extends Context.Service<
  GitHubHttpCache,
  {
    readonly get: (key: CacheKey) => Effect.Effect<Option.Option<CachedPage>, GitHubHttpCacheError>
    readonly put: (request: PutRequest) => Effect.Effect<void, GitHubHttpCacheError>
    readonly purgeScope: (scopeKey: string) => Effect.Effect<void, GitHubHttpCacheError>
    readonly purgeRepository: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<void, GitHubHttpCacheError>
  }
>()("@janitor/cluster/GitHub/HttpCache/GitHubHttpCache", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const cipher = yield* PayloadCipher
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(CacheRow))
    const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
    const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new GitHubHttpCacheError({ operation, message: describeError(error) }),
        )

    // The cipher binds additional data by delivery id; a request key plays that role here.
    const aad = (key: string) => GitHubWebhookDeliveryId.make(key)

    const get = Effect.fn("GitHubHttpCache.get")(function* (key: CacheKey) {
      const request = requestKey(key)
      const rows = yield* sql`
        SELECT etag, next_url, encryption_key_id, encryption_iv, body FROM github_http_cache
        WHERE scope_key = ${key.scopeKey} AND request_key = ${request}
      `.pipe(Effect.flatMap(decodeRows), wrap("get"))
      const row = rows[0]
      if (row === undefined) return Option.none()
      const plaintext = yield* cipher
        .decrypt(
          aad(request),
          { algorithm: "AES-256-GCM", keyId: row.encryption_key_id, iv: row.encryption_iv },
          row.body,
        )
        .pipe(wrap("get"))
      const body = yield* decodeJson(new TextDecoder().decode(plaintext)).pipe(wrap("get"))
      return Option.some({ etag: row.etag, body, next: Option.fromNullishOr(row.next_url) })
    })

    const put = Effect.fn("GitHubHttpCache.put")(function* (request: PutRequest) {
      const key = requestKey(request)
      const json = yield* encodeJson(request.body).pipe(wrap("put"))
      const { encryption, ciphertext } = yield* cipher
        .encrypt(aad(key), new TextEncoder().encode(json))
        .pipe(wrap("put"))
      yield* sql`
        INSERT INTO github_http_cache ${sql.insert({
          scope_key: request.scopeKey,
          request_key: key,
          repository_id: Option.getOrNull(request.repositoryId),
          etag: request.etag,
          next_url: Option.getOrNull(request.next),
          encryption_key_id: encryption.keyId,
          encryption_iv: encryption.iv,
          body: ciphertext,
        })}
        ON CONFLICT (scope_key, request_key) DO UPDATE SET
          repository_id = EXCLUDED.repository_id,
          etag = EXCLUDED.etag,
          next_url = EXCLUDED.next_url,
          encryption_key_id = EXCLUDED.encryption_key_id,
          encryption_iv = EXCLUDED.encryption_iv,
          body = EXCLUDED.body,
          observed_at = CLOCK_TIMESTAMP()
      `.pipe(wrap("put"))
    })

    const purgeScope = Effect.fn("GitHubHttpCache.purgeScope")(function* (scopeKey: string) {
      yield* sql`DELETE FROM github_http_cache WHERE scope_key = ${scopeKey}`.pipe(
        wrap("purgeScope"),
      )
    })

    const purgeRepository = Effect.fn("GitHubHttpCache.purgeRepository")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* sql`DELETE FROM github_http_cache WHERE repository_id = ${repositoryId}`.pipe(
        wrap("purgeRepository"),
      )
    })

    return { get, put, purgeScope, purgeRepository }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

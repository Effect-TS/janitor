import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import {
  DiscoverInstallations,
  DiscoverInstallationsLayer,
} from "../../src/GitHub/DiscoverInstallations.ts"
import { GitHubTransport } from "../../src/GitHub/Transport.ts"
import { GitHubHttpCache } from "../../src/GitHub/HttpCache.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { SyncIntegration } from "../../src/SyncIntegration.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const DataLayer = Layer.mergeAll(SyncTargets.layer, GitHubReadModel.layer).pipe(
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(DataLayer, { timeout: "2 minutes" })("Installation discovery", (it) => {
  it.effect("discovers installations across pages without a creation webhook", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const model = yield* GitHubReadModel
      const scope = { _tag: "AppInventory" } as const
      const requested = yield* targets.invalidate({ scope, sequence: Option.none() })
      const requests: string[] = []
      yield* DiscoverInstallations.execute({ scope, generation: requested.generation }).pipe(
        Effect.provide(
          DiscoverInstallationsLayer.pipe(
            Layer.provide(SyncIntegration.noop),
            Layer.provide(
              Layer.succeed(GitHubHttpCache, {
                get: () => Effect.succeedNone,
                put: () => Effect.void,
                purgeScope: () => Effect.void,
                purgeRepository: () => Effect.void,
              }),
            ),
            Layer.provide(
              Layer.succeed(GitHubTransport, {
                request: (request) =>
                  Effect.sync(() => {
                    requests.push(request.url)
                    const second = request.url.includes("page=2")
                    return {
                      _tag: "Ok" as const,
                      status: 200,
                      etag: Option.none(),
                      requestId: Option.none(),
                      link: second
                        ? Option.none()
                        : Option.some(
                            '<https://api.github.com/app/installations?per_page=100&page=2>; rel="next"',
                          ),
                      body: [
                        {
                          id: second ? 902 : 901,
                          account: { id: 1, login: "org", type: "Organization" },
                          repository_selection: "all",
                          html_url: "https://github.com/settings/installations/901",
                          permissions: {
                            metadata: "read",
                            issues: "write",
                            pull_requests: "read",
                            checks: "read",
                          },
                          suspended_at: null,
                        },
                      ],
                    }
                  }),
              }),
            ),
            Layer.provideMerge(WorkflowEngine.layerMemory),
          ),
        ),
      )
      assert.strictEqual(requests.length, 2)
      for (const id of ["901", "902"]) {
        const installationId = GitHubInstallationId.make(id)
        assert.isTrue(Option.isSome(yield* model.getInstallation(installationId)))
        assert.strictEqual(
          Option.getOrThrow(yield* targets.get({ _tag: "InstallationInventory", installationId }))
            .requestedGeneration,
          "1",
        )
      }
      assert.strictEqual(
        Option.getOrThrow(yield* targets.get(scope)).verifiedGeneration,
        requested.generation,
      )
    }),
  )
})

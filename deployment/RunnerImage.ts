import process from "node:process"
import { Resource } from "alchemy/Resource"
import * as Provider from "alchemy/Provider"
import * as Docker from "alchemy/Docker"
import * as Credentials from "@distilled.cloud/cloudflare/Credentials"
import { parseRepoDigest } from "alchemy/Docker/Registry"
import { isResolved } from "alchemy/Diff"
import { createContainerRegistryCredentials } from "@distilled.cloud/cloudflare/containers"
import { Effect, FileSystem, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { bridgeSourceHash, BRIDGE_SOURCES } from "../apps/runner/scripts/bridge-source.mjs"

export class RunnerImageProviders extends Provider.ProviderCollection<RunnerImageProviders>()(
  "JanitorRunnerImage",
) {}
interface RunnerImage extends Resource<
  "Janitor.RunnerImage",
  {
    readonly context: string
    readonly contentHash: string
    readonly sourceHash: string
    readonly accountId: string
  },
  {
    readonly contentHash: string
    readonly sourceHash: string
    readonly imageRef: string
    readonly imageId: string
    readonly tools: { readonly node: string; readonly packages: string }
  },
  never,
  RunnerImageProviders
> {}
export const RunnerImage = Resource<RunnerImage>("Janitor.RunnerImage")

/** Publishes an independently versioned image before the Worker is bundled.
 * Container applications cannot own this step: their namespace binding depends on that Worker.
 * All Docker lifecycle and Cloudflare authorization use the installed Alchemy/Effect clients.
 */
const provider = () =>
  Provider.effect(
    RunnerImage,
    Effect.gen(function* () {
      const docker = yield* Docker.Docker
      const fs = yield* FileSystem.FileSystem
      return RunnerImage.Provider.of({
        list: () => Effect.succeed([]),
        read: ({ output }) => Effect.succeed(output),
        diff: ({ news, output }) =>
          Effect.succeed(
            isResolved(news) &&
              output &&
              (news.contentHash !== output.contentHash ||
                !output.imageRef.startsWith(`registry.cloudflare.com/${news.accountId}/`))
              ? { action: "update" as const }
              : undefined,
          ),
        reconcile: Effect.fn("RunnerImage.publish")(function* ({ news, session }) {
          const source = yield* Effect.try(() =>
            bridgeSourceHash(new URL(`${news.context}/`, `file://${process.cwd()}/`)),
          )
          const declared = JSON.parse(yield* fs.readFileString(`${news.context}/build.json`)) as {
            sourceHash: string
          }
          if (source !== news.sourceHash || declared.sourceHash !== source)
            return yield* Effect.die(
              new Error("Sandbox source hash differs from the reviewed release manifest"),
            )
          const ref = `registry.cloudflare.com/${news.accountId}/janitor-agent-sandbox:${news.contentHash}`
          yield* session.note("Building and verifying the runner sandbox image")
          yield* docker.image.build({ tag: ref, context: news.context, platform: "linux/amd64" })
          const inspected = yield* docker.image.inspect(ref)
          const verification = yield* docker.run([
            "run",
            "--rm",
            "--network=none",
            "--entrypoint",
            "node",
            ref,
            "--input-type=module",
            "-e",
            `
        import { readFileSync } from 'node:fs';
        import { execFileSync } from 'node:child_process';
        import { createHash } from 'node:crypto';
        const hash = createHash('sha256');
        for (const name of ${JSON.stringify(BRIDGE_SOURCES)}) {
          hash.update(name); hash.update('\\0'); hash.update(readFileSync('/opt/janitor/' + name)); hash.update('\\0');
        }
        console.log(JSON.stringify({ sourceHash: hash.digest('hex'), node: process.version,
          packages: execFileSync('dpkg-query', ['-W','coreutils','findutils','ripgrep','git','util-linux','ca-certificates'], {encoding:'utf8'}) }));
      `,
          ])
          const verified = JSON.parse(verification.stdout) as {
            sourceHash: string
            node: string
            packages: string
          }
          if (verified.sourceHash !== source)
            return yield* Effect.die(
              new Error("Built sandbox sources differ from the reviewed release"),
            )
          // Mint only during reconciliation. Plans and unchanged releases do not mint credentials.
          const credentials = yield* createContainerRegistryCredentials({
            accountId: news.accountId,
            registryId: "registry.cloudflare.com",
            permissions: ["pull", "push"],
            expirationMinutes: 30,
          }).pipe(Effect.provide(Credentials.fromEnv()))
          const username = credentials.username ?? credentials.user
          if (!username)
            return yield* Effect.die(new Error("Container registry returned no username"))
          yield* session.note("Publishing the verified sandbox image")
          const pushed = yield* docker.image.push(
            ref,
            { server: "registry.cloudflare.com", username, password: credentials.password },
            "linux/amd64",
          )
          const imageRef = parseRepoDigest(ref, pushed.stdout)
          if (!imageRef)
            return yield* Effect.die(
              new Error("Container registry push returned no immutable digest"),
            )
          return {
            contentHash: news.contentHash,
            sourceHash: source,
            imageRef,
            imageId: inspected.Id,
            tools: { node: verified.node, packages: verified.packages },
          }
        }),
        // Published immutable images are retained for rollback; replacing a Worker never deletes them.
        delete: () => Effect.void,
      })
    }),
  )

export const runnerImageProviders = () =>
  Layer.effect(RunnerImageProviders, Provider.collection([RunnerImage])).pipe(
    Layer.provide(provider()),
    Layer.provideMerge(Docker.DockerLive),
    Layer.provide(FetchHttpClient.layer),
  )

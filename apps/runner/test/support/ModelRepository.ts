import { makeRepositoryFixture } from "../../dev/RepositoryFixture.ts"
/** Repository HTTP boundary shared by the controlled and live model tests. */
export const modelRepository = () => {
  const repository = makeRepositoryFixture()
  return {
    dispose: () => {},
    bindings: { REPOSITORY_SERVICE_TOKEN: "model-test-authority" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async () =>
        Response.json({ owner: "fixture", repo: "fixture", token: "fixture-token" }),
      GITHUB_API: async (request: Request) => (await repository).fetch(request),
    },
  }
}

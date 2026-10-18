import { defineConfig } from "@effect/graphql-generator/Config"

// GitHub's public schema, from https://docs.github.com/public/fpt/schema.docs.graphql
export default defineConfig({
  schema: "./src/GitHub/graphql/github.graphql",
  documents: ["src/**/*.graphql"],
  scalars: {
    Int: "effect/Schema#Int",
    GitObjectID: "effect/Schema#String",
  },
})

import { defineConfig } from "vite-plus"
import { recommended } from "@effect/tsgo/oxlint-presets"

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    semi: false,
  },
  lint: {
    extends: [recommended],
    plugins: ["typescript"],
    jsPlugins: [
      {
        name: "foldkit",
        specifier: "@foldkit/oxlint-plugin",
      },
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    rules: {
      "eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  run: {
    cache: true,

    tasks: {
      dev: {
        command: "vp exec node scripts/dev.mjs",
        cache: false,
      },
      seed: {
        // Re-seeds the running dev container without restarting the stack.
        // `alchemy dev` also runs this, but only when the fixtures change.
        command: "vp exec node apps/cluster/seed/main.ts",
        cache: false,
      },
      "production:plan": {
        command: "vp exec node scripts/deploy.ts production plan",
        cache: false,
      },
      "production:deploy": {
        command: "vp exec node scripts/deploy.ts production deploy",
        cache: false,
      },
      "build:web": { command: "vp build --config apps/web/vite.config.ts" },
      "check:dependencies": {
        command: "vp exec node scripts/check-dependencies.mjs",
        cache: false,
      },
      "check:worker-bundle": {
        command: "vp exec node scripts/check-worker-bundle.ts",
        cache: false,
      },
      "benchmark:sync": {
        command: "vp exec tsx apps/cluster/scripts/BenchmarkSync.ts",
        cache: false,
      },
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "backend",
          include: ["apps/cluster/test/**/*.test.ts", "packages/domain/test/**/*.test.ts"],
        },
      },
      "./apps/web/vite.config.ts",
    ],
    exclude: [".direnv", "**/node_modules/**"],
    server: {
      deps: {
        // Run these inside the vitest module graph so they share one `effect`
        // instance with the tests. Externalized, Node would load `effect`
        // separately and module-level state such as the Redacted registry
        // would split across two copies.
        inline: [/@effect\/sql-pg/, /@effect\/platform-node/],
      },
    },
  },
})

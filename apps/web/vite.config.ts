import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite-plus"

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [tailwindcss(), foldkit({ devToolsMcpPort: 9988 })],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
  server: {
    // Deployed, the API is a second Worker on this same hostname, reached
    // through a route. Routes are an edge feature and do not exist locally,
    // so in development this proxy stands in for one: `alchemy dev` runs
    // this server for the website Worker and the API Worker on 8787, where
    // Access is simulated. Set JANITOR_API_ORIGIN to point at a deployed
    // stage instead; that stage is behind Access, so also set
    // CF_ACCESS_TOKEN to the output of `cloudflared access token`. The proxy
    // rewrites the origin so writes still look same-origin to the Worker.
    proxy: {
      "/api": {
        target: process.env.JANITOR_API_ORIGIN ?? "http://localhost:8787",
        changeOrigin: true,
        headers:
          process.env.CF_ACCESS_TOKEN === undefined
            ? {}
            : { "cf-access-token": process.env.CF_ACCESS_TOKEN },
      },
    },
  },
  test: {
    name: "web",
    environment: "happy-dom",
    setupFiles: ["./vitest-setup.ts"],
  },
})

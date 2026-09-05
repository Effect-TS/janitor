import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { getCACertificates } from "node:tls"
import { fileURLToPath } from "node:url"

// Refuse a second session before it opens the same local Durable Object stores.
for (const port of [1337, 8787, 9988]) {
  const server = createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, resolve)
    })
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error
    process.stderr.write(
      `Dev port ${port} is occupied. Stop the existing dev process before running vp run dev.\n`,
    )
    process.exit(1)
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
}

// workerd's system CA lookup does not work on every Nix installation.
// Share Node's trusted roots with it, including caller-configured extra CAs.
const directory = new URL("../.alchemy/", import.meta.url)
await mkdir(directory, { recursive: true })
const certificates = new URL("dev-ca.pem", directory)
await writeFile(certificates, getCACertificates("default").join("\n"))
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../bin/cli.js", import.meta.resolve("alchemy"))),
    "dev",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(certificates) },
  },
)
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal))
}
child.on("error", (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143)
})

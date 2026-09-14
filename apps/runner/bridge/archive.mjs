import {
  lstatSync,
  readdirSync,
  readlinkSync,
  mkdirSync,
  symlinkSync,
  chmodSync,
  rmSync,
  renameSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  mkdtempSync,
  createReadStream,
  createWriteStream,
  statSync,
} from "node:fs"
import { join, posix, basename } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createInterface } from "node:readline"
import { pipeline } from "node:stream/promises"
import { Transform } from "node:stream"

const excluded = new Set([
  "node_modules",
  ".cache",
  ".pnpm-store",
  ".npm",
  ".ssh",
  ".aws",
  ".git-credentials",
  ".env",
])
const safe = (path) =>
  typeof path === "string" &&
  path !== "" &&
  !path.includes("\0") &&
  !path.startsWith("/") &&
  path.split("/").every((part) => part && part !== "." && part !== "..")
const safeLink = (path, target) =>
  typeof target === "string" &&
  !target.includes("\0") &&
  !target.startsWith("/") &&
  safe(posix.normalize(posix.join(posix.dirname(path), target)))

// Cache exclusions never discard tracked repository content or its parent directories.
function trackedPaths(root) {
  const tracked = new Set()
  if (!readdirSync(root).includes("repository")) return tracked
  const files = execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${join(root, "repository")}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      join(root, "repository"),
      "ls-files",
      "--cached",
      "-z",
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  )
  for (const file of files.split("\0").filter(Boolean)) {
    let path = `repository/${file}`
    while (path !== ".") {
      tracked.add(path)
      path = posix.dirname(path)
    }
  }
  return tracked
}

/** A line-oriented archive keeps file contents bounded to 64 KiB chunks throughout transfer. */
export function archive(root) {
  const temporary = mkdtempSync(join(tmpdir(), "janitor-archive-"))
  const file = join(temporary, "workspace.ndjson")
  const fd = openSync(file, "wx", 0o600)
  const hash = createHash("sha256")
  const emit = (record) => {
    const bytes = Buffer.from(JSON.stringify(record) + "\n")
    hash.update(bytes)
    writeSync(fd, bytes)
  }
  try {
    const tracked = trackedPaths(root)
    emit({ format: "janitor-workspace-2" })
    const walk = (relative, omitted = false) => {
      for (const name of readdirSync(join(root, relative)).sort()) {
        const path = relative ? `${relative}/${name}` : name
        const skip = omitted || excluded.has(name) || name.startsWith(".env.")
        if (skip && !tracked.has(path)) continue
        const source = join(root, path)
        const stat = lstatSync(source)
        const mode = stat.mode & 0o777
        if (stat.isDirectory()) {
          emit({ path, type: "directory", mode })
          walk(path, skip)
        } else if (stat.isSymbolicLink()) {
          const target = readlinkSync(source)
          if (!safeLink(path, target)) throw new Error(`Symlink escapes workspace: ${path}`)
          emit({ path, type: "symlink", target, mode })
        } else if (stat.isFile()) {
          emit({ path, type: "file", mode })
          const input = openSync(source, "r")
          try {
            const bytes = Buffer.alloc(64 * 1024)
            let count
            while ((count = readSync(input, bytes)) > 0)
              emit({ data: bytes.subarray(0, count).toString("base64") })
          } finally {
            closeSync(input)
          }
          emit({ end: true })
        } else throw new Error(`Unsupported workspace file: ${path}`)
      }
    }
    walk("")
    closeSync(fd)
    return {
      file,
      sha256: hash.digest("hex"),
      size: statSync(file).size,
      cleanup: () => rmSync(temporary, { recursive: true, force: true }),
    }
  } catch (error) {
    closeSync(fd)
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

/** Verify the complete incoming archive before parsing it or changing the workspace. */
export async function restore(root, stream, sha256) {
  const temporary = mkdtempSync(join(tmpdir(), "janitor-restore-"))
  const file = join(temporary, "workspace.ndjson")
  const staging = mkdtempSync(join(root, ".janitor-restore-"))
  let output
  try {
    const hash = createHash("sha256")
    await pipeline(
      stream,
      new Transform({
        transform(bytes, _encoding, done) {
          hash.update(bytes)
          done(null, bytes)
        },
      }),
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
    )
    if (hash.digest("hex") !== sha256) throw new Error("Archive checksum mismatch")
    const paths = new Map()
    const directories = []
    let first = true
    for await (const line of createInterface({
      input: createReadStream(file),
      crlfDelay: Infinity,
    })) {
      if (line.length > 128 * 1024) throw new Error("Invalid archive record size")
      const entry = JSON.parse(line)
      if (first) {
        first = false
        if (entry.format !== "janitor-workspace-2") throw new Error("Unsupported archive format")
        continue
      }
      if (output !== undefined) {
        if (entry.end === true) {
          closeSync(output)
          output = undefined
          continue
        }
        if (
          typeof entry.data !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data)
        )
          throw new Error("Invalid archive bytes")
        writeSync(output, Buffer.from(entry.data, "base64"))
        continue
      }
      if (
        !safe(entry.path) ||
        paths.has(entry.path) ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o777
      )
        throw new Error("Invalid archive entry")
      const parent = posix.dirname(entry.path)
      if (parent !== "." && paths.get(parent) !== "directory")
        throw new Error("Invalid archive parent")
      const target = join(staging, entry.path)
      if (entry.type === "directory") {
        mkdirSync(target)
        directories.push(entry)
      } else if (entry.type === "symlink") {
        if (!safeLink(entry.path, entry.target)) throw new Error("Unsafe archive link")
        symlinkSync(entry.target, target)
      } else if (entry.type === "file") {
        output = openSync(target, "wx", entry.mode)
        chmodSync(target, entry.mode)
      } else throw new Error("Unsupported archive entry")
      paths.set(entry.path, entry.type)
    }
    if (first || output !== undefined) throw new Error("Incomplete archive")
    for (const entry of directories.toReversed()) chmodSync(join(staging, entry.path), entry.mode)
    for (const name of readdirSync(root))
      if (name !== basename(staging)) rmSync(join(root, name), { recursive: true, force: true })
    for (const name of readdirSync(staging)) renameSync(join(staging, name), join(root, name))
  } finally {
    if (output !== undefined) closeSync(output)
    rmSync(temporary, { recursive: true, force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

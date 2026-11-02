import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ChatFile } from "./Platform.ts"
import type { SandboxReadFailed } from "./Sandbox/Sandboxes.ts"

/**
 * Files the chat agent attaches to its reply (EFF-3309). `attachFile` reads
 * a file from the sandbox into the turn's list, and the files go out with
 * the reply, in the same message as its last part.
 */

/**
 * Files one reply may carry. Discord takes ten files a message, and a reply
 * too long to post as messages takes one of them as `reply.md`.
 */
export const MAX_REPLY_FILES = 9

/**
 * The size of a reply's files together. Discord takes 10 MiB a message on a
 * server without boosts; the rest leaves room for a `reply.md`.
 */
export const MAX_REPLY_BYTES = 9 * 1024 * 1024

export const AttachFileParameters = Schema.Struct({
  path: Schema.String.annotate({
    description: "The file's absolute path, under /workspace.",
  }),
  name: Schema.optionalKey(
    Schema.String.annotate({
      description: "The filename shown in the thread. Defaults to the file's own name.",
    }),
  ),
})

const AttachFile = Tool.make("attachFile", {
  description:
    "Attach a file from /workspace to your reply: a generated image, a diff, a log, or anything too big to paste. The file is read now and posted with your reply; nothing is posted if the turn ends without one.",
  parameters: AttachFileParameters,
  success: Schema.String,
  failure: Schema.String,
})

/** The chat agent's loop-side tools. */
export const ChatTools = Toolkit.make(AttachFile)

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  diff: "text/x-diff",
  patch: "text/x-diff",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  mp4: "video/mp4",
}

/** A file's content type, from its name's extension. */
export const contentTypeOf = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return (
    (dot <= 0 ? undefined : CONTENT_TYPES[name.slice(dot + 1).toLowerCase()]) ??
    "application/octet-stream"
  )
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/**
 * One loop's attached files, read from its sandbox. A loop in a new sandbox
 * starts a new list: files from a lost one may be gone or out of date.
 */
export const makeReplyFiles = (sandbox: {
  readonly readFile: (
    path: string,
    maxBytes: number,
  ) => Effect.Effect<Uint8Array, SandboxReadFailed>
}) => {
  const files: Array<ChatFile> = []
  const used = () => files.reduce((sum, file) => sum + file.content.length, 0)

  const tooMany = () =>
    Effect.fail(
      `A reply can carry at most ${MAX_REPLY_FILES} files, and it has ${files.length}. Put the rest in one archive, or link to them.`,
    )
  const unreadable = (path: string, reason: string, left: number) =>
    Effect.fail(
      `Couldn't attach ${path}: ${reason}. A reply's files can total ${megabytes(MAX_REPLY_BYTES)}, and ${megabytes(left)} is left; for a larger file, compress it, attach an excerpt, or link to it.`,
    )

  const attachFile = ({ path, name }: typeof AttachFileParameters.Type) =>
    Effect.gen(function* () {
      if (files.length >= MAX_REPLY_FILES) return yield* tooMany()
      const shown = (name ?? path).split("/").at(-1)?.trim() ?? ""
      if (shown === "") return yield* Effect.fail(`${name ?? path} is no filename`)
      const left = MAX_REPLY_BYTES - used()
      const content = yield* sandbox
        .readFile(path, left)
        .pipe(Effect.catch((error) => unreadable(path, error.reason, left)))
      // Calls running at once, as in a `Promise.all`, are checked again once read.
      if (files.length >= MAX_REPLY_FILES) return yield* tooMany()
      const now = MAX_REPLY_BYTES - used()
      if (content.length > now)
        return yield* unreadable(path, `it is ${megabytes(content.length)}`, now)
      files.push({ name: shown, contentType: contentTypeOf(shown), content })
      return `Attached ${shown} (${megabytes(content.length)}). It is posted with your reply.`
    })

  return {
    attachFile,
    /** The files attached so far, in order. */
    files: (): ReadonlyArray<ChatFile> => [...files],
  }
}

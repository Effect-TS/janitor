import type { DiscordREST } from "dfx/DiscordREST"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ChatPlatform } from "../Platform.ts"

const notImplemented = Effect.die("The Discord platform is not implemented")

/**
 * Discord's `ChatPlatform`, over dfx's REST client. Replies go out in
 * chunks of at most 2,000 characters with code fences kept balanced.
 *
 * Not implemented yet: the tests in `test/Chat/Discord` describe it.
 */
export const layer: Layer.Layer<ChatPlatform, never, DiscordREST> = Layer.succeed(ChatPlatform, {
  postStatus: () => notImplemented,
  editStatus: () => notImplemented,
  postReply: () => notImplemented,
  uploadFile: () => notImplemented,
  download: () => notImplemented,
  history: () => notImplemented,
})

import * as Cloudflare from "@alchemy.run/cloudflare"

/**
 * The chat sandbox: clanka's executor with every tool, and whatever the model
 * clones into `/workspace`. A container class of its own, so chat sessions
 * can't take PR review's sandboxes. Its whole surface is the HTTP app on port
 * 3000 (`ContainerApp.ts`); the runtime is in `ChatSandbox.runtime.ts`, kept
 * apart so the Worker bundle doesn't pull in clanka's executor.
 */
export class ChatSandbox extends Cloudflare.Container<ChatSandbox, {}>()("ChatSandbox") {}

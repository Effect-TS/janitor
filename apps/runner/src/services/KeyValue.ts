// The small key-value port publication records use. The Durable Object binds
// its storage; tests use a map.
import { Context, Layer } from "effect"

export class KeyValue extends Context.Service<
  KeyValue,
  {
    readonly get: <T>(key: string) => Promise<T | undefined>
    readonly put: (key: string, value: unknown) => Promise<void>
    readonly delete: (key: string) => Promise<void>
    readonly list: <T>(prefix: string) => Promise<Map<string, T>>
    readonly sync: () => Promise<void>
  }
>()("janitor/runner/KeyValue") {
  static fromDurableObject(storage: DurableObjectStorage): KeyValue["Service"] {
    return {
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key).then(() => undefined),
      list: (prefix) => storage.list({ prefix }),
      sync: () => storage.sync(),
    }
  }
  static memory(): KeyValue["Service"] {
    const map = new Map<string, unknown>()
    return {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      put: async (key, value) => {
        map.set(key, structuredClone(value))
      },
      delete: async (key) => {
        map.delete(key)
      },
      list: async <T>(prefix: string) =>
        new Map([...map].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
      sync: async () => {},
    }
  }
  static layer(service: KeyValue["Service"]) {
    return Layer.succeed(this, service)
  }
}

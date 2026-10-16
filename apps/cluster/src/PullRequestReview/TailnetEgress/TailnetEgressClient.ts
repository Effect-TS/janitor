/** The tailnet egress DO's raw namespace binding, as workerd hands it to the Worker. */
export interface TailnetEgressNamespace {
  readonly getByName: (name: string) => {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
}

/** The one egress instance every run shares. */
export const TAILNET_EGRESS_NAME = "default"

/**
 * A `fetch` that sends each request, URL included, to the tailnet egress
 * DO; the container forwards it to the endpoint's origin. It goes through
 * the binding's own `fetch`, since alchemy's stub `fetch` drops POST bodies.
 */
export const tailnetFetch =
  (namespace: TailnetEgressNamespace): typeof globalThis.fetch =>
  (input, init) =>
    namespace.getByName(TAILNET_EGRESS_NAME).fetch(input, init)

import * as HttpApi from "effect/http-api/HttpApi"
import { SyncGroup } from "./Api/Sync.ts"

/**
 * Janitor's HTTP API, shared by the cluster's handlers and the web app's
 * derived client. Middleware stays on the router, outside the definition.
 */
export class JanitorApi extends HttpApi.make("janitor").add(SyncGroup).prefix("/api/v1") {}

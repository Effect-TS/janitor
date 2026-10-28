import * as HttpApi from "effect/http-api/HttpApi"
import { AccountGroup } from "./Api/Account.ts"
import { ChatGroup } from "./Api/Chat.ts"
import { ConnectionsGroup } from "./Api/Connections.ts"
import { LabelingGroup } from "./Api/Labeling.ts"
import { PoliciesGroup } from "./Api/Policies.ts"
import { PullRequestReviewGroup } from "./Api/PullRequestReview.ts"
import { RulesGroup } from "./Api/Rules.ts"
import { SyncGroup } from "./Api/Sync.ts"
import { TestBenchGroup } from "./Api/TestBench.ts"

/**
 * Janitor's HTTP API, shared by the cluster's handlers and the web app's
 * derived client. Middleware stays on the router, outside the definition.
 */
export class JanitorApi extends HttpApi.make("janitor")
  .add(SyncGroup)
  .add(AccountGroup)
  .add(ConnectionsGroup)
  .add(PullRequestReviewGroup)
  .add(PoliciesGroup)
  .add(RulesGroup)
  .add(TestBenchGroup)
  .add(LabelingGroup)
  .add(ChatGroup)
  .prefix("/api/v1") {}

import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import { AuthorizationExpired, AuthorizationRejected } from "../GitHub/Authorization.ts"
import {
  AccountAlreadyConnected,
  AccountView,
  ConnectedAccountNotFound,
  LinkedAccount,
  LinkId,
  LinkPlatform,
  LinkReturnRequest,
} from "../Team/Account.ts"

/** The account page: the signed-in teammate's view, and proving or dropping a platform account. */
export class AccountGroup extends HttpApiGroup.make("account")
  .add(HttpApiEndpoint.get("get", "/account", { success: AccountView }))
  .add(
    HttpApiEndpoint.post("startLink", "/account/links/:platform/start", {
      params: { platform: LinkPlatform },
      success: Schema.Struct({ url: Schema.String }),
    }),
  )
  .add(
    HttpApiEndpoint.post("completeLink", "/account/links/:platform/return", {
      params: { platform: LinkPlatform },
      payload: LinkReturnRequest,
      success: LinkedAccount,
      error: [AuthorizationExpired, AuthorizationRejected, AccountAlreadyConnected],
    }),
  )
  .add(
    HttpApiEndpoint.delete("unlink", "/account/links/:linkId", {
      params: { linkId: LinkId },
      error: ConnectedAccountNotFound,
    }),
  ) {}

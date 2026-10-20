import * as Schema from "effect/Schema"

/** The authorization attempt is unknown, already used, expired, or belongs to someone else. */
export class AuthorizationExpired extends Schema.TaggedError<AuthorizationExpired>()(
  "AuthorizationExpired",
  {},
  { httpApiStatus: 410 },
) {}

/** GitHub did not accept the authorization code it sent back. */
export class AuthorizationRejected extends Schema.TaggedError<AuthorizationRejected>()(
  "AuthorizationRejected",
  {},
  { httpApiStatus: 422 },
) {}

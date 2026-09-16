import * as Schema from "effect/Schema"
import { Checkout } from "./Checkouts.ts"

/** Pending records reserve ownership and allow a failed acquisition to resume. */
export const CheckoutRecord = Schema.Struct({
  state: Schema.Literals(["Pending", "Ready"]),
  checkout: Checkout,
})
export type CheckoutRecord = typeof CheckoutRecord.Type
export const CheckoutRecordJson = Schema.fromJsonString(CheckoutRecord)

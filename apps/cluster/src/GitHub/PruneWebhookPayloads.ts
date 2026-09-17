import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Terminal deliveries are never decrypted again. Keep their IDs for deduplication. */
export const pruneWebhookPayloads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    WITH batch AS (
      SELECT delivery_id FROM github_webhook_delivery
      WHERE purged_at IS NULL AND projection_status <> 'pending'
      ORDER BY sequence
      LIMIT 1000
      FOR UPDATE SKIP LOCKED
    )
    UPDATE github_webhook_delivery AS d
    SET payload = ''::bytea, purged_at = CLOCK_TIMESTAMP()
    FROM batch WHERE d.delivery_id = batch.delivery_id
    RETURNING d.delivery_id
  `
  return rows.length
})

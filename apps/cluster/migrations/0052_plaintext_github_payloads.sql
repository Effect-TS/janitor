-- Webhook journal payloads and cached GitHub pages are stored as plaintext.
-- The read model already holds the same content unencrypted, so application
-- encryption protected nothing extra. Existing ciphertext cannot be read
-- without the retired key: cached pages are dropped and refetched, and
-- journaled payloads are purged like retention would, keeping audit rows.

DELETE FROM github_http_cache;

ALTER TABLE github_http_cache
  DROP COLUMN encryption_key_id,
  DROP COLUMN encryption_iv;

UPDATE github_webhook_delivery
SET projection_status = 'failed',
    projection_error = 'Encrypted payload discarded when payload encryption was retired',
    projected_at = CLOCK_TIMESTAMP()
WHERE projection_status = 'pending';

UPDATE github_webhook_delivery
SET payload = ''::bytea, purged_at = CLOCK_TIMESTAMP()
WHERE purged_at IS NULL;

ALTER TABLE github_webhook_delivery
  DROP COLUMN encryption_algorithm,
  DROP COLUMN encryption_key_id,
  DROP COLUMN encryption_iv;

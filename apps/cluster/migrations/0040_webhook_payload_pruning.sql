-- Keep each maintenance batch from scanning retained delivery metadata.
CREATE INDEX github_webhook_delivery_prunable_idx
  ON github_webhook_delivery (sequence)
  WHERE purged_at IS NULL AND projection_status <> 'pending';

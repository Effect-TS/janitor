-- Inventory exists before the first repository is connected. Give it a
-- channel of its own and notify open repository pages that show Settings.
CREATE FUNCTION enqueue_connection_live_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
    (to_jsonb(OLD) - 'updated_at' - 'observed_at' - 'projected_sequence') =
    (to_jsonb(NEW) - 'updated_at' - 'observed_at' - 'projected_sequence') THEN
    RETURN NULL;
  END IF;
  INSERT INTO live_notification(repository_id, topic)
    SELECT 'application', 'connections'
    UNION ALL
    SELECT repository_id, 'connections' FROM github_repository
      WHERE connected AND access = 'accessible'
    ON CONFLICT(repository_id, topic) DO UPDATE
      SET revision = nextval('live_notification_revision');
  RETURN NULL;
END $$;

CREATE TRIGGER live_connection_repository AFTER INSERT OR UPDATE OR DELETE ON github_repository
FOR EACH ROW EXECUTE FUNCTION enqueue_connection_live_notification();
CREATE TRIGGER live_connection_installation AFTER INSERT OR UPDATE OR DELETE ON github_installation
FOR EACH ROW EXECUTE FUNCTION enqueue_connection_live_notification();
CREATE TRIGGER live_connection_sync AFTER INSERT OR UPDATE OR DELETE ON sync_target
FOR EACH ROW EXECUTE FUNCTION enqueue_connection_live_notification();

-- Account and Team pages share the authenticated application channel.
CREATE FUNCTION enqueue_account_live_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'updated_at') = (to_jsonb(NEW) - 'updated_at') THEN RETURN NULL; END IF;
  INSERT INTO live_notification(repository_id, topic) VALUES ('application', 'account')
    ON CONFLICT(repository_id, topic) DO UPDATE SET revision = nextval('live_notification_revision');
  RETURN NULL;
END $$;
CREATE TRIGGER live_account_teammate AFTER INSERT OR UPDATE OR DELETE ON teammate
FOR EACH ROW EXECUTE FUNCTION enqueue_account_live_notification();
CREATE TRIGGER live_account_link AFTER INSERT OR UPDATE OR DELETE ON teammate_link
FOR EACH ROW EXECUTE FUNCTION enqueue_account_live_notification();

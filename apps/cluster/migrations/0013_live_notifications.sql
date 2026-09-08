CREATE SEQUENCE live_notification_revision;
CREATE TABLE live_notification (
  repository_id text NOT NULL,
  topic text NOT NULL,
  revision bigint NOT NULL DEFAULT nextval('live_notification_revision'),
  PRIMARY KEY(repository_id, topic)
);
CREATE FUNCTION enqueue_live_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'updated_at' - 'observed_at') = (to_jsonb(NEW) - 'updated_at' - 'observed_at') THEN RETURN NEW; END IF;
  -- The header summarizes sync across all repositories, including installation
  -- inventory. Coalesce that invalidation for every connected repository.
  IF TG_TABLE_NAME = 'sync_target' THEN
    INSERT INTO live_notification(repository_id,topic)
      SELECT repository_id,'sync' FROM github_repository WHERE connected AND access='accessible'
      ON CONFLICT(repository_id,topic) DO UPDATE SET revision=nextval('live_notification_revision');
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN r := COALESCE(to_jsonb(OLD)->>'repository_id',to_jsonb(OLD)->'scope'->>'repositoryId'); ELSE r := COALESCE(to_jsonb(NEW)->>'repository_id',to_jsonb(NEW)->'scope'->>'repositoryId'); END IF;
  IF r IS NULL AND TG_TABLE_NAME='labeling_policy_draft' THEN
    SELECT repository_id INTO r FROM labeling_policy WHERE policy_id=COALESCE(to_jsonb(NEW)->>'policy_id',to_jsonb(OLD)->>'policy_id');
  END IF;
  IF r IS NOT NULL THEN
    INSERT INTO live_notification(repository_id,topic) VALUES(r,TG_ARGV[0])
      ON CONFLICT(repository_id,topic) DO UPDATE SET revision=nextval('live_notification_revision');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER live_configuration AFTER INSERT OR UPDATE OR DELETE ON labeling_repository_rules FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('configuration');
CREATE TRIGGER live_policy AFTER INSERT OR UPDATE OR DELETE ON labeling_policy FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('configuration');
CREATE TRIGGER live_draft AFTER INSERT OR UPDATE OR DELETE ON labeling_policy_draft FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('configuration');
CREATE TRIGGER live_rules AFTER INSERT OR UPDATE OR DELETE ON labeling_rule FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('configuration');
CREATE TRIGGER live_activity AFTER INSERT OR UPDATE OR DELETE ON labeling_reconciliation FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('activity');
CREATE TRIGGER live_actions AFTER INSERT OR UPDATE OR DELETE ON labeling_label_action FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('activity');
CREATE TRIGGER live_sync AFTER INSERT OR UPDATE OR DELETE ON sync_target FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('sync');
CREATE TRIGGER live_candidates AFTER INSERT OR UPDATE OR DELETE ON github_entity FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('candidates');
CREATE TRIGGER live_labels AFTER INSERT OR UPDATE OR DELETE ON github_label FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('configuration');
CREATE TRIGGER live_consent AFTER INSERT OR UPDATE OR DELETE ON labeling_ai_consent FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('consent');
CREATE TRIGGER live_test AFTER INSERT OR UPDATE OR DELETE ON labeling_rule_test FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('test');
CREATE TRIGGER live_repository AFTER INSERT OR UPDATE OR DELETE ON github_repository FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('repository');

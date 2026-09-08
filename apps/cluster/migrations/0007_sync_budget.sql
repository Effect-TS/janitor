-- Keep the budget lock on the database server instead of holding it across
-- multiple Worker/Hyperdrive round trips. Existing tables and leases are retained.
CREATE FUNCTION acquire_github_rate_lease(
  p_scope TEXT, p_resource TEXT, p_priority TEXT, p_token TEXT,
  p_now TIMESTAMPTZ, p_reserve INTEGER, p_limit INTEGER, p_lease_seconds INTEGER
) RETURNS TABLE(decision TEXT, until_at TIMESTAMPTZ, reason TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  budget github_rate_budget%ROWTYPE;
  cooldown_at TIMESTAMPTZ;
  active INTEGER;
BEGIN
  INSERT INTO github_rate_budget(scope_key,resource) VALUES(p_scope,p_resource)
    ON CONFLICT DO NOTHING;
  SELECT * INTO budget FROM github_rate_budget
    WHERE scope_key=p_scope AND resource=p_resource FOR UPDATE;
  DELETE FROM github_rate_lease WHERE scope_key=p_scope AND resource=p_resource AND expires_at<=p_now;
  cooldown_at := GREATEST(budget.retry_after_until,budget.secondary_cooldown_until);
  IF cooldown_at>p_now THEN
    RETURN QUERY SELECT 'Wait',cooldown_at,'cooldown'; RETURN;
  END IF;
  SELECT count(*) INTO active FROM github_rate_lease
    WHERE scope_key=p_scope AND resource=p_resource AND expires_at>p_now;
  IF active>=p_limit THEN
    RETURN QUERY SELECT 'Wait',p_now+interval '1 second','concurrency'; RETURN;
  END IF;
  IF budget.remaining IS NOT NULL AND budget.reset_at>p_now AND budget.remaining-active<=p_reserve THEN
    RETURN QUERY SELECT 'Wait',budget.reset_at,'reserve'; RETURN;
  END IF;
  INSERT INTO github_rate_lease(lease_token,scope_key,resource,priority,expires_at)
    VALUES(p_token,p_scope,p_resource,p_priority,p_now+make_interval(secs=>p_lease_seconds));
  RETURN QUERY SELECT 'Granted',NULL::timestamptz,NULL::text;
END;
$$;

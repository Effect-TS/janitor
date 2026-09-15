-- Slack delivery remembers which attempt already streamed its text blocks to
-- the thread, so the attempt's completion does not post the final text again.
ALTER TABLE slack_thread ADD COLUMN streamed_attempt TEXT;

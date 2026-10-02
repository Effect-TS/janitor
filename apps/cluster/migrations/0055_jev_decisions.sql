-- AI labeling rules move to TypeSafe's Jev decision model through OpenRouter.
-- Decisions record the probabilities they came from, and consent given for
-- the previous chat model carries over to Jev.

ALTER TABLE labeling_ai_decision ADD COLUMN probabilities jsonb;

UPDATE labeling_ai_consent SET provider = 'openrouter', model = 'typesafe/jev-1.13';

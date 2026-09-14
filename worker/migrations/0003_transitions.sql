-- Race-safe status changes (docs/API.md clarification 7). Every status change stamps a fresh `rev`, and the hold
-- statements in the same batch only take effect when `rev` is the one this change wrote. A conditional UPDATE that
-- matches no rows does not abort a batch, so the holds need a condition of their own.
ALTER TABLE requests ADD COLUMN rev TEXT NOT NULL DEFAULT '';

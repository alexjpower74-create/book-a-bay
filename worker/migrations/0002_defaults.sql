-- Default settings for the SAMPLE shop. Stored twice: once under `default:<key>` (the pristine copy that
-- POST /api/test/reset restores from, so the defaults live in exactly one file) and once under `<key>` (live).
-- The PIN is 2468 as PBKDF2-SHA256 (100 000 iterations, random salt from tools/hash-pin.mjs). Change it after setup.

INSERT INTO settings (key, value) VALUES
  ('default:shop_name',     '"SAMPLE Auto Service — Grand Falls-Windsor (demo)"'),
  ('default:timezone',      '"America/St_Johns"'),
  ('default:bays',          '3'),
  ('default:slot_step_min', '30'),
  ('default:lead_time_min', '60'),
  ('default:max_per_slot',  '2'),
  ('default:window_days',   '14'),
  ('default:hours',         '{"0":null,"1":{"open":"08:00","close":"17:00"},"2":{"open":"08:00","close":"17:00"},"3":{"open":"08:00","close":"17:00"},"4":{"open":"08:00","close":"17:00"},"5":{"open":"08:00","close":"17:00"},"6":{"open":"09:00","close":"13:00"}}'),
  ('default:closures',      '[{"date":"2026-09-21","reason":"Staff training (sample)"}]'),
  ('default:services',      '[{"id":"oil","name":"Oil change","minutes":30,"bays_needed":1,"active":true},{"id":"tire-swap","name":"Tire swap","minutes":45,"bays_needed":1,"active":true},{"id":"brakes","name":"Brakes","minutes":120,"bays_needed":1,"active":true},{"id":"diagnostic","name":"Diagnostic","minutes":60,"bays_needed":1,"active":true},{"id":"truck-rv","name":"Truck or RV service","minutes":120,"bays_needed":2,"active":true}]'),
  ('default:pin',           '{"alg":"PBKDF2-SHA256","iterations":100000,"salt":"Cv2ZRJEb6/PTR41jCIAhPg==","hash":"EySPQusGeGMi32xa9kHUVvm71kQUarsyk3TZC7phboc="}');

INSERT INTO settings (key, value)
  SELECT substr(key, 9), value FROM settings WHERE key LIKE 'default:%';

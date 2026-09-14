-- The SAMPLE company and its yard. PIN 2468 as PBKDF2-SHA256 (100 000 iterations, random salt, from tools/hash-pin.mjs).
-- Change it after setup (PUT /api/owner/pin). POST /api/test/reset seeds the same company from src/sample-data.js;
-- tests/sample.test.mjs checks the two agree and that this hash really is 2468.
INSERT INTO company (id, name, timezone, yard_label, yard_lat, yard_lng, pin) VALUES (
  1,
  'SAMPLE Snow Clearing — Grand Falls-Windsor (demo)',
  'America/St_Johns',
  'SAMPLE yard, Mill Road',
  48.92729,
  -55.66127,
  '{"alg":"PBKDF2-SHA256","iterations":100000,"salt":"Ay+jMoQWyfu0mNpxNZJ4uA==","hash":"4n5oZIa+DAUN104kr3zlt0JXB5z4XUNafgYbU2C30HA="}'
);

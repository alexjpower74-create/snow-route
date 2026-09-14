-- The route has a version (API.md clarification 32). Every route PUT, stop add and stop remove bumps it inside its own batch, and a
-- route PUT carrying a stale version is refused by a guard in that batch, so two screens can never silently undo each other.
ALTER TABLE storms ADD COLUMN route_version INTEGER NOT NULL DEFAULT 1;

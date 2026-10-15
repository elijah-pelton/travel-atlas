-- Travel Atlas sync v2: each map's places and notes become two JSON documents in its maps row
-- (see docs/SYNC.md). Only adds columns, so the v1 Worker keeps working against this schema.
-- No secondary indexes on purpose: each index update is an extra written row.

ALTER TABLE maps ADD COLUMN rev         INTEGER NOT NULL DEFAULT 0;    -- map-wide revision; 0 = not yet converted from marks
ALTER TABLE maps ADD COLUMN pub         TEXT    NOT NULL DEFAULT '{}'; -- {placeId: [status, t, rev]}
ALTER TABLE maps ADD COLUMN pub_rev     INTEGER NOT NULL DEFAULT 0;    -- rev at which pub last changed
ALTER TABLE maps ADD COLUMN priv        TEXT    NOT NULL DEFAULT '{}'; -- {placeId: [rating, year, note, t, rev]}
ALTER TABLE maps ADD COLUMN priv_rev    INTEGER NOT NULL DEFAULT 0;    -- rev at which priv last changed
ALTER TABLE maps ADD COLUMN notes_token TEXT;                          -- notes view link token; NULL = no notes link

-- The marks table stays until docs/later/0003_drop_marks.sql (rollback safety): maps with
-- rev = 0 are converted from it lazily on first GET or sync.

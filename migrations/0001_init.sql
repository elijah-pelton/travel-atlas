-- Travel Atlas sync: one row per shared map, one row per place mark (see docs/SYNC.md).

CREATE TABLE maps (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  owner    TEXT NOT NULL DEFAULT '',
  owner_t  INTEGER NOT NULL DEFAULT 0,
  key_hash TEXT NOT NULL,          -- hex SHA-256 of the edit key; the key itself is never stored
  created  INTEGER NOT NULL,       -- ms since epoch
  updated  INTEGER NOT NULL        -- ms since epoch, last time a mark or the owner changed
);

-- visited = 0 rows are kept on purpose: they are deliberate removals that must win over older adds.
CREATE TABLE marks (
  map_id   TEXT NOT NULL,
  place_id TEXT NOT NULL,
  visited  INTEGER NOT NULL,
  t        INTEGER NOT NULL,       -- ms since epoch of the change on the client (last-writer-wins)
  PRIMARY KEY (map_id, place_id)
);

-- Travel Atlas sync v2, later release (runbook step 5 in docs/plan-data-sync.md). NOT in
-- migrations/ yet so it cannot auto-apply. Ship it only after every map is converted:
--   SELECT count(*) FROM maps WHERE rev = 0;   -- must be 0 (backfill first)
-- Then move this file to migrations/0003_drop_marks.sql. After it runs, rolling back to the v1
-- Worker is no longer possible, and the Worker's legacy marks code (CONVERT_SQL, the marks
-- DELETE in DELETE /api/maps/:id) must be removed in the same release.
DROP TABLE marks;

-- Removes everything created by perf-seed.sql and load-test.mjs (all rows use the +999 phone prefix).
-- Run the two statements as separate commands if you add VACUUM; VACUUM cannot run inside a transaction.
BEGIN;
DELETE FROM conversations WHERE created_by IN (SELECT id FROM users WHERE phone LIKE '+999%');
DELETE FROM users WHERE phone LIKE '+999%';
COMMIT;

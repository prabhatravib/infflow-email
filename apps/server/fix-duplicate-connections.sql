-- Collapse duplicate mail0_connection rows and stop them coming back.
--
-- Every sign-in used to INSERT a brand new connection row (fresh UUID, no
-- unique constraint to collide with), so the account switcher listed the same
-- mailbox once per login and getActiveConnection() picked the oldest row -
-- i.e. the one with the most stale OAuth tokens.
--
-- Keep the newest row per (user_id, email): it carries the freshest tokens.
-- Its created_at is backdated to the group's earliest so "connected since"
-- stays truthful.
--
-- Run with:
--   wrangler d1 execute zero-email-demo --remote --file=./fix-duplicate-connections.sql

-- 1. Preserve the original connection date on the row we are keeping.
UPDATE mail0_connection
SET created_at = (
  SELECT MIN(older.created_at)
  FROM mail0_connection AS older
  WHERE older.user_id = mail0_connection.user_id
    AND older.email = mail0_connection.email
)
WHERE rowid IN (
  SELECT MAX(rowid) FROM mail0_connection GROUP BY user_id, email
);

-- 2. Re-point anything that referenced a duplicate at the surviving row.
UPDATE mail0_user
SET default_connection_id = (
  SELECT keeper.id
  FROM mail0_connection AS keeper
  WHERE keeper.rowid = (
    SELECT MAX(dup.rowid)
    FROM mail0_connection AS dup
    WHERE dup.user_id = keeper.user_id
      AND dup.email = keeper.email
  )
    AND keeper.user_id = mail0_user.id
    AND keeper.email = (
      SELECT current.email
      FROM mail0_connection AS current
      WHERE current.id = mail0_user.default_connection_id
    )
)
WHERE default_connection_id IS NOT NULL
  AND default_connection_id NOT IN (
    SELECT id FROM mail0_connection
    WHERE rowid IN (SELECT MAX(rowid) FROM mail0_connection GROUP BY user_id, email)
  );

-- 3. Drop the superseded rows.
DELETE FROM mail0_connection
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM mail0_connection GROUP BY user_id, email
);

-- 4. Make the duplicate impossible at the database level, matching the
--    unique(user_id, email) constraint the Postgres schema always had.
CREATE UNIQUE INDEX IF NOT EXISTS connection_user_id_email_unique
  ON mail0_connection (user_id, email);

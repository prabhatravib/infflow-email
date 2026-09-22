/**
 * Raw-SQL helpers for ZeroDB's D1 path. Each helper executes its statement: a
 * `D1PreparedStatement` does nothing until `.run()`, `.first()` or `.all()` is
 * called, and the old `sql()` helper handed back the bound statement, so most
 * writes were awaited and then silently dropped.
 *
 * Kept free of `cloudflare:workers` so `node --test` can load it.
 */

export type D1Params = unknown[];

/**
 * The D1 tables are declared with snake_case columns (`src/db/migrations-d1.sql`)
 * while every caller reads the camelCase field names from `schema-d1.ts`. A raw
 * `SELECT *` hands the column names back verbatim, so rows have to be mapped on
 * the way out — the same translation `ZeroDriver.setupAuth` does by hand.
 */
const toCamelCase = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export const toSnakeCase = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export const mapRow = <T>(row: Record<string, unknown> | null | undefined): T | undefined => {
  if (!row) return undefined;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [toCamelCase(key), value]),
  ) as T;
};

/**
 * `D1PreparedStatement.all()` resolves to a `D1Result` wrapper — `{ results, success,
 * meta }` — never to a bare array. Returning it unwrapped is what made
 * `connections.filter is not a function` reach the inbox.
 */
export const mapRows = <T>(result: D1Result<Record<string, unknown>>): T[] =>
  (result.results ?? []).map((row) => mapRow<T>(row) as T);

/** D1 cannot bind a `Date`; `createConnection` already stores timestamps as ISO strings. */
export const toBindable = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

/** Runs a write and returns its `D1Result` (`meta.changes` says how many rows it touched). */
export const runStatement = (db: D1Database, query: string, params: D1Params = []) =>
  db.prepare(query).bind(...params).run();

/** Runs a query and returns its first row with camelCase keys, or `undefined`. */
export const firstRow = async <T>(db: D1Database, query: string, params: D1Params = []) =>
  mapRow<T>(await db.prepare(query).bind(...params).first<Record<string, unknown>>());

/** Runs a query and returns every row with camelCase keys. */
export const allRows = async <T>(db: D1Database, query: string, params: D1Params = []) =>
  mapRows<T>(await db.prepare(query).bind(...params).all<Record<string, unknown>>());

const SELECT_USER_SETTINGS = 'SELECT * FROM mail0_user_settings WHERE user_id = ?';

// `user_id` has no unique index in the live database, so "insert unless the user
// already has a row" has to be one statement: a SELECT followed by an INSERT lets
// two requests both see no row and both insert.
const INSERT_USER_SETTINGS_IF_ABSENT = `INSERT INTO mail0_user_settings (id, user_id, settings, created_at, updated_at)
   SELECT ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
   WHERE NOT EXISTS (SELECT 1 FROM mail0_user_settings WHERE user_id = ?)`;

// Keyed on user_id rather than a looked-up id: if duplicates ever exist they all
// carry the same settings, so it doesn't matter which one SELECT_USER_SETTINGS returns.
const UPDATE_USER_SETTINGS =
  'UPDATE mail0_user_settings SET settings = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?';

const parseSettings = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    // Callers validate what they get back; null makes settings.get fall back to
    // (and rewrite) the defaults instead of spreading a string.
    return null;
  }
};

/**
 * The settings column holds a JSON string. drizzle's `mode: 'json'` parses it on
 * read and every caller expects the object, so parse it here too.
 */
export const findUserSettingsRow = async <T extends { settings: unknown }>(
  db: D1Database,
  userId: string,
) => {
  const row = await firstRow<T>(db, SELECT_USER_SETTINGS, [userId]);
  if (row && typeof row.settings === 'string') {
    row.settings = parseSettings(row.settings) as T['settings'];
  }
  return row;
};

/** Adds the user's settings row unless they already have one. Returns whether it inserted. */
export const insertUserSettingsRow = async (db: D1Database, userId: string, settings: unknown) => {
  const result = await runStatement(db, INSERT_USER_SETTINGS_IF_ABSENT, [
    crypto.randomUUID(),
    userId,
    JSON.stringify(settings),
    userId,
  ]);
  return (result.meta?.changes ?? 0) > 0;
};

/**
 * Overwrites the user's settings, inserting a row only when they have none.
 * `INSERT OR REPLACE` with a fresh id added a row on every save.
 */
export const saveUserSettingsRow = async (db: D1Database, userId: string, settings: unknown) => {
  const json = JSON.stringify(settings);
  const updated = await runStatement(db, UPDATE_USER_SETTINGS, [json, userId]);
  if ((updated.meta?.changes ?? 0) > 0) return;

  if (await insertUserSettingsRow(db, userId, settings)) return;

  // Another request inserted the row between the two statements; write over it.
  await runStatement(db, UPDATE_USER_SETTINGS, [json, userId]);
};

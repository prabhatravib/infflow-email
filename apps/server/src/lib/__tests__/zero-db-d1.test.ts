/**
 * ZeroDB's D1 helpers. The bug these guard against is a statement that is
 * prepared and bound but never executed, so the fake records, per statement,
 * how (and whether) it was run.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allRows,
  findUserSettingsRow,
  firstRow,
  insertUserSettingsRow,
  runStatement,
  saveUserSettingsRow,
} from '../zero-db-d1';

type Row = Record<string, unknown>;
type Outcome = { rows?: Row[]; changes?: number };
type Handler = (query: string, params: unknown[]) => Outcome;

type Recorded = { query: string; params: unknown[]; ranWith: 'run' | 'first' | 'all' | null };

const createFakeD1 = (handler: Handler = () => ({})) => {
  const statements: Recorded[] = [];

  const db = {
    prepare(query: string) {
      const record: Recorded = { query, params: [], ranWith: null };
      statements.push(record);
      const execute = (how: NonNullable<Recorded['ranWith']>) => {
        assert.equal(record.ranWith, null, `statement executed twice: ${query}`);
        record.ranWith = how;
        return handler(query, record.params);
      };
      const statement = {
        bind(...params: unknown[]) {
          record.params = params;
          return statement;
        },
        async run() {
          const { changes = 0 } = execute('run');
          return { success: true, results: [], meta: { changes } };
        },
        async first() {
          return execute('first').rows?.[0] ?? null;
        },
        async all() {
          return { success: true, results: execute('all').rows ?? [], meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };

  return { db: db as unknown as D1Database, statements };
};

const assertAllRan = (statements: Recorded[]) => {
  for (const s of statements) assert.notEqual(s.ranWith, null, `never executed: ${s.query}`);
};

/** Just enough of mail0_user_settings to exercise the three settings statements. */
const createSettingsTable = (initial: Row[] = []) => {
  const rows = initial.map((row) => ({ ...row }));
  let beforeInsert: (() => void) | null = null;

  const handler: Handler = (query, params) => {
    if (query.startsWith('SELECT * FROM mail0_user_settings')) {
      return { rows: rows.filter((r) => r.user_id === params[0]) };
    }
    if (query.startsWith('UPDATE mail0_user_settings')) {
      const [settings, userId] = params;
      const matched = rows.filter((r) => r.user_id === userId);
      for (const r of matched) Object.assign(r, { settings, updated_at: 'now' });
      return { changes: matched.length };
    }
    if (query.startsWith('INSERT INTO mail0_user_settings')) {
      assert.match(query, /WHERE NOT EXISTS/);
      beforeInsert?.();
      const [id, userId, settings, existsUserId] = params;
      assert.equal(existsUserId, userId);
      if (rows.some((r) => r.user_id === userId)) return { changes: 0 };
      rows.push({ id, user_id: userId, settings, created_at: 'now', updated_at: 'now' });
      return { changes: 1 };
    }
    throw new Error(`unexpected query: ${query}`);
  };

  return {
    rows,
    handler,
    /** Simulates another request inserting the row just before our INSERT runs. */
    raceInsert(row: Row) {
      beforeInsert = () => {
        rows.push({ ...row });
        beforeInsert = null;
      };
    },
  };
};

test('runStatement executes the write and returns its D1Result', async () => {
  const { db, statements } = createFakeD1(() => ({ changes: 1 }));
  const result = await runStatement(db, 'DELETE FROM mail0_connection WHERE id = ? AND user_id = ?', [
    'c1',
    'u1',
  ]);

  assert.equal(result.meta.changes, 1);
  assert.equal(statements.length, 1);
  assert.equal(statements[0].ranWith, 'run');
  assert.deepEqual(statements[0].params, ['c1', 'u1']);
});

test('firstRow executes the query and camelCases the row', async () => {
  const { db, statements } = createFakeD1(() => ({
    rows: [{ id: 'u1', default_connection_id: 'c1', phone_number_verified: 0 }],
  }));
  const row = await firstRow<Row>(db, 'SELECT * FROM mail0_user WHERE id = ?', ['u1']);

  assert.deepEqual(row, { id: 'u1', defaultConnectionId: 'c1', phoneNumberVerified: 0 });
  assert.equal(statements[0].ranWith, 'first');
});

test('firstRow returns undefined when nothing matches', async () => {
  const { db } = createFakeD1(() => ({ rows: [] }));
  assert.equal(await firstRow(db, 'SELECT * FROM mail0_user WHERE id = ?', ['nobody']), undefined);
});

test('allRows unwraps the D1Result into a plain array', async () => {
  const { db, statements } = createFakeD1(() => ({
    rows: [{ user_id: 'u1', email: 'a@x' }, { user_id: 'u1', email: 'b@x' }],
  }));
  const rows = await allRows<Row>(db, 'SELECT * FROM mail0_connection WHERE user_id = ?', ['u1']);

  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows, [
    { userId: 'u1', email: 'a@x' },
    { userId: 'u1', email: 'b@x' },
  ]);
  assert.equal(statements[0].ranWith, 'all');
});

test('findUserSettingsRow parses the stored JSON string', async () => {
  const table = createSettingsTable([
    { id: 's1', user_id: 'u1', settings: '{"timezone":"UTC","externalImages":true}' },
  ]);
  const { db } = createFakeD1(table.handler);
  const row = await findUserSettingsRow<{ userId: string; settings: unknown }>(db, 'u1');

  assert.equal(row?.userId, 'u1');
  assert.deepEqual(row?.settings, { timezone: 'UTC', externalImages: true });
});

test('findUserSettingsRow turns unparseable settings into null', async () => {
  const table = createSettingsTable([{ id: 's1', user_id: 'u1', settings: '{not json' }]);
  const { db } = createFakeD1(table.handler);
  const row = await findUserSettingsRow<{ settings: unknown }>(db, 'u1');

  assert.equal(row?.settings, null);
});

test('findUserSettingsRow returns undefined for a user without settings', async () => {
  const { db } = createFakeD1(createSettingsTable().handler);
  assert.equal(await findUserSettingsRow(db, 'u1'), undefined);
});

test('insertUserSettingsRow inserts the first row and runs the statement', async () => {
  const table = createSettingsTable();
  const { db, statements } = createFakeD1(table.handler);

  assert.equal(await insertUserSettingsRow(db, 'u1', { timezone: 'UTC' }), true);
  assertAllRan(statements);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].user_id, 'u1');
  assert.equal(table.rows[0].settings, '{"timezone":"UTC"}');
  assert.equal(typeof table.rows[0].id, 'string');
});

test('insertUserSettingsRow leaves an existing row alone', async () => {
  const table = createSettingsTable([{ id: 's1', user_id: 'u1', settings: '{"timezone":"UTC"}' }]);
  const { db, statements } = createFakeD1(table.handler);

  assert.equal(await insertUserSettingsRow(db, 'u1', { timezone: 'Asia/Tokyo' }), false);
  assertAllRan(statements);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].settings, '{"timezone":"UTC"}');
});

test('saveUserSettingsRow updates the existing row in place', async () => {
  const table = createSettingsTable([{ id: 's1', user_id: 'u1', settings: '{"timezone":"UTC"}' }]);
  const { db, statements } = createFakeD1(table.handler);

  await saveUserSettingsRow(db, 'u1', { timezone: 'Asia/Tokyo' });

  assertAllRan(statements);
  assert.equal(statements.length, 1, 'an update that hits a row needs no insert');
  assert.deepEqual(table.rows.map((r) => [r.id, r.settings]), [['s1', '{"timezone":"Asia/Tokyo"}']]);
});

test('repeated saves never add a second row', async () => {
  const table = createSettingsTable();
  const { db, statements } = createFakeD1(table.handler);

  await saveUserSettingsRow(db, 'u1', { timezone: 'UTC' });
  await saveUserSettingsRow(db, 'u1', { timezone: 'Europe/Paris' });
  await saveUserSettingsRow(db, 'u1', { timezone: 'Asia/Tokyo' });
  await insertUserSettingsRow(db, 'u1', { timezone: 'America/New_York' });

  assertAllRan(statements);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].settings, '{"timezone":"Asia/Tokyo"}');
});

test('saveUserSettingsRow only touches the given user', async () => {
  const table = createSettingsTable([{ id: 's2', user_id: 'u2', settings: '{"timezone":"UTC"}' }]);
  const { db } = createFakeD1(table.handler);

  await saveUserSettingsRow(db, 'u1', { timezone: 'Asia/Tokyo' });

  assert.equal(table.rows.length, 2);
  assert.equal(table.rows.find((r) => r.user_id === 'u2')?.settings, '{"timezone":"UTC"}');
  assert.equal(table.rows.find((r) => r.user_id === 'u1')?.settings, '{"timezone":"Asia/Tokyo"}');
});

test('saveUserSettingsRow writes over a row another request inserted mid-save', async () => {
  const table = createSettingsTable();
  table.raceInsert({ id: 'other', user_id: 'u1', settings: '{"timezone":"UTC"}' });
  const { db, statements } = createFakeD1(table.handler);

  await saveUserSettingsRow(db, 'u1', { timezone: 'Asia/Tokyo' });

  assertAllRan(statements);
  assert.deepEqual(
    statements.map((s) => s.query.split(' ')[0]),
    ['UPDATE', 'INSERT', 'UPDATE'],
  );
  assert.deepEqual(table.rows.map((r) => [r.id, r.settings]), [['other', '{"timezone":"Asia/Tokyo"}']]);
});

test('settings survive a save followed by a read', async () => {
  const table = createSettingsTable();
  const { db } = createFakeD1(table.handler);

  await saveUserSettingsRow(db, 'u1', { timezone: 'Asia/Tokyo', trustedSenders: ['a@x'] });
  const row = await findUserSettingsRow<{ settings: unknown }>(db, 'u1');

  assert.deepEqual(row?.settings, { timezone: 'Asia/Tokyo', trustedSenders: ['a@x'] });
});

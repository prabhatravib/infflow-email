/**
 * The log bundle exists to be read by whoever is debugging a voice session, so
 * these tests are about what survives into the file and what it is called -
 * not about the console patching, which needs a browser.
 */
import {
  getRollingConsoleEntryKey,
  shouldRetainPreviousRollingEntry,
  trimRelayedConsoleValue,
} from '@/lib/console-log-compaction';
import {
  resolveExplicitLogRequestFromUrl,
  resolveHexaLogsOverride,
  resolveLogVisibilityFromUrl,
} from '@/lib/log-visibility';
import { buildConsoleLogFile, makeConsoleLogFilename } from '@/lib/console-log-capture';
import assert from 'node:assert/strict';
import test from 'node:test';

const entry = (over: Partial<Parameters<typeof buildConsoleLogFile>[1]['entries'][number]>) => ({
  id: 1,
  compactionKey: null,
  source: 'mail' as const,
  method: 'log' as const,
  timestamp: '2026-09-08T12:00:00.000Z',
  sessionId: 'session-a',
  args: ['hello'],
  message: 'hello',
  ...over,
});

const snapshot = (entries: ReturnType<typeof entry>[]) => ({
  entries,
  requestedAt: '2026-09-08T12:00:01.000Z',
  compactedRollingEntryCount: 0,
  evictedEntryCount: 0,
});

test('a newer download sorts above an older one by filename', () => {
  const older = makeConsoleLogFilename('s', new Date('2026-09-08T12:00:00.000Z'));
  const newer = makeConsoleLogFilename('s', new Date('2026-09-08T12:05:00.000Z'));

  assert.ok(newer < older, `${newer} should sort before ${older}`);
});

test('a session id that is not filename-safe cannot escape the filename', () => {
  const filename = makeConsoleLogFilename('narrator/../../etc:passwd');

  assert.ok(!filename.includes('/'));
  assert.ok(!filename.includes(':'));
  assert.match(filename, /^infflow-email-logs-[\w.-]+\.txt$/);
});

test('Hexa lines survive a filter on the host session id', () => {
  // Hexa can be a session behind after a reset, and its lines are the reason
  // the file is being downloaded at all.
  const file = buildConsoleLogFile(
    'session-a',
    snapshot([
      entry({ message: 'host line' }),
      entry({ source: 'hexa', sessionId: 'session-b', message: 'voice line' }),
      entry({ sessionId: 'session-b', message: 'other host session' }),
    ]),
  );

  assert.match(file, /host line/);
  assert.match(file, /voice line/);
  assert.doesNotMatch(file, /other host session/);
  assert.match(file, /Source counts: mail=1, hexa=1/);
});

test('an empty match still reports the counters rather than an empty file', () => {
  const file = buildConsoleLogFile('session-a', {
    ...snapshot([]),
    evictedEntryCount: 7,
  });

  assert.match(file, /No captured console entries matched this session\./);
  assert.match(file, /retention cap: 7/);
});

test('multi-line messages stay indented under their own header line', () => {
  const file = buildConsoleLogFile(null, snapshot([entry({ message: 'first\nsecond' })]));

  assert.match(file, /\[MAIL\]|\[mail\]/);
  assert.match(file, /first\n {2}second/);
});

test('only the newest viseme snapshot per run holds a buffer slot', () => {
  const first = getRollingConsoleEntryKey(
    '[Hexa O-shape stats] {"runId":"run-1","expected":3}',
    'hexa',
    'session-a',
  );
  const second = getRollingConsoleEntryKey(
    '[Hexa O-shape stats] {"runId":"run-1","expected":9}',
    'hexa',
    'session-a',
  );
  const otherRun = getRollingConsoleEntryKey(
    '[Hexa O-shape stats] {"runId":"run-2","expected":9}',
    'hexa',
    'session-a',
  );

  assert.equal(first, second);
  assert.notEqual(first, otherRun);
  assert.equal(getRollingConsoleEntryKey('an ordinary log line', 'hexa', 'session-a'), null);
});

test('a truncated snapshot does not displace a complete earlier one', () => {
  const complete = '[Hexa O-shape stats] {"runId":"run-1"}';
  const truncated = `${'x'.repeat(10)}... [truncated]`;

  assert.equal(shouldRetainPreviousRollingEntry(truncated, true), true);
  assert.equal(shouldRetainPreviousRollingEntry(truncated, false), false);
  assert.equal(shouldRetainPreviousRollingEntry(complete, true), false);
});

test('viseme stats get a larger truncation budget than an ordinary line', () => {
  const long = 'y'.repeat(50_000);

  assert.ok(trimRelayedConsoleValue(long).length < 5_000);
  assert.equal(trimRelayedConsoleValue(`[Hexa O-shape stats] ${long}`).length, long.length + 21);
});

test('logs print by default and ?logs=off silences them', () => {
  assert.equal(resolveLogVisibilityFromUrl('https://mail.test/'), true);
  assert.equal(resolveLogVisibilityFromUrl('https://mail.test/?logs=off'), false);
  assert.equal(resolveLogVisibilityFromUrl('https://mail.test/?logs=banana'), true);

  assert.equal(resolveExplicitLogRequestFromUrl('https://mail.test/'), false);
  assert.equal(resolveExplicitLogRequestFromUrl('https://mail.test/?logs=on'), true);
});

test('the host flag overrides what Hexa would choose for itself', () => {
  // Off here forces off there, even when the link asks Hexa for logs.
  assert.equal(resolveHexaLogsOverride('https://mail.test/?logs=off&hexaLogs=on'), '&hexaLogs=off');
  // On here forwards an explicit choice and stays silent otherwise.
  assert.equal(resolveHexaLogsOverride('https://mail.test/?hexaLogs=off'), '&hexaLogs=off');
  assert.equal(resolveHexaLogsOverride('https://mail.test/'), '');
});

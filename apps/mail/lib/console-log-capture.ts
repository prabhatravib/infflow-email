/**
 * One downloadable text file holding everything both halves of the app printed.
 *
 * The voice assistant runs in an iframe on its own origin, so its console is not
 * reachable from this page's DevTools and a bug report that spans the two is
 * otherwise impossible to assemble by hand. Hexa relays each of its lines here
 * as a `HEXA_CONSOLE_LOG` message; this module patches the host console, merges
 * both streams into one timestamped ring buffer, and writes the result out.
 *
 * Capture is unconditional. `areLogsVisible()` gates only whether a line is also
 * *printed*, so a session run with printing off still produces a complete file.
 *
 * Ported from infflow-BrianChesky (cf-worker/frontend/src/utils/console-log-capture.ts),
 * without that app's narrator audio-timing bundle and viseme summaries.
 */
import {
  getRollingConsoleEntryKey,
  shouldRetainPreviousRollingEntry,
  trimRelayedConsoleValue,
} from '@/lib/console-log-compaction';
import { HEXA_WORKER_ORIGIN } from '@/lib/hexa-worker-url';
import { areLogsVisible } from '@/lib/log-visibility';
import { sessionManager } from '@/lib/hexa-session';

type ConsoleMethod = 'debug' | 'error' | 'info' | 'log' | 'warn';
type ConsoleLogSource = 'hexa' | 'mail';

interface CapturedConsoleEntry {
  id: number;
  compactionKey: string | null;
  source: ConsoleLogSource;
  method: ConsoleMethod;
  timestamp: string;
  sessionId: string | null;
  args: string[];
  message: string;
}

interface CapturedConsoleSnapshot {
  entries: CapturedConsoleEntry[];
  requestedAt: string;
  compactedRollingEntryCount: number;
  evictedEntryCount: number;
}

interface HexaConsoleLogPayload {
  method?: string;
  timestamp?: string;
  sessionId?: string | null;
  args?: string[];
  message?: string;
}

interface HexaConsoleLogMessage {
  type?: string;
  payload?: HexaConsoleLogPayload;
}

interface WritableDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface WindowWithDirectoryPicker extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<WritableDirectoryHandle>;
}

const CONSOLE_METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];
const MAX_LOG_ENTRIES = 5000;
const MAX_ARG_LENGTH = 4000;
const HEXA_CONSOLE_LOG_MESSAGE = 'HEXA_CONSOLE_LOG';
const DOWNLOAD_DIRECTORY_DB = 'infflow-email-download-directory';
const DOWNLOAD_DIRECTORY_STORE = 'handles';
const DOWNLOAD_DIRECTORY_KEY = 'console-logs';

const capturedEntries: CapturedConsoleEntry[] = [];
let nextEntryId = 1;
let isInstalled = false;
let isDownloadInFlight = false;
let compactedRollingEntryCount = 0;
let evictedEntryCount = 0;

function trimSerializedValue(value: string): string {
  if (value.length <= MAX_ARG_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_ARG_LENGTH)}... [truncated]`;
}

function createCircularReplacer() {
  const seen = new WeakSet<object>();

  return (_key: string, value: unknown) => {
    if (typeof value === 'function') {
      return `[Function ${(value as (...args: unknown[]) => unknown).name || 'anonymous'}]`;
    }

    if (typeof value === 'bigint') {
      return `${value.toString()}n`;
    }

    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }

      seen.add(value);
    }

    return value;
  };
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const classes =
    element.className && typeof element.className === 'string'
      ? `.${element.className.trim().split(/\s+/).filter(Boolean).join('.')}`
      : '';

  return `<${element.tagName.toLowerCase()}${id}${classes}>`;
}

function serializeConsoleArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return trimSerializedValue(arg);
  }

  if (
    typeof arg === 'number' ||
    typeof arg === 'boolean' ||
    typeof arg === 'undefined' ||
    arg === null
  ) {
    return String(arg);
  }

  if (typeof arg === 'bigint') {
    return `${arg.toString()}n`;
  }

  if (typeof arg === 'symbol') {
    return arg.toString();
  }

  if (arg instanceof Error) {
    return trimSerializedValue(arg.stack || `${arg.name}: ${arg.message}`);
  }

  if (typeof Element !== 'undefined' && arg instanceof Element) {
    return describeElement(arg);
  }

  try {
    const serialized = JSON.stringify(arg, createCircularReplacer(), 2);
    return trimSerializedValue(serialized ?? String(arg));
  } catch {
    try {
      return trimSerializedValue(String(arg));
    } catch {
      return '[Unserializable value]';
    }
  }
}

function isConsoleMethod(value: string | undefined): value is ConsoleMethod {
  return CONSOLE_METHODS.includes(value as ConsoleMethod);
}

function pushCapturedEntry(entry: Omit<CapturedConsoleEntry, 'id' | 'compactionKey'>): void {
  // Viseme logs are cumulative snapshots. Keep the newest snapshot per
  // source/session/run/shape so the final summaries remain complete without
  // spending hundreds of ring-buffer slots on superseded state.
  const compactionKey =
    entry.source === 'hexa'
      ? getRollingConsoleEntryKey(entry.message, entry.source, entry.sessionId)
      : null;
  if (compactionKey) {
    const previousIndex = capturedEntries.findIndex(
      (capturedEntry) => capturedEntry.compactionKey === compactionKey,
    );
    if (shouldRetainPreviousRollingEntry(entry.message, previousIndex >= 0)) {
      compactedRollingEntryCount += 1;
      return;
    }
    if (previousIndex >= 0) {
      capturedEntries.splice(previousIndex, 1);
      compactedRollingEntryCount += 1;
    }
  }

  capturedEntries.push({
    ...entry,
    id: nextEntryId,
    compactionKey,
  });
  nextEntryId += 1;

  if (capturedEntries.length > MAX_LOG_ENTRIES) {
    const overflow = capturedEntries.length - MAX_LOG_ENTRIES;
    capturedEntries.splice(0, overflow);
    evictedEntryCount += overflow;
  }
}

function captureConsoleEntry(method: ConsoleMethod, args: unknown[]): void {
  const serializedArgs = args.map(serializeConsoleArg);

  pushCapturedEntry({
    source: 'mail',
    method,
    timestamp: new Date().toISOString(),
    sessionId: sessionManager.getSessionId(),
    args: serializedArgs,
    message: serializedArgs.join(' '),
  });
}

function captureHexaConsoleEntry(payload: HexaConsoleLogPayload): void {
  if (!isConsoleMethod(payload.method)) {
    return;
  }

  const args = Array.isArray(payload.args)
    ? payload.args.map((arg) => trimRelayedConsoleValue(String(arg)))
    : [];
  const message =
    typeof payload.message === 'string' ? trimRelayedConsoleValue(payload.message) : args.join(' ');

  pushCapturedEntry({
    source: 'hexa',
    method: payload.method,
    timestamp: payload.timestamp || new Date().toISOString(),
    sessionId: payload.sessionId || null,
    args,
    message,
  });
}

function handleHexaConsoleMessage(event: MessageEvent<HexaConsoleLogMessage>): void {
  if (event.origin !== HEXA_WORKER_ORIGIN) {
    return;
  }

  if (event.data?.type !== HEXA_CONSOLE_LOG_MESSAGE || !event.data.payload) {
    return;
  }

  captureHexaConsoleEntry(event.data.payload);
}

function formatConsoleEntry(entry: CapturedConsoleEntry): string {
  const message = entry.message.replace(/\n/g, '\n  ');

  return `[${entry.timestamp}] [${entry.source}] [${entry.method.toUpperCase()}] [session:${
    entry.sessionId || 'none'
  }] ${message}`;
}

export function buildConsoleLogFile(
  sessionId: string | null,
  snapshot: CapturedConsoleSnapshot,
): string {
  const { entries } = snapshot;
  // Hexa lines are always kept: the voice session is the reason the bundle
  // exists, and its own session id can lag a reset on this side.
  const matchingEntries = sessionId
    ? entries.filter((entry) => entry.sessionId === sessionId || entry.source === 'hexa')
    : entries;
  const sourceCounts = matchingEntries.reduce<Record<ConsoleLogSource, number>>(
    (counts, entry) => {
      counts[entry.source] += 1;
      return counts;
    },
    { mail: 0, hexa: 0 },
  );
  const lines = [
    'Infflow Email Console Logs',
    `Generated: ${new Date().toLocaleString()}`,
    `Download requested / console snapshot boundary: ${snapshot.requestedAt}`,
    `Requested session: ${sessionId || 'all sessions'}`,
    'Included sources: Infflow Email page, Hexa voice iframe',
    `Matching entries: ${matchingEntries.length} of ${entries.length} captured`,
    `Source counts: mail=${sourceCounts.mail}, hexa=${sourceCounts.hexa}`,
    `Rolling snapshots compacted page-wide through the snapshot boundary: ${snapshot.compactedRollingEntryCount}`,
    `Entries evicted page-wide through the snapshot boundary by the ${MAX_LOG_ENTRIES}-entry retention cap: ${snapshot.evictedEntryCount}`,
    '',
  ];

  if (matchingEntries.length === 0) {
    lines.push('No captured console entries matched this session.');
    lines.push('Console entries are captured after page load while the target session is active.');
    return lines.join('\n');
  }

  lines.push(...matchingEntries.map(formatConsoleEntry));
  return lines.join('\n');
}

export function makeConsoleLogFilename(sessionId: string | null, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
  // Inverted key so the newest download sorts first when a file list is ordered
  // by name ascending (the default). Subtracting the epoch from a large constant
  // means a later download yields a smaller number, which sorts to the top.
  // 9999999999999 - epochMs stays 13 digits until well past year 2200; pad defensively.
  const invertedKey = (9999999999999 - now.getTime()).toString().padStart(13, '0');
  const sessionSlug = (sessionId || 'all-sessions').replace(/[^a-zA-Z0-9_-]/g, '-');

  return `infflow-email-logs-${invertedKey}-${timestamp}-${sessionSlug}.txt`;
}

function downloadTextFileWithBrowser(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 250);
}

function openDownloadDirectoryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DOWNLOAD_DIRECTORY_DB, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DOWNLOAD_DIRECTORY_STORE)) {
        request.result.createObjectStore(DOWNLOAD_DIRECTORY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStoredDownloadDirectory(): Promise<WritableDirectoryHandle | null> {
  if (!window.indexedDB) {
    return null;
  }

  const database = await openDownloadDirectoryDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DOWNLOAD_DIRECTORY_STORE, 'readonly');
    const request = transaction.objectStore(DOWNLOAD_DIRECTORY_STORE).get(DOWNLOAD_DIRECTORY_KEY);

    request.onsuccess = () =>
      resolve((request.result as WritableDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function storeDownloadDirectory(directory: WritableDirectoryHandle): Promise<void> {
  if (!window.indexedDB) {
    return;
  }

  const database = await openDownloadDirectoryDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DOWNLOAD_DIRECTORY_STORE, 'readwrite');

    transaction.objectStore(DOWNLOAD_DIRECTORY_STORE).put(directory, DOWNLOAD_DIRECTORY_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

async function canWriteToDirectory(directory: WritableDirectoryHandle): Promise<boolean> {
  if ((await directory.queryPermission({ mode: 'readwrite' })) === 'granted') {
    return true;
  }

  return (await directory.requestPermission({ mode: 'readwrite' })) === 'granted';
}

type DownloadDestination =
  | { kind: 'directory'; directory: WritableDirectoryHandle }
  | { kind: 'browser' }
  | { kind: 'cancelled' };

/**
 * Prefer a folder the user picked once and keeps: repeated bug reports then land
 * next to each other instead of scattering through Downloads. Browsers without
 * the File System Access API fall back to an ordinary download.
 */
async function acquireDownloadDestination(): Promise<DownloadDestination> {
  const directoryPicker = (window as WindowWithDirectoryPicker).showDirectoryPicker;

  if (!directoryPicker) {
    return { kind: 'browser' };
  }

  try {
    let directory: WritableDirectoryHandle | null = null;

    try {
      directory = await getStoredDownloadDirectory();
    } catch (error) {
      console.warn('[ConsoleLogs] Could not read the saved download directory.', error);
    }

    if (directory && !(await canWriteToDirectory(directory))) {
      directory = null;
    }

    if (!directory) {
      directory = await directoryPicker.call(window, {
        id: 'infflow-email-console-logs',
        mode: 'readwrite',
      });

      try {
        await storeDownloadDirectory(directory);
      } catch (error) {
        console.warn('[ConsoleLogs] Could not remember the selected download directory.', error);
      }
    }

    return { kind: 'directory', directory };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { kind: 'cancelled' };
    }

    console.error('[ConsoleLogs] Failed to save console logs to the selected directory.', error);
    window.alert('Unable to save console logs to the selected folder. Please try again.');
    return { kind: 'cancelled' };
  }
}

async function writeDirectoryFile(
  directory: FileSystemDirectoryHandle,
  filename: string,
  content: string,
): Promise<void> {
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // The original write failure is the useful error.
    }
    throw error;
  }
}

async function writeConsoleLogFile(
  sessionId: string | null,
  logFilename: string,
  consoleSnapshot: CapturedConsoleSnapshot,
): Promise<void> {
  const destination = await acquireDownloadDestination();
  if (destination.kind === 'cancelled') {
    return;
  }

  const logContent = buildConsoleLogFile(sessionId, consoleSnapshot);

  if (destination.kind === 'browser') {
    downloadTextFileWithBrowser(logContent, logFilename);
    return;
  }

  try {
    await writeDirectoryFile(destination.directory, logFilename, logContent);
  } catch (error) {
    console.error('[ConsoleLogs] Failed while writing the console log file.', error);
    window.alert('The console log file could not be written to the selected folder.');
  }
}

/**
 * Patch the console and start listening for Hexa's relay. Call once, after
 * `initializeLogVisibility`, before anything else has a chance to print.
 */
export function installConsoleLogCapture(): void {
  if (isInstalled || typeof window === 'undefined') {
    return;
  }

  const consoleTarget = console as unknown as Record<ConsoleMethod, (...data: unknown[]) => void>;

  CONSOLE_METHODS.forEach((method) => {
    const originalMethod = consoleTarget[method].bind(console);

    consoleTarget[method] = (...args: unknown[]) => {
      try {
        // Capture is unconditional: the downloaded file stays complete even
        // when nothing is printed. Only the visible pass-through is gated.
        captureConsoleEntry(method, args);
      } finally {
        if (areLogsVisible()) {
          originalMethod(...args);
        }
      }
    };
  });

  window.addEventListener('message', handleHexaConsoleMessage);
  isInstalled = true;
}

export function downloadConsoleLogsForSession(sessionId?: string | null): void {
  if (typeof document === 'undefined') {
    return;
  }
  // The export follows console visibility: when logs are off the button is
  // hidden, and this refuses too so the download cannot be reached another way.
  // Capture itself keeps running, so turning logs back on exposes the full
  // history including everything recorded while they were hidden.
  if (!areLogsVisible()) {
    return;
  }
  if (isDownloadInFlight) {
    console.warn('[ConsoleLogs] A console log download is already in progress.');
    return;
  }
  isDownloadInFlight = true;

  const targetSessionId = sessionId ?? sessionManager.getSessionId();
  const filename = makeConsoleLogFilename(targetSessionId);
  // Snapshot before the first await so the file describes the moment of the
  // click, not whatever arrived while the folder picker was open.
  const consoleSnapshot: CapturedConsoleSnapshot = {
    entries: capturedEntries.slice(),
    requestedAt: new Date().toISOString(),
    compactedRollingEntryCount,
    evictedEntryCount,
  };

  void writeConsoleLogFile(targetSessionId, filename, consoleSnapshot)
    .catch((error) => {
      console.error('[ConsoleLogs] Unexpected console log export failure.', error);
      window.alert('The console log file could not be saved.');
    })
    .finally(() => {
      isDownloadInFlight = false;
    });
}

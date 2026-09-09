/**
 * Whether this page load prints console output.
 *
 * `?logs=off` silences printing for a page load; `?logs=on` turns it back on.
 *
 * Only *printing* is gated. `installConsoleLogCapture` still records every
 * entry, so the downloadable log bundle stays complete no matter what this
 * resolves to. Hidden does not mean lost.
 *
 * This flag also vetoes the embedded Hexa iframe: see `resolveHexaLogsOverride`.
 *
 * Ported from infflow-BrianChesky (cf-worker/frontend/src/application/logVisibility.ts).
 */

const LOGS_PARAM = 'logs';
const HEXA_LOGS_PARAM = 'hexaLogs';

const TRUE_VALUES = new Set(['on', 'true', '1', 'yes']);
const FALSE_VALUES = new Set(['off', 'false', '0', 'no']);

/** Returns null for anything that is not a recognised on/off spelling. */
const parseFlag = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  return null;
};

/** `import.meta.env` is absent when this module is bundled for the node tests. */
const isDevBuild = (): boolean => {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
};

export const resolveLogVisibilityFromUrl = (href: string): boolean => {
  const fromUrl = parseFlag(new URL(href).searchParams.get(LOGS_PARAM));
  return fromUrl ?? true; // change this to false if you want logs off by default in production
};

/**
 * Whether this page load *asked* for logs, as opposed to inheriting the
 * on-by-default flag above. Kept separate from `areLogsVisible` so a caller can
 * distinguish "nobody said otherwise" from "this link wants logs".
 */
export const resolveExplicitLogRequestFromUrl = (href: string): boolean =>
  parseFlag(new URL(href).searchParams.get(LOGS_PARAM)) === true;

/**
 * The query fragment appended to the Hexa iframe `src`.
 *
 * The host's flag supersedes Hexa's own: when printing is off here, Hexa is
 * forced off regardless of what it would have chosen for itself. When printing
 * is on here, an explicit `?hexaLogs=` is forwarded so Hexa's flag stays usable
 * from an embedded page; absent that, Hexa applies its own default.
 *
 * Carried in the URL rather than posted after load so the setting is in force
 * before Hexa's first log line, with no startup race.
 */
export const resolveHexaLogsOverride = (href: string): string => {
  if (!resolveLogVisibilityFromUrl(href)) {
    return `&${HEXA_LOGS_PARAM}=off`;
  }

  const forwarded = parseFlag(new URL(href).searchParams.get(HEXA_LOGS_PARAM));
  if (forwarded === null) {
    return '';
  }

  return `&${HEXA_LOGS_PARAM}=${forwarded ? 'on' : 'off'}`;
};

let logsVisible: boolean | null = null;
/**
 * What the Hexa iframe is told, frozen at page load. The live
 * `window.__infflowLogs` toggle must not rewrite an iframe `src`: that would
 * remount the iframe and drop the active voice session.
 */
let hexaLogsOverride = '';
/**
 * Whether `?logs=` explicitly turned printing on, frozen at page load. Unlike
 * `logsVisible` this is not affected by the live `window.__infflowLogs` toggle:
 * it records what the link asked for.
 */
let logsExplicitlyRequested = false;

/**
 * Resolve log visibility for this page load. Call once, before
 * `installConsoleLogCapture`, so nothing prints ahead of the decision.
 */
export const initializeLogVisibility = (): boolean => {
  if (logsVisible !== null) {
    return logsVisible;
  }

  if (typeof window === 'undefined') {
    // Server render: decide nothing durable, so the browser's own call wins.
    return isDevBuild();
  }

  logsVisible = resolveLogVisibilityFromUrl(window.location.href);
  hexaLogsOverride = resolveHexaLogsOverride(window.location.href);
  logsExplicitlyRequested = resolveExplicitLogRequestFromUrl(window.location.href);

  // Live toggle, in the style of the existing __hexa* switches. Affects this
  // page's console only; the iframe keeps whatever it was handed at boot.
  Object.defineProperty(window, '__infflowLogs', {
    configurable: true,
    get: () => logsVisible,
    set: (value: unknown) => {
      logsVisible = parseFlag(value) ?? logsVisible;
    },
  });

  return logsVisible;
};

export const areLogsVisible = (): boolean => logsVisible ?? initializeLogVisibility();

export const wereLogsExplicitlyRequested = (): boolean => {
  if (logsVisible === null) {
    initializeLogVisibility();
  }

  return logsExplicitlyRequested;
};

export const hexaLogsOverrideSearch = (): string => {
  if (logsVisible === null) {
    initializeLogVisibility();
  }

  return hexaLogsOverride;
};

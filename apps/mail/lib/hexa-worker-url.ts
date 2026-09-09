/**
 * Where the embedded Hexa voice worker lives.
 *
 * Two places need this and must never disagree: the panel that frames the
 * worker, and the console log capture, which accepts a relayed `HEXA_CONSOLE_LOG`
 * message only when it arrives from this exact origin.
 */
const DEFAULT_HEXA_WORKER_URL = 'https://hexa-worker-v2.prabhatravib.workers.dev';

/** `import.meta.env` is absent when this module is loaded by the node tests. */
const workerUrlFromEnv = (): string | undefined => {
  try {
    return import.meta.env?.VITE_PUBLIC_HEXA_WORKER_URL;
  } catch {
    return undefined;
  }
};

export const HEXA_WORKER_URL = workerUrlFromEnv() ?? DEFAULT_HEXA_WORKER_URL;

export const HEXA_WORKER_ORIGIN = new URL(HEXA_WORKER_URL).origin;

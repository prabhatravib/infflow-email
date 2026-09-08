import { formatMailboxPrompt, formatMailboxSummary } from '@/lib/hexa-mailbox-context';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMailboxSnapshot } from '@/hooks/use-mailbox-snapshot';
import { sessionManager } from '@/lib/hexa-session';

const DEFAULT_HEXA_WORKER_URL = 'https://hexa-worker-v2.prabhatravib.workers.dev';

/** Reapply the layout once the embedded app has registered its listener. */
const IFRAME_SETUP_DELAYS_MS = [400, 1200];

interface HexaPanelProps {
  hexaWorkerUrl?: string;
}

/**
 * The voice pane that lives in the mail sidebar between the folder list and the
 * settings button: Hexa's hexagon on top, its transcript below. The worker runs
 * in its own origin, so the host talks to it two ways — a `postMessage` channel
 * for presentation, and a POST to `/api/external-data` for the mailbox context
 * the assistant answers from.
 *
 * Adapted from infflow-calendar (calendar-worker/web/src/components/HexaWorker.tsx).
 */
export function HexaPanel({ hexaWorkerUrl }: HexaPanelProps) {
  const workerUrl =
    hexaWorkerUrl ?? import.meta.env.VITE_PUBLIC_HEXA_WORKER_URL ?? DEFAULT_HEXA_WORKER_URL;
  const workerOrigin = useMemo(() => new URL(workerUrl).origin, [workerUrl]);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastSentDataRef = useRef<string | null>(null);
  const iframeSetupTimeoutsRef = useRef<number[]>([]);
  const presentationRef = useRef({ visualHidden: true, transcriptHidden: true });

  const snapshot = useMailboxSnapshot();

  const configureIframe = useCallback(() => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame) return;

    frame.postMessage(
      {
        type: 'SET_LAYOUT_SPLIT',
        hexagonHeight: 40,
        chatHeight: 60,
        hideHexagon: false,
        compactHexagon: true,
      },
      workerOrigin,
    );
    frame.postMessage({ type: 'SET_ASPECT_COUNT', aspectCount: 0 }, workerOrigin);
    // Seed a fresh iframe, then let Hexa's native controls own visibility. The
    // snapshot also preserves the user's choices after a connection reset.
    frame.postMessage(
      { type: 'SET_NARRATOR_PRESENTATION', ...presentationRef.current },
      workerOrigin,
    );
  }, [workerOrigin]);

  const handleIframeLoad = useCallback(() => {
    iframeSetupTimeoutsRef.current.forEach(window.clearTimeout);
    configureIframe();
    iframeSetupTimeoutsRef.current = IFRAME_SETUP_DELAYS_MS.map((delay) =>
      window.setTimeout(configureIframe, delay),
    );
  }, [configureIframe]);

  useEffect(
    () => () => {
      iframeSetupTimeoutsRef.current.forEach(window.clearTimeout);
      iframeSetupTimeoutsRef.current = [];
    },
    [sessionId],
  );

  useEffect(() => {
    const unsubscribe = sessionManager.onSessionChange(setSessionId);
    setSessionId(sessionManager.getSessionId() ?? sessionManager.generateSessionId());
    return unsubscribe;
  }, []);

  // Push the mailbox context to the worker whenever it actually changes.
  useEffect(() => {
    if (!sessionId) return;
    // The sidebar renders on the settings routes too, where there is no folder
    // to describe. Keep the last mailbox the assistant was told about rather
    // than overwriting it with an empty one.
    if (!snapshot.folder) return;

    const summary = formatMailboxSummary(snapshot);
    const dataHash = JSON.stringify({ summary, sessionId, workerUrl });
    if (dataHash === lastSentDataRef.current) return;
    lastSentDataRef.current = dataHash;
    setIsSyncing(true);

    fetch(`${workerUrl}/api/external-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        mermaidCode: summary,
        diagramImage: '',
        prompt: formatMailboxPrompt(snapshot),
        type: 'email',
        sessionId,
      }),
    })
      .then((response) => {
        setIsSyncing(false);
        if (!response.ok) {
          console.error('Failed to send mailbox context to Hexa:', response.status);
          lastSentDataRef.current = null;
        }
      })
      .catch((error) => {
        setIsSyncing(false);
        console.error('Error sending mailbox context to Hexa:', error);
        lastSentDataRef.current = null;
      });
  }, [snapshot, sessionId, workerUrl]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== workerOrigin || event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (!event.data || typeof event.data !== 'object') return;

      switch (event.data.type) {
        case 'IFRAME_READY':
          if (event.data.sessionId === sessionId) configureIframe();
          break;
        case 'HEXA_PRESENTATION_STATE':
          if (
            event.data.source === 'hexa-presentation-state' &&
            event.data.sessionId === sessionId &&
            typeof event.data.visualHidden === 'boolean' &&
            typeof event.data.transcriptHidden === 'boolean'
          ) {
            presentationRef.current = {
              visualHidden: event.data.visualHidden,
              transcriptHidden: event.data.transcriptHidden,
            };
          }
          break;
        case 'error':
          console.error('Hexa voice worker error:', event.data.error);
          break;
        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [workerOrigin, configureIframe, sessionId]);

  const status = isSyncing
    ? 'Syncing mailbox...'
    : `${snapshot.threads.length} email${snapshot.threads.length === 1 ? '' : 's'} in context`;

  return (
    <section className="hexa-panel border-sidebar-border bg-panelLight dark:bg-panelDark border" aria-label="Voice assistant">
      <div className="hexa-panel__header border-sidebar-border border-b">
        <div className="min-w-0">
          <h2 className="text-sidebar-foreground truncate text-sm font-semibold">Voice Pane</h2>
          <p className="text-muted-foreground truncate text-xs" role="status">
            {status}
          </p>
        </div>
        <button
          type="button"
          onClick={() => sessionManager.generateSessionId()}
          className="hexa-panel__reset"
          title="Reset voice connection"
          aria-label="Reset voice connection"
          disabled={!sessionId}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      </div>
      <div className="hexa-panel__body">
        {sessionId ? (
          <iframe
            key={sessionId}
            ref={iframeRef}
            // `prewarm=true` is what makes the pane arrive *loaded*: Hexa builds
            // its Realtime session at load even though voice starts off, so the
            // reader sees the hexagon rather than a blurred progress bar and the
            // first Voice ON is instant. The microphone is untouched until they
            // tap the pill.
            src={`${workerUrl}/enhancedMode?showChat=true&sessionId=${encodeURIComponent(sessionId)}&iframe=true&curtains=true&voice=off&prewarm=true`}
            className="hexa-panel__frame"
            allow="microphone; autoplay"
            title="Voice assistant - hexagon and transcript"
            onLoad={handleIframeLoad}
          />
        ) : (
          <p className="text-muted-foreground p-4 text-center text-sm" role="status">
            Initializing voice assistant...
          </p>
        )}
      </div>
    </section>
  );
}

import {
  formatImageAnalysisReply,
  NO_EMAIL_OPEN_MESSAGE,
  STALE_IMAGE_RESULT_MESSAGE,
  type ImageAnalysisResult,
} from '@/lib/hexa-email-image-reply';
import { HEXAGON_SPLIT_MIN_PERCENT, resolveHexagonSplitPercent } from '@/lib/hexa-layout-split';
import { buildEmailContextPack, type SelectedEmailContext } from '@/lib/hexa-email-context';
import { EmailContextTracker, type SendTicket } from '@/lib/hexa-email-delivery';
import { useSelectedEmailContext } from '@/hooks/use-selected-email-context';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMailboxSnapshot } from '@/hooks/use-mailbox-snapshot';
import { hexaLogsOverrideSearch } from '@/lib/log-visibility';
import { HEXA_WORKER_URL } from '@/lib/hexa-worker-url';
import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
import { sessionManager } from '@/lib/hexa-session';

/** Reapply the layout once the embedded app has registered its listener. */
const IFRAME_SETUP_DELAYS_MS = [400, 1200];

interface HexaPanelProps {
  hexaWorkerUrl?: string;
}

type ContextStatus = 'idle' | 'syncing' | 'failed';

/**
 * The voice pane that lives in the mail sidebar between the folder list and the
 * settings button: Hexa's hexagon on top, its transcript below. The worker runs
 * in its own origin, so the host talks to it three ways — a `postMessage` channel
 * for presentation, a POST to `/api/external-data` carrying the email reference
 * pack, and the same `postMessage` channel in reverse when Hexa asks to look at
 * an image in the open email.
 *
 * Context updates are silent: nothing here starts a turn, so selecting an email
 * never makes Hexa speak and never restarts the conversation.
 *
 * Adapted from infflow-calendar (calendar-worker/web/src/components/HexaWorker.tsx).
 */
export function HexaPanel({ hexaWorkerUrl }: HexaPanelProps) {
  const workerUrl = hexaWorkerUrl ?? HEXA_WORKER_URL;
  const workerOrigin = useMemo(() => new URL(workerUrl).origin, [workerUrl]);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [contextStatus, setContextStatus] = useState<ContextStatus>('idle');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeSetupTimeoutsRef = useRef<number[]>([]);
  const retryTimeoutRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const presentationRef = useRef({ visualHidden: true, transcriptHidden: true });
  const hexagonSplitRef = useRef(HEXAGON_SPLIT_MIN_PERCENT);
  const trackerRef = useRef(new EmailContextTracker());

  const snapshot = useMailboxSnapshot();
  const { selected, scopeId } = useSelectedEmailContext();
  const trpc = useTRPC();
  const { mutateAsync: describeThreadImages } = useMutation(
    trpc.mail.describeThreadImages.mutationOptions(),
  );

  // Kept in a ref so the postMessage listener always answers about the email that
  // is open at the moment the question arrives, not the one it closed over.
  const selectedRef = useRef<SelectedEmailContext | null>(selected);
  selectedRef.current = selected;

  const postLayoutSplit = useCallback(
    (hexagonHeight: number) => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'SET_LAYOUT_SPLIT',
          hexagonHeight,
          chatHeight: 100 - hexagonHeight,
          hideHexagon: false,
          compactHexagon: true,
        },
        workerOrigin,
      );
    },
    [workerOrigin],
  );

  const configureIframe = useCallback(() => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame) return;

    postLayoutSplit(hexagonSplitRef.current);
    frame.postMessage({ type: 'SET_ASPECT_COUNT', aspectCount: 0 }, workerOrigin);
    // Seed a fresh iframe, then let Hexa's native controls own visibility. The
    // snapshot also preserves the user's choices after a connection reset.
    frame.postMessage(
      { type: 'SET_NARRATOR_PRESENTATION', ...presentationRef.current },
      workerOrigin,
    );
  }, [workerOrigin, postLayoutSplit]);

  // Keep the split in step with the frame's height. Hexa's hexagon section has
  // a fixed pixel cost - two pills and their gaps - that a percentage cannot
  // know about, so the share it needs depends on how tall the frame currently
  // is. The frame is watched rather than the pane, and its *layout* height is
  // what a ResizeObserver reports: the stylesheet draws it scaled down to buy
  // horizontal room, but the viewport inside it is the untransformed box, and
  // that is the number Hexa's own percentage is applied to.
  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;

    const apply = (frameHeight: number) => {
      const next = resolveHexagonSplitPercent(frameHeight);
      if (next === hexagonSplitRef.current) return;
      hexagonSplitRef.current = next;
      // A frame that has not loaded yet has nothing listening, which is fine:
      // the ref is what `configureIframe` reads on load.
      postLayoutSplit(next);
    };

    apply(frame.offsetHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) apply(entry.contentRect.height);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [sessionId, postLayoutSplit]);

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

  // A replacement session starts with no stored record, so everything the
  // assistant was told has to be delivered again.
  useEffect(() => {
    if (!sessionId) return;
    trackerRef.current.markStale();
  }, [sessionId]);

  useEffect(
    () => () => {
      if (retryTimeoutRef.current !== null) window.clearTimeout(retryTimeoutRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  const [retryTick, setRetryTick] = useState(0);

  // Push the email reference pack whenever the selection or the mailbox changes.
  // This does not wait on the mailbox cache-settling timer: `selected` comes
  // straight off the thread query, so an opened email is sent as soon as it loads.
  useEffect(() => {
    if (!sessionId) return;

    const tracker = trackerRef.current;
    tracker.setScope(scopeId);
    tracker.setSelection(selected?.threadId ?? null);

    // The sidebar renders on the settings routes too, where there is neither a
    // folder to describe nor an email open. Keep the last context rather than
    // overwriting it with an empty one.
    if (!snapshot.folder && !selected) return;

    const pack = buildEmailContextPack({
      snapshot,
      selected,
      revision: tracker.getRevision(),
      scopeId,
    });

    const ticket = tracker.beginSend(pack.text);
    if (!ticket) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setContextStatus('syncing');

    const finish = (delivered: boolean, ticketForResult: SendTicket) => {
      // A reply for a superseded send must not report on the current selection.
      const current = tracker.isCurrent(ticketForResult);
      tracker.completeSend(ticketForResult, delivered);
      if (!current) return;
      setContextStatus(delivered ? 'idle' : 'failed');
      if (delivered) return;
      const delay = tracker.retryDelayMs();
      if (delay === null) return;
      if (retryTimeoutRef.current !== null) window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = window.setTimeout(() => setRetryTick((tick) => tick + 1), delay);
    };

    fetch(`${workerUrl}/api/external-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        mermaidCode: pack.text,
        diagramImage: '',
        prompt: pack.prompt,
        type: 'email',
        sessionId,
      }),
    })
      .then((response) => {
        if (!response.ok) console.error('Failed to send email context to Hexa:', response.status);
        finish(response.ok, ticket);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          // Superseded by a newer selection; the newer send owns the status.
          tracker.completeSend(ticket, false);
          return;
        }
        console.error('Error sending email context to Hexa:', error);
        finish(false, ticket);
      });
  }, [snapshot, selected, scopeId, sessionId, workerUrl, retryTick]);

  const handleImageRequest = useCallback(
    async (hint: string | undefined, question: string | undefined): Promise<string> => {
      const tracker = trackerRef.current;
      const current = selectedRef.current;
      if (!current || current.status !== 'ready' || !current.newest) {
        return NO_EMAIL_OPEN_MESSAGE;
      }

      const selectionTicket = tracker.beginSelectionRequest();
      try {
        const result = (await describeThreadImages({
          threadId: current.threadId,
          messageId: current.newest.id,
          hint,
          question,
        })) as ImageAnalysisResult;

        // The user may have moved on while the model was looking at the picture.
        if (!tracker.isSelectionCurrent(selectionTicket)) return STALE_IMAGE_RESULT_MESSAGE;
        if (result.threadId !== selectionTicket.threadId) return STALE_IMAGE_RESULT_MESSAGE;
        return formatImageAnalysisReply(result);
      } catch (error) {
        console.error('Email image analysis failed:', error);
        return 'That image could not be analyzed just now. Say so rather than guessing what it shows.';
      }
    },
    [describeThreadImages],
  );

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
        case 'HEXA_APP_ACTION_REQUEST': {
          const { requestId, action } = event.data;
          if (event.data.sessionId !== sessionId) break;
          if (!requestId || action?.name !== 'describe_email_image') break;
          void handleImageRequest(action.imageHint, action.question).then((message) => {
            iframeRef.current?.contentWindow?.postMessage(
              {
                type: 'HEXA_APP_ACTION_RESULT',
                requestId,
                sessionId,
                success: true,
                message,
              },
              workerOrigin,
            );
          });
          break;
        }
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
  }, [workerOrigin, configureIframe, sessionId, handleImageRequest]);

  // The line speaks for the open conversation and nothing else. With no email
  // open it stays blank: a folder-wide tally here read as a claim about what
  // Hexa had been handed, and it counted headers held by the client rather than
  // the ones the pack actually carries.
  const selectedStatus = selected?.status;
  const status = useMemo(() => {
    if (!selectedStatus) return '';
    if (selectedStatus === 'error') return 'This email could not be loaded';
    if (selectedStatus === 'empty') return 'This email has no readable content';
    if (selectedStatus === 'loading') return 'Loading this email...';
    if (contextStatus === 'failed') return 'This email was not delivered - retrying';
    if (contextStatus === 'syncing') return 'Sending this email to Hexa...';
    return 'This email is loaded into Hexa';
  }, [contextStatus, selectedStatus]);

  return (
    <section
      className="hexa-panel border-sidebar-border bg-panelLight dark:bg-panelDark border"
      aria-label="Voice assistant"
    >
      <div className="hexa-panel__header border-sidebar-border border-b">
        {/* The status paragraph stays mounted even while it is blank: a live
            region that is added to the page at the same moment it gains text is
            not reliably announced. */}
        <div className="hexa-panel__heading min-w-0">
          <h2 className="text-sidebar-foreground truncate text-sm font-semibold">Voice Pane</h2>
          <p className="text-muted-foreground truncate text-xs" role="status">
            {status}
          </p>
        </div>
        <div className="hexa-panel__actions">
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
            // `curtainsStart=both` is what makes it arrive *covered*. This pane
            // wants both regions hidden to begin with, and the
            // SET_NARRATOR_PRESENTATION in `configureIframe` can only say so
            // once the frame has loaded — necessarily too late, so the hexagon
            // and the transcript painted in full and were covered a beat later.
            // On the URL the seed is known before Hexa's first render, so the
            // curtains are there from the start and the voice app boots behind
            // them. The message still matters: it is what restores the reader's
            // own choices into a replaced iframe after a connection reset, and
            // a seed deliberately does not override it.
            // `hexaLogsOverrideSearch()` is appended, not posted after load, so
            // the setting is in force before Hexa's first log line. It is frozen
            // at page load for the same reason the key is the session id: a new
            // src would remount the iframe and drop the voice session.
            src={`${workerUrl}/enhancedMode?showChat=true&sessionId=${encodeURIComponent(sessionId)}&iframe=true&curtains=true&curtainsStart=both&voice=off&prewarm=true${hexaLogsOverrideSearch()}`}
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

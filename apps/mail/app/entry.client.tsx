import { installConsoleLogCapture } from '@/lib/console-log-capture';
import { initializeLogVisibility } from '@/lib/log-visibility';
import { startTransition, StrictMode } from 'react';
import { HydratedRouter } from 'react-router/dom';
import { hydrateRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import './instrument';

// Must precede the capture install so no line prints ahead of the decision, and
// both must precede hydration so the file covers the whole page load.
initializeLogVisibility();
installConsoleLogCapture();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
    {
      onUncaughtError: Sentry.reactErrorHandler((error, errorInfo) => {
        console.warn('Uncaught error', error, errorInfo.componentStack);
      }),
      // Callback called when React catches an error in an ErrorBoundary.
      onCaughtError: Sentry.reactErrorHandler(),
      // Callback called when React automatically recovers from errors.
      onRecoverableError: Sentry.reactErrorHandler(),
    },
  );
});

import { downloadConsoleLogsForSession } from '@/lib/console-log-capture';
import { areLogsVisible } from '@/lib/log-visibility';
import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Downloads the Infflow Email and Hexa console log bundle for the live voice
 * session. It sits beside the sidebar's settings button rather than in the
 * voice pane header: it is a debugging affordance, not a voice control, so it
 * belongs with the other utility action at the bottom of the sidebar.
 *
 * `downloadConsoleLogsForSession` resolves the current session id from
 * `sessionManager` on its own, so this stays a plain button with no session
 * subscription — and, unlike the voice pane, it never mints an id of its own.
 */
export function ConsoleLogDownloadButton({ className }: { className?: string }) {
  // Resolved after mount rather than during render: log visibility is a
  // browser-only decision, and reading it while the server renders would make
  // the two passes disagree.
  const [showLogButton, setShowLogButton] = useState(false);
  useEffect(() => setShowLogButton(areLogsVisible()), []);

  const handleDownloadConsoleLogs = useCallback(() => downloadConsoleLogsForSession(), []);

  if (!showLogButton) return null;

  return (
    <button
      type="button"
      onClick={handleDownloadConsoleLogs}
      className={cn('console-log-download', className)}
      title="Download Infflow Email and Hexa console logs"
      aria-label="Download Infflow Email and Hexa console logs"
    >
      <Download className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/**
 * Turns what the mail client already has loaded into the plain-text pack the
 * Hexa voice worker reads. Headers only — sender, subject, date, read state and
 * AI group — never message bodies.
 *
 * The worker stores this pack in a Durable Object whose value cap is 128 KiB,
 * and UTF-16 serialization doubles the byte size, so anything past ~60K chars is
 * silently dropped on the way in. MAX_CONTEXT_CHARS keeps this an order of
 * magnitude below that ceiling.
 */

export const MAX_CONTEXT_THREADS = 40;
export const MAX_CONTEXT_CHARS = 20000;

export interface MailboxThread {
  id: string;
  sender: string;
  subject: string;
  receivedOn: string;
  unread: boolean;
  categories: string[];
}

export interface MailboxSnapshot {
  /** Folder segment of the current route, e.g. `inbox`. Empty outside /mail. */
  folder: string;
  folderCounts: { label: string; count: number }[];
  groupCounts: { id: string; name: string; count: number }[];
  /** Threads whose headers are already cached, newest first. */
  threads: MailboxThread[];
  /** Threads the current folder listing knows about, loaded or not. */
  listedThreadCount: number;
}

/**
 * Mirrors the category-to-group rules in `hooks/use-email-groups.ts` so the
 * counts the assistant hears match the group cards the user sees.
 */
export function resolveEmailGroupId(categories: string[] | undefined): 'fubo' | 'jobs' | 'others' {
  if (!categories?.length) return 'others';
  if (categories.some((category) => category.toLowerCase().includes('fubo'))) return 'fubo';
  if (
    categories.some((category) => {
      const lower = category.toLowerCase();
      return lower.includes('jobs') || lower.includes('employment') || lower.includes('job');
    })
  ) {
    return 'jobs';
  }
  return 'others';
}

export const EMAIL_GROUP_NAMES: Record<string, string> = {
  fubo: 'FUBO Related',
  jobs: 'Jobs and Employment',
  others: 'Others',
};

function formatReceivedOn(receivedOn: string): string {
  if (!receivedOn) return 'unknown date';
  const parsed = new Date(receivedOn);
  if (Number.isNaN(parsed.getTime())) return receivedOn;
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatMailboxSummary(snapshot: MailboxSnapshot): string {
  const { folder, folderCounts, groupCounts, threads, listedThreadCount } = snapshot;

  let summary = `# Mailbox summary\n\n`;
  summary += `Current folder: ${folder || 'unknown'}\n`;
  summary += `Threads in this folder listing: ${listedThreadCount}\n`;
  summary += `Threads with headers loaded: ${threads.length}\n\n`;

  summary += `## Folder counts\n\n`;
  if (folderCounts.length === 0) {
    summary += `Folder counts are not loaded yet.\n`;
  } else {
    for (const { label, count } of folderCounts) {
      summary += `- ${label}: ${count}\n`;
    }
  }

  summary += `\n## Email groups\n\n`;
  for (const { name, count } of groupCounts) {
    summary += `- ${name}: ${count}\n`;
  }

  summary += `\n## Loaded threads (newest first)\n\n`;
  if (threads.length === 0) {
    summary += `No thread headers are loaded yet. Say so rather than guessing what is in the mailbox.\n`;
    return summary;
  }

  const shown = threads.slice(0, MAX_CONTEXT_THREADS);
  for (const thread of shown) {
    const group = EMAIL_GROUP_NAMES[resolveEmailGroupId(thread.categories)];
    summary += `- ${thread.sender} — "${thread.subject}" (${formatReceivedOn(thread.receivedOn)}, ${thread.unread ? 'unread' : 'read'}, group: ${group})\n`;
  }

  if (threads.length > shown.length) {
    summary += `\n${threads.length - shown.length} further loaded threads are omitted from this list.\n`;
  }
  if (listedThreadCount > threads.length) {
    summary += `\nThe folder holds more threads than are loaded here. Do not claim the list is complete.\n`;
  }

  return summary.length > MAX_CONTEXT_CHARS
    ? `${summary.slice(0, MAX_CONTEXT_CHARS)}\n\n[context truncated]\n`
    : summary;
}

export function formatMailboxPrompt(snapshot: MailboxSnapshot): string {
  return (
    `Mailbox context for the "${snapshot.folder || 'unknown'}" folder: ` +
    `${snapshot.threads.length} of ${snapshot.listedThreadCount} listed threads have headers loaded. ` +
    `Answer from these headers only — message bodies are not available to you.`
  );
}

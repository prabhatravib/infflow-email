/**
 * Selection bookkeeping for the Hexa email context: which conversation is
 * current, which revision it is, and whether an in-flight result still applies.
 *
 * Everything asynchronous about this feature - the context POST, and the image
 * analysis the assistant can ask for - can land after the user has already moved
 * to another email. Both take a ticket from this tracker before they start and
 * hand it back when they finish; a ticket from a superseded selection is refused.
 *
 * Deliberately free of React and timers so the ordering rules can be tested
 * directly. The panel owns the effects.
 */

export interface SendTicket {
  sequence: number;
  revision: number;
  scopeId: string;
  threadId: string | null;
  hash: string;
}

export interface SelectionTicket {
  revision: number;
  scopeId: string;
  threadId: string | null;
}

/** Backoff for a failed context POST. Bounded, and it never gives up entirely. */
export const RETRY_DELAYS_MS = [1000, 3000, 8000, 20000];

/** FNV-1a over the pack text. Cheap, synchronous, and only used for equality. */
export function hashContext(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${value.length}`;
}

export class EmailContextTracker {
  private scopeId = '';
  private threadId: string | null = null;
  private revision = 0;
  private sequence = 0;
  private deliveredHash: string | null = null;
  private inFlight: SendTicket | null = null;
  private failureCount = 0;

  /**
   * Point the tracker at an account. A different account invalidates the open
   * email outright: the previous account's thread must never stay active.
   */
  setScope(scopeId: string): boolean {
    if (scopeId === this.scopeId) return false;
    this.scopeId = scopeId;
    this.threadId = null;
    this.revision += 1;
    this.deliveredHash = null;
    this.inFlight = null;
    this.failureCount = 0;
    return true;
  }

  /** Open, switch or close the conversation. `null` clears the active focus. */
  setSelection(threadId: string | null): boolean {
    const next = threadId || null;
    if (next === this.threadId) return false;
    this.threadId = next;
    this.revision += 1;
    this.failureCount = 0;
    return true;
  }

  getScopeId(): string {
    return this.scopeId;
  }

  getSelectedThreadId(): string | null {
    return this.threadId;
  }

  getRevision(): number {
    return this.revision;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  /** Delay before the next attempt, or null once the caller should stop retrying. */
  retryDelayMs(): number | null {
    if (this.failureCount === 0) return null;
    return RETRY_DELAYS_MS[Math.min(this.failureCount - 1, RETRY_DELAYS_MS.length - 1)];
  }

  /**
   * Forget what was delivered, so the next build is sent again. Used when the
   * embedded worker session is replaced and its stored record may be gone.
   */
  markStale(): void {
    this.deliveredHash = null;
    this.inFlight = null;
    this.failureCount = 0;
  }

  /**
   * Claim the right to send `text`. Returns null when the identical pack is
   * already delivered or already on the wire, which is what keeps repeated
   * clicks on the same email from re-injecting it.
   */
  beginSend(text: string): SendTicket | null {
    const hash = hashContext(text);
    if (hash === this.deliveredHash) return null;
    if (this.inFlight && this.inFlight.hash === hash) return null;

    this.sequence += 1;
    const ticket: SendTicket = {
      sequence: this.sequence,
      revision: this.revision,
      scopeId: this.scopeId,
      threadId: this.threadId,
      hash,
    };
    this.inFlight = ticket;
    return ticket;
  }

  /** A ticket is current only while nothing newer has been started. */
  isCurrent(ticket: SendTicket): boolean {
    return ticket.sequence === this.sequence && ticket.revision === this.revision;
  }

  /**
   * Record the outcome. A late reply from a superseded send is ignored, so a slow
   * response for email A can never mark email B's context as delivered.
   */
  completeSend(ticket: SendTicket, delivered: boolean): void {
    if (this.inFlight?.sequence === ticket.sequence) this.inFlight = null;
    if (!this.isCurrent(ticket)) return;
    if (delivered) {
      this.deliveredHash = ticket.hash;
      this.failureCount = 0;
      return;
    }
    // A failure must never latch: clearing the hash lets the next attempt run.
    this.deliveredHash = null;
    this.failureCount += 1;
  }

  /** Snapshot of the selection an image request is being made against. */
  beginSelectionRequest(): SelectionTicket {
    return { revision: this.revision, scopeId: this.scopeId, threadId: this.threadId };
  }

  /** Whether a result taken against `ticket` still describes what is open. */
  isSelectionCurrent(ticket: SelectionTicket): boolean {
    return (
      ticket.revision === this.revision &&
      ticket.scopeId === this.scopeId &&
      ticket.threadId === this.threadId
    );
  }
}

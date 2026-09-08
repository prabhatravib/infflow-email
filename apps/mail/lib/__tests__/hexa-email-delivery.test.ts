/**
 * Selection ordering: what happens when the user clicks faster than the network.
 *
 * Every failure this guards against looks the same from the outside - the
 * assistant answering about the wrong email - so the tests are written as the
 * races that produce it, not as method-level checks.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EmailContextTracker, hashContext, RETRY_DELAYS_MS } from '@/lib/hexa-email-delivery';

const packFor = (thread: string) => `=== EMAIL REFERENCE CONTEXT ===\nThread-Id: ${thread}\nbody`;

test('the same context is not sent twice', () => {
  const tracker = new EmailContextTracker();
  tracker.setScope('conn-1');
  tracker.setSelection('a');

  const first = tracker.beginSend(packFor('a'));
  assert.ok(first);
  tracker.completeSend(first, true);

  assert.equal(tracker.beginSend(packFor('a')), null, 'identical pack should not be resent');
});

test('a second send is refused while the identical one is still on the wire', () => {
  const tracker = new EmailContextTracker();
  tracker.setSelection('a');
  assert.ok(tracker.beginSend(packFor('a')));
  assert.equal(tracker.beginSend(packFor('a')), null);
});

test('a slow response for email A cannot mark email B as delivered', () => {
  const tracker = new EmailContextTracker();
  tracker.setScope('conn-1');

  tracker.setSelection('a');
  const ticketA = tracker.beginSend(packFor('a'));
  assert.ok(ticketA);

  // The user clicks B before A's POST comes back.
  tracker.setSelection('b');
  const ticketB = tracker.beginSend(packFor('b'));
  assert.ok(ticketB);

  assert.equal(tracker.isCurrent(ticketA), false);
  tracker.completeSend(ticketA, true);

  // B is still outstanding, and B's own pack is still worth sending.
  assert.ok(tracker.isCurrent(ticketB));
  tracker.completeSend(ticketB, true);
  assert.equal(tracker.getSelectedThreadId(), 'b');
  // A's pack is not remembered as delivered, so returning to A re-sends it.
  tracker.setSelection('a');
  assert.ok(tracker.beginSend(packFor('a')));
});

test('a failed delivery does not latch: the next attempt is allowed', () => {
  const tracker = new EmailContextTracker();
  tracker.setSelection('a');

  const first = tracker.beginSend(packFor('a'));
  assert.ok(first);
  tracker.completeSend(first, false);
  assert.equal(tracker.getFailureCount(), 1);
  assert.equal(tracker.retryDelayMs(), RETRY_DELAYS_MS[0]);

  const retry = tracker.beginSend(packFor('a'));
  assert.ok(retry, 'a failure must not suppress the retry of the same context');
  tracker.completeSend(retry, false);
  assert.equal(tracker.retryDelayMs(), RETRY_DELAYS_MS[1]);

  const third = tracker.beginSend(packFor('a'));
  assert.ok(third);
  tracker.completeSend(third, true);
  assert.equal(tracker.getFailureCount(), 0);
  assert.equal(tracker.retryDelayMs(), null);
});

test('a stale failure does not raise the retry count for the email now open', () => {
  const tracker = new EmailContextTracker();
  tracker.setSelection('a');
  const ticketA = tracker.beginSend(packFor('a'));
  assert.ok(ticketA);

  tracker.setSelection('b');
  const ticketB = tracker.beginSend(packFor('b'));
  assert.ok(ticketB);
  tracker.completeSend(ticketA, false);

  assert.equal(tracker.getFailureCount(), 0);
  tracker.completeSend(ticketB, true);
  assert.equal(tracker.getFailureCount(), 0);
});

test('closing the email clears the active focus and counts as a change', () => {
  const tracker = new EmailContextTracker();
  tracker.setSelection('a');
  const revisionWithEmail = tracker.getRevision();

  assert.equal(tracker.setSelection(null), true);
  assert.equal(tracker.getSelectedThreadId(), null);
  assert.ok(tracker.getRevision() > revisionWithEmail);
  assert.equal(tracker.setSelection(null), false, 'closing twice is not a new change');
});

test('changing account drops the previous account email outright', () => {
  const tracker = new EmailContextTracker();
  tracker.setScope('conn-1');
  tracker.setSelection('a');
  const delivered = tracker.beginSend(packFor('a'));
  assert.ok(delivered);
  tracker.completeSend(delivered, true);

  assert.equal(tracker.setScope('conn-2'), true);
  assert.equal(tracker.getSelectedThreadId(), null, 'the other account email must not stay open');
  // Even the identical pack must go out again: it belongs to a different account now.
  assert.ok(tracker.beginSend(packFor('a')));
});

test('a replaced voice session gets the context again', () => {
  const tracker = new EmailContextTracker();
  tracker.setSelection('a');
  const first = tracker.beginSend(packFor('a'));
  assert.ok(first);
  tracker.completeSend(first, true);
  assert.equal(tracker.beginSend(packFor('a')), null);

  tracker.markStale();
  assert.ok(tracker.beginSend(packFor('a')), 'a new session holds none of the old context');
});

test('an image result taken against a superseded selection is refused', () => {
  const tracker = new EmailContextTracker();
  tracker.setScope('conn-1');
  tracker.setSelection('a');

  const ticket = tracker.beginSelectionRequest();
  assert.ok(tracker.isSelectionCurrent(ticket));

  tracker.setSelection('b');
  assert.equal(tracker.isSelectionCurrent(ticket), false);

  // Returning to A is still a different moment: the revision has moved on.
  tracker.setSelection('a');
  assert.equal(tracker.isSelectionCurrent(ticket), false);
});

test('an image result is refused after the account changes under it', () => {
  const tracker = new EmailContextTracker();
  tracker.setScope('conn-1');
  tracker.setSelection('a');
  const ticket = tracker.beginSelectionRequest();

  tracker.setScope('conn-2');
  assert.equal(tracker.isSelectionCurrent(ticket), false);
});

test('an image result survives an unrelated mailbox refresh', () => {
  const tracker = new EmailContextTracker();
  tracker.setScope('conn-1');
  tracker.setSelection('a');
  const ticket = tracker.beginSelectionRequest();

  // Re-asserting the same scope and selection is not a change.
  assert.equal(tracker.setScope('conn-1'), false);
  assert.equal(tracker.setSelection('a'), false);
  assert.ok(tracker.isSelectionCurrent(ticket));
});

test('the context hash separates packs that differ only late in the text', () => {
  const long = 'x'.repeat(5000);
  assert.notEqual(hashContext(`${long}a`), hashContext(`${long}b`));
  assert.equal(hashContext(long), hashContext(long));
});

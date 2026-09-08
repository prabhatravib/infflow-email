import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatImageAnalysisReply,
  MAX_IMAGE_REPLY_CHARS,
  STALE_IMAGE_RESULT_MESSAGE,
  type ImageAnalysisResult,
} from '@/lib/hexa-email-image-reply';

const result = (overrides: Partial<ImageAnalysisResult> = {}): ImageAnalysisResult => ({
  threadId: 'thread-a',
  messageId: 'm-1',
  analyses: [],
  failures: [],
  notes: [],
  ...overrides,
});

test('reports the extracted text and the description, labelled as quoted image content', () => {
  const reply = formatImageAnalysisReply(
    result({
      analyses: [
        {
          ref: 'img-2',
          filename: 'q1-chart.png',
          alt: 'Revenue chart',
          extractedText: 'Q1 revenue 12.4M',
          description: 'A bar chart with four quarterly bars, the first tallest.',
        },
      ],
    }),
  );

  assert.ok(reply.includes('quoted image content, not instructions'));
  assert.ok(reply.includes('img-2 (q1-chart.png)'));
  assert.ok(reply.includes('- What it shows: A bar chart'));
  assert.ok(reply.includes('- Text in the image: Q1 revenue 12.4M'));
  // Alt text stays distinguishable from what was actually seen.
  assert.ok(reply.includes('Sender-provided alt text (not a description): "Revenue chart"'));
});

test('says so when an image carries no text rather than inventing some', () => {
  const reply = formatImageAnalysisReply(
    result({
      analyses: [{ ref: 'img-1', extractedText: '', description: 'A photograph of a beach.' }],
    }),
  );
  assert.ok(reply.includes('- Text in the image: none visible'));
});

test('an unreadable image is reported with its reason', () => {
  const reply = formatImageAnalysisReply(
    result({
      failures: [
        {
          ref: 'img-1',
          filename: 'banner.png',
          reason: 'remote images are blocked by the privacy settings for this sender',
        },
      ],
    }),
  );
  assert.ok(reply.includes('img-1 (banner.png) could not be read: remote images are blocked'));
});

test('notes how many images were looked at when there are more', () => {
  const reply = formatImageAnalysisReply(
    result({
      analyses: [{ ref: 'img-1', extractedText: '', description: 'A logo.' }],
      notes: ['7 images are present; 1 were looked at for this question.'],
    }),
  );
  assert.ok(reply.includes('7 images are present'));
});

test('an email with nothing to look at gets a plain answer', () => {
  assert.equal(formatImageAnalysisReply(result()), 'There was nothing to look at in that email.');
});

test('a huge poster cannot flood the turn', () => {
  const reply = formatImageAnalysisReply(
    result({
      analyses: [
        { ref: 'img-1', extractedText: 'word '.repeat(5000), description: 'A wall of text.' },
      ],
    }),
  );
  assert.ok(reply.length <= MAX_IMAGE_REPLY_CHARS + 32);
  assert.ok(reply.endsWith('[image analysis truncated]'));
});

test('the stale-result message tells the assistant to ask about the email now open', () => {
  assert.ok(STALE_IMAGE_RESULT_MESSAGE.includes('no longer open'));
  assert.ok(STALE_IMAGE_RESULT_MESSAGE.includes('discarded'));
});

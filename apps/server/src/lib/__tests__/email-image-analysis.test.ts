/**
 * Which image gets looked at, and what is allowed to be fetched to look at it.
 *
 * The selection endpoint never takes a URL, so these two questions are the whole
 * attack surface: the ranking decides what the user meant, and `resolveImage`
 * decides what may be read at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_REQUEST,
  parseAnalysisReply,
  resolveImage,
  selectImagesForRequest,
} from '../email-image-analysis';
import { extractEmailImages, type EmailImage } from '../email-reference';

const image = (overrides: Partial<EmailImage>): EmailImage => ({
  ref: 'img-1',
  kind: 'inline',
  ...overrides,
});

const pngDataUri = (bytes = 64) =>
  `data:image/png;base64,${Buffer.alloc(bytes, 1).toString('base64')}`;

test('an explicit img-N reference wins over everything else', () => {
  const images = [
    image({ ref: 'img-1', alt: 'chart', approxBytes: 90000 }),
    image({ ref: 'img-2', alt: 'logo', approxBytes: 500 }),
  ];
  assert.deepEqual(
    selectImagesForRequest(images, 'tell me about img-2').map((entry) => entry.ref),
    ['img-2'],
  );
});

test('"the second image" and "the first picture" resolve positionally', () => {
  const images = [image({ ref: 'img-1' }), image({ ref: 'img-2' }), image({ ref: 'img-3' })];
  assert.deepEqual(
    selectImagesForRequest(images, 'what is in the second image?').map((entry) => entry.ref),
    ['img-2'],
  );
  assert.deepEqual(
    selectImagesForRequest(images, 'read the first picture').map((entry) => entry.ref),
    ['img-1'],
  );
  assert.deepEqual(
    selectImagesForRequest(images, 'the last one').map((entry) => entry.ref),
    ['img-3'],
  );
});

test('a described image is matched by its alt text or filename', () => {
  const images = [
    image({ ref: 'img-1', alt: 'company logo', approxBytes: 4000 }),
    image({ ref: 'img-2', filename: 'revenue-chart.png', approxBytes: 4000 }),
  ];
  assert.equal(selectImagesForRequest(images, 'what does the revenue chart say?')[0].ref, 'img-2');
  assert.equal(selectImagesForRequest(images, 'describe the logo')[0].ref, 'img-1');
});

test('spacers and tracking pixels lose to real pictures when there is no hint', () => {
  const images = [
    image({ ref: 'img-1', approxBytes: 43 }),
    image({ ref: 'img-2', approxBytes: 120000 }),
    image({ ref: 'img-3', approxBytes: 8000 }),
  ];
  assert.deepEqual(
    selectImagesForRequest(images, undefined).map((entry) => entry.ref),
    ['img-2', 'img-3'],
  );
});

test('never analyzes more than two images for one question', () => {
  const images = Array.from({ length: 9 }, (_unused, index) =>
    image({ ref: `img-${index + 1}`, approxBytes: 50000 }),
  );
  assert.equal(selectImagesForRequest(images, undefined, 9).length, MAX_IMAGES_PER_REQUEST);
  assert.equal(selectImagesForRequest(images, undefined).length, MAX_IMAGES_PER_REQUEST);
});

test('an email with no images selects nothing', () => {
  assert.deepEqual(selectImagesForRequest([], 'the chart'), []);
});

test('an embedded image is decoded without touching the network', async () => {
  let fetched = 0;
  const resolved = await resolveImage(image({ kind: 'inline', source: pngDataUri() }), {
    getAttachmentBody: async () => null,
    allowRemoteImages: true,
    fetchImpl: (async () => {
      fetched += 1;
      throw new Error('should not fetch');
    }) as unknown as typeof fetch,
  });

  assert.ok('bytes' in resolved);
  assert.equal(resolved.mimeType, 'image/png');
  assert.equal(resolved.bytes.length, 64);
  assert.equal(fetched, 0);
});

test('an unsupported image type is refused rather than guessed at', async () => {
  const resolved = await resolveImage(
    image({ kind: 'inline', source: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }),
    { getAttachmentBody: async () => null, allowRemoteImages: true },
  );
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /unsupported image type/);
});

test('an oversized embedded image is refused before it is handed to a model', async () => {
  const huge = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 4096) / 3) * 4)}`;
  const resolved = await resolveImage(image({ kind: 'inline', source: huge }), {
    getAttachmentBody: async () => null,
    allowRemoteImages: true,
  });
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /too large/);
});

test('an attachment is read through the caller credentials, never by URL', async () => {
  const requested: string[] = [];
  const resolved = await resolveImage(
    image({ ref: 'img-1', kind: 'attachment', attachmentId: 'att-9', mimeType: 'image/jpeg' }),
    {
      allowRemoteImages: false,
      // Gmail hands back url-safe base64.
      getAttachmentBody: async (attachmentId) => {
        requested.push(attachmentId);
        return { body: Buffer.from([1, 2, 3, 4]).toString('base64url'), mimeType: 'image/jpeg' };
      },
    },
  );

  assert.deepEqual(requested, ['att-9']);
  assert.ok('bytes' in resolved);
  assert.deepEqual(Array.from(resolved.bytes), [1, 2, 3, 4]);
});

test('blocked remote images are not fetched, and the block is reported', async () => {
  let fetched = 0;
  const resolved = await resolveImage(
    image({ kind: 'remote', source: 'https://cdn.example.com/a.png' }),
    {
      getAttachmentBody: async () => null,
      allowRemoteImages: false,
      fetchImpl: (async () => {
        fetched += 1;
        return new Response(null);
      }) as unknown as typeof fetch,
    },
  );

  assert.equal(fetched, 0, 'a blocked image must never be requested from its host');
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /blocked by the privacy settings/);
});

test('a plain-http image is refused even when remote images are allowed', async () => {
  const resolved = await resolveImage(
    image({ kind: 'remote', source: 'http://cdn.example.com/a.png' }),
    { getAttachmentBody: async () => null, allowRemoteImages: true },
  );
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /only https/);
});

test('a URL that answers with a webpage is refused, so this cannot fetch pages', async () => {
  const resolved = await resolveImage(
    image({ kind: 'remote', source: 'https://example.com/article' }),
    {
      getAttachmentBody: async () => null,
      allowRemoteImages: true,
      fetchImpl: (async () =>
        new Response('<html>not an image</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })) as unknown as typeof fetch,
    },
  );
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /did not return a supported image/);
});

test('a remote image that declares itself oversized is refused before download', async () => {
  const resolved = await resolveImage(
    image({ kind: 'remote', source: 'https://cdn.example.com/huge.png' }),
    {
      getAttachmentBody: async () => null,
      allowRemoteImages: true,
      fetchImpl: (async () =>
        new Response('x', {
          headers: {
            'content-type': 'image/png',
            'content-length': String(MAX_IMAGE_BYTES + 1),
          },
        })) as unknown as typeof fetch,
    },
  );
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /too large/);
});

test('a host error becomes a reported reason, not a thrown request', async () => {
  const resolved = await resolveImage(
    image({ kind: 'remote', source: 'https://cdn.example.com/gone.png' }),
    {
      getAttachmentBody: async () => null,
      allowRemoteImages: true,
      fetchImpl: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
    },
  );
  assert.ok('reason' in resolved);
  assert.match(resolved.reason, /returned 404/);
});

test('the analysis reply is parsed into bounded halves', () => {
  const parsed = parseAnalysisReply(
    'TEXT: Q1 revenue 12.4M\nUp 8% year on year\nDESCRIPTION: A bar chart in blue.',
  );
  assert.equal(parsed.extractedText, 'Q1 revenue 12.4M\nUp 8% year on year');
  assert.equal(parsed.description, 'A bar chart in blue.');

  const empty = parseAnalysisReply('TEXT: none\nDESCRIPTION: A photograph of a dog.');
  assert.equal(empty.extractedText, '');
  assert.equal(empty.description, 'A photograph of a dog.');

  const flood = parseAnalysisReply(`TEXT: ${'x'.repeat(9000)}\nDESCRIPTION: ${'y'.repeat(9000)}`);
  assert.ok(flood.extractedText.length <= 2000);
  assert.ok(flood.description.length <= 600);
});

test('the client inventory and the server selection agree on which image is which', () => {
  const html =
    '<p>a</p><img src="https://cdn.example.com/one.png" alt="one">' +
    '<div style="display:none"><img src="https://cdn.example.com/hidden.png"></div>' +
    '<img src="data:image/png;base64,AAAA" alt="two">';
  const images = extractEmailImages(html, [
    {
      attachmentId: 'att-1',
      filename: 'scan.jpg',
      mimeType: 'image/jpeg',
      size: 90000,
      headers: [],
    },
  ]);

  assert.deepEqual(
    images.map((entry) => entry.ref),
    ['img-1', 'img-2', 'img-3', 'img-4'],
  );
  // A hidden image is still image #2 on both sides: the numbering follows the
  // document, not what the reading pane happens to paint.
  assert.equal(images[1].host, 'cdn.example.com');
  assert.equal(images[3].kind, 'attachment');
  assert.equal(selectImagesForRequest(images, 'the scan')[0].ref, 'img-4');
});

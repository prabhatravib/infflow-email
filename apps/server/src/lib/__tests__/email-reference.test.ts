/**
 * The markup scanner both runtimes share. Real email HTML is malformed, so the
 * cases here are the shapes that actually arrive rather than well-formed samples.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractEmailImages,
  htmlToReadableText,
  MAX_IMAGE_INVENTORY,
  stripBase64Blobs,
} from '../email-reference';

const read = (html: string, maxChars = 5000) => htmlToReadableText(html, { maxChars });

test('a plain-text body survives untouched apart from entities', () => {
  const { text, truncated } = read('Hello &amp; welcome &#8212; see you at 9.');
  assert.equal(text, 'Hello & welcome — see you at 9.');
  assert.equal(truncated, false);
});

test('unclosed and malformed tags do not unbalance the scanner', () => {
  const { text } = read('<div><p>One<p>Two<div><span>Three</div>Four');
  assert.ok(text.includes('One'));
  assert.ok(text.includes('Two'));
  assert.ok(text.includes('Three'));
  assert.ok(text.includes('Four'));
});

test('a > inside an attribute value does not end the tag early', () => {
  const { text } = read('<a href="https://example.com/?a=1&b=2" title="x > y">link</a>');
  assert.ok(text.includes('link (https://example.com/?a=1&b=2)'));
  assert.ok(!text.includes('title='));
});

test('a link whose label already is the destination is not repeated', () => {
  const { text } = read('<a href="https://example.com/x">https://example.com/x</a>');
  assert.equal(text, 'https://example.com/x');
});

test('an unclosed style block does not swallow the whole message', () => {
  const { text } = read('<style>.a{color:red}</style><p>Body text.</p>');
  assert.equal(text, 'Body text.');
});

test('nested hidden content stays hidden, and visible siblings do not', () => {
  const { text } = read(
    '<div style="display: none"><p>secret</p><span>also secret</span></div><p>public</p>',
  );
  assert.ok(!text.includes('secret'));
  assert.equal(text, 'public');
});

test('aria-hidden decoration is dropped', () => {
  const { text } = read('<span aria-hidden="true">•</span><p>Item</p>');
  assert.equal(text, 'Item');
});

test('reply separators end the message rather than duplicating the thread', () => {
  const { text, quotedTrimmed } = read(
    '<p>Sounds good.</p><p>On Mon, 2 Mar 2026 at 09:14, Ada &lt;ada@example.com&gt; wrote:</p><p>Original text.</p>',
  );
  assert.ok(text.includes('Sounds good.'));
  assert.ok(!text.includes('Original text.'));
  assert.equal(quotedTrimmed, true);
});

test('truncation cuts on a boundary and is reported', () => {
  const { text, truncated } = read(`<p>${'alpha '.repeat(400)}</p>`, 200);
  assert.equal(truncated, true);
  assert.ok(text.length <= 200);
  assert.ok(text.endsWith('alpha'));
});

test('base64 that reaches the text is replaced, not passed through', () => {
  const blob = `data:image/png;base64,${'A'.repeat(500)}`;
  assert.equal(stripBase64Blobs(blob), '[embedded image data removed]');
  const { text } = read(`<p>${blob}</p>`);
  assert.ok(!text.includes('AAAAAAAA'));
});

test('images are numbered in document order and marked in place', () => {
  const html =
    '<img src="https://a.example/1.png" alt="first"><p>Middle</p><img src="data:image/png;base64,AAAA">';
  const { text } = read(html);
  assert.ok(text.includes('[image #1]'));
  assert.ok(text.includes('[image #2]'));
  assert.ok(text.indexOf('[image #1]') < text.indexOf('Middle'));

  const images = extractEmailImages(html);
  assert.equal(images[0].ref, 'img-1');
  assert.equal(images[0].alt, 'first');
  assert.equal(images[0].host, 'a.example');
  assert.equal(images[1].kind, 'inline');
  assert.equal(images[1].mimeType, 'image/png');
});

test('a cid: image is matched to the attachment that carries it', () => {
  const images = extractEmailImages('<img src="cid:logo@mail" alt="Logo">', [
    {
      attachmentId: 'att-1',
      filename: 'logo.png',
      mimeType: 'image/png',
      size: 4096,
      headers: [{ name: 'Content-ID', value: '<logo@mail>' }],
    },
  ]);

  assert.equal(images.length, 1, 'the attachment must not also be listed separately');
  assert.equal(images[0].kind, 'cid');
  assert.equal(images[0].attachmentId, 'att-1');
  assert.equal(images[0].filename, 'logo.png');
});

test('non-image attachments are never offered as pictures', () => {
  const images = extractEmailImages('<p>See attached.</p>', [
    {
      attachmentId: 'att-1',
      filename: 'contract.pdf',
      mimeType: 'application/pdf',
      size: 90000,
      headers: [],
    },
  ]);
  assert.deepEqual(images, []);
});

test('the same src listed twice counts once', () => {
  const images = extractEmailImages(
    '<img src="https://a.example/1.png"><img src="https://a.example/1.png">',
  );
  assert.equal(images.length, 1);
});

test('an absurd number of images is capped', () => {
  const html = Array.from(
    { length: 90 },
    (_unused, index) => `<img src="https://a.example/${index}.png">`,
  ).join('');
  assert.equal(extractEmailImages(html).length, MAX_IMAGE_INVENTORY);
});

test('an image with an unusable scheme is skipped rather than listed', () => {
  const images = extractEmailImages('<img src="javascript:alert(1)"><img src="">');
  assert.deepEqual(images, []);
});

/**
 * Dependency-free extraction of readable text and an image inventory from an
 * email body.
 *
 * Both runtimes import this file: the mail client builds the voice assistant's
 * reference pack from it, and the server re-derives the same image list when the
 * user asks about a picture. The two sides must agree on image ordering, so both
 * walk the markup through `forEachTag` rather than through their own regexes.
 *
 * Nothing here touches the DOM or a parser package - it has to run in the
 * browser, in a Cloudflare Worker, and under `node --test` unchanged.
 */

/** Where a picture in an email actually lives. */
export type EmailImageKind = 'inline' | 'remote' | 'cid' | 'attachment';

export interface EmailImage {
  /** Stable handle the assistant and the analysis endpoint both speak. */
  ref: string;
  kind: EmailImageKind;
  mimeType?: string;
  /** Sender-authored alt text. Never a description of what the image shows. */
  alt?: string;
  filename?: string;
  approxBytes?: number;
  /** Host only, for remote images - the full URL stays in `source`. */
  host?: string;
  attachmentId?: string;
  /**
   * The raw `src` (a data: URI, an https URL or a cid: reference). Server-side
   * only: it carries base64 payloads and tracking URLs, so the reference pack
   * must never serialize it. Use `describeEmailImages` for the safe view.
   */
  source?: string;
}

export interface ReadableTextResult {
  text: string;
  /** The body was longer than the caller's budget and was cut. */
  truncated: boolean;
  /** A quoted reply chain was dropped rather than repeated. */
  quotedTrimmed: boolean;
}

/** Tags whose entire subtree is dropped: never readable content. */
const SKIPPED_TAGS = new Set([
  'script',
  'style',
  'head',
  'title',
  'noscript',
  'iframe',
  'object',
  'svg',
  'template',
  'map',
]);

/** Tags whose subtree is quoted history the pack already carries as messages. */
const QUOTE_TAGS = new Set(['blockquote']);

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
]);

/** Class names Gmail and Outlook put on the collapsed "earlier message" block. */
const QUOTE_CLASS_RE =
  /\b(?:gmail_quote|gmail_extra|moz-cite-prefix|yahoo_quoted|OutlookMessageHeader)\b/;

const HIDDEN_STYLE_RE =
  /(?:display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0(?:px)?\b)/i;

/** "On Tue, 3 Jun 2025 at 14:02, Ada <ada@x.com> wrote:" and friends. */
const QUOTE_SEPARATOR_RE =
  /^\s*(?:-{2,}\s*(?:original message|forwarded message)\s*-{2,}|_{5,}|on\s.{0,180}\swrote:\s*$|from:\s.{0,160}\bsent:\s)/i;

export const MAX_IMAGE_INVENTORY = 20;
export const MAX_LINKS_IN_TEXT = 40;
export const MAX_LINK_URL_CHARS = 200;
export const MAX_ALT_CHARS = 160;

/** Longest base64 run allowed to survive into readable text. */
const BASE64_BLOB_RE = /data:[a-z0-9.+/-]*;base64,[A-Za-z0-9+/=\s]{40,}/gi;

interface TagToken {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (match, body: string) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Drops any base64 payload that leaked into text destined for the model. */
export function stripBase64Blobs(input: string): string {
  return input.replace(BASE64_BLOB_RE, '[embedded image data removed]');
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributeRe =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attributeRe.exec(raw)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[match[1].toLowerCase()] = decodeEntities(value);
  }
  return attributes;
}

/**
 * Single pass over the markup, handing every tag and text run to the callback in
 * document order. The one scanner both the inventory and the text extractor use,
 * so an image is image #3 on the client exactly when it is image #3 on the server.
 */
export function forEachTag(
  html: string,
  onTag: (tag: TagToken) => void,
  onText?: (text: string) => void,
): void {
  let index = 0;
  const length = html.length;

  while (index < length) {
    const next = html.indexOf('<', index);
    if (next === -1) {
      onText?.(html.slice(index));
      return;
    }
    if (next > index) onText?.(html.slice(index, next));

    // Comments and doctype/CDATA declarations carry no readable content.
    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next + 4);
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (html.startsWith('<!', next) || html.startsWith('<?', next)) {
      const end = html.indexOf('>', next + 2);
      index = end === -1 ? length : end + 1;
      continue;
    }

    const nameMatch = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(next, next + 64));
    if (!nameMatch) {
      onText?.('<');
      index = next + 1;
      continue;
    }

    // Walk to the closing '>' without stopping inside a quoted attribute value.
    let cursor = next + nameMatch[0].length;
    let quote: string | null = null;
    while (cursor < length) {
      const character = html[cursor];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
      cursor += 1;
    }
    const rawAttributes = html.slice(next + nameMatch[0].length, cursor);
    const name = nameMatch[2].toLowerCase();

    onTag({
      name,
      closing: nameMatch[1] === '/',
      selfClosing: VOID_TAGS.has(name) || rawAttributes.trimEnd().endsWith('/'),
      attributes: nameMatch[1] === '/' ? {} : parseAttributes(rawAttributes),
    });

    index = cursor >= length ? length : cursor + 1;
  }
}

function readDataUri(source: string): { mimeType: string; approxBytes: number } | null {
  const match = /^data:([a-z0-9.+/-]*);base64,/i.exec(source);
  if (!match) return null;
  const payload = source.slice(match[0].length).replace(/\s+/g, '');
  return { mimeType: match[1] || 'image/*', approxBytes: Math.floor((payload.length * 3) / 4) };
}

function readHost(source: string): string | undefined {
  const match = /^https?:\/\/([^/?#]+)/i.exec(source);
  return match ? match[1] : undefined;
}

function truncateAlt(alt: string | undefined): string | undefined {
  if (!alt) return undefined;
  const clean = alt.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > MAX_ALT_CHARS ? `${clean.slice(0, MAX_ALT_CHARS)}…` : clean;
}

export interface AttachmentLike {
  attachmentId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  headers?: { name?: string | null; value?: string | null }[];
}

function contentIdOf(attachment: AttachmentLike): string | undefined {
  const header = attachment.headers?.find((entry) => entry.name?.toLowerCase() === 'content-id');
  return header?.value?.replace(/[<>]/g, '').trim() || undefined;
}

/**
 * Every picture the message offers, in document order, followed by image
 * attachments the body never referenced. Pure and deterministic: the same
 * message always yields the same `ref` for the same picture.
 */
export function extractEmailImages(
  html: string | undefined,
  attachments: AttachmentLike[] = [],
): EmailImage[] {
  const images: EmailImage[] = [];
  const seenSources = new Set<string>();
  const usedAttachmentIds = new Set<string>();

  forEachTag(html ?? '', (tag) => {
    if (tag.closing || tag.name !== 'img') return;
    if (images.length >= MAX_IMAGE_INVENTORY) return;

    const source = (tag.attributes.src || '').trim();
    if (!source || seenSources.has(source)) return;

    const alt = truncateAlt(tag.attributes.alt);
    const dataUri = readDataUri(source);
    if (dataUri) {
      seenSources.add(source);
      images.push({ ref: '', kind: 'inline', alt, source, ...dataUri });
      return;
    }
    if (/^https?:\/\//i.test(source)) {
      seenSources.add(source);
      images.push({ ref: '', kind: 'remote', alt, source, host: readHost(source) });
      return;
    }
    if (/^cid:/i.test(source)) {
      const contentId = source.slice(4).replace(/[<>]/g, '').trim();
      const match = attachments.find((attachment) => contentIdOf(attachment) === contentId);
      seenSources.add(source);
      if (match?.attachmentId) usedAttachmentIds.add(match.attachmentId);
      images.push({
        ref: '',
        kind: 'cid',
        alt,
        source,
        mimeType: match?.mimeType,
        filename: match?.filename,
        approxBytes: match?.size,
        attachmentId: match?.attachmentId,
      });
    }
  });

  for (const attachment of attachments) {
    if (images.length >= MAX_IMAGE_INVENTORY) break;
    if (!attachment.attachmentId || usedAttachmentIds.has(attachment.attachmentId)) continue;
    if (!attachment.mimeType?.toLowerCase().startsWith('image/')) continue;
    usedAttachmentIds.add(attachment.attachmentId);
    images.push({
      ref: '',
      kind: 'attachment',
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      approxBytes: attachment.size,
      attachmentId: attachment.attachmentId,
    });
  }

  return images.map((image, position) => ({ ...image, ref: `img-${position + 1}` }));
}

/**
 * The subset of an image that is safe to put in front of the model. Built field
 * by field rather than by omission, so a field added to `EmailImage` later has to
 * be listed here deliberately before it can reach the reference pack.
 */
export function describeEmailImages(images: EmailImage[]): Omit<EmailImage, 'source'>[] {
  return images.map((image) => ({
    ref: image.ref,
    kind: image.kind,
    mimeType: image.mimeType,
    alt: image.alt,
    filename: image.filename,
    approxBytes: image.approxBytes,
    host: image.host,
    attachmentId: image.attachmentId,
  }));
}

interface ExtractOptions {
  /** Hard ceiling on the returned text. */
  maxChars: number;
  /** Drop quoted reply chains the pack already lists as separate messages. */
  dropQuotedHistory?: boolean;
}

interface Frame {
  name: string;
  /** Output-part index where this element's text began, for link labels. */
  start: number;
  href?: string;
}

/**
 * Readable text from an email body: paragraphs, list items, table rows and link
 * destinations survive; scripts, styles, hidden nodes, quoted history and image
 * bytes do not. Images become `[image #n]` markers matching `extractEmailImages`.
 */
export function htmlToReadableText(
  html: string | undefined,
  options: ExtractOptions,
): ReadableTextResult {
  const dropQuoted = options.dropQuotedHistory !== false;
  const parts: string[] = [];
  const stack: Frame[] = [];
  let skipDepth: number | null = null;
  let quotedTrimmed = false;
  let imageIndex = 0;
  let linkCount = 0;
  let listDepth = 0;

  const push = (value: string) => {
    if (skipDepth === null) parts.push(value);
  };

  forEachTag(
    html ?? '',
    (tag) => {
      const { name } = tag;

      if (tag.closing) {
        // Pop to the matching open tag; unclosed markup must not unbalance us.
        const frameIndex = stack.map((frame) => frame.name).lastIndexOf(name);
        if (frameIndex !== -1) {
          if (skipDepth !== null && frameIndex <= skipDepth) skipDepth = null;
          const frame = stack[frameIndex];

          if (frame.href && skipDepth === null && linkCount < MAX_LINKS_IN_TEXT) {
            const label = parts.slice(frame.start).join('').replace(/\s+/g, ' ').trim();
            const href = frame.href.slice(0, MAX_LINK_URL_CHARS);
            const labelIsHref =
              !label ||
              label.includes(href) ||
              href.toLowerCase() === `mailto:${label.toLowerCase()}`;
            if (!labelIsHref) {
              linkCount += 1;
              push(` (${href})`);
            } else if (!label) {
              linkCount += 1;
              push(href);
            }
          }
          if (name === 'ul' || name === 'ol') listDepth = Math.max(0, listDepth - 1);
          stack.length = frameIndex;
        }
        if (name === 'td' || name === 'th') push(' | ');
        if (BLOCK_TAGS.has(name)) push('\n');
        return;
      }

      if (name === 'img') {
        imageIndex += 1;
        if (imageIndex <= MAX_IMAGE_INVENTORY) push(` [image #${imageIndex}] `);
        return;
      }
      if (name === 'br') {
        push('\n');
        return;
      }

      const style = tag.attributes.style || '';
      const className = tag.attributes.class || '';
      const isQuote = QUOTE_TAGS.has(name) || (dropQuoted && QUOTE_CLASS_RE.test(className));
      const isHidden =
        'hidden' in tag.attributes ||
        HIDDEN_STYLE_RE.test(style) ||
        tag.attributes['aria-hidden'] === 'true';

      if (!tag.selfClosing) stack.push({ name, start: parts.length });

      if (skipDepth === null && (SKIPPED_TAGS.has(name) || isHidden || isQuote)) {
        if (isQuote) quotedTrimmed = true;
        if (tag.selfClosing) return;
        skipDepth = stack.length - 1;
        return;
      }
      if (skipDepth !== null) return;

      if (name === 'a') {
        const href = (tag.attributes.href || '').trim();
        if (/^(?:https?:|mailto:)/i.test(href) && stack.length) {
          stack[stack.length - 1].href = href;
        }
      }
      if (name === 'ul' || name === 'ol') listDepth += 1;
      if (name === 'li') push(`\n${'  '.repeat(Math.max(0, listDepth - 1))}- `);
      else if (BLOCK_TAGS.has(name)) push('\n');
    },
    (text) => {
      if (skipDepth !== null) return;
      if (!text) return;
      parts.push(decodeEntities(text));
    },
  );

  let text = parts.join('');
  text = stripBase64Blobs(text);
  text = text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\|\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (dropQuoted) {
    const lines = text.split('\n');
    const cut = lines.findIndex((line) => QUOTE_SEPARATOR_RE.test(line));
    if (cut > 0) {
      text = lines.slice(0, cut).join('\n').trim();
      quotedTrimmed = true;
    }
  }

  let truncated = false;
  if (text.length > options.maxChars) {
    const slice = text.slice(0, options.maxChars);
    const boundary = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    text = (boundary > options.maxChars * 0.6 ? slice.slice(0, boundary) : slice).trimEnd();
    truncated = true;
  }

  return { text, truncated, quotedTrimmed };
}

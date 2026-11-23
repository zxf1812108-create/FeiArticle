export interface TextSpan {
  start: number;
  end: number;
}

export interface DomPoint {
  node: Text;
  offset: number;
}

export interface DomRangePoints {
  start: DomPoint;
  end: DomPoint;
}

interface TextNodeSegment {
  node: Text;
  start: number;
  end: number;
}

const SOFT_HYPHEN = '\u00AD';

const BLOCK_SELECTOR =
  '[data-block-idx], p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, pre';

// Sentence-ending punctuation for CJK & full-width text
const CJK_TERMINATORS = new Set(['。', '？', '！']);
// Sentence-ending punctuation for English / ASCII text
const ASCII_TERMINATORS = new Set(['.', '?', '!']);
// Directional closing quotes/brackets that always belong to the preceding sentence
const CLOSING_DELIMITERS = new Set([
  '”',
  '’',
  '」',
  '』',
  '》',
  '）',
  '】',
  '〕',
  '〉',
  ')',
  ']',
  '}',
]);
// Ambiguous ASCII straight quotes (absorb at most one contiguous quote right after terminator)
const STRAIGHT_QUOTES = new Set(['"', "'"]);

// Common English abbreviations that end with '.' and should not terminate a sentence
const ENGLISH_ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'rev',
  'gen',
  'col',
  'lt',
  'capt',
  'sgt',
  'hon',
  'pres',
  'gov',
  'sen',
  'rep',
  'eg',
  'ie',
  'etc',
  'vs',
  'al',
  'fig',
  'eq',
  'vol',
  'no',
  'nos',
  'p',
  'pp',
  'ch',
  'chap',
  'sec',
  'approx',
  'dept',
  'est',
  'inc',
  'ltd',
  'co',
  'corp',
  'ave',
  'blvd',
  'rd',
  'apt',
  'tel',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
  'am',
  'pm',
  'ph',
  'mt',
]);

function isWhitespaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\u00A0' || ch === '\u3000';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isAsciiWordChar(ch: string): boolean {
  return isAsciiLetter(ch) || isDigit(ch) || ch === '_';
}

function isCjkChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * Peek at the next visible character (skipping invisible soft hyphens inserted by auto-hyphenation).
 */
function nextVisibleIndex(text: string, from: number): number {
  let i = from;
  while (i < text.length && text[i] === SOFT_HYPHEN) i++;
  return i;
}

function prevVisibleIndex(text: string, from: number): number {
  let i = from;
  while (i >= 0 && text[i] === SOFT_HYPHEN) i--;
  return i;
}

/**
 * Extract the ASCII word immediately preceding an ASCII period at `dotIdx` (ignoring soft hyphens).
 */
function extractWordBeforeDot(text: string, dotIdx: number): { word: string; startIdx: number } {
  let i = dotIdx - 1;
  const chars: string[] = [];
  let startIdx = dotIdx;
  while (i >= 0) {
    const ch = text[i];
    if (ch === SOFT_HYPHEN) {
      i--;
      continue;
    }
    if (isAsciiLetter(ch)) {
      chars.push(ch);
      startIdx = i;
      i--;
      continue;
    }
    break;
  }
  chars.reverse();
  return { word: chars.join(''), startIdx };
}

/**
 * Decide whether an ASCII '.' at `dotIdx` is a genuine sentence terminator
 * (avoiding false splits on decimals like 3.14, URLs like example.com, ellipsis '...',
 * and common abbreviations like Dr., Mr., e.g., U.S., J. K. Rowling).
 */
function isAsciiPeriodSentenceEnd(text: string, dotIdx: number): boolean {
  const prevIdx = prevVisibleIndex(text, dotIdx - 1);
  const nextIdx = nextVisibleIndex(text, dotIdx + 1);
  const prevCh = prevIdx >= 0 ? text[prevIdx] : '';
  const nextCh = nextIdx < text.length ? text[nextIdx] : '';

  // Ellipsis: part of consecutive dots (e.g. "..." or "..")
  if (prevCh === '.' || nextCh === '.') {
    return false;
  }

  // Decimal numbers / version numbers (e.g. 3.14, v2.0)
  if (isDigit(prevCh) && isDigit(nextCh)) {
    return false;
  }

  // ASCII period immediately after a CJK character (e.g. "这是第一句.Next") is a sentence end
  if (prevCh && isCjkChar(prevCh)) {
    return true;
  }

  // Domain names, file names, dotted acronyms (e.g. example.com, U.S.A., index.html)
  if (nextCh && isAsciiWordChar(nextCh)) {
    return false;
  }

  // Check for common English abbreviations before the period
  const { word, startIdx } = extractWordBeforeDot(text, dotIdx);
  if (word.length > 0) {
    const lower = word.toLowerCase();
    const charBeforeWordIdx = prevVisibleIndex(text, startIdx - 1);
    const charBeforeWord = charBeforeWordIdx >= 0 ? text[charBeforeWordIdx] : '';

    // Dotted multi-part abbreviations like "e.g.", "i.e.", "U.S.", "Ph.D."
    if (charBeforeWord === '.' && word.length <= 2) {
      // Allow ending a sentence ONLY if followed by newline/end or space + uppercase start of a new sentence
      if (!nextCh || nextCh === '\n') return true;
      let scan = nextIdx;
      while (scan < text.length && (text[scan] === ' ' || text[scan] === '\t' || text[scan] === '\u00A0')) {
        scan++;
      }
      // If next token is lowercase (e.g. "e.g. apple" or "U.S. economy"), do NOT split
      if (scan < text.length && text[scan] >= 'a' && text[scan] <= 'z') {
        return false;
      }
      // For "e.g." and "i.e.", never split even before capitalized proper nouns
      if (lower === 'g' || lower === 'e') {
        return false;
      }
    }

    if (ENGLISH_ABBREVIATIONS.has(lower)) {
      // Still split if this abbreviation is at the very end of the block/line
      if (!nextCh || nextCh === '\n') return true;
      return false;
    }

    // Single-letter initial like "J. K. Rowling" or "A. Smith" (but allow pronoun "I." at sentence end)
    if (word.length === 1 && word !== 'I' && nextCh && !isCjkChar(nextCh)) {
      let scan = nextIdx;
      while (scan < text.length && (text[scan] === ' ' || text[scan] === '\t' || text[scan] === '\u00A0')) {
        scan++;
      }
      if (scan < text.length && isAsciiLetter(text[scan])) {
        // Single initial followed by another word/initial (e.g. "J. K." or "A. Smith")
        return false;
      }
    }
  }

  // After closing quotes/brackets (if any), ensure period is followed by end, whitespace, CJK, or closing delimiter
  if (!nextCh || isWhitespaceChar(nextCh) || isCjkChar(nextCh)) {
    return true;
  }
  if (CLOSING_DELIMITERS.has(nextCh) || STRAIGHT_QUOTES.has(nextCh)) {
    return true;
  }

  return false;
}

/**
 * Split a single block's plain text into trimmed sentence spans [start, end).
 * Supports Chinese (。！？), English (. ? !), mixed CN/EN text, closing quotes/brackets,
 * hard newlines (\n), and soft hyphens (\u00AD) from auto-hyphenation.
 */
export function splitTextIntoSentences(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const len = text.length;
  if (len === 0) return spans;

  const pushTrimmedSpan = (rawStart: number, rawEnd: number) => {
    let s = rawStart;
    let e = rawEnd;
    while (s < e && isWhitespaceChar(text[s])) s++;
    while (e > s && isWhitespaceChar(text[e - 1])) e--;
    if (e > s) {
      spans.push({ start: s, end: e });
    }
  };

  let segStart = 0;
  let i = 0;

  while (i < len) {
    const ch = text[i];

    // Hard newline within a paragraph (whitespace-pre-line) ends the current sentence
    if (ch === '\n' || ch === '\r') {
      pushTrimmedSpan(segStart, i);
      while (i < len && (text[i] === '\n' || text[i] === '\r')) i++;
      segStart = i;
      continue;
    }

    const isCjkTerm = CJK_TERMINATORS.has(ch);
    const isAsciiTerm =
      ASCII_TERMINATORS.has(ch) && (ch !== '.' || isAsciiPeriodSentenceEnd(text, i));

    if (isCjkTerm || isAsciiTerm) {
      let endIdx = i + 1;

      // Absorb consecutive terminators (e.g. "？！", "?!", "!!", "??")
      while (endIdx < len) {
        const c = text[endIdx];
        if (CJK_TERMINATORS.has(c) || c === '?' || c === '!') {
          endIdx++;
          continue;
        }
        break;
      }

      // Absorb immediately attached closing quotes / brackets (e.g. 。” / ?" / !) / ？」)
      let absorbedStraightQuote = false;
      while (endIdx < len) {
        const c = text[endIdx];
        if (CLOSING_DELIMITERS.has(c)) {
          endIdx++;
          continue;
        }
        if (STRAIGHT_QUOTES.has(c) && !absorbedStraightQuote) {
          absorbedStraightQuote = true;
          endIdx++;
          continue;
        }
        break;
      }

      pushTrimmedSpan(segStart, endIdx);
      segStart = endIdx;
      i = endIdx;
      continue;
    }

    i++;
  }

  if (segStart < len) {
    pushTrimmedSpan(segStart, len);
  }

  // Fallback for whitespace-only block
  if (spans.length === 0) {
    spans.push({ start: 0, end: len });
  }

  return spans;
}

/**
 * Find the sentence span covering `offset` in `spans`.
 * - `prefer`: when `offset` lies in inter-sentence whitespace, `'next'` picks the following
 *   sentence (ideal for range starts), `'prev'` picks the preceding sentence (ideal for range ends).
 */
export function findSentenceSpanAtOffset(
  spans: TextSpan[],
  offset: number,
  prefer: 'prev' | 'next'
): TextSpan {
  if (spans.length === 0) return { start: 0, end: 0 };

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (offset >= span.start && offset <= span.end) {
      // If offset sits right at the boundary of a span:
      // - For a range start sitting exactly on span.end (e.g. right after sentence 0's period),
      //   prefer the next sentence if one exists.
      if (prefer === 'next' && offset === span.end && i + 1 < spans.length) {
        return spans[i + 1];
      }
      // - For a range end sitting exactly on span.start (e.g. right before sentence 1's first char),
      //   prefer the previous sentence if one exists.
      if (prefer === 'prev' && offset === span.start && i > 0) {
        return spans[i - 1];
      }
      return span;
    }
    if (offset < span.start) {
      if (prefer === 'prev' && i > 0) {
        return spans[i - 1];
      }
      return span;
    }
  }

  return spans[spans.length - 1];
}

function findEnclosingBlock(articleEl: HTMLElement, node: Node): HTMLElement {
  let curr: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (curr && curr !== articleEl) {
    if (curr instanceof HTMLElement && curr.matches(BLOCK_SELECTOR)) {
      return curr;
    }
    curr = curr.parentNode;
  }
  return articleEl;
}

function collectBlockTextSegments(blockEl: HTMLElement): {
  text: string;
  segments: TextNodeSegment[];
} {
  const segments: TextNodeSegment[] = [];
  const parts: string[] = [];
  let offset = 0;

  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const textNode = node as Text;
    const data = textNode.data;
    if (!data) continue;
    segments.push({ node: textNode, start: offset, end: offset + data.length });
    parts.push(data);
    offset += data.length;
  }

  return { text: parts.join(''), segments };
}

function resolveContainerOffsetToFlat(
  blockEl: HTMLElement,
  segments: TextNodeSegment[],
  container: Node,
  offset: number
): number {
  if (segments.length === 0) return 0;

  if (container.nodeType === Node.TEXT_NODE) {
    for (const seg of segments) {
      if (seg.node === container) {
        return seg.start + Math.max(0, Math.min(seg.end - seg.start, offset));
      }
    }
  }

  // Element container: map child index boundary via Range comparison
  try {
    const probe = document.createRange();
    probe.selectNodeContents(blockEl);
    probe.setEnd(container, Math.max(0, Math.min(container.childNodes.length, offset)));
    return probe.toString().length;
  } catch {
    return 0;
  }
}

function resolveFlatOffsetToDomPoint(
  segments: TextNodeSegment[],
  flatOffset: number,
  edge: 'start' | 'end'
): DomPoint | null {
  if (segments.length === 0) return null;
  const totalLen = segments[segments.length - 1].end;
  const clamped = Math.max(0, Math.min(totalLen, flatOffset));

  if (edge === 'start') {
    for (const seg of segments) {
      if (clamped < seg.end) {
        return { node: seg.node, offset: Math.max(0, clamped - seg.start) };
      }
    }
    const last = segments[segments.length - 1];
    return { node: last.node, offset: last.end - last.start };
  }

  // edge === 'end': prefer ending at the end of a text node rather than offset 0 of the next node
  for (const seg of segments) {
    if (clamped <= seg.end) {
      return { node: seg.node, offset: Math.max(0, clamped - seg.start) };
    }
  }
  const last = segments[segments.length - 1];
  return { node: last.node, offset: last.end - last.start };
}

/**
 * Expand a single DOM point (or short range) to its enclosing full sentence range.
 */
export function getSentenceRangeAtPoint(
  articleEl: HTMLElement,
  container: Node,
  offset: number,
  prefer: 'prev' | 'next' = 'next'
): DomRangePoints | null {
  if (!articleEl.contains(container)) return null;
  const blockEl = findEnclosingBlock(articleEl, container);
  const { text, segments } = collectBlockTextSegments(blockEl);
  if (segments.length === 0) return null;

  const flatOffset = resolveContainerOffsetToFlat(blockEl, segments, container, offset);
  const spans = splitTextIntoSentences(text);
  const targetSpan = findSentenceSpanAtOffset(spans, flatOffset, prefer);

  const start = resolveFlatOffsetToDomPoint(segments, targetSpan.start, 'start');
  const end = resolveFlatOffsetToDomPoint(segments, targetSpan.end, 'end');
  if (!start || !end) return null;
  return { start, end };
}

/**
 * Expand an arbitrary DOM Range inside `articleEl` to full sentence boundaries.
 * Supports single-block and multi-block selections across Chinese and English text.
 */
export function expandRangeToFullSentences(
  articleEl: HTMLElement,
  range: Range
): DomRangePoints | null {
  if (!articleEl.contains(range.startContainer) || !articleEl.contains(range.endContainer)) {
    return null;
  }

  const startSentence = getSentenceRangeAtPoint(
    articleEl,
    range.startContainer,
    range.startOffset,
    'next'
  );
  const endSentence = getSentenceRangeAtPoint(
    articleEl,
    range.endContainer,
    range.endOffset,
    'prev'
  );

  if (!startSentence || !endSentence) return null;
  return {
    start: startSentence.start,
    end: endSentence.end,
  };
}

/**
 * Compare two DOM points in document order:
 * returns < 0 if a is before b, 0 if equal, > 0 if a is after b.
 */
export function compareDomPoints(a: DomPoint, b: DomPoint): number {
  if (a.node === b.node) {
    return a.offset - b.offset;
  }
  const pos = a.node.compareDocumentPosition(b.node);
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

/**
 * Union two DomRangePoints into the minimal range covering both.
 */
export function unionDomRanges(a: DomRangePoints, b: DomRangePoints): DomRangePoints {
  const start = compareDomPoints(a.start, b.start) <= 0 ? a.start : b.start;
  const end = compareDomPoints(a.end, b.end) >= 0 ? a.end : b.end;
  return { start, end };
}

export function domRangePointsEqual(a: DomRangePoints | null, b: DomRangePoints | null): boolean {
  if (!a || !b) return false;
  return (
    a.start.node === b.start.node &&
    a.start.offset === b.start.offset &&
    a.end.node === b.end.node &&
    a.end.offset === b.end.offset
  );
}

function distancePointToRect(px: number, py: number, rect: DOMRect): number {
  const dx = px < rect.left ? rect.left - px : px > rect.right ? px - rect.right : 0;
  const dy = py < rect.top ? rect.top - py : py > rect.bottom ? py - rect.bottom : 0;
  return Math.hypot(dx, dy);
}

function probeCaretPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === 'function') {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      return { node: r.startContainer, offset: r.startOffset };
    }
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) {
      return { node: pos.offsetNode, offset: pos.offset };
    }
  }
  return null;
}

function getSentenceRangeInBlockByCoords(
  blockEl: HTMLElement,
  clientX: number,
  clientY: number
): DomRangePoints | null {
  const { text, segments } = collectBlockTextSegments(blockEl);
  if (segments.length === 0) return null;

  const spans = splitTextIntoSentences(text);
  if (spans.length === 0) return null;

  const blockRect = blockEl.getBoundingClientRect();
  if (clientY < blockRect.top) {
    const first = spans[0];
    const start = resolveFlatOffsetToDomPoint(segments, first.start, 'start');
    const end = resolveFlatOffsetToDomPoint(segments, first.end, 'end');
    return start && end ? { start, end } : null;
  }
  if (clientY > blockRect.bottom) {
    const last = spans[spans.length - 1];
    const start = resolveFlatOffsetToDomPoint(segments, last.start, 'start');
    const end = resolveFlatOffsetToDomPoint(segments, last.end, 'end');
    return start && end ? { start, end } : null;
  }

  let bestRange: DomRangePoints | null = null;
  let bestDist = Infinity;

  for (const span of spans) {
    const start = resolveFlatOffsetToDomPoint(segments, span.start, 'start');
    const end = resolveFlatOffsetToDomPoint(segments, span.end, 'end');
    if (!start || !end) continue;
    try {
      const r = document.createRange();
      r.setStart(start.node, start.offset);
      r.setEnd(end.node, end.offset);
      const rects = r.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (rect.width <= 0 && rect.height <= 0) continue;
        // Weight vertical distance slightly higher than horizontal distance so lines stay stable
        const dx =
          clientX < rect.left
            ? rect.left - clientX
            : clientX > rect.right
              ? clientX - rect.right
              : 0;
        const dy =
          clientY < rect.top
            ? rect.top - clientY
            : clientY > rect.bottom
              ? clientY - rect.bottom
              : 0;
        const score = dy * 2.5 + dx;
        if (score < bestDist) {
          bestDist = score;
          bestRange = { start, end };
          if (score === 0) return bestRange;
        }
      }
    } catch {
      // ignore invalid range
    }
  }

  return bestRange;
}

/**
 * Resolve the full sentence directly beneath viewport coordinates `(clientX, clientY)`.
 * Uses native caret hit-testing first, then falls back cleanly to the closest visible block
 * and sentence rect so dragging across margins or inter-paragraph gaps never stalls.
 */
export function getSentenceRangeAtViewportPoint(
  articleEl: HTMLElement,
  clientX: number,
  clientY: number
): DomRangePoints | null {
  const articleRect = articleEl.getBoundingClientRect();
  if (articleRect.width <= 0 || articleRect.height <= 0) return null;

  const clampedX = Math.max(
    articleRect.left + 4,
    Math.min(articleRect.right - 4, clientX)
  );
  const clampedY = Math.max(
    articleRect.top + 4,
    Math.min(articleRect.bottom - 4, clientY)
  );

  // Fast path: direct caret hit-test on a text node inside articleEl
  const caret = probeCaretPoint(clampedX, clampedY);
  if (
    caret &&
    caret.node.nodeType === Node.TEXT_NODE &&
    articleEl.contains(caret.node)
  ) {
    try {
      const checkRange = document.createRange();
      const textNode = caret.node as Text;
      const len = textNode.data.length;
      if (len > 0) {
        const idx = Math.min(len - 1, Math.max(0, caret.offset));
        checkRange.setStart(textNode, idx);
        checkRange.setEnd(textNode, Math.min(len, idx + 1));
        const charRect = checkRange.getBoundingClientRect();
        if (
          charRect.height > 0 &&
          distancePointToRect(clampedX, clampedY, charRect) <= Math.max(36, charRect.height * 1.6)
        ) {
          const hit = getSentenceRangeAtPoint(articleEl, textNode, caret.offset, 'next');
          if (hit) return hit;
        }
      }
    } catch {
      // Fall through to block/sentence rect scan
    }
  }

  // Fallback path: find the vertically closest block inside articleEl and pick its closest sentence
  const blockNodes = articleEl.querySelectorAll<HTMLElement>('[data-block-idx]');
  let closestBlock: HTMLElement | null = null;
  let closestVertDist = Infinity;

  for (let i = 0; i < blockNodes.length; i++) {
    const el = blockNodes[i];
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (clampedY >= rect.top && clampedY <= rect.bottom) {
      closestBlock = el;
      closestVertDist = 0;
      break;
    }
    const vertDist = clampedY < rect.top ? rect.top - clampedY : clampedY - rect.bottom;
    if (vertDist < closestVertDist) {
      closestVertDist = vertDist;
      closestBlock = el;
    }
  }

  if (closestBlock) {
    const byCoords = getSentenceRangeInBlockByCoords(closestBlock, clampedX, clampedY);
    if (byCoords) return byCoords;
  }

  // Final fallback: if caret hit an element inside articleEl, resolve via that caret
  if (caret && articleEl.contains(caret.node)) {
    return getSentenceRangeAtPoint(articleEl, caret.node, caret.offset, 'next');
  }

  return null;
}


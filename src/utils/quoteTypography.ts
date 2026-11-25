const CURLY_QUOTE_RE = /[\u2018\u2019\u201C\u201D]/;
const HAN_OR_CJK_PUNCT_RE = /[\p{Script=Han}\u3000-\u303F\uFF00-\uFFEF]/u;
const LATIN_ALNUM_RE = /[A-Za-z0-9]/;
const LATIN_WORD_CHAR_RE = /[A-Za-z0-9\u00AD]/;
const OPENING_WRAP_RE = /[\s\u201C\u2018([{<]/;
const CLOSING_PUNCT_RE = /[\s.,!?;:)\]}…—–-]/;

export interface QuoteTypographySegment {
  text: string;
  latin: boolean;
}

export function hasCurlyQuotes(text: string): boolean {
  return CURLY_QUOTE_RE.test(text);
}

/**
 * True when a block contains curly quotes and Latin text with NO Han/CJK punctuation,
 * allowing block-level CSS class `.font-latin-punct` with zero extra span nodes.
 */
export function isPureLatinQuotedBlock(text: string): boolean {
  return CURLY_QUOTE_RE.test(text) && LATIN_ALNUM_RE.test(text) && !HAN_OR_CJK_PUNCT_RE.test(text);
}

function findPrevChar(text: string, idx: number, skipRe: RegExp): string | null {
  for (let j = idx - 1; j >= 0; j--) {
    const ch = text[j];
    if (!skipRe.test(ch)) return ch;
  }
  return null;
}

function findNextChar(text: string, idx: number, skipRe: RegExp): string | null {
  for (let j = idx + 1; j < text.length; j++) {
    const ch = text[j];
    if (!skipRe.test(ch)) return ch;
  }
  return null;
}

/**
 * Split a mixed CJK + Latin string into segments where ONLY English-context
 * curly quotes / apostrophes (and their attached Latin word tokens, so words like
 * "It’s" remain one unbroken DOM text node for native selection & MDict lookup)
 * are marked `latin: true`, while Chinese quotes (“你好”, ‘测试’, 他说“AI”很重要)
 * remain `latin: false` to render with the Chinese font.
 */
export function splitLatinQuoteSegments(text: string): QuoteTypographySegment[] | null {
  if (!text || !CURLY_QUOTE_RE.test(text) || !LATIN_ALNUM_RE.test(text)) {
    return null;
  }
  if (!HAN_OR_CJK_PUNCT_RE.test(text)) {
    return [{ text, latin: true }];
  }

  const latinMask = new Uint8Array(text.length);
  const doubleStack: Array<'latin' | 'cjk'> = [];
  const singleStack: Array<'latin' | 'cjk'> = [];
  let hasAnyLatinQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\u2018' && ch !== '\u2019' && ch !== '\u201C' && ch !== '\u201D') {
      continue;
    }

    const prevRaw = i > 0 ? text[i - 1] : '';
    const nextRaw = i + 1 < text.length ? text[i + 1] : '';

    if (ch === '\u201C') {
      const prev = findPrevChar(text, i, /\s/);
      const next = findNextChar(text, i, OPENING_WRAP_RE);
      const isLatin =
        !(prev && HAN_OR_CJK_PUNCT_RE.test(prev)) && Boolean(next && LATIN_ALNUM_RE.test(next));
      doubleStack.push(isLatin ? 'latin' : 'cjk');
      if (isLatin) {
        latinMask[i] = 1;
        hasAnyLatinQuote = true;
      }
      continue;
    }

    if (ch === '\u201D') {
      let isLatin: boolean;
      if (doubleStack.length > 0) {
        isLatin = doubleStack.pop() === 'latin';
      } else {
        const next = findNextChar(text, i, /\s/);
        const prevMeaningful = findPrevChar(text, i, CLOSING_PUNCT_RE);
        isLatin =
          !(next && HAN_OR_CJK_PUNCT_RE.test(next)) &&
          Boolean(prevMeaningful && LATIN_ALNUM_RE.test(prevMeaningful));
      }
      if (isLatin) {
        latinMask[i] = 1;
        hasAnyLatinQuote = true;
      }
      continue;
    }

    // Intra-word apostrophe / contraction (e.g. It’s, don’t, o’clock, ’90s)
    if (LATIN_WORD_CHAR_RE.test(prevRaw) && LATIN_WORD_CHAR_RE.test(nextRaw)) {
      latinMask[i] = 1;
      hasAnyLatinQuote = true;
      continue;
    }

    if (ch === '\u2018') {
      const prev = findPrevChar(text, i, /\s/);
      const next = findNextChar(text, i, OPENING_WRAP_RE);
      const isLatin =
        !(prev && HAN_OR_CJK_PUNCT_RE.test(prev)) && Boolean(next && LATIN_ALNUM_RE.test(next));
      singleStack.push(isLatin ? 'latin' : 'cjk');
      if (isLatin) {
        latinMask[i] = 1;
        hasAnyLatinQuote = true;
      }
      continue;
    }

    // ch === '\u2019' (could be closing single quote, trailing possessive s’, or leading elision ’90s)
    const isLeadingElision =
      (!prevRaw || /\s/.test(prevRaw) || /[\u201C(\[{—–-]/.test(prevRaw)) &&
      LATIN_ALNUM_RE.test(nextRaw) &&
      singleStack.length === 0;
    if (isLeadingElision) {
      latinMask[i] = 1;
      hasAnyLatinQuote = true;
      continue;
    }

    const isTrailingPossessive =
      LATIN_WORD_CHAR_RE.test(prevRaw) &&
      (!nextRaw || !HAN_OR_CJK_PUNCT_RE.test(nextRaw)) &&
      singleStack[singleStack.length - 1] !== 'cjk';
    if (isTrailingPossessive && singleStack.length === 0) {
      latinMask[i] = 1;
      hasAnyLatinQuote = true;
      continue;
    }

    let isLatin: boolean;
    if (singleStack.length > 0) {
      isLatin = singleStack.pop() === 'latin';
    } else {
      const next = findNextChar(text, i, /\s/);
      const prevMeaningful = findPrevChar(text, i, CLOSING_PUNCT_RE);
      isLatin =
        !(next && HAN_OR_CJK_PUNCT_RE.test(next)) &&
        Boolean(prevMeaningful && LATIN_ALNUM_RE.test(prevMeaningful));
    }
    if (isLatin) {
      latinMask[i] = 1;
      hasAnyLatinQuote = true;
    }
  }

  if (!hasAnyLatinQuote) return null;

  // Expand each Latin quote/apostrophe to cover attached Latin word characters
  // so contractions like "It’s" stay in one unbroken DOM text node.
  for (let i = 0; i < text.length; i++) {
    if (!latinMask[i]) continue;
    let l = i - 1;
    while (l >= 0 && LATIN_WORD_CHAR_RE.test(text[l])) {
      latinMask[l] = 1;
      l--;
    }
    let r = i + 1;
    while (r < text.length && LATIN_WORD_CHAR_RE.test(text[r])) {
      latinMask[r] = 1;
      r++;
    }
  }

  const segments: QuoteTypographySegment[] = [];
  let start = 0;
  let currentFlag = latinMask[0] === 1;
  for (let i = 1; i < text.length; i++) {
    const flag = latinMask[i] === 1;
    if (flag !== currentFlag) {
      segments.push({ text: text.slice(start, i), latin: currentFlag });
      start = i;
      currentFlag = flag;
    }
  }
  segments.push({ text: text.slice(start), latin: currentFlag });
  return segments;
}

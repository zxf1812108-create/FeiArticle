import hyphenEn from 'hyphen/en';

type HyphenateSyncFn = (text: string, options?: { hyphenChar?: string; minWordLength?: number }) => string;

const rawHyphenateSync: HyphenateSyncFn | null =
  typeof hyphenEn?.hyphenateSync === 'function'
    ? hyphenEn.hyphenateSync
    : typeof (hyphenEn as unknown as { default?: { hyphenateSync?: HyphenateSyncFn } })?.default
          ?.hyphenateSync === 'function'
      ? (hyphenEn as unknown as { default: { hyphenateSync: HyphenateSyncFn } }).default
          .hyphenateSync
      : null;

const SOFT_HYPHEN = '\u00AD';
const ENGLISH_WORD_RE = /[A-Za-z]{5,}/g;
const HAS_LONG_ENGLISH_WORD_RE = /[A-Za-z]{5,}/;

// Bounded per-word cache so large English documents hyphenate near-instantaneously
const WORD_CACHE_LIMIT = 8000;
const wordCache = new Map<string, string>();

/**
 * Insert invisible TeX/Liang soft hyphens (\u00AD) at valid English syllable break points
 * so browsers and Android WebView break long line-ending words with a visible '-' hyphen
 * like printed newspapers and books, regardless of OS locale or missing system hyphenation dicts.
 */
export function hyphenateEnglishWords(text: string): string {
  if (!text || !rawHyphenateSync || !HAS_LONG_ENGLISH_WORD_RE.test(text)) {
    return text;
  }

  return text.replace(ENGLISH_WORD_RE, (word) => {
    // Keep ALL-CAPS acronyms (e.g. UNESCO, HTTPS) intact
    if (word === word.toUpperCase()) {
      return word;
    }

    const cached = wordCache.get(word);
    if (cached !== undefined) {
      return cached;
    }

    const hyphenated = rawHyphenateSync(word, {
      hyphenChar: SOFT_HYPHEN,
      minWordLength: 5,
    });

    if (wordCache.size >= WORD_CACHE_LIMIT) {
      wordCache.clear();
    }
    wordCache.set(word, hyphenated);
    return hyphenated;
  });
}

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ArrowLeft, BookA, X } from 'lucide-react';
import { MdictDictionarySummary, MdictLookupResult } from '../types';
import { sanitizeMdictCss } from '../utils/mdict';
import { stripDictExt } from '../utils/mdictStorage';
import { hasCurlyQuotes, splitLatinQuoteSegments } from '../utils/quoteTypography';

export interface MdictLookupPopupHandle {
  pageUp: () => void;
  pageDown: () => void;
  autoExpandIfOverflowing: () => void;
  getScrollTop: () => number;
}

interface MdictLookupPopupProps {
  queryWord: string;
  placement: 'top' | 'bottom';
  fontSize?: number;
  loading: boolean;
  result: MdictLookupResult | null;
  matchCount: number;
  error: string | null;
  suggestions: string[];
  canGoBack: boolean;
  restoreScrollTop?: number | null;
  dictionaries: MdictDictionarySummary[];
  activeDictId: string | null;
  onCycleDict: () => void;
  onLookupWord: (word: string) => void;
  onLiveQueryChange: (raw: string) => void;
  onSelectSuggestion: (word: string) => void;
  onGoBack: () => void;
  onRestoreScrollTopDone?: () => void;
  onClose: () => void;
}

const UNSAFE_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'textarea',
  'select',
  'meta',
  'base',
  'link',
];

const BACK_TO_TOP_RE =
  /^[\s\[\]【】()（）<>《》↑▲△⇧⬆⬆︎🔝·•\-—]*回\s*到\s*顶\s*部[\s\[\]【】()（）<>《》↑▲△⇧⬆⬆︎🔝·•\-—]*$/;

const EMPTY_WRAPPER_TAGS = new Set([
  'DIV',
  'P',
  'SPAN',
  'CENTER',
  'FONT',
  'B',
  'I',
  'U',
  'SMALL',
  'STRONG',
  'EM',
  'A',
  'LI',
]);

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractSafeAnchorFromJs(code: string): string | null {
  const patterns = [
    /getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)/i,
    /querySelector\s*\(\s*['"]#([^'"\s]+)['"]\s*\)/i,
    /(?:location\.)?hash\s*=\s*['"]#?([^'"\s]+)['"]/i,
    /scrollToElement\s*\(\s*['"]#?([^'"]+)['"]\s*\)/i,
  ];
  for (const re of patterns) {
    const m = code.match(re);
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  return null;
}

function isNodeOnlyWhitespaceOrBr(node: Node | null): boolean {
  if (!node) return true;
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue || '').trim().length === 0;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return (node as Element).tagName === 'BR';
  }
  return true;
}

function hasOnlyTrailingNoiseAfter(node: Node): boolean {
  let cur: Node | null = node.nextSibling;
  while (cur) {
    if (!isNodeOnlyWhitespaceOrBr(cur)) return false;
    cur = cur.nextSibling;
  }
  return true;
}

function removeBackToTopElements(body: HTMLElement): void {
  const fullText = body.textContent || '';
  if (!fullText.includes('回到顶部') && !/回\s*到\s*顶\s*部/.test(fullText)) {
    return;
  }
  // Never wipe out an entry if the entire entry itself is only "回到顶部"
  if (BACK_TO_TOP_RE.test(fullText)) {
    return;
  }

  let removedAny = false;

  const removeNodeAndCleanup = (node: Node) => {
    const parent = node.parentElement;
    if (!parent) return;

    const atTrailingEnd = hasOnlyTrailingNoiseAfter(node);
    const prevSibling = node.previousSibling;
    const nextSibling = node.nextSibling;

    node.parentNode?.removeChild(node);
    removedAny = true;

    if (atTrailingEnd) {
      // Trim trailing whitespace and <br> immediately before the removed back-to-top control
      let cursor: Node | null = parent.lastChild;
      while (cursor && isNodeOnlyWhitespaceOrBr(cursor)) {
        const prev = cursor.previousSibling;
        parent.removeChild(cursor);
        cursor = prev;
      }
    } else if (
      prevSibling &&
      prevSibling.nodeType === Node.ELEMENT_NODE &&
      (prevSibling as Element).tagName === 'BR' &&
      nextSibling &&
      nextSibling.nodeType === Node.ELEMENT_NODE &&
      (nextSibling as Element).tagName === 'BR'
    ) {
      parent.removeChild(prevSibling);
    }

    // Remove ancestor wrappers that became completely empty
    let ancestor: HTMLElement | null = parent;
    while (ancestor && ancestor !== body) {
      if (
        EMPTY_WRAPPER_TAGS.has(ancestor.tagName) &&
        (ancestor.textContent || '').trim() === '' &&
        !ancestor.querySelector('img, svg, hr, table')
      ) {
        const nextParent: HTMLElement | null = ancestor.parentElement;
        const ancestorAtEnd = hasOnlyTrailingNoiseAfter(ancestor);
        ancestor.remove();
        if (ancestorAtEnd && nextParent) {
          let cursor: Node | null = nextParent.lastChild;
          while (cursor && isNodeOnlyWhitespaceOrBr(cursor)) {
            const prev = cursor.previousSibling;
            nextParent.removeChild(cursor);
            cursor = prev;
          }
        }
        ancestor = nextParent;
      } else {
        break;
      }
    }
  };

  // Pass 1: Remove elements (deepest-first) whose sole text is "回到顶部"
  const candidates = Array.from(
    body.querySelectorAll(
      'a, button, span, b, i, u, font, small, strong, em, p, div, center, li, td'
    )
  ).reverse();

  for (const el of candidates) {
    if (!el.isConnected) continue;
    if (BACK_TO_TOP_RE.test(el.textContent || '')) {
      removeNodeAndCleanup(el);
    }
  }

  // Pass 2: Remove standalone bare text nodes matching "回到顶部"
  const textWalker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const matchingTextNodes: Text[] = [];
  let textNode = textWalker.nextNode();
  while (textNode) {
    if (BACK_TO_TOP_RE.test(textNode.nodeValue || '')) {
      matchingTextNodes.push(textNode as Text);
    }
    textNode = textWalker.nextNode();
  }
  for (const tn of matchingTextNodes) {
    if (!tn.isConnected) continue;
    const remainingText = (body.textContent || '').replace(tn.nodeValue || '', '').trim();
    if (remainingText.length > 0) {
      removeNodeAndCleanup(tn);
    }
  }

  if (removedAny) {
    let cursor: Node | null = body.lastChild;
    while (cursor && isNodeOnlyWhitespaceOrBr(cursor)) {
      const prev = cursor.previousSibling;
      body.removeChild(cursor);
      cursor = prev;
    }
  }
}

function findAnchorTargetInScope(scope: ParentNode, rawAnchor: string): HTMLElement | null {
  const cleaned = rawAnchor.replace(/^#+/, '').trim();
  if (!cleaned) return null;
  const decoded = safeDecodeURIComponent(cleaned);
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>('[id], [name]'));

  for (const el of candidates) {
    const id = el.getAttribute('id');
    if (id && (id === cleaned || id === decoded)) return el;
  }
  for (const el of candidates) {
    const name = el.getAttribute('name');
    if (name && (name === cleaned || name === decoded)) return el;
  }

  const lowerCleaned = cleaned.toLowerCase();
  const lowerDecoded = decoded.toLowerCase();
  for (const el of candidates) {
    const id = (el.getAttribute('id') || '').toLowerCase();
    const name = (el.getAttribute('name') || '').toLowerCase();
    if (
      (id && (id === lowerCleaned || id === lowerDecoded)) ||
      (name && (name === lowerCleaned || name === lowerDecoded))
    ) {
      return el;
    }
  }
  return null;
}

function getScrollableTargetRect(targetEl: HTMLElement): DOMRect | null {
  const r = targetEl.getBoundingClientRect();
  if (r.top !== 0 || r.bottom !== 0 || r.height > 0 || r.width > 0) {
    return r;
  }
  let probe: Element | null = targetEl.nextElementSibling;
  while (probe) {
    const pr = probe.getBoundingClientRect();
    if (pr.top !== 0 || pr.bottom !== 0 || pr.height > 0 || pr.width > 0) {
      return pr;
    }
    probe = probe.nextElementSibling;
  }
  if (targetEl.parentElement) {
    return targetEl.parentElement.getBoundingClientRect();
  }
  return null;
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  lsaquo: '‹',
  rsaquo: '›',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  plusmn: '±',
};

const RESIDUAL_ENTITY_RE =
  /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,10});/g;

function decodeResidualEntitiesInText(text: string): string {
  if (!text.includes('&')) return text;
  let current = text;
  // Resolve double/triple-encoded entities (e.g. &amp;lt; -> &lt; -> <) safely in text nodes
  for (let pass = 0; pass < 3; pass++) {
    if (!current.includes('&')) break;
    let next = current.replace(RESIDUAL_ENTITY_RE, (full, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const cp = parseInt(body.slice(2), 16);
        if (
          Number.isFinite(cp) &&
          cp >= 0x20 &&
          cp <= 0x10ffff &&
          !(cp >= 0xd800 && cp <= 0xdfff)
        ) {
          return String.fromCodePoint(cp);
        }
        return full;
      }
      if (body.startsWith('#')) {
        const cp = parseInt(body.slice(1), 10);
        if (
          Number.isFinite(cp) &&
          cp >= 0x20 &&
          cp <= 0x10ffff &&
          !(cp >= 0xd800 && cp <= 0xdfff)
        ) {
          return String.fromCodePoint(cp);
        }
        return full;
      }
      const mapped = NAMED_HTML_ENTITIES[body.toLowerCase()];
      return mapped !== undefined ? mapped : full;
    });
    // Also repair malformed semicolon-less &lt / &gt (e.g. &lt名&gt) when not followed by alphanumerics
    next = next.replace(/&(lt|gt)(?=[^a-zA-Z0-9;]|$)/gi, (_, name: string) =>
      name.toLowerCase() === 'lt' ? '<' : '>'
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

function decodeResidualEntitiesInBody(body: HTMLElement): void {
  if (!(body.textContent || '').includes('&')) return;
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parentTag = (node.parentElement?.tagName || '').toUpperCase();
    if (parentTag !== 'STYLE' && parentTag !== 'SCRIPT') {
      const raw = node.nodeValue || '';
      if (raw.includes('&')) {
        const decoded = decodeResidualEntitiesInText(raw);
        if (decoded !== raw) {
          node.nodeValue = decoded;
        }
      }
    }
    node = walker.nextNode();
  }
}

function sanitizeMdictEntryHtml(rawHtml: string): string {
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  for (const tag of UNSAFE_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  }

  doc.querySelectorAll('style').forEach((styleEl) => {
    styleEl.textContent = sanitizeMdictCss(styleEl.textContent || '');
  });

  doc.querySelectorAll('img').forEach((img) => {
    const src = (img.getAttribute('src') || '').trim();
    if (!src.startsWith('data:image/')) {
      img.remove();
    }
  });

  doc.querySelectorAll('*').forEach((el) => {
    if (el.tagName === 'FONT') {
      el.removeAttribute('size');
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim();
      if (name.startsWith('on')) {
        if (name === 'onclick' && !el.getAttribute('data-mdx-anchor')) {
          const safeAnchor = extractSafeAnchorFromJs(val);
          if (safeAnchor) {
            el.setAttribute('data-mdx-anchor', safeAnchor);
          }
        }
        el.removeAttribute(attr.name);
        continue;
      }
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^(?:javascript|vbscript):/i.test(val)
      ) {
        if (name === 'href' && !el.getAttribute('data-mdx-anchor')) {
          const safeAnchor = extractSafeAnchorFromJs(val);
          if (safeAnchor) {
            el.setAttribute('data-mdx-anchor', safeAnchor);
          }
        }
        el.removeAttribute(attr.name);
      }
      if (name === 'style') {
        if (/expression\s*\(|javascript:/i.test(val)) {
          el.removeAttribute(attr.name);
        } else {
          // Strip inline font-size declarations so every element uses the unified popup font size
          const cleanedStyle = val.replace(/(^|;)\s*font-size\s*:[^;]*(;|$)/gi, '$1').trim();
          if (cleanedStyle) {
            el.setAttribute('style', cleanedStyle);
          } else {
            el.removeAttribute('style');
          }
        }
      }
    }
  });

  decodeResidualEntitiesInBody(doc.body);
  applyLatinQuoteTypographyInBody(doc.body);
  removeBackToTopElements(doc.body);

  return doc.body.innerHTML;
}

function applyLatinQuoteTypographyInBody(body: HTMLElement): void {
  if (!hasCurlyQuotes(body.textContent || '')) return;
  const textNodes: Text[] = [];
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parentTag = (node.parentElement?.tagName || '').toUpperCase();
    if (
      parentTag !== 'STYLE' &&
      parentTag !== 'SCRIPT' &&
      parentTag !== 'CODE' &&
      parentTag !== 'PRE'
    ) {
      const raw = node.nodeValue || '';
      if (hasCurlyQuotes(raw)) {
        textNodes.push(node as Text);
      }
    }
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const raw = textNode.nodeValue || '';
    const segments = splitLatinQuoteSegments(raw);
    if (!segments) continue;
    const frag = body.ownerDocument.createDocumentFragment();
    for (const seg of segments) {
      if (seg.latin) {
        const span = body.ownerDocument.createElement('span');
        span.className = 'fei-latin-punct';
        span.textContent = seg.text;
        frag.appendChild(span);
      } else {
        frag.appendChild(body.ownerDocument.createTextNode(seg.text));
      }
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

interface PopupVisualLine {
  top: number;
  bottom: number;
}

/**
 * Collect rendered visual lines inside the dictionary popup (including open Shadow DOM content),
 * returning coordinates in scroll-content space (relative to scrollEl.scrollTop = 0).
 */
function collectPopupVisualLines(
  scrollEl: HTMLElement,
  bodyContentEl: HTMLElement,
  shadowRoot: ShadowRoot | null
): PopupVisualLine[] {
  const rootNode: Node =
    (shadowRoot?.querySelector('.mdx-surface') as Node | null) || shadowRoot || bodyContentEl;
  const containerRect = scrollEl.getBoundingClientRect();
  const baseOffset = scrollEl.scrollTop - containerRect.top;

  const rawRects: PopupVisualLine[] = [];
  const range = document.createRange();

  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parentTag = (node.parentElement?.tagName || '').toUpperCase();
    if (parentTag !== 'STYLE' && parentTag !== 'SCRIPT') {
      const val = node.nodeValue || '';
      if (val.trim().length > 0) {
        range.selectNodeContents(node);
        const clientRects = range.getClientRects();
        for (let i = 0; i < clientRects.length; i++) {
          const r = clientRects[i];
          if (r.height > 1 && r.width > 0) {
            rawRects.push({
              top: r.top + baseOffset,
              bottom: r.bottom + baseOffset,
            });
          }
        }
      }
    }
    node = walker.nextNode();
  }

  // Also include images & horizontal rules so media blocks are never sliced across edges
  const queryContainer =
    (shadowRoot?.querySelector('.mdx-surface') as ParentNode | null) || shadowRoot || bodyContentEl;
  queryContainer.querySelectorAll('img, hr').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height > 1 && r.width > 0) {
      rawRects.push({
        top: r.top + baseOffset,
        bottom: r.bottom + baseOffset,
      });
    }
  });

  if (rawRects.length === 0) return [];

  rawRects.sort((a, b) => a.top - b.top);

  const merged: PopupVisualLine[] = [rawRects[0]];
  for (let i = 1; i < rawRects.length; i++) {
    const curr = rawRects[i];
    const last = merged[merged.length - 1];
    const overlap = Math.min(last.bottom, curr.bottom) - Math.max(last.top, curr.top);
    const minHeight = Math.min(last.bottom - last.top, curr.bottom - curr.top);
    if (overlap > minHeight * 0.4) {
      last.top = Math.min(last.top, curr.top);
      last.bottom = Math.max(last.bottom, curr.bottom);
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

const MdictShadowDefinition: React.FC<{
  htmlDefinitions: string[];
  dictCssText?: string;
  fontSize: number;
  currentWords: string[];
  onLookupWord: (word: string, anchorId?: string) => void;
  onJumpToAnchor: (anchorId: string, sourceEntry?: Element | null) => void;
  onShadowReady?: (shadow: ShadowRoot | null) => void;
  onContentRendered?: () => void;
}> = ({
  htmlDefinitions,
  dictCssText,
  fontSize,
  currentWords,
  onLookupWord,
  onJumpToAnchor,
  onShadowReady,
  onContentRendered,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const currentWordsRef = useRef(currentWords);
  currentWordsRef.current = currentWords;
  const onLookupWordRef = useRef(onLookupWord);
  onLookupWordRef.current = onLookupWord;
  const onJumpToAnchorRef = useRef(onJumpToAnchor);
  onJumpToAnchorRef.current = onJumpToAnchor;
  const onShadowReadyRef = useRef(onShadowReady);
  onShadowReadyRef.current = onShadowReady;
  const onContentRenderedRef = useRef(onContentRendered);
  onContentRenderedRef.current = onContentRendered;

  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setIsDark(root.classList.contains('dark'));
    syncTheme();
    const obs = new MutationObserver(syncTheme);
    obs.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const sanitizedEntries = useMemo(
    () => htmlDefinitions.map((raw) => sanitizeMdictEntryHtml(raw)).filter(Boolean),
    [htmlDefinitions]
  );

  const safeDictCss = useMemo(
    () => (dictCssText ? sanitizeMdictCss(dictCssText) : ''),
    [dictCssText]
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!shadowRef.current) {
      shadowRef.current = host.attachShadow({ mode: 'open' });
      onShadowReadyRef.current?.(shadowRef.current);
      shadowRef.current.addEventListener('contextmenu', (evt) => {
        evt.preventDefault();
      });
      shadowRef.current.addEventListener('click', (evt) => {
        const rawTarget = evt.target as Node | null;
        const targetEl =
          rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement ?? null;
        if (!targetEl) return;

        const anchor = targetEl.closest('a[href], [data-mdx-anchor]') as HTMLElement | null;
        if (!anchor) return;

        const sourceEntry = anchor.closest('.mdx-entry');
        const dataAnchor = (anchor.getAttribute('data-mdx-anchor') || '').trim();
        if (dataAnchor) {
          evt.preventDefault();
          evt.stopPropagation();
          onJumpToAnchorRef.current(dataAnchor, sourceEntry);
          return;
        }

        const href = (anchor.getAttribute('href') || '').trim();
        if (!href) return;

        // Direct in-entry hash anchor (e.g. href="#pos_n" or href="about:blank#pos_n")
        if (href.startsWith('#') || /^about:blank#/i.test(href)) {
          evt.preventDefault();
          evt.stopPropagation();
          const hashPart = href.slice(href.indexOf('#') + 1).trim();
          onJumpToAnchorRef.current(hashPart, sourceEntry);
          return;
        }

        // MDict entry:// or bword:// link (in-entry anchor, same-word anchor, or cross-word lookup)
        const entryMatch = href.match(/^(?:entry|bword):\/\/(.*)$/i);
        if (entryMatch) {
          evt.preventDefault();
          evt.stopPropagation();
          const rawPayload = entryMatch[1] || '';
          const payload = rawPayload.includes('#') ? rawPayload : safeDecodeURIComponent(rawPayload);
          const hashIdx = payload.indexOf('#');
          const rawWordPart = hashIdx >= 0 ? payload.slice(0, hashIdx) : payload;
          const rawAnchorPart = hashIdx >= 0 ? payload.slice(hashIdx + 1) : '';
          const nextWord = safeDecodeURIComponent(rawWordPart).trim();
          const anchorId = rawAnchorPart.trim();

          const isSameWord =
            !nextWord ||
            currentWordsRef.current.some((w) => w && w.toLowerCase() === nextWord.toLowerCase());

          if (anchorId && isSameWord) {
            onJumpToAnchorRef.current(anchorId, sourceEntry);
            return;
          }

          if (nextWord) {
            onLookupWordRef.current(nextWord, anchorId || undefined);
          }
        }
      });
    }

    const shadow = shadowRef.current;
    const hasCustomCss = Boolean(safeDictCss.trim());
    const baseStyle = `
      :host {
        display: block;
        color: var(--fei-text-primary, #000000);
        font-family: var(--font-doc-body, "Noto Sans SC", "Source Han Sans SC", "Source Han Sans CN", sans-serif);
        font-size: ${fontSize}px;
        line-height: 1.56;
        word-break: break-word;
        -webkit-touch-callout: none;
      }
      .fei-latin-punct {
        font-family: "FeiLatinPunct", var(--font-doc-body, "Noto Sans SC", "Source Han Sans SC", "Source Han Sans CN", sans-serif);
      }
      *, *::before, *::after {
        box-sizing: border-box;
        max-width: 100%;
        -webkit-touch-callout: none;
      }
      .mdx-surface, .mdx-entry {
        font-size: ${fontSize}px;
      }
      .mdx-entry + .mdx-entry {
        margin-top: 9px;
        padding-top: 9px;
        border-top: 1px solid var(--fei-border, #C4C4C4);
      }
      p { margin: 0.25em 0; }
      ul, ol { margin: 0.3em 0; padding-left: 1.3em; }
      li { margin: 0.12em 0; }
      a[href^="entry://"], a[href^="bword://"], a[href^="#"], [data-mdx-anchor] {
        color: inherit;
        text-decoration: underline;
        text-underline-offset: 2px;
        cursor: pointer;
      }
      a:not([href^="entry://"]):not([href^="bword://"]):not([href^="#"]):not([data-mdx-anchor]) {
        color: inherit;
        text-decoration: none;
        cursor: default;
      }
      img { max-width: 100%; height: auto; }
    `;

    // Enforce one uniform font size across every element in the definition body
    const fontScaleOverride = `
      .mdx-surface,
      .mdx-surface *,
      .mdx-surface *::before,
      .mdx-surface *::after {
        font-size: ${fontSize}px !important;
        line-height: 1.56 !important;
      }
    `;

    const themeAdaptStyle = hasCustomCss
      ? isDark
        ? `
          .mdx-surface {
            background-color: #ffffff;
            color: #222222;
            padding: 4px 6px;
            border-radius: 6px;
            filter: invert(0.85) hue-rotate(180deg);
          }
          .mdx-surface img {
            filter: invert(1) hue-rotate(180deg);
          }
        `
        : `
          .mdx-surface {
            background-color: var(--fei-popup-bg, #ffffff);
            color: var(--fei-text-primary, #000000);
          }
        `
      : '';

    const entriesHtml = sanitizedEntries
      .map((html) => `<div class="mdx-entry">${html}</div>`)
      .join('');

    shadow.replaceChildren();

    const baseStyleEl = document.createElement('style');
    baseStyleEl.textContent = baseStyle;
    shadow.appendChild(baseStyleEl);

    if (hasCustomCss) {
      const dictStyleEl = document.createElement('style');
      dictStyleEl.textContent = safeDictCss;
      shadow.appendChild(dictStyleEl);
    }

    const overrideStyleEl = document.createElement('style');
    overrideStyleEl.textContent = `${fontScaleOverride}${themeAdaptStyle}`;
    shadow.appendChild(overrideStyleEl);

    const surfaceEl = document.createElement('div');
    surfaceEl.className = 'mdx-surface';
    surfaceEl.innerHTML = entriesHtml;
    shadow.appendChild(surfaceEl);

    onContentRenderedRef.current?.();
  }, [sanitizedEntries, safeDictCss, isDark, fontSize]);

  useEffect(() => {
    return () => {
      onShadowReadyRef.current?.(null);
    };
  }, []);

  return <div ref={hostRef} />;
};

export const MdictLookupPopup = forwardRef<MdictLookupPopupHandle, MdictLookupPopupProps>(
  function MdictLookupPopup(
    {
      queryWord,
      placement,
      fontSize = 16,
      loading,
      result,
      matchCount,
      error,
      suggestions,
      canGoBack,
      restoreScrollTop = null,
      dictionaries,
      activeDictId,
      onCycleDict,
      onLookupWord,
      onLiveQueryChange,
      onSelectSuggestion,
      onGoBack,
      onRestoreScrollTopDone,
      onClose,
    },
    ref
  ) {
    const bodyScrollRef = useRef<HTMLDivElement>(null);
    const bodyContentRef = useRef<HTMLDivElement>(null);
    const shadowRootRef = useRef<ShadowRoot | null>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
    const clipRafRef = useRef<number | null>(null);
    const autoExpandRafRef = useRef<number | null>(null);
    const liveSearchTimerRef = useRef<number | null>(null);
    const pendingAnchorRef = useRef<string | null>(null);
    const isInputFocusedRef = useRef(false);
    const stableViewportHeightRef = useRef<number>(
      typeof window !== 'undefined' ? window.innerHeight : 800
    );

    const [inputText, setInputText] = useState(queryWord);
    const [keyboardInsetPx, setKeyboardInsetPx] = useState(0);
    const [isExpanded, setIsExpanded] = useState(false);
    const isExpandedRef = useRef(false);
    isExpandedRef.current = isExpanded;
    const loadingRef = useRef(loading);
    loadingRef.current = loading;
    const manualExpandToggledRef = useRef(false);
    const pendingAutoExpandCheckRef = useRef(false);
    const [hasToggledExpand, setHasToggledExpand] = useState(false);
    const [topClipPx, setTopClipPx] = useState(0);
    const [bottomClipPx, setBottomClipPx] = useState(0);
    const topClipPxRef = useRef(0);
    const bottomClipPxRef = useRef(0);
    const bottomSpacerRef = useRef<HTMLDivElement>(null);
    const bottomSpacerHeightRef = useRef(0);

    // Sync editable input when queryWord changes externally (selection, cross-ref click, back, suggestion tap)
    useEffect(() => {
      if (!isInputFocusedRef.current) {
        setInputText(queryWord);
      } else if (searchInputRef.current && searchInputRef.current.value.trim() !== queryWord.trim()) {
        // External navigation (e.g. clicking suggestion/back while input still focused)
        setInputText(queryWord);
      }
    }, [queryWord]);

    // Lift bottom-docked/expanded popup cleanly above mobile soft keyboard via visualViewport
    useEffect(() => {
      if (typeof window === 'undefined') return;
      const updateViewport = () => {
        const vv = window.visualViewport;
        const innerH = window.innerHeight;
        if (!vv) {
          if (!isInputFocusedRef.current) {
            stableViewportHeightRef.current = innerH;
          }
          setKeyboardInsetPx(0);
          return;
        }
        const inset = Math.max(0, Math.round(innerH - (vv.height + vv.offsetTop)));
        const nextInset = inset >= 80 ? inset : 0;
        if (nextInset === 0) {
          stableViewportHeightRef.current = Math.max(innerH, Math.round(vv.height));
        }
        setKeyboardInsetPx((prev) => (prev === nextInset ? prev : nextInset));
      };
      updateViewport();
      const vv = window.visualViewport;
      vv?.addEventListener('resize', updateViewport);
      vv?.addEventListener('scroll', updateViewport);
      window.addEventListener('resize', updateViewport);
      return () => {
        vv?.removeEventListener('resize', updateViewport);
        vv?.removeEventListener('scroll', updateViewport);
        window.removeEventListener('resize', updateViewport);
      };
    }, []);

    useEffect(() => {
      return () => {
        if (liveSearchTimerRef.current !== null) {
          window.clearTimeout(liveSearchTimerRef.current);
        }
      };
    }, []);

    const setSpacerHeightSync = useCallback((px: number) => {
      const clamped = Math.max(0, Math.round(px));
      if (bottomSpacerHeightRef.current === clamped) return;
      bottomSpacerHeightRef.current = clamped;
      if (bottomSpacerRef.current) {
        bottomSpacerRef.current.style.height = `${clamped}px`;
      }
    }, []);

    const getNaturalMaxScroll = useCallback((el: HTMLElement): number => {
      const currentSpacer = bottomSpacerHeightRef.current;
      const naturalScrollHeight = Math.max(el.clientHeight, el.scrollHeight - currentSpacer);
      return Math.max(0, naturalScrollHeight - el.clientHeight);
    }, []);

    // Uniform definition text size, slightly smaller than the current document font size
    const popupFontSize = Math.max(12, Math.round(fontSize - 2));

    const displayedDict =
      (result && dictionaries.find((d) => d.id === result.dictId)) ||
      dictionaries.find((d) => d.id === activeDictId) ||
      dictionaries[0] ||
      null;
    const displayedDictName = displayedDict
      ? stripDictExt(displayedDict.fileName) || displayedDict.title
      : result?.dictTitle || '';

    const updatePopupEdgeClips = useCallback(() => {
      const el = bodyScrollRef.current;
      const contentEl = bodyContentRef.current;
      if (!el || !contentEl) {
        topClipPxRef.current = 0;
        bottomClipPxRef.current = 0;
        setTopClipPx((prev) => (prev === 0 ? prev : 0));
        setBottomClipPx((prev) => (prev === 0 ? prev : 0));
        setSpacerHeightSync(0);
        return;
      }

      const viewHeight = el.clientHeight;
      if (viewHeight <= 0) return;

      const lines = collectPopupVisualLines(el, contentEl, shadowRootRef.current);
      if (lines.length === 0) {
        topClipPxRef.current = 0;
        bottomClipPxRef.current = 0;
        setTopClipPx((prev) => (prev === 0 ? prev : 0));
        setBottomClipPx((prev) => (prev === 0 ? prev : 0));
        setSpacerHeightSync(0);
        return;
      }

      const lastLineBottom = lines[lines.length - 1].bottom;
      const overflows = lastLineBottom > viewHeight - 1;

      if (!overflows) {
        setSpacerHeightSync(0);
        topClipPxRef.current = 0;
        bottomClipPxRef.current = 0;
        setTopClipPx((prev) => (prev === 0 ? prev : 0));
        setBottomClipPx((prev) => (prev === 0 ? prev : 0));
        return;
      }

      // Never retain more bottom spacer than the current paged scroll position actually requires
      if (bottomSpacerHeightRef.current > 0) {
        const naturalMax = getNaturalMaxScroll(el);
        const needed = Math.max(0, Math.ceil(el.scrollTop - naturalMax));
        if (needed < bottomSpacerHeightRef.current) {
          setSpacerHeightSync(needed);
        }
      }

      const viewTop = el.scrollTop;
      const rawViewBottom = viewTop + viewHeight;

      // Mask any partially clipped line at the top edge
      let nextTop = 0;
      if (viewTop > 1.5) {
        const topCutIdx = lines.findIndex(
          (line) => line.top < viewTop - 0.5 && line.bottom > viewTop + 0.5
        );
        if (topCutIdx !== -1) {
          const topCutLine = lines[topCutIdx];
          if (topCutLine.bottom < rawViewBottom - 4) {
            const nextLineTop =
              topCutIdx + 1 < lines.length ? lines[topCutIdx + 1].top : rawViewBottom;
            const safeTopCutY = Math.min(nextLineTop - 0.5, topCutLine.bottom + 1);
            nextTop = Math.max(0, Math.min(72, Math.ceil(safeTopCutY - viewTop)));
          }
        }
      }

      // Mask any partially clipped line at the bottom edge
      let nextBottom = 0;
      if (lastLineBottom > rawViewBottom + 0.5) {
        const bottomCutIdx = lines.findIndex(
          (line) => line.top < rawViewBottom - 0.5 && line.bottom > rawViewBottom + 0.5
        );
        if (bottomCutIdx !== -1) {
          const bottomCutLine = lines[bottomCutIdx];
          if (bottomCutLine.top > viewTop + nextTop + 4) {
            const prevLineBottom =
              bottomCutIdx > 0 ? lines[bottomCutIdx - 1].bottom : viewTop;
            const safeBottomCutY = Math.max(prevLineBottom + 0.5, bottomCutLine.top - 1);
            nextBottom = Math.max(0, Math.min(72, Math.ceil(rawViewBottom - safeBottomCutY)));
          }
        }
      }

      topClipPxRef.current = nextTop;
      bottomClipPxRef.current = nextBottom;
      setTopClipPx((prev) => (prev === nextTop ? prev : nextTop));
      setBottomClipPx((prev) => (prev === nextBottom ? prev : nextBottom));
    }, [getNaturalMaxScroll, setSpacerHeightSync]);

    const scheduleEdgeClipUpdate = useCallback(() => {
      if (clipRafRef.current !== null) {
        window.cancelAnimationFrame(clipRafRef.current);
      }
      clipRafRef.current = window.requestAnimationFrame(() => {
        clipRafRef.current = null;
        updatePopupEdgeClips();
      });
    }, [updatePopupEdgeClips]);

    const handleBodyScroll = useCallback(() => {
      const el = bodyScrollRef.current;
      if (el && bottomSpacerHeightRef.current > 0) {
        const naturalMax = getNaturalMaxScroll(el);
        const neededForCurrentPos = Math.max(0, Math.ceil(el.scrollTop - naturalMax));
        if (neededForCurrentPos < bottomSpacerHeightRef.current) {
          setSpacerHeightSync(neededForCurrentPos);
        }
      }
      scheduleEdgeClipUpdate();
    }, [getNaturalMaxScroll, setSpacerHeightSync, scheduleEdgeClipUpdate]);

    const runOverflowAutoExpandCheck = useCallback(() => {
      if (isExpandedRef.current || manualExpandToggledRef.current || loadingRef.current) {
        pendingAutoExpandCheckRef.current = false;
        return;
      }
      const el = bodyScrollRef.current;
      const contentEl = bodyContentRef.current;
      if (!el || !contentEl) return;

      const viewHeight = el.clientHeight;
      if (viewHeight <= 0) return;

      // Measure against standard compact body height so mobile soft-keyboard shrinkage
      // never falsely triggers auto-expand for a short definition.
      const standardCompactOuter = Math.min(stableViewportHeightRef.current * 0.4, 340);
      const headerH = headerRef.current?.offsetHeight || 44;
      const standardCompactBodyHeight = Math.max(80, standardCompactOuter - headerH - 12);
      const effectiveCompactHeight = Math.max(viewHeight, standardCompactBodyHeight);

      const lines = collectPopupVisualLines(el, contentEl, shadowRootRef.current);
      const style = window.getComputedStyle(el);
      const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const contentNaturalHeight = contentEl.getBoundingClientRect().height + padY;

      // Shadow DOM content not painted yet — keep pending so onContentRendered triggers the check
      if (lines.length === 0 && contentNaturalHeight <= padY + 1) {
        return;
      }

      pendingAutoExpandCheckRef.current = false;
      const overflowsByLines =
        lines.length > 0 && lines[lines.length - 1].bottom > effectiveCompactHeight + 2;
      const overflowsByHeight = contentNaturalHeight > effectiveCompactHeight + 6;
      if (overflowsByLines || overflowsByHeight) {
        setHasToggledExpand(true);
        setIsExpanded(true);
      }
    }, []);

    const scheduleAutoExpandCheck = useCallback(() => {
      if (autoExpandRafRef.current !== null) {
        window.cancelAnimationFrame(autoExpandRafRef.current);
      }
      autoExpandRafRef.current = window.requestAnimationFrame(() => {
        autoExpandRafRef.current = null;
        runOverflowAutoExpandCheck();
      });
    }, [runOverflowAutoExpandCheck]);

    const autoExpandIfOverflowing = useCallback(() => {
      if (isExpandedRef.current || manualExpandToggledRef.current) return;
      pendingAutoExpandCheckRef.current = true;
      scheduleAutoExpandCheck();
    }, [scheduleAutoExpandCheck]);

    const scrollToAnchor = useCallback(
      (anchorId: string, sourceEntry?: Element | null): boolean => {
        const scrollEl = bodyScrollRef.current;
        const shadow = shadowRootRef.current;
        if (!scrollEl || !shadow) return false;

        const cleaned = anchorId.replace(/^#+/, '').trim();
        if (!cleaned) {
          setSpacerHeightSync(0);
          scrollEl.scrollTop = 0;
          updatePopupEdgeClips();
          return true;
        }

        const targetEl =
          (sourceEntry ? findAnchorTargetInScope(sourceEntry, cleaned) : null) ||
          findAnchorTargetInScope(shadow, cleaned);

        if (!targetEl) {
          if (cleaned.toLowerCase() === 'top' || cleaned.toLowerCase() === '_top') {
            setSpacerHeightSync(0);
            scrollEl.scrollTop = 0;
            updatePopupEdgeClips();
            return true;
          }
          return false;
        }

        // Open any collapsed <details> ancestor so the jumped section becomes visible
        let ancestor: HTMLElement | null = targetEl.parentElement;
        while (ancestor) {
          if (ancestor.tagName === 'DETAILS' && !(ancestor as HTMLDetailsElement).open) {
            (ancestor as HTMLDetailsElement).open = true;
          }
          ancestor = ancestor.parentElement;
        }

        const targetRect = getScrollableTargetRect(targetEl);
        if (!targetRect) return false;

        const containerRect = scrollEl.getBoundingClientRect();
        const naturalMax = getNaturalMaxScroll(scrollEl);
        if (naturalMax <= 0) {
          setSpacerHeightSync(0);
          scrollEl.scrollTop = 0;
          updatePopupEdgeClips();
          return true;
        }

        const desiredTop = Math.max(
          0,
          Math.floor(scrollEl.scrollTop + (targetRect.top - containerRect.top) - 6)
        );
        const neededSpacer = Math.max(0, Math.ceil(desiredTop - naturalMax));
        setSpacerHeightSync(neededSpacer);
        scrollEl.scrollTop = desiredTop;
        updatePopupEdgeClips();
        return true;
      },
      [getNaturalMaxScroll, setSpacerHeightSync, updatePopupEdgeClips]
    );

    const handleLookupWordWithAnchor = useCallback(
      (word: string, anchorId?: string) => {
        pendingAnchorRef.current = anchorId || null;
        onLookupWord(word);
      },
      [onLookupWord]
    );

    const currentWords = useMemo(() => {
      const list: string[] = [];
      if (queryWord) list.push(queryWord);
      if (result?.matchedHeadword && result.matchedHeadword !== queryWord) {
        list.push(result.matchedHeadword);
      }
      return list;
    }, [queryWord, result?.matchedHeadword]);

    const handleShadowContentRendered = useCallback(() => {
      scheduleEdgeClipUpdate();
      if (pendingAutoExpandCheckRef.current) {
        scheduleAutoExpandCheck();
      }
    }, [scheduleEdgeClipUpdate, scheduleAutoExpandCheck]);

    useEffect(() => {
      return () => {
        if (clipRafRef.current !== null) {
          window.cancelAnimationFrame(clipRafRef.current);
        }
        if (autoExpandRafRef.current !== null) {
          window.cancelAnimationFrame(autoExpandRafRef.current);
        }
      };
    }, []);

    // Whenever displayed content changes (live search, suggestion list, cross-ref click, back, dict switch)
    // while in compact mode, automatically switch to expanded mode if the new content overflows.
    const contentSignature = useMemo(
      () =>
        `${result?.dictId ?? ''}|${result?.matchedHeadword ?? ''}|${result?.htmlDefinitions.length ?? 0}|${suggestions.join('\u001f')}|${error ?? ''}`,
      [result?.dictId, result?.matchedHeadword, result?.htmlDefinitions.length, suggestions, error]
    );
    const prevContentSigRef = useRef<string | null>(null);
    useEffect(() => {
      if (loading) return;
      const prev = prevContentSigRef.current;
      prevContentSigRef.current = contentSignature;
      if (prev !== null && prev !== contentSignature) {
        manualExpandToggledRef.current = false;
        if (!isExpandedRef.current) {
          pendingAutoExpandCheckRef.current = true;
          scheduleAutoExpandCheck();
        }
      }
    }, [contentSignature, loading, scheduleAutoExpandCheck]);

    useEffect(() => {
      const pendingAnchor = pendingAnchorRef.current;
      if (pendingAnchor && result && result.htmlDefinitions.length > 0) {
        pendingAnchorRef.current = null;
        const raf = window.requestAnimationFrame(() => {
          if (!scrollToAnchor(pendingAnchor)) {
            setSpacerHeightSync(0);
            if (bodyScrollRef.current) {
              bodyScrollRef.current.scrollTop = 0;
            }
            scheduleEdgeClipUpdate();
          }
        });
        return () => window.cancelAnimationFrame(raf);
      }
      if (typeof restoreScrollTop === 'number' && !loading) {
        const targetTop = Math.max(0, restoreScrollTop);
        const raf = window.requestAnimationFrame(() => {
          setSpacerHeightSync(0);
          if (bodyScrollRef.current) {
            bodyScrollRef.current.scrollTop = targetTop;
          }
          scheduleEdgeClipUpdate();
          onRestoreScrollTopDone?.();
        });
        return () => window.cancelAnimationFrame(raf);
      }
      setSpacerHeightSync(0);
      if (bodyScrollRef.current) {
        bodyScrollRef.current.scrollTop = 0;
      }
      scheduleEdgeClipUpdate();
    }, [
      queryWord,
      result,
      suggestions,
      restoreScrollTop,
      loading,
      onRestoreScrollTopDone,
      scheduleEdgeClipUpdate,
      scrollToAnchor,
      setSpacerHeightSync,
    ]);

    useLayoutEffect(() => {
      updatePopupEdgeClips();
    }, [isExpanded, popupFontSize, loading, error, suggestions, updatePopupEdgeClips]);

    useEffect(() => {
      const el = bodyScrollRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => scheduleEdgeClipUpdate());
      ro.observe(el);
      return () => ro.disconnect();
    }, [scheduleEdgeClipUpdate]);

    const performPopupPageUp = useCallback(() => {
      const el = bodyScrollRef.current;
      const contentEl = bodyContentRef.current;
      if (!el || !contentEl) return;

      const viewHeight = el.clientHeight;
      const currentTop = el.scrollTop;
      if (currentTop <= 0 || viewHeight <= 0) return;

      const currentBottom = currentTop + viewHeight;
      const effectiveTop = currentTop + topClipPxRef.current;
      const lines = collectPopupVisualLines(el, contentEl, shadowRootRef.current);
      const EPS = 0.5;

      const firstCompleteIdx = lines.findIndex(
        (line) => line.top >= effectiveTop - EPS && line.bottom <= currentBottom + EPS
      );

      let targetScrollTop = Math.max(0, currentTop - viewHeight);
      if (firstCompleteIdx > 0) {
        const firstComplete = lines[firstCompleteIdx];
        const prevLine = lines[firstCompleteIdx - 1];
        const maxAllowedBottom = Math.floor(firstComplete.top);
        const minNeededBottom = Math.ceil(prevLine.bottom);
        const desiredBottom =
          minNeededBottom <= maxAllowedBottom
            ? Math.min(maxAllowedBottom, minNeededBottom + 2)
            : maxAllowedBottom;
        targetScrollTop = Math.max(0, desiredBottom - viewHeight);
      } else if (firstCompleteIdx === 0) {
        targetScrollTop = 0;
      }

      if (targetScrollTop >= currentTop) {
        targetScrollTop = Math.max(0, currentTop - Math.max(40, viewHeight - popupFontSize * 2));
      }

      const naturalMax = getNaturalMaxScroll(el);
      const neededSpacer = Math.max(0, Math.ceil(targetScrollTop - naturalMax));
      el.scrollTop = targetScrollTop;
      setSpacerHeightSync(neededSpacer);
      updatePopupEdgeClips();
    }, [getNaturalMaxScroll, popupFontSize, setSpacerHeightSync, updatePopupEdgeClips]);

    const performPopupPageDown = useCallback(() => {
      const el = bodyScrollRef.current;
      const contentEl = bodyContentRef.current;
      if (!el || !contentEl) return;

      const viewHeight = el.clientHeight;
      const currentTop = el.scrollTop;
      if (viewHeight <= 0) return;

      const effectiveBottom = currentTop + viewHeight - bottomClipPxRef.current;
      const lines = collectPopupVisualLines(el, contentEl, shadowRootRef.current);
      const EPS = 0.5;

      const firstIncompleteIdx = lines.findIndex((line) => line.bottom > effectiveBottom + EPS);
      if (firstIncompleteIdx === -1) {
        // Every remaining line of the definition is already fully visible
        return;
      }

      const firstIncomplete = lines[firstIncompleteIdx];
      const prevComplete = firstIncompleteIdx > 0 ? lines[firstIncompleteIdx - 1] : null;
      const minSafeTop = prevComplete ? Math.ceil(prevComplete.bottom) : 0;
      const desiredTop = Math.floor(firstIncomplete.top) - 4;
      let targetScrollTop = Math.max(minSafeTop, desiredTop);

      if (targetScrollTop <= currentTop) {
        targetScrollTop = currentTop + Math.max(40, viewHeight - popupFontSize * 2);
      }

      const naturalMax = getNaturalMaxScroll(el);
      const lastLine = lines[lines.length - 1];
      const maxPagedTop = Math.max(naturalMax, Math.floor(lastLine.top) - 4);
      targetScrollTop = Math.min(maxPagedTop, targetScrollTop);

      if (targetScrollTop <= currentTop + 0.5) {
        return;
      }

      const neededSpacer = Math.max(0, Math.ceil(targetScrollTop - naturalMax));
      setSpacerHeightSync(neededSpacer);

      el.scrollTop = targetScrollTop;
      updatePopupEdgeClips();
    }, [getNaturalMaxScroll, popupFontSize, setSpacerHeightSync, updatePopupEdgeClips]);

    useImperativeHandle(
      ref,
      () => ({
        pageUp: performPopupPageUp,
        pageDown: performPopupPageDown,
        autoExpandIfOverflowing,
        getScrollTop: () => bodyScrollRef.current?.scrollTop ?? 0,
      }),
      [performPopupPageUp, performPopupPageDown, autoExpandIfOverflowing]
    );

    const handleBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const down = pointerDownPosRef.current;
      pointerDownPosRef.current = null;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) {
        return;
      }

      // Skip paging if the user clicked an interactive element (including cross-ref links in Shadow DOM)
      const path = typeof e.nativeEvent.composedPath === 'function' ? e.nativeEvent.composedPath() : [];
      for (const item of path) {
        if (item instanceof HTMLElement) {
          const tag = item.tagName;
          if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'INPUT' || tag === 'SELECT') {
            return;
          }
          if (item.hasAttribute('data-mdx-anchor')) {
            return;
          }
          if (tag === 'A') {
            const href = (item.getAttribute('href') || '').trim();
            if (/^(?:entry|bword):\/\//i.test(href) || href.startsWith('#') || /^about:blank#/i.test(href)) {
              return;
            }
          }
        }
      }

      // Skip paging if user actively highlighted text inside the popup (including inside Shadow DOM)
      const scrollEl = bodyScrollRef.current;
      if (!scrollEl) return;
      const sel = window.getSelection();
      if (
        sel &&
        !sel.isCollapsed &&
        sel.toString().length > 0 &&
        sel.anchorNode &&
        (scrollEl.contains(sel.anchorNode) || Boolean(shadowRootRef.current?.contains(sel.anchorNode)))
      ) {
        return;
      }

      const rect = scrollEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const xRatio = (e.clientX - rect.left) / rect.width;
      if (xRatio < 0.5) {
        performPopupPageUp();
      } else {
        performPopupPageDown();
      }
    };

    const handleInputChange = (nextVal: string) => {
      setInputText(nextVal);
      if (liveSearchTimerRef.current !== null) {
        window.clearTimeout(liveSearchTimerRef.current);
      }
      liveSearchTimerRef.current = window.setTimeout(() => {
        liveSearchTimerRef.current = null;
        onLiveQueryChange(nextVal);
      }, 150);
    };

    const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (liveSearchTimerRef.current !== null) {
          window.clearTimeout(liveSearchTimerRef.current);
          liveSearchTimerRef.current = null;
        }
        const trimmed = inputText.trim();
        if (!result && suggestions.length > 0) {
          onSelectSuggestion(suggestions[0]);
          searchInputRef.current?.blur();
        } else if (trimmed) {
          onLiveQueryChange(trimmed);
          searchInputRef.current?.blur();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        searchInputRef.current?.blur();
      }
    };

    const extraRelatedSuggestions = useMemo(() => {
      if (!result || suggestions.length === 0) return [];
      const currentLow = queryWord.trim().toLowerCase();
      const matchedLow = (result.matchedHeadword || '').trim().toLowerCase();
      return suggestions.filter((w) => {
        const low = w.trim().toLowerCase();
        return low !== currentLow && low !== matchedLow;
      });
    }, [result, suggestions, queryWord]);

    const popupContainerStyle: React.CSSProperties | undefined =
      keyboardInsetPx > 0 && (isExpanded || placement === 'bottom')
        ? { bottom: `${keyboardInsetPx + 8}px` }
        : undefined;

    const lowerTrimmedInput = inputText.trim().toLowerCase();

    return (
      <div
        data-mdict-popup="true"
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        style={popupContainerStyle}
        className={`fixed left-3 right-3 z-40 flex justify-center pointer-events-none ${
          isExpanded
            ? 'top-[max(0.75rem,env(safe-area-inset-top))] bottom-[64px]'
            : placement === 'top'
              ? `top-[max(0.75rem,env(safe-area-inset-top))] ${hasToggledExpand ? '' : 'animate-mdict-down'}`
              : `bottom-[64px] ${hasToggledExpand ? '' : 'animate-mdict-up'}`
        }`}
      >
        <div
          className={`pointer-events-auto w-full max-w-[720px] flex flex-col bg-[var(--fei-popup-bg)] border-[1.5px] border-[var(--fei-popup-border)] rounded-2xl shadow-[0_12px_32px_-6px_rgba(0,0,0,0.14)] dark:ring-1 dark:ring-white/10 dark:shadow-[0_14px_36px_-4px_rgba(0,0,0,0.75)] eink:shadow-none overflow-hidden text-[var(--fei-text-primary)] ${
            isExpanded ? 'h-full' : 'max-h-[min(40vh,340px)]'
          }`}
        >
          {/* Subtle handle bar when docked at bottom */}
          {placement === 'bottom' && !isExpanded && (
            <div className="flex justify-center pt-1.5 pb-0.5 bg-[var(--fei-popup-header-bg)] shrink-0">
              <span className="w-7 h-[3px] rounded-full bg-[var(--fei-popup-handle)]" />
            </div>
          )}

          {/* Top Title Bar */}
          <div
            ref={headerRef}
            className="relative px-3.5 py-1.5 bg-[var(--fei-popup-header-bg)] border-b border-[var(--fei-popup-divider)] flex items-center justify-between gap-2 shrink-0 select-none"
          >
            <div className="w-[min(50%,240px)] shrink-0 flex items-center gap-1.5 min-w-0">
              {canGoBack ? (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    searchInputRef.current?.blur();
                    onGoBack();
                  }}
                  aria-label="返回上一个词条"
                  title="返回上一个词条"
                  className="w-7 h-7 -ml-1.5 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors shrink-0"
                >
                  <ArrowLeft className="w-4 h-4" strokeWidth={1.9} />
                </button>
              ) : (
                <BookA
                  className="w-4 h-4 text-[var(--fei-text-muted)] shrink-0"
                  strokeWidth={1.75}
                />
              )}

              <input
                ref={searchInputRef}
                type="text"
                value={inputText}
                onFocus={() => {
                  isInputFocusedRef.current = true;
                }}
                onBlur={() => {
                  isInputFocusedRef.current = false;
                }}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleInputKeyDown}
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="输入查词…"
                aria-label="编辑查询单词"
                className="font-doc-body text-[15px] font-semibold text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)]/60 bg-transparent border-b border-transparent focus:border-[var(--fei-border-strong)] outline-none min-w-0 flex-1 w-full py-0.5 select-text"
              />
            </div>

            <div className="flex-1 min-w-0 flex items-center justify-end gap-1.5">
              {displayedDictName ? (
                matchCount > 1 ? (
                  <button
                    type="button"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={onCycleDict}
                    title="点击切换下一个包含该词的词典"
                    aria-label={`当前词典 ${displayedDictName}，点击切换词典`}
                    className="text-[12px] text-[var(--fei-text-primary)] underline decoration-[var(--fei-border-strong)] underline-offset-[3px] truncate min-w-0 hover:opacity-75 transition-opacity cursor-pointer"
                  >
                    {displayedDictName}
                  </button>
                ) : (
                  <span className="text-[12px] text-[var(--fei-text-muted)] truncate min-w-0">
                    {displayedDictName}
                  </span>
                )
              ) : null}

              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onClose}
                aria-label="关闭释义"
                className="w-7 h-7 -mr-1 shrink-0 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Scrollable Definition / Suggestion Body (Left half click => Page Up, Right half click => Page Down; partial lines masked) */}
          <div className="relative flex-1 min-h-0 flex flex-col">
            <div
              ref={bodyScrollRef}
              onMouseDown={(e) => {
                const target = e.target as HTMLElement | null;
                if (target?.closest('button, a, input')) return;
                const el = e.currentTarget;
                const scrollbarWidth = el.offsetWidth - el.clientWidth;
                const rect = el.getBoundingClientRect();
                if (e.clientX < rect.right - scrollbarWidth - 2) {
                  e.preventDefault();
                }
              }}
              onPointerDown={handleBodyPointerDown}
              onClick={handleBodyClick}
              onScroll={handleBodyScroll}
              className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3.5 py-2.5 bg-[var(--fei-popup-bg)] cursor-pointer"
            >
              <div ref={bodyContentRef}>
                {loading ? (
                  <div
                    style={{ fontSize: `${popupFontSize}px` }}
                    className="py-3 text-[var(--fei-text-muted)]"
                  >
                    正在查词…
                  </div>
                ) : result && result.htmlDefinitions.length > 0 ? (
                  <>
                    {extraRelatedSuggestions.length > 0 && (
                      <div
                        className="mb-2 pb-1.5 border-b border-[var(--fei-border)]/70 flex items-center gap-2.5 overflow-x-auto whitespace-nowrap select-none"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {extraRelatedSuggestions.slice(0, 12).map((word) => (
                          <button
                            key={word}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              searchInputRef.current?.blur();
                              onSelectSuggestion(word);
                            }}
                            className="font-doc-body text-[12.5px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] underline decoration-transparent hover:decoration-[var(--fei-border-strong)] underline-offset-[3px] transition-colors shrink-0 cursor-pointer"
                          >
                            {word}
                          </button>
                        ))}
                      </div>
                    )}
                    <MdictShadowDefinition
                      htmlDefinitions={result.htmlDefinitions}
                      dictCssText={result.dictCssText}
                      fontSize={popupFontSize}
                      currentWords={currentWords}
                      onLookupWord={handleLookupWordWithAnchor}
                      onJumpToAnchor={scrollToAnchor}
                      onShadowReady={(shadow) => {
                        shadowRootRef.current = shadow;
                      }}
                      onContentRendered={handleShadowContentRendered}
                    />
                  </>
                ) : suggestions.length > 0 ? (
                  <div
                    className="divide-y divide-[var(--fei-border)]/70 select-none"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {suggestions.map((word) => {
                      const matchesPrefix =
                        lowerTrimmedInput.length > 0 &&
                        word.toLowerCase().startsWith(lowerTrimmedInput);
                      const prefixLen = matchesPrefix ? lowerTrimmedInput.length : 0;
                      return (
                        <button
                          key={word}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            searchInputRef.current?.blur();
                            onSelectSuggestion(word);
                          }}
                          style={{ fontSize: `${popupFontSize}px` }}
                          className="w-full text-left py-2 px-1 font-doc-body text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] rounded-md transition-colors cursor-pointer flex items-center justify-between gap-2"
                        >
                          <span className="truncate">
                            {prefixLen > 0 ? (
                              <>
                                <strong className="font-semibold">{word.slice(0, prefixLen)}</strong>
                                <span className="text-[var(--fei-text-muted)]">
                                  {word.slice(prefixLen)}
                                </span>
                              </>
                            ) : (
                              word
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : error ? (
                  <div
                    style={{ fontSize: `${popupFontSize}px` }}
                    className="py-3 text-[var(--fei-text-muted)]"
                  >
                    {error}
                  </div>
                ) : (
                  <div
                    style={{ fontSize: `${popupFontSize}px` }}
                    className="py-3 text-[var(--fei-text-muted)]"
                  >
                    {inputText.trim() ? '未找到匹配词条' : '输入单词即可查词'}
                  </div>
                )}
              </div>

              <div ref={bottomSpacerRef} aria-hidden="true" style={{ height: '0px' }} />
            </div>

            {topClipPx > 0 && (
              <div
                aria-hidden="true"
                style={{ height: `${topClipPx}px` }}
                className="pointer-events-none absolute left-0 right-1.5 top-0 bg-[var(--fei-popup-bg)] z-10"
              />
            )}

            {bottomClipPx > 0 && (
              <div
                aria-hidden="true"
                style={{ height: `${bottomClipPx}px` }}
                className="pointer-events-none absolute left-0 right-1.5 bottom-0 bg-[var(--fei-popup-bg)] z-10"
              />
            )}
          </div>

          {/* Subtle handle bar when docked at top */}
          {placement === 'top' && !isExpanded && (
            <div className="flex justify-center pt-0.5 pb-1.5 bg-[var(--fei-popup-bg)] shrink-0">
              <span className="w-7 h-[3px] rounded-full bg-[var(--fei-popup-handle)]" />
            </div>
          )}
        </div>
      </div>
    );
  }
);

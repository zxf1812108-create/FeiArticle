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
import { BookA, Maximize2, Minimize2, X } from 'lucide-react';
import { MdictDictionarySummary, MdictLookupResult } from '../types';
import { sanitizeMdictCss } from '../utils/mdict';
import { stripDictExt } from '../utils/mdictStorage';

export interface MdictLookupPopupHandle {
  pageUp: () => void;
  pageDown: () => void;
}

interface MdictLookupPopupProps {
  queryWord: string;
  placement: 'top' | 'bottom';
  fontSize?: number;
  loading: boolean;
  result: MdictLookupResult | null;
  matchCount: number;
  error: string | null;
  dictionaries: MdictDictionarySummary[];
  activeDictId: string | null;
  onCycleDict: () => void;
  onLookupWord: (word: string) => void;
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
        el.removeAttribute(attr.name);
        continue;
      }
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^(?:javascript|vbscript):/i.test(val)
      ) {
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

  return doc.body.innerHTML;
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
  onLookupWord: (word: string) => void;
  onShadowReady?: (shadow: ShadowRoot | null) => void;
  onContentRendered?: () => void;
}> = ({
  htmlDefinitions,
  dictCssText,
  fontSize,
  onLookupWord,
  onShadowReady,
  onContentRendered,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const onLookupWordRef = useRef(onLookupWord);
  onLookupWordRef.current = onLookupWord;
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
        const target = evt.target as HTMLElement | null;
        const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        const href = (anchor.getAttribute('href') || '').trim();
        const entryMatch = href.match(/^(?:entry|bword):\/\/(.+)$/i);
        if (entryMatch && entryMatch[1]) {
          evt.preventDefault();
          evt.stopPropagation();
          const nextWord = decodeURIComponent(entryMatch[1]).replace(/#.*$/, '').trim();
          if (nextWord) {
            onLookupWordRef.current(nextWord);
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
        font-family: var(--font-doc-body, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif);
        font-size: ${fontSize}px;
        line-height: 1.56;
        word-break: break-word;
        -webkit-touch-callout: none;
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
      a[href^="entry://"], a[href^="bword://"] {
        color: inherit;
        text-decoration: underline;
        text-underline-offset: 2px;
        cursor: pointer;
      }
      a:not([href^="entry://"]):not([href^="bword://"]) {
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
            background-color: #ffffff;
            color: #000000;
          }
        `
      : '';

    const entriesHtml = sanitizedEntries
      .map((html) => `<div class="mdx-entry">${html}</div>`)
      .join('');

    shadow.innerHTML = `<style>${baseStyle}</style>${
      hasCustomCss ? `<style>${escapeHtmlText(safeDictCss)}</style>` : ''
    }<style>${fontScaleOverride}${themeAdaptStyle}</style><div class="mdx-surface">${entriesHtml}</div>`;
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
      dictionaries,
      activeDictId,
      onCycleDict,
      onLookupWord,
      onClose,
    },
    ref
  ) {
    const bodyScrollRef = useRef<HTMLDivElement>(null);
    const bodyContentRef = useRef<HTMLDivElement>(null);
    const shadowRootRef = useRef<ShadowRoot | null>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const dictNameRef = useRef<HTMLElement | null>(null);
    const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
    const clipRafRef = useRef<number | null>(null);

    const [isExpanded, setIsExpanded] = useState(false);
    const [hasToggledExpand, setHasToggledExpand] = useState(false);
    const [shiftExpandLeft, setShiftExpandLeft] = useState(false);
    const [topClipPx, setTopClipPx] = useState(0);
    const [bottomClipPx, setBottomClipPx] = useState(0);
    const topClipPxRef = useRef(0);
    const bottomClipPxRef = useRef(0);
    const [bottomSpacerPx, setBottomSpacerPx] = useState(0);

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

    // Measure whether the dictionary name occupies the horizontal center of the header bar;
    // if so, shift the expand/restore button left so it sits immediately to the left of the dictionary name.
    const measureExpandButtonPlacement = useCallback(() => {
      const headerEl = headerRef.current;
      const dictEl = dictNameRef.current;
      if (!headerEl || !dictEl) {
        setShiftExpandLeft(false);
        return;
      }
      const headerRect = headerEl.getBoundingClientRect();
      const dictRect = dictEl.getBoundingClientRect();
      if (headerRect.width <= 0) return;

      const dictLeftInHeader = dictRect.left - headerRect.left;
      // Centered button is 28px wide (half = 14px) + 6px clearance on right = 20px from center
      const centerRightBound = headerRect.width / 2 + 20;
      const occupied = dictLeftInHeader < centerRightBound;
      setShiftExpandLeft((prev) => (prev === occupied ? prev : occupied));
    }, []);

    useLayoutEffect(() => {
      measureExpandButtonPlacement();
    }, [displayedDictName, matchCount, queryWord, isExpanded, measureExpandButtonPlacement]);

    useEffect(() => {
      const headerEl = headerRef.current;
      if (!headerEl || typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => measureExpandButtonPlacement());
      ro.observe(headerEl);
      return () => ro.disconnect();
    }, [measureExpandButtonPlacement]);

    const updatePopupEdgeClips = useCallback(() => {
      const el = bodyScrollRef.current;
      const contentEl = bodyContentRef.current;
      if (!el || !contentEl) {
        topClipPxRef.current = 0;
        bottomClipPxRef.current = 0;
        setTopClipPx((prev) => (prev === 0 ? prev : 0));
        setBottomClipPx((prev) => (prev === 0 ? prev : 0));
        setBottomSpacerPx((prev) => (prev === 0 ? prev : 0));
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
        setBottomSpacerPx((prev) => (prev === 0 ? prev : 0));
        return;
      }

      const lastLineBottom = lines[lines.length - 1].bottom;
      const overflows = lastLineBottom > viewHeight - 1;
      const desiredSpacer = overflows
        ? Math.max(0, Math.round(viewHeight - Math.max(28, popupFontSize * 2.2)))
        : 0;
      setBottomSpacerPx((prev) => (Math.abs(prev - desiredSpacer) <= 2 ? prev : desiredSpacer));

      const viewTop = el.scrollTop;
      const rawViewBottom = viewTop + viewHeight;

      if (!overflows) {
        topClipPxRef.current = 0;
        bottomClipPxRef.current = 0;
        setTopClipPx((prev) => (prev === 0 ? prev : 0));
        setBottomClipPx((prev) => (prev === 0 ? prev : 0));
        return;
      }

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
    }, [popupFontSize]);

    const scheduleEdgeClipUpdate = useCallback(() => {
      if (clipRafRef.current !== null) {
        window.cancelAnimationFrame(clipRafRef.current);
      }
      clipRafRef.current = window.requestAnimationFrame(() => {
        clipRafRef.current = null;
        updatePopupEdgeClips();
      });
    }, [updatePopupEdgeClips]);

    useEffect(() => {
      return () => {
        if (clipRafRef.current !== null) {
          window.cancelAnimationFrame(clipRafRef.current);
        }
      };
    }, []);

    useEffect(() => {
      if (bodyScrollRef.current) {
        bodyScrollRef.current.scrollTop = 0;
      }
      scheduleEdgeClipUpdate();
    }, [queryWord, result, scheduleEdgeClipUpdate]);

    useLayoutEffect(() => {
      updatePopupEdgeClips();
    }, [isExpanded, popupFontSize, loading, error, updatePopupEdgeClips]);

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

      el.scrollTop = targetScrollTop;
      updatePopupEdgeClips();
    }, [popupFontSize, updatePopupEdgeClips]);

    const performPopupPageDown = useCallback(() => {
      const el = bodyScrollRef.current;
      const contentEl = bodyContentRef.current;
      if (!el || !contentEl) return;

      const viewHeight = el.clientHeight;
      const currentTop = el.scrollTop;
      const maxScroll = Math.max(0, el.scrollHeight - viewHeight);
      if (viewHeight <= 0 || currentTop >= maxScroll - 1) return;

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
      let targetScrollTop = Math.min(maxScroll, Math.max(minSafeTop, desiredTop));

      if (targetScrollTop <= currentTop) {
        targetScrollTop = Math.min(
          maxScroll,
          currentTop + Math.max(40, viewHeight - popupFontSize * 2)
        );
      }

      el.scrollTop = targetScrollTop;
      updatePopupEdgeClips();
    }, [popupFontSize, updatePopupEdgeClips]);

    useImperativeHandle(
      ref,
      () => ({
        pageUp: performPopupPageUp,
        pageDown: performPopupPageDown,
      }),
      [performPopupPageUp, performPopupPageDown]
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
          if (tag === 'A') {
            const href = (item.getAttribute('href') || '').trim();
            if (/^(?:entry|bword):\/\//i.test(href)) {
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

    const expandButton = (
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setHasToggledExpand(true);
          setIsExpanded((prev) => !prev);
        }}
        aria-label={isExpanded ? '恢复词典窗口大小' : '拉长词典窗口'}
        title={isExpanded ? '恢复' : '拉长'}
        className={`w-7 h-7 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors shrink-0 ${
          shiftExpandLeft
            ? ''
            : 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10'
        }`}
      >
        {isExpanded ? (
          <Minimize2 className="w-3.5 h-3.5" strokeWidth={1.9} />
        ) : (
          <Maximize2 className="w-3.5 h-3.5" strokeWidth={1.9} />
        )}
      </button>
    );

    return (
      <div
        data-mdict-popup="true"
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        className={`fixed left-3 right-3 z-40 flex justify-center pointer-events-none ${
          isExpanded
            ? 'top-[max(0.75rem,env(safe-area-inset-top))] bottom-[64px]'
            : placement === 'top'
              ? `top-[max(0.75rem,env(safe-area-inset-top))] ${hasToggledExpand ? '' : 'animate-mdict-down'}`
              : `bottom-[64px] ${hasToggledExpand ? '' : 'animate-mdict-up'}`
        }`}
      >
        <div
          className={`pointer-events-auto w-full max-w-[720px] flex flex-col bg-[#FFFFFF] dark:bg-[#242424] border-[1.5px] border-[#262626] dark:border-[#787878] rounded-2xl shadow-none dark:ring-1 dark:ring-white/10 dark:shadow-[0_14px_36px_-4px_rgba(0,0,0,0.75)] overflow-hidden text-[var(--fei-text-primary)] ${
            isExpanded ? 'h-full' : 'max-h-[min(40vh,340px)]'
          }`}
        >
          {/* Subtle handle bar when docked at bottom */}
          {placement === 'bottom' && !isExpanded && (
            <div className="flex justify-center pt-1.5 pb-0.5 bg-[#FFFFFF] dark:bg-[#2A2A2A] shrink-0">
              <span className="w-7 h-[3px] rounded-full bg-[#B0B0B0] dark:bg-[#5E5E5E]" />
            </div>
          )}

          {/* Header Band */}
          <div
            ref={headerRef}
            className="relative px-3.5 py-2 bg-[#FFFFFF] dark:bg-[#2A2A2A] border-b border-[#BDBDBD] dark:border-[#4A4A4A] flex items-center justify-between gap-2 shrink-0 select-none"
          >
            <div
              style={!shiftExpandLeft ? { maxWidth: 'calc(50% - 22px)' } : undefined}
              className="flex items-baseline gap-1.5 min-w-0 flex-1"
            >
              <BookA
                className="w-4 h-4 text-[var(--fei-text-muted)] shrink-0 self-center"
                strokeWidth={1.75}
              />
              <span className="font-doc-body text-[15px] font-semibold text-[var(--fei-text-primary)] truncate">
                {queryWord}
              </span>
            </div>

            {!shiftExpandLeft && expandButton}

            <div className="flex items-center gap-1.5 shrink-0">
              {shiftExpandLeft && expandButton}

              {displayedDictName ? (
                matchCount > 1 ? (
                  <button
                    ref={(el) => {
                      dictNameRef.current = el;
                    }}
                    type="button"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={onCycleDict}
                    title="点击切换下一个包含该词的词典"
                    aria-label={`当前词典 ${displayedDictName}，点击切换词典`}
                    className="text-[12px] text-[var(--fei-text-primary)] underline decoration-[var(--fei-border-strong)] underline-offset-[3px] truncate max-w-[min(220px,52vw)] hover:opacity-75 transition-opacity cursor-pointer"
                  >
                    {displayedDictName}
                  </button>
                ) : (
                  <span
                    ref={(el) => {
                      dictNameRef.current = el;
                    }}
                    className="text-[12px] text-[var(--fei-text-muted)] truncate max-w-[min(220px,52vw)]"
                  >
                    {displayedDictName}
                  </span>
                )
              ) : null}

              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={onClose}
                aria-label="关闭释义"
                className="w-7 h-7 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Scrollable Definition Body (Left half click => Page Up, Right half click => Page Down; partial lines masked) */}
          <div className="relative flex-1 min-h-0 flex flex-col">
            <div
              ref={bodyScrollRef}
              onMouseDown={(e) => {
                const el = e.currentTarget;
                const scrollbarWidth = el.offsetWidth - el.clientWidth;
                const rect = el.getBoundingClientRect();
                if (e.clientX < rect.right - scrollbarWidth - 2) {
                  e.preventDefault();
                }
              }}
              onPointerDown={handleBodyPointerDown}
              onClick={handleBodyClick}
              onScroll={scheduleEdgeClipUpdate}
              className="flex-1 min-h-0 overflow-y-auto px-3.5 py-2.5 bg-[#FFFFFF] dark:bg-[#242424] cursor-pointer"
            >
              <div ref={bodyContentRef}>
                {loading ? (
                  <div
                    style={{ fontSize: `${popupFontSize}px` }}
                    className="py-3 text-[var(--fei-text-muted)]"
                  >
                    正在查词…
                  </div>
                ) : error ? (
                  <div
                    style={{ fontSize: `${popupFontSize}px` }}
                    className="py-3 text-[var(--fei-text-muted)]"
                  >
                    {error}
                  </div>
                ) : result && result.htmlDefinitions.length > 0 ? (
                  <MdictShadowDefinition
                    htmlDefinitions={result.htmlDefinitions}
                    dictCssText={result.dictCssText}
                    fontSize={popupFontSize}
                    onLookupWord={onLookupWord}
                    onShadowReady={(shadow) => {
                      shadowRootRef.current = shadow;
                    }}
                    onContentRendered={scheduleEdgeClipUpdate}
                  />
                ) : null}
              </div>

              {bottomSpacerPx > 0 && (
                <div aria-hidden="true" style={{ height: `${bottomSpacerPx}px` }} />
              )}
            </div>

            {topClipPx > 0 && (
              <div
                aria-hidden="true"
                style={{ height: `${topClipPx}px` }}
                className="pointer-events-none absolute left-0 right-1.5 top-0 bg-[#FFFFFF] dark:bg-[#242424] z-10"
              />
            )}

            {bottomClipPx > 0 && (
              <div
                aria-hidden="true"
                style={{ height: `${bottomClipPx}px` }}
                className="pointer-events-none absolute left-0 right-1.5 bottom-0 bg-[#FFFFFF] dark:bg-[#242424] z-10"
              />
            )}
          </div>

          {/* Subtle handle bar when docked at top */}
          {placement === 'top' && !isExpanded && (
            <div className="flex justify-center pt-0.5 pb-1.5 bg-[#FFFFFF] dark:bg-[#242424] shrink-0">
              <span className="w-7 h-[3px] rounded-full bg-[#B0B0B0] dark:bg-[#5E5E5E]" />
            </div>
          )}
        </div>
      </div>
    );
  }
);

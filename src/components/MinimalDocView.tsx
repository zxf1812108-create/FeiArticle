import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CloudDownload } from 'lucide-react';
import { ArticleDoc } from '../types';
import { extractEnglishLookupWord } from '../utils/mdict';
import { DocOutlineModal } from './DocOutlineModal';
import { BlockNode, formatBytes, parseDocumentBlocks, TocItem } from '../utils/textParser';
import {
  extractExactVisualLineText,
  findScrollTopForCharOffset,
  resolveReadViewportCharOffset,
} from '../utils/docAnchor';
import {
  setNativeVolumeKeyIntercept,
  subscribeNativeVolumeKeys,
} from '../utils/readerNative';

export type EditFormatKind = 'h1' | 'h2' | 'ul';

export interface DocViewStateSnapshot {
  mode: 'read' | 'edit';
  scrollTop: number;
  charOffset: number;
  readProgress: number;
}

export interface MinimalDocViewHandle {
  prepareModeSwitch: (nextEditing: boolean) => void;
  captureTypographyAnchor: () => void;
  flushAndCaptureViewState: () => DocViewStateSnapshot;
  applyMarkdownFormat: (kind: EditFormatKind) => void;
  undo: () => void;
  redo: () => void;
}

interface MinimalDocViewProps {
  doc: ArticleDoc;
  isEditing: boolean;
  fontSize?: number;
  docFontFamily?: string;
  hasActiveMdict?: boolean;
  isMdictPopupOpen?: boolean;
  onEnglishWordSelected?: (payload: { word: string; placement: 'top' | 'bottom' }) => void;
  onClearMdictLookup?: () => void;
  onSaveDraft: (updates: { title: string; content: string }) => void;
  onViewStateChange: (state: DocViewStateSnapshot) => void;
  onReadProgressChange?: (progress: number) => void;
  onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
  onFetchRemoteBody: () => Promise<void>;
}

interface VisualLine {
  top: number;
  bottom: number;
  text: string;
}

/**
 * Measure rendered visual lines in scroll-content coordinates, keeping text snippets
 * for exact line-accurate pagination, edge clipping, and Read <-> Edit content synchronization.
 */
function collectVisualLines(scrollEl: HTMLElement, articleEl: HTMLElement): VisualLine[] {
  const containerRect = scrollEl.getBoundingClientRect();
  const baseOffset = scrollEl.scrollTop - containerRect.top;
  const rawRects: VisualLine[] = [];

  const walker = document.createTreeWalker(articleEl, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node = walker.nextNode();

  while (node) {
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
            text: val.trim(),
          });
        }
      }
    }
    node = walker.nextNode();
  }

  const hrs = articleEl.querySelectorAll('hr');
  hrs.forEach((hr) => {
    const r = hr.getBoundingClientRect();
    if (r.height > 0) {
      rawRects.push({
        top: r.top + baseOffset,
        bottom: r.bottom + baseOffset,
        text: '',
      });
    }
  });

  if (rawRects.length === 0) return [];

  rawRects.sort((a, b) => a.top - b.top);

  const merged: VisualLine[] = [rawRects[0]];
  for (let i = 1; i < rawRects.length; i++) {
    const curr = rawRects[i];
    const last = merged[merged.length - 1];
    const overlap = Math.min(last.bottom, curr.bottom) - Math.max(last.top, curr.top);
    const minHeight = Math.min(last.bottom - last.top, curr.bottom - curr.top);
    if (overlap > minHeight * 0.4) {
      last.top = Math.min(last.top, curr.top);
      last.bottom = Math.max(last.bottom, curr.bottom);
      if (curr.text && !last.text.includes(curr.text)) {
        last.text = `${last.text} ${curr.text}`.trim();
      }
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/**
 * Browser <textarea> normalizes CRLF (\r\n) and CR (\r) to LF (\n) internally.
 * Convert raw content & offset to match textarea.value 1:1.
 */
function normalizeForTextarea(raw: string, rawOffset: number): { text: string; offset: number } {
  const safeOffset = Math.min(raw.length, Math.max(0, rawOffset));
  if (!raw.includes('\r')) {
    return { text: raw, offset: safeOffset };
  }
  let text = '';
  let mappedOffset = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i === safeOffset) {
      mappedOffset = text.length;
    }
    const ch = raw[i];
    if (ch === '\r') {
      if (i + 1 < raw.length && raw[i + 1] === '\n') {
        i++;
        if (i === safeOffset) {
          mappedOffset = text.length;
        }
      }
      text += '\n';
    } else {
      text += ch;
    }
  }
  if (safeOffset >= raw.length) {
    mappedOffset = text.length;
  }
  return { text, offset: mappedOffset };
}

function mapTextareaOffsetToRaw(raw: string, taOffset: number): number {
  if (!raw.includes('\r')) {
    return Math.min(raw.length, Math.max(0, taOffset));
  }
  let taIdx = 0;
  for (let i = 0; i < raw.length; i++) {
    if (taIdx >= taOffset) return i;
    if (raw[i] === '\r' && i + 1 < raw.length && raw[i + 1] === '\n') {
      i++;
    }
    taIdx++;
  }
  return raw.length;
}

/**
 * Create a temporary off-screen <textarea> clone using the exact same browser text-control
 * layout engine and computed typography/wrapping styles as the real editor, eliminating any
 * cumulative height drift between a <div> mirror and <textarea>.
 */
function createTextareaProbe(textarea: HTMLTextAreaElement): {
  probe: HTMLTextAreaElement;
  singleLineHeight: number;
  padTop: number;
} {
  const style = window.getComputedStyle(textarea);
  const probe = document.createElement('textarea');
  probe.setAttribute('aria-hidden', 'true');
  probe.tabIndex = -1;
  probe.readOnly = true;
  probe.style.position = 'fixed';
  probe.style.top = '-9999px';
  probe.style.left = '-9999px';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.boxSizing = 'border-box';
  probe.style.border = '0';
  probe.style.margin = '0';
  probe.style.outline = 'none';
  probe.style.resize = 'none';
  probe.style.overflow = 'hidden';
  probe.style.height = '0px';
  probe.style.minHeight = '0px';
  probe.style.width = `${textarea.clientWidth}px`;
  probe.style.paddingTop = '0px';
  probe.style.paddingBottom = '0px';
  probe.style.paddingLeft = style.paddingLeft;
  probe.style.paddingRight = style.paddingRight;
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  probe.style.fontWeight = style.fontWeight;
  probe.style.fontStyle = style.fontStyle;
  probe.style.fontVariant = style.fontVariant;
  probe.style.lineHeight = style.lineHeight;
  probe.style.letterSpacing = style.letterSpacing;
  probe.style.wordSpacing = style.wordSpacing;
  probe.style.whiteSpace = style.whiteSpace;
  probe.style.overflowWrap = style.overflowWrap;
  probe.style.wordBreak = style.wordBreak;
  probe.style.tabSize = style.tabSize;
  probe.style.textIndent = style.textIndent;
  probe.style.textTransform = style.textTransform;
  probe.style.direction = style.direction;
  document.body.appendChild(probe);

  probe.value = '测A';
  const measuredLh = probe.scrollHeight;
  const parsedLh = parseFloat(style.lineHeight);
  const singleLineHeight =
    measuredLh > 4 ? measuredLh : Number.isFinite(parsedLh) && parsedLh > 0 ? parsedLh : 24;
  const padTop = parseFloat(style.paddingTop) || 0;

  return { probe, singleLineHeight, padTop };
}

function measureParaTopInProbe(
  probe: HTMLTextAreaElement,
  text: string,
  paraStart: number
): number {
  if (paraStart <= 0) return 0;
  probe.value = text.slice(0, paraStart - 1);
  return probe.scrollHeight;
}

function measureIntraParaTopInProbe(
  probe: HTMLTextAreaElement,
  paraText: string,
  localIdx: number,
  singleLineHeight: number
): number {
  if (localIdx <= 0 || !paraText) return 0;
  const clamped = Math.min(paraText.length, localIdx);
  let wordEnd = Math.min(paraText.length, clamped + 1);
  if (clamped < paraText.length && /[A-Za-z0-9_'’-]/.test(paraText[clamped])) {
    const limit = Math.min(paraText.length, clamped + 48);
    while (wordEnd < limit && /[A-Za-z0-9_'’-]/.test(paraText[wordEnd])) {
      wordEnd++;
    }
  }
  probe.value = paraText.slice(0, wordEnd);
  return Math.max(0, probe.scrollHeight - singleLineHeight);
}

function measureCharOffsetY(
  textarea: HTMLTextAreaElement,
  rawText: string,
  rawCharIndex: number
): number {
  const padTopFallback = parseFloat(window.getComputedStyle(textarea).paddingTop) || 0;
  if (rawCharIndex <= 0 || !rawText || textarea.clientWidth <= 0) {
    return padTopFallback;
  }
  const { text, offset } = normalizeForTextarea(rawText, rawCharIndex);
  if (offset <= 0) return padTopFallback;

  const { probe, singleLineHeight, padTop } = createTextareaProbe(textarea);
  try {
    const paraStart = offset > 0 ? text.lastIndexOf('\n', offset - 1) + 1 : 0;
    const paraEndRaw = text.indexOf('\n', paraStart);
    const paraEnd = paraEndRaw === -1 ? text.length : paraEndRaw;
    const paraTopY = measureParaTopInProbe(probe, text, paraStart);
    const localIdx = Math.max(0, offset - paraStart);
    const intraParaY =
      localIdx > 0
        ? measureIntraParaTopInProbe(
            probe,
            text.slice(paraStart, paraEnd),
            localIdx,
            singleLineHeight
          )
        : 0;
    return padTop + paraTopY + intraParaY;
  } finally {
    document.body.removeChild(probe);
  }
}

function findCharOffsetAtY(
  textarea: HTMLTextAreaElement,
  rawText: string,
  targetScrollTop: number
): number {
  if (targetScrollTop <= 0 || !rawText || textarea.clientWidth <= 0) return 0;
  const { text } = normalizeForTextarea(rawText, 0);
  if (!text) return 0;

  const { probe, singleLineHeight } = createTextareaProbe(textarea);
  try {
    const minVisibleTop = Math.max(0, targetScrollTop - singleLineHeight * 0.35);

    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') lineStarts.push(i + 1);
    }

    // Stage 1: binary search raw paragraphs to locate the one spanning minVisibleTop
    let lo = 0;
    let hi = lineStarts.length - 1;
    let bestLineIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const y = measureParaTopInProbe(probe, text, lineStarts[mid]);
      if (y < minVisibleTop) {
        bestLineIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    const paraStart = lineStarts[bestLineIdx];
    const nextParaStart =
      bestLineIdx + 1 < lineStarts.length ? lineStarts[bestLineIdx + 1] : text.length;
    const paraEnd =
      nextParaStart > paraStart && text[nextParaStart - 1] === '\n'
        ? nextParaStart - 1
        : nextParaStart;
    const paraTopY = measureParaTopInProbe(probe, text, paraStart);
    const paraText = text.slice(paraStart, paraEnd);

    // Stage 2: binary search inside wrapped paragraph for the exact first visible visual line
    let charLo = 0;
    let charHi = paraText.length;
    let resultTaOffset = nextParaStart;
    while (charLo <= charHi) {
      const mid = (charLo + charHi) >> 1;
      const intraY =
        mid < paraText.length
          ? measureIntraParaTopInProbe(probe, paraText, mid, singleLineHeight)
          : measureIntraParaTopInProbe(
              probe,
              paraText,
              Math.max(0, paraText.length - 1),
              singleLineHeight
            );
      if (paraTopY + intraY >= minVisibleTop) {
        resultTaOffset = paraStart + mid;
        charHi = mid - 1;
      } else {
        charLo = mid + 1;
      }
    }

    while (resultTaOffset < text.length && text[resultTaOffset] === '\n') {
      resultTaOffset++;
    }
    return mapTextareaOffsetToRaw(rawText, Math.min(text.length, resultTaOffset));
  } finally {
    document.body.removeChild(probe);
  }
}

type PendingAnchor =
  | { kind: 'top' }
  | { kind: 'to-edit'; charOffset: number }
  | { kind: 'to-read'; charOffset: number };

type PendingTypographyAnchor =
  | { kind: 'top' }
  | { kind: 'edit'; charOffset: number }
  | { kind: 'read'; charOffset: number };

export const MinimalDocView = forwardRef<MinimalDocViewHandle, MinimalDocViewProps>(
  function MinimalDocView(
    {
      doc,
      isEditing,
      fontSize = 16,
      docFontFamily,
      hasActiveMdict = false,
      isMdictPopupOpen = false,
      onEnglishWordSelected,
      onClearMdictLookup,
      onSaveDraft,
      onViewStateChange,
      onReadProgressChange,
      onHistoryChange,
      onFetchRemoteBody,
    },
    ref
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const articleRef = useRef<HTMLElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const [content, setContent] = useState(doc.content);
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [articleOverflow, setArticleOverflow] = useState(false);
    const articleOverflowRef = useRef(false);
    articleOverflowRef.current = articleOverflow;
    const [showOutline, setShowOutline] = useState(false);
    const [topClipPx, setTopClipPx] = useState(0);
    const [bottomClipPx, setBottomClipPx] = useState(0);
    const topClipPxRef = useRef(0);
    const bottomClipPxRef = useRef(0);
    const clipRafRef = useRef<number | null>(null);
    const editAlignTimerRef = useRef<number | null>(null);

    const titleRef = useRef(doc.title);
    const contentRef = useRef(content);
    titleRef.current = doc.title;
    contentRef.current = content;

    const debounceSaveRef = useRef<number | null>(null);
    const debounceScrollRef = useRef<number | null>(null);
    const hasUnsavedDraftRef = useRef(false);
    const pendingAnchorRef = useRef<PendingAnchor | null>(null);
    const pendingTypographyAnchorRef = useRef<PendingTypographyAnchor | null>(null);
    const typographyLockUntilRef = useRef(0);
    const lastProgrammaticScrollAtRef = useRef(0);
    const restoredDocIdRef = useRef<string | null>(null);
    const hadSelectionOnDownRef = useRef(false);
    const lastPointerDownAtRef = useRef(0);
    const lastTouchStartAtRef = useRef(0);
    const isPointerActiveRef = useRef(false);
    const selectionCheckTimerRef = useRef<number | null>(null);
    const lastReportedProgressRef = useRef<number>(-1);

    // Keyboard visibility tracking for Edit mode cursor centering
    const baselineViewportHeightRef = useRef<number>(
      typeof window !== 'undefined'
        ? (window.visualViewport?.height ?? window.innerHeight)
        : 800
    );
    const wasKeyboardOpenRef = useRef(false);
    const keyboardCenterTimerRef = useRef<number | null>(null);

    const hasActiveMdictRef = useRef(hasActiveMdict);
    hasActiveMdictRef.current = hasActiveMdict;
    const isMdictPopupOpenRef = useRef(isMdictPopupOpen);
    isMdictPopupOpenRef.current = isMdictPopupOpen;
    const isEditingRef = useRef(isEditing);
    isEditingRef.current = isEditing;
    const onEnglishWordSelectedRef = useRef(onEnglishWordSelected);
    onEnglishWordSelectedRef.current = onEnglishWordSelected;
    const onClearMdictLookupRef = useRef(onClearMdictLookup);
    onClearMdictLookupRef.current = onClearMdictLookup;
    const onViewStateChangeRef = useRef(onViewStateChange);
    onViewStateChangeRef.current = onViewStateChange;
    const onReadProgressChangeRef = useRef(onReadProgressChange);
    onReadProgressChangeRef.current = onReadProgressChange;
    const onHistoryChangeRef = useRef(onHistoryChange);
    onHistoryChangeRef.current = onHistoryChange;

    // Per-document edit history stack for reliable Undo / Redo across typing & toolbar formatting
    const historyRef = useRef<Array<{ content: string; selStart: number; selEnd: number }>>([
      { content: doc.content, selStart: 0, selEnd: 0 },
    ]);
    const historyIndexRef = useRef<number>(0);
    const lastEditAtRef = useRef<number>(0);
    const lastEditKindRef = useRef<'typing' | 'delete' | 'other'>('other');

    const notifyHistoryState = () => {
      onHistoryChangeRef.current?.({
        canUndo: historyIndexRef.current > 0,
        canRedo: historyIndexRef.current < historyRef.current.length - 1,
      });
    };

    const resetEditHistory = (initialContent: string) => {
      historyRef.current = [{ content: initialContent, selStart: 0, selEnd: 0 }];
      historyIndexRef.current = 0;
      lastEditAtRef.current = 0;
      lastEditKindRef.current = 'other';
      notifyHistoryState();
    };

    const recordEditHistory = (
      nextContent: string,
      selStart: number,
      selEnd: number,
      coalesce: boolean,
      editKind: 'typing' | 'delete' | 'other'
    ) => {
      const now = Date.now();
      const curIdx = historyIndexRef.current;
      const curEntry = historyRef.current[curIdx];
      if (curEntry && curEntry.content === nextContent) {
        curEntry.selStart = selStart;
        curEntry.selEnd = selEnd;
        return;
      }

      const canCoalesce =
        coalesce &&
        curIdx > 0 &&
        curIdx === historyRef.current.length - 1 &&
        lastEditKindRef.current === editKind &&
        now - lastEditAtRef.current < 600;

      if (canCoalesce) {
        historyRef.current[curIdx] = { content: nextContent, selStart, selEnd };
      } else {
        const truncated = historyRef.current.slice(0, curIdx + 1);
        truncated.push({ content: nextContent, selStart, selEnd });
        const MAX_HISTORY = 100;
        if (truncated.length > MAX_HISTORY) {
          truncated.shift();
        }
        historyRef.current = truncated;
        historyIndexRef.current = truncated.length - 1;
      }

      lastEditAtRef.current = now;
      lastEditKindRef.current = editKind;
      notifyHistoryState();
    };

    const applyHistorySnapshot = (targetIndex: number) => {
      const entry = historyRef.current[targetIndex];
      if (!entry) return;
      const ta = textareaRef.current;
      const prevScrollTop = ta?.scrollTop ?? 0;
      const wasFocused = Boolean(ta && document.activeElement === ta);

      historyIndexRef.current = targetIndex;
      lastEditAtRef.current = 0;
      lastEditKindRef.current = 'other';
      clearTypographyLock();

      contentRef.current = entry.content;
      setContent(entry.content);
      scheduleSave(titleRef.current, entry.content);
      notifyHistoryState();

      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        if (wasFocused) {
          try {
            el.setSelectionRange(entry.selStart, entry.selEnd);
          } catch {
            // ignore selection errors on mobile
          }
        }
        el.scrollTop = prevScrollTop;
      });
    };

    const performUndo = () => {
      if (historyIndexRef.current <= 0) return;
      applyHistorySnapshot(historyIndexRef.current - 1);
    };

    const performRedo = () => {
      if (historyIndexRef.current >= historyRef.current.length - 1) return;
      applyHistorySnapshot(historyIndexRef.current + 1);
    };

    const clearTypographyLock = () => {
      pendingTypographyAnchorRef.current = null;
      typographyLockUntilRef.current = 0;
      if (editAlignTimerRef.current !== null) {
        window.clearTimeout(editAlignTimerRef.current);
        editAlignTimerRef.current = null;
      }
    };

    const computeReadProgress = (): number => {
      if (!contentRef.current.trim()) return 0;

      if (isEditingRef.current) {
        const ta = textareaRef.current;
        if (!ta) return doc.readProgress ?? 0;
        const maxScroll = Math.max(0, ta.scrollHeight - ta.clientHeight);
        if (maxScroll <= 2) return 100;
        if (ta.scrollTop <= 2) return 0;
        const charOffset = findCharOffsetAtY(ta, contentRef.current, ta.scrollTop);
        return Math.min(100, Math.max(0, Math.round((charOffset / Math.max(1, contentRef.current.length)) * 100)));
      }

      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return doc.readProgress ?? 0;

      const viewHeight = el.clientHeight;
      if (viewHeight <= 0) return doc.readProgress ?? 0;

      const containerRect = el.getBoundingClientRect();
      const articleRect = articleEl.getBoundingClientRect();
      const baseOffset = el.scrollTop - containerRect.top;
      const articleBottom = articleRect.bottom + baseOffset;
      const effectiveMax = Math.max(0, articleBottom - viewHeight);

      if (effectiveMax <= 2) return 100;
      if (el.scrollTop <= 2) return 0;
      return Math.min(100, Math.max(0, Math.round((el.scrollTop / effectiveMax) * 100)));
    };

    const reportReadProgress = (): number => {
      const pct = computeReadProgress();
      if (pct !== lastReportedProgressRef.current) {
        lastReportedProgressRef.current = pct;
        onReadProgressChangeRef.current?.(pct);
      }
      return pct;
    };

    const captureCurrentCharOffset = (): number => {
      const raw = contentRef.current;
      if (!raw) return 0;

      if (isEditingRef.current) {
        const ta = textareaRef.current;
        if (!ta || ta.scrollTop <= 10) return 0;
        return findCharOffsetAtY(ta, raw, ta.scrollTop);
      }

      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl || !articleOverflowRef.current) return 0;
      if (el.scrollTop <= 10) {
        const firstBlock = articleEl.querySelector<HTMLElement>('[data-start-offset]');
        const firstStart = Number(firstBlock?.getAttribute('data-start-offset'));
        return Number.isFinite(firstStart) && firstStart > 0 ? firstStart : 0;
      }

      const lines = collectVisualLines(el, articleEl);
      const effectiveViewTop = el.scrollTop + topClipPxRef.current;
      const firstIdx = lines.findIndex((line) => {
        if (!line.text.trim()) return false;
        const lineHeight = Math.max(12, line.bottom - line.top);
        const minKeep = Math.min(10, Math.max(4, lineHeight * 0.45));
        return line.bottom > effectiveViewTop + minKeep;
      });
      if (firstIdx === -1) return 0;

      const firstLine = lines[firstIdx];
      const exactText =
        extractExactVisualLineText(el, articleEl, firstLine.top, firstLine.bottom) ||
        firstLine.text;

      return resolveReadViewportCharOffset(
        el,
        articleEl,
        raw,
        firstLine.top,
        firstLine.bottom,
        exactText
      );
    };

    const emitCurrentViewState = () => {
      const mode: 'read' | 'edit' = isEditingRef.current ? 'edit' : 'read';
      const el = mode === 'edit' ? textareaRef.current : scrollRef.current;
      const scrollTop = el?.scrollTop ?? 0;
      const charOffset = captureCurrentCharOffset();
      const readProgress = reportReadProgress();
      onViewStateChangeRef.current({ mode, scrollTop, charOffset, readProgress });
    };

    // Sync local buffer only when switching documents
    useEffect(() => {
      setContent(doc.content);
      titleRef.current = doc.title;
      contentRef.current = doc.content;
      hasUnsavedDraftRef.current = false;
      hadSelectionOnDownRef.current = false;
      pendingAnchorRef.current = null;
      lastReportedProgressRef.current = -1;
      clearTypographyLock();
      if (debounceScrollRef.current) {
        window.clearTimeout(debounceScrollRef.current);
        debounceScrollRef.current = null;
      }
      setFetchError(null);
      setArticleOverflow(false);
      setShowOutline(false);
      topClipPxRef.current = 0;
      bottomClipPxRef.current = 0;
      setTopClipPx(0);
      setBottomClipPx(0);
      resetEditHistory(doc.content);
    }, [doc.id]);

    useEffect(() => {
      if (isEditing) {
        setShowOutline(false);
        notifyHistoryState();
      }
      return () => {
        if (debounceScrollRef.current) {
          window.clearTimeout(debounceScrollRef.current);
          debounceScrollRef.current = null;
        }
      };
    }, [isEditing]);

    // Sync content only when remote body arrives lazily in read mode
    useEffect(() => {
      if (!isEditing && !hasUnsavedDraftRef.current && doc.content !== contentRef.current) {
        setContent(doc.content);
        contentRef.current = doc.content;
        resetEditHistory(doc.content);
      }
    }, [doc.content, isEditing]);

    // Measure whether rendered Markdown overflows the reading viewport
    const measureReadOverflow = () => {
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return false;
      const needed = articleEl.offsetHeight + 24 > el.clientHeight;
      if (needed !== articleOverflow) {
        setArticleOverflow(needed);
        return true;
      }
      return false;
    };

    // Mask partially clipped lines at both top and bottom edges of Browse viewport
    const updateEdgeClips = () => {
      if (isEditingRef.current) {
        topClipPxRef.current = 0;
        bottomClipPxRef.current = 0;
        setTopClipPx((prev) => (prev === 0 ? prev : 0));
        setBottomClipPx((prev) => (prev === 0 ? prev : 0));
        return;
      }
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) {
        topClipPxRef.current = 0;
        bottomClipPxRef.current = 0;
        setTopClipPx((prev) => (prev === 0 ? prev : 0));
        setBottomClipPx((prev) => (prev === 0 ? prev : 0));
        return;
      }
      const viewTop = el.scrollTop;
      const viewHeight = el.clientHeight;
      const maxScroll = Math.max(0, el.scrollHeight - viewHeight);
      if (viewHeight <= 0 || maxScroll <= 2) {
        topClipPxRef.current = 0;
        bottomClipPxRef.current = 0;
        setTopClipPx((prev) => (prev === 0 ? prev : 0));
        setBottomClipPx((prev) => (prev === 0 ? prev : 0));
        return;
      }

      const rawViewBottom = viewTop + viewHeight;
      const lines = collectVisualLines(el, articleEl);

      // Top edge clip: hide any partially clipped top line so Page Up shows it completely next time
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
            nextTop = Math.max(0, Math.min(56, Math.ceil(safeTopCutY - viewTop)));
          }
        }
      }

      // Bottom edge clip: hide any partially clipped bottom line so Page Down shows it completely
      let nextBottom = 0;
      if (viewTop < maxScroll - 1.5) {
        const bottomCutIdx = lines.findIndex(
          (line) => line.top < rawViewBottom - 0.5 && line.bottom > rawViewBottom + 0.5
        );
        if (bottomCutIdx !== -1) {
          const bottomCutLine = lines[bottomCutIdx];
          if (bottomCutLine.top > viewTop + nextTop + 4) {
            const prevLineBottom = bottomCutIdx > 0 ? lines[bottomCutIdx - 1].bottom : viewTop;
            const safeBottomCutY = Math.max(prevLineBottom + 0.5, bottomCutLine.top - 1);
            nextBottom = Math.max(0, Math.min(56, Math.ceil(rawViewBottom - safeBottomCutY)));
          }
        }
      }

      topClipPxRef.current = nextTop;
      bottomClipPxRef.current = nextBottom;
      setTopClipPx((prev) => (prev === nextTop ? prev : nextTop));
      setBottomClipPx((prev) => (prev === nextBottom ? prev : nextBottom));
    };

    const scheduleEdgeClipUpdate = () => {
      if (clipRafRef.current !== null) {
        window.cancelAnimationFrame(clipRafRef.current);
      }
      clipRafRef.current = window.requestAnimationFrame(() => {
        clipRafRef.current = null;
        updateEdgeClips();
        reportReadProgress();
      });
    };

    const scrollReadToCharOffset = (charOffset: number): number => {
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return 0;

      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      let targetTop = 0;
      if (charOffset > 0) {
        const matchedTop = findScrollTopForCharOffset(el, articleEl, contentRef.current, charOffset);
        if (matchedTop !== null) {
          targetTop = Math.min(maxScroll, Math.max(0, Math.floor(matchedTop) - 4));
        } else {
          const ratio = charOffset / Math.max(1, contentRef.current.length);
          targetTop = Math.round(ratio * maxScroll);
        }
      }

      lastProgrammaticScrollAtRef.current = performance.now();
      el.scrollTop = targetTop;
      updateEdgeClips();
      return el.scrollTop;
    };

    const scrollEditToCharOffset = (charOffset: number): number => {
      const ta = textareaRef.current;
      if (!ta) return 0;
      const maxScroll = Math.max(0, ta.scrollHeight - ta.clientHeight);
      let targetTop = 0;
      if (charOffset > 0) {
        const measuredY = measureCharOffsetY(ta, contentRef.current, charOffset);
        const padTop = parseFloat(window.getComputedStyle(ta).paddingTop) || 0;
        targetTop = Math.min(maxScroll, Math.max(0, Math.round(measuredY - padTop)));
      }
      lastProgrammaticScrollAtRef.current = performance.now();
      ta.scrollTop = targetTop;
      return ta.scrollTop;
    };

    const applyTypographyAnchorIfLocked = () => {
      const anchor = pendingTypographyAnchorRef.current;
      if (!anchor) return false;
      if (Date.now() > typographyLockUntilRef.current) {
        clearTypographyLock();
        return false;
      }

      if (isEditingRef.current) {
        const ta = textareaRef.current;
        if (!ta) return false;
        const targetOffset = anchor.kind === 'top' ? 0 : anchor.charOffset;
        const nextTop = scrollEditToCharOffset(targetOffset);
        const readProgress = reportReadProgress();
        onViewStateChangeRef.current({
          mode: 'edit',
          scrollTop: nextTop,
          charOffset: targetOffset,
          readProgress,
        });
        return true;
      }

      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return false;
      if (measureReadOverflow()) return true;

      const targetOffset = anchor.kind === 'top' ? 0 : anchor.charOffset;
      const nextTop = scrollReadToCharOffset(targetOffset);
      const readProgress = reportReadProgress();
      onViewStateChangeRef.current({
        mode: 'read',
        scrollTop: nextTop,
        charOffset: targetOffset,
        readProgress,
      });
      return true;
    };

    useLayoutEffect(() => {
      if (isEditing) {
        topClipPxRef.current = 0;
        bottomClipPxRef.current = 0;
        setTopClipPx(0);
        setBottomClipPx(0);
      } else {
        measureReadOverflow();
      }
      if (!applyTypographyAnchorIfLocked() && !isEditing) {
        updateEdgeClips();
        reportReadProgress();
      }
    }, [isEditing, content, doc.id, fontSize, docFontFamily, articleOverflow]);

    useEffect(() => {
      if (isEditing) return;
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl || typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => {
        const needed = articleEl.offsetHeight + 24 > el.clientHeight;
        setArticleOverflow((prev) => (prev === needed ? prev : needed));
        if (pendingTypographyAnchorRef.current && Date.now() <= typographyLockUntilRef.current) {
          applyTypographyAnchorIfLocked();
        } else {
          scheduleEdgeClipUpdate();
        }
      });
      ro.observe(el);
      ro.observe(articleEl);
      return () => ro.disconnect();
    }, [isEditing, doc.id, fontSize, docFontFamily]);

    // Re-anchor & refresh edge clips when bundled @fontsource woff2 unicode-range subsets finish swapping in
    useEffect(() => {
      if (typeof document === 'undefined' || !('fonts' in document)) return;
      let cancelled = false;
      let rafId: number | null = null;
      const onFontSwap = () => {
        if (cancelled) return;
        if (rafId !== null) window.cancelAnimationFrame(rafId);
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          if (cancelled) return;
          if (pendingTypographyAnchorRef.current && Date.now() <= typographyLockUntilRef.current) {
            applyTypographyAnchorIfLocked();
          } else if (!isEditingRef.current) {
            measureReadOverflow();
            updateEdgeClips();
            reportReadProgress();
          }
        });
      };

      const fontSet = document.fonts;
      fontSet.addEventListener('loadingdone', onFontSwap);
      fontSet.ready.then(onFontSwap).catch(() => {});
      return () => {
        cancelled = true;
        fontSet.removeEventListener('loadingdone', onFontSwap);
        if (rafId !== null) window.cancelAnimationFrame(rafId);
      };
    }, [docFontFamily, fontSize, isEditing, doc.id]);

    // Restore saved reading progress (preferring canonical synced charOffset over raw scrollTop)
    useLayoutEffect(() => {
      if (restoredDocIdRef.current === doc.id) return;
      if (!isEditing && measureReadOverflow()) return;
      restoredDocIdRef.current = doc.id;

      const savedCharOffset =
        typeof doc.lastCharOffset === 'number' && Number.isFinite(doc.lastCharOffset)
          ? Math.max(0, Math.min(contentRef.current.length, Math.round(doc.lastCharOffset)))
          : null;

      if (savedCharOffset !== null && savedCharOffset > 0) {
        if (isEditing) {
          scrollEditToCharOffset(savedCharOffset);
          pendingTypographyAnchorRef.current = { kind: 'edit', charOffset: savedCharOffset };
        } else {
          scrollReadToCharOffset(savedCharOffset);
          pendingTypographyAnchorRef.current = { kind: 'read', charOffset: savedCharOffset };
        }
        typographyLockUntilRef.current = Date.now() + 1800;
        reportReadProgress();
        return;
      }

      const targetEl = isEditing ? textareaRef.current : scrollRef.current;
      if (!targetEl) return;
      lastProgrammaticScrollAtRef.current = performance.now();
      targetEl.scrollTop = savedCharOffset === 0 ? 0 : (doc.lastScrollTop ?? 0);
      if (!isEditing) {
        updateEdgeClips();
      }
      reportReadProgress();
    }, [doc.id, doc.lastCharOffset, doc.lastScrollTop, isEditing, articleOverflow]);

    // Apply deterministic charOffset scroll alignment right after Read <-> Edit mode toggle commits
    useLayoutEffect(() => {
      const anchor = pendingAnchorRef.current;
      if (!anchor) return;
      if (!isEditing && measureReadOverflow()) return;
      pendingAnchorRef.current = null;

      if (isEditing) {
        const ta = textareaRef.current;
        if (!ta) return;

        // Never auto-focus textarea on Browse -> Edit: keyboard must wait until user taps to place cursor
        const targetOffset = anchor.kind === 'top' ? 0 : anchor.charOffset;
        const targetTop = scrollEditToCharOffset(targetOffset);
        if (editAlignTimerRef.current !== null) {
          window.clearTimeout(editAlignTimerRef.current);
          editAlignTimerRef.current = null;
        }
        window.requestAnimationFrame(() => {
          if (isEditingRef.current && textareaRef.current) {
            scrollEditToCharOffset(targetOffset);
          }
        });
        editAlignTimerRef.current = window.setTimeout(() => {
          editAlignTimerRef.current = null;
          if (isEditingRef.current && textareaRef.current) {
            scrollEditToCharOffset(targetOffset);
          }
        }, 60);
        const readProgress = reportReadProgress();
        onViewStateChangeRef.current({
          mode: 'edit',
          scrollTop: targetTop,
          charOffset: targetOffset,
          readProgress,
        });
        return;
      }

      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return;

      const targetOffset = anchor.kind === 'top' ? 0 : anchor.charOffset;
      const targetTop = scrollReadToCharOffset(targetOffset);
      const readProgress = reportReadProgress();
      onViewStateChangeRef.current({
        mode: 'read',
        scrollTop: targetTop,
        charOffset: targetOffset,
        readProgress,
      });
    }, [isEditing, articleOverflow]);

    // Center the active cursor line in the screen area above the soft keyboard when it opens
    const centerCursorAboveKeyboard = (ta: HTMLTextAreaElement) => {
      if (document.activeElement !== ta) return;
      const vv = window.visualViewport;
      const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const taRect = ta.getBoundingClientRect();
      const visibleTop = Math.max(0, taRect.top);
      const visibleBottom = Math.min(taRect.bottom, vvBottom);
      const visibleHeight = Math.max(60, visibleBottom - visibleTop);

      const style = window.getComputedStyle(ta);
      const parsedLh = parseFloat(style.lineHeight);
      const lineHeight = Number.isFinite(parsedLh) && parsedLh > 0 ? parsedLh : fontSize * 1.62;
      const cursorIdx = ta.selectionStart ?? 0;
      const cursorY = measureCharOffsetY(ta, contentRef.current, cursorIdx);

      const desiredTop = cursorY + lineHeight * 0.5 - visibleHeight * 0.5;
      const maxScroll = Math.max(0, ta.scrollHeight - ta.clientHeight);
      const nextTop = Math.min(maxScroll, Math.max(0, Math.round(desiredTop)));

      lastProgrammaticScrollAtRef.current = performance.now();
      ta.scrollTop = nextTop;
      emitCurrentViewState();
    };

    const scheduleCenterCursorAboveKeyboard = (ta: HTMLTextAreaElement) => {
      if (keyboardCenterTimerRef.current !== null) {
        window.clearTimeout(keyboardCenterTimerRef.current);
      }
      window.requestAnimationFrame(() => {
        if (textareaRef.current === ta && document.activeElement === ta) {
          centerCursorAboveKeyboard(ta);
        }
      });
      keyboardCenterTimerRef.current = window.setTimeout(() => {
        keyboardCenterTimerRef.current = null;
        if (textareaRef.current === ta && document.activeElement === ta) {
          centerCursorAboveKeyboard(ta);
        }
      }, 150);
    };

    useEffect(() => {
      if (!isEditing) {
        wasKeyboardOpenRef.current = false;
        if (typeof window !== 'undefined') {
          baselineViewportHeightRef.current = Math.max(
            baselineViewportHeightRef.current,
            window.visualViewport?.height ?? window.innerHeight
          );
        }
        return;
      }

      const initH = window.visualViewport?.height ?? window.innerHeight;
      if (initH > baselineViewportHeightRef.current) {
        baselineViewportHeightRef.current = initH;
      }

      const handleViewportResize = () => {
        const currentH = window.visualViewport?.height ?? window.innerHeight;
        if (currentH > baselineViewportHeightRef.current) {
          baselineViewportHeightRef.current = currentH;
        }
        const kbOpen = baselineViewportHeightRef.current - currentH >= 100;
        const ta = textareaRef.current;
        if (kbOpen && !wasKeyboardOpenRef.current && ta && document.activeElement === ta) {
          scheduleCenterCursorAboveKeyboard(ta);
        }
        wasKeyboardOpenRef.current = kbOpen;
      };

      const vv = window.visualViewport;
      vv?.addEventListener('resize', handleViewportResize);
      window.addEventListener('resize', handleViewportResize);
      return () => {
        vv?.removeEventListener('resize', handleViewportResize);
        window.removeEventListener('resize', handleViewportResize);
        if (keyboardCenterTimerRef.current !== null) {
          window.clearTimeout(keyboardCenterTimerRef.current);
          keyboardCenterTimerRef.current = null;
        }
      };
    }, [isEditing, fontSize]);

    // Persist reading progress immediately when app is backgrounded or closed
    useEffect(() => {
      const persistNow = () => {
        if (debounceScrollRef.current) {
          window.clearTimeout(debounceScrollRef.current);
          debounceScrollRef.current = null;
        }
        emitCurrentViewState();
      };
      const onVisChange = () => {
        if (document.visibilityState === 'hidden') {
          persistNow();
        }
      };
      document.addEventListener('visibilitychange', onVisChange);
      window.addEventListener('pagehide', persistNow);
      return () => {
        document.removeEventListener('visibilitychange', onVisChange);
        window.removeEventListener('pagehide', persistNow);
      };
    }, []);

    const flushDraftNow = () => {
      if (debounceSaveRef.current) {
        window.clearTimeout(debounceSaveRef.current);
        debounceSaveRef.current = null;
      }
      if (hasUnsavedDraftRef.current) {
        hasUnsavedDraftRef.current = false;
        onSaveDraft({
          title: titleRef.current.trim() || '无标题文档',
          content: contentRef.current,
        });
      }
    };

    useEffect(() => {
      return () => {
        if (debounceSaveRef.current) window.clearTimeout(debounceSaveRef.current);
        if (debounceScrollRef.current) window.clearTimeout(debounceScrollRef.current);
        if (clipRafRef.current !== null) window.cancelAnimationFrame(clipRafRef.current);
        if (keyboardCenterTimerRef.current !== null) {
          window.clearTimeout(keyboardCenterTimerRef.current);
        }
        if (editAlignTimerRef.current !== null) {
          window.clearTimeout(editAlignTimerRef.current);
        }
      };
    }, []);

    useImperativeHandle(ref, () => ({
      captureTypographyAnchor() {
        const now = Date.now();
        if (pendingTypographyAnchorRef.current && now <= typographyLockUntilRef.current) {
          typographyLockUntilRef.current = now + 2500;
          return;
        }
        const activeEl = isEditingRef.current ? textareaRef.current : scrollRef.current;
        if (!activeEl) return;

        if (activeEl.scrollTop <= 10 || (!isEditingRef.current && !articleOverflowRef.current)) {
          pendingTypographyAnchorRef.current = { kind: 'top' };
          typographyLockUntilRef.current = now + 2500;
          return;
        }

        const charOffset = captureCurrentCharOffset();
        pendingTypographyAnchorRef.current = {
          kind: isEditingRef.current ? 'edit' : 'read',
          charOffset,
        };
        typographyLockUntilRef.current = now + 2500;
      },
      prepareModeSwitch(nextEditing: boolean) {
        if (debounceScrollRef.current) {
          window.clearTimeout(debounceScrollRef.current);
          debounceScrollRef.current = null;
        }
        if (editAlignTimerRef.current !== null) {
          window.clearTimeout(editAlignTimerRef.current);
          editAlignTimerRef.current = null;
        }
        clearTypographyLock();

        const activeScrollEl = isEditingRef.current ? textareaRef.current : scrollRef.current;
        if (!activeScrollEl) return;

        if (!isEditingRef.current && !articleOverflowRef.current) {
          const firstBlock = articleRef.current?.querySelector<HTMLElement>('[data-start-offset]');
          const firstStart = Number(firstBlock?.getAttribute('data-start-offset'));
          pendingAnchorRef.current =
            Number.isFinite(firstStart) && firstStart > 0
              ? { kind: 'to-edit', charOffset: firstStart }
              : { kind: 'top' };
          return;
        }

        if (activeScrollEl.scrollTop <= 10) {
          if (isEditingRef.current) {
            flushDraftNow();
            pendingAnchorRef.current = { kind: 'top' };
          } else {
            const firstBlock = articleRef.current?.querySelector<HTMLElement>('[data-start-offset]');
            const firstStart = Number(firstBlock?.getAttribute('data-start-offset'));
            pendingAnchorRef.current =
              Number.isFinite(firstStart) && firstStart > 0
                ? { kind: 'to-edit', charOffset: firstStart }
                : { kind: 'top' };
          }
          return;
        }

        const charOffset = captureCurrentCharOffset();
        if (isEditingRef.current) {
          flushDraftNow();
        }
        pendingAnchorRef.current = {
          kind: nextEditing ? 'to-edit' : 'to-read',
          charOffset,
        };
      },
      flushAndCaptureViewState() {
        flushDraftNow();
        const mode: 'read' | 'edit' = isEditingRef.current ? 'edit' : 'read';
        const activeEl = mode === 'edit' ? textareaRef.current : scrollRef.current;
        return {
          mode,
          scrollTop: activeEl?.scrollTop ?? 0,
          charOffset: captureCurrentCharOffset(),
          readProgress: computeReadProgress(),
        };
      },
      applyMarkdownFormat(kind: EditFormatKind) {
        const ta = textareaRef.current;
        if (!ta) return;

        const prevScrollTop = ta.scrollTop;
        const current = contentRef.current;
        const selStart = ta.selectionStart ?? current.length;
        const selEnd = ta.selectionEnd ?? selStart;

        const blockStart = current.lastIndexOf('\n', Math.max(0, selStart - 1)) + 1;
        const blockEndRaw = current.indexOf('\n', selEnd);
        const blockEnd = blockEndRaw === -1 ? current.length : blockEndRaw;
        const selectedBlock = current.slice(blockStart, blockEnd);
        const lines = selectedBlock.split('\n');

        const targetPrefix = kind === 'h1' ? '# ' : kind === 'h2' ? '## ' : '- ';

        const transformed = lines.map((line) => {
          const stripMatch = line.match(/^(\s*)(#{1,6}\s+|[-*+]\s+|\d+\.\s+)/);
          const indent = stripMatch ? stripMatch[1] : '';
          const existingPrefix = stripMatch ? stripMatch[2] : '';
          const body = stripMatch ? line.slice(stripMatch[0].length) : line;

          if (kind === 'h1' && existingPrefix === '# ') {
            return indent + body;
          }
          if (kind === 'h2' && existingPrefix === '## ') {
            return indent + body;
          }
          if (kind === 'ul' && /^[-*+]\s+$/.test(existingPrefix)) {
            return indent + body;
          }
          return `${indent}${targetPrefix}${body}`;
        });

        const replacedBlock = transformed.join('\n');
        const nextContent = current.slice(0, blockStart) + replacedBlock + current.slice(blockEnd);

        let nextSelStart = selStart;
        let nextSelEnd = selEnd;
        if (selStart === selEnd) {
          const delta = replacedBlock.length - selectedBlock.length;
          nextSelStart = Math.max(blockStart, selStart + delta);
          nextSelEnd = nextSelStart;
        } else {
          nextSelStart = blockStart;
          nextSelEnd = blockStart + replacedBlock.length;
        }

        // Anchor pre-format selection on current history entry before recording the formatted step
        const curEntry = historyRef.current[historyIndexRef.current];
        if (curEntry && curEntry.content === current) {
          curEntry.selStart = selStart;
          curEntry.selEnd = selEnd;
        }

        contentRef.current = nextContent;
        setContent(nextContent);
        recordEditHistory(nextContent, nextSelStart, nextSelEnd, false, 'other');
        scheduleSave(titleRef.current, nextContent);

        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          try {
            el.focus({ preventScroll: true });
            el.setSelectionRange(nextSelStart, nextSelEnd);
          } catch {
            // ignore focus errors on mobile
          }
          el.scrollTop = prevScrollTop;
        });
      },
      undo() {
        performUndo();
      },
      redo() {
        performRedo();
      },
    }));

    const scheduleSave = (nextTitle: string, nextContent: string) => {
      hasUnsavedDraftRef.current = true;
      if (debounceSaveRef.current) window.clearTimeout(debounceSaveRef.current);
      debounceSaveRef.current = window.setTimeout(() => {
        hasUnsavedDraftRef.current = false;
        onSaveDraft({
          title: nextTitle.trim() || '无标题文档',
          content: nextContent,
        });
      }, 300);
    };

    const handleScroll = () => {
      const el = isEditing ? textareaRef.current : scrollRef.current;
      if (!el) return;
      if (!isEditing) {
        scheduleEdgeClipUpdate();
      }
      if (
        performance.now() - lastProgrammaticScrollAtRef.current < 140 ||
        (pendingTypographyAnchorRef.current && Date.now() <= typographyLockUntilRef.current)
      ) {
        return;
      }
      if (debounceScrollRef.current) window.clearTimeout(debounceScrollRef.current);
      debounceScrollRef.current = window.setTimeout(() => {
        emitCurrentViewState();
      }, 180);
    };

    const evaluateSelectionForMdict = () => {
      if (isEditingRef.current || !hasActiveMdictRef.current) return;
      const articleEl = articleRef.current;
      const sel = window.getSelection();
      if (!articleEl || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        if (isMdictPopupOpenRef.current) {
          onClearMdictLookupRef.current?.();
        }
        return;
      }

      const range = sel.getRangeAt(0);
      const commonAncestor = range.commonAncestorContainer;
      if (!articleEl.contains(commonAncestor)) return;

      const word = extractEnglishLookupWord(sel.toString());
      if (!word) {
        if (isMdictPopupOpenRef.current) {
          onClearMdictLookupRef.current?.();
        }
        return;
      }

      const rect = range.getBoundingClientRect();
      const vh = window.innerHeight || 800;
      const wordMidY = rect.height > 0 ? (rect.top + rect.bottom) / 2 : vh * 0.25;
      const placement: 'top' | 'bottom' = wordMidY >= vh * 0.5 ? 'top' : 'bottom';
      onEnglishWordSelectedRef.current?.({ word, placement });
    };

    const scheduleMdictSelectionCheck = (delayMs: number) => {
      if (selectionCheckTimerRef.current) {
        window.clearTimeout(selectionCheckTimerRef.current);
      }
      selectionCheckTimerRef.current = window.setTimeout(() => {
        selectionCheckTimerRef.current = null;
        evaluateSelectionForMdict();
      }, delayMs);
    };

    useEffect(() => {
      const handleSelectionChange = () => {
        if (isEditingRef.current || !hasActiveMdictRef.current) return;

        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl?.closest('[data-mdict-popup="true"]')) return;

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          if (selectionCheckTimerRef.current) {
            window.clearTimeout(selectionCheckTimerRef.current);
            selectionCheckTimerRef.current = null;
          }
          if (isMdictPopupOpenRef.current) {
            onClearMdictLookupRef.current?.();
          }
          return;
        }

        // Evaluate promptly whether dragging native selection handles or releasing pointer
        scheduleMdictSelectionCheck(isPointerActiveRef.current ? 140 : 90);
      };

      document.addEventListener('selectionchange', handleSelectionChange);
      return () => {
        document.removeEventListener('selectionchange', handleSelectionChange);
        if (selectionCheckTimerRef.current) {
          window.clearTimeout(selectionCheckTimerRef.current);
          selectionCheckTimerRef.current = null;
        }
      };
    }, []);

    const hasActiveSelection = () => {
      const sel = window.getSelection();
      return Boolean(sel && !sel.isCollapsed && sel.toString().length > 0);
    };

    const handleReadPointerDownCapture = () => {
      if (isEditing) return;
      isPointerActiveRef.current = true;
      const now = performance.now();
      const active = hasActiveSelection() || isMdictPopupOpenRef.current;
      if (now - lastTouchStartAtRef.current < 40) {
        if (active) hadSelectionOnDownRef.current = true;
      } else {
        hadSelectionOnDownRef.current = active;
      }
      lastPointerDownAtRef.current = now;
    };

    const handleReadTouchStartCapture = () => {
      if (isEditing) return;
      isPointerActiveRef.current = true;
      const now = performance.now();
      const active = hasActiveSelection() || isMdictPopupOpenRef.current;
      if (now - lastPointerDownAtRef.current < 40) {
        if (active) hadSelectionOnDownRef.current = true;
      } else {
        hadSelectionOnDownRef.current = active;
      }
      lastTouchStartAtRef.current = now;
    };

    const handleReadPointerEnd = () => {
      isPointerActiveRef.current = false;
      if (!isEditingRef.current && hasActiveMdictRef.current) {
        scheduleMdictSelectionCheck(60);
      }
    };

    const performPageUp = () => {
      if (isEditingRef.current) return;
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return;

      const viewHeight = el.clientHeight;
      const currentTop = el.scrollTop;
      if (currentTop <= 0 || viewHeight <= 0) return;

      const currentBottom = currentTop + viewHeight;
      const effectiveTop = currentTop + topClipPxRef.current;
      const lines = collectVisualLines(el, articleEl);
      const EPS = 0.5;

      // Include any top-masked partial line on the next Page Up so no text is ever skipped
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
        targetScrollTop = Math.max(0, currentTop - viewHeight);
      }

      clearTypographyLock();
      lastProgrammaticScrollAtRef.current = performance.now();
      el.scrollTop = targetScrollTop;
      updateEdgeClips();
      emitCurrentViewState();
    };

    const performPageDown = () => {
      if (isEditingRef.current) return;
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return;

      const viewHeight = el.clientHeight;
      const maxScroll = Math.max(0, el.scrollHeight - viewHeight);
      const currentTop = el.scrollTop;
      if (currentTop >= maxScroll || viewHeight <= 0) return;

      const effectiveBottom = currentTop + viewHeight - bottomClipPxRef.current;
      const lines = collectVisualLines(el, articleEl);
      const EPS = 0.5;

      const firstIncompleteIdx = lines.findIndex((line) => line.bottom > effectiveBottom + EPS);
      if (firstIncompleteIdx === -1) return;

      const firstIncomplete = lines[firstIncompleteIdx];
      const prevComplete = firstIncompleteIdx > 0 ? lines[firstIncompleteIdx - 1] : null;
      const minSafeTop = prevComplete ? Math.ceil(prevComplete.bottom) : 0;
      const desiredTop = Math.floor(firstIncomplete.top) - 4;
      let targetScrollTop = Math.min(maxScroll, Math.max(minSafeTop, desiredTop));

      if (targetScrollTop <= currentTop) {
        targetScrollTop = Math.min(maxScroll, currentTop + viewHeight);
      }

      clearTypographyLock();
      lastProgrammaticScrollAtRef.current = performance.now();
      el.scrollTop = targetScrollTop;
      updateEdgeClips();
      emitCurrentViewState();
    };

    const performPageUpRef = useRef(performPageUp);
    performPageUpRef.current = performPageUp;
    const performPageDownRef = useRef(performPageDown);
    performPageDownRef.current = performPageDown;

    // Hardware volume keys (Android native + Web/E-ink keydown) turn pages in Browse mode
    useEffect(() => {
      if (isEditing || showOutline) {
        void setNativeVolumeKeyIntercept(false);
        return;
      }

      void setNativeVolumeKeyIntercept(true);
      const unsubscribeNative = subscribeNativeVolumeKeys((direction) => {
        if (document.querySelector('[role="dialog"]')) return;
        if (isMdictPopupOpenRef.current) {
          onClearMdictLookupRef.current?.();
        }
        if (direction === 'up') {
          performPageUpRef.current();
        } else {
          performPageDownRef.current();
        }
      });

      const handleKeyDown = (e: KeyboardEvent) => {
        if (document.querySelector('[role="dialog"]')) return;
        const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;

        if (e.key === 'AudioVolumeUp' || e.key === 'VolumeUp' || e.key === 'PageUp') {
          e.preventDefault();
          if (isMdictPopupOpenRef.current) onClearMdictLookupRef.current?.();
          performPageUpRef.current();
        } else if (e.key === 'AudioVolumeDown' || e.key === 'VolumeDown' || e.key === 'PageDown') {
          e.preventDefault();
          if (isMdictPopupOpenRef.current) onClearMdictLookupRef.current?.();
          performPageDownRef.current();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        unsubscribeNative();
        void setNativeVolumeKeyIntercept(false);
      };
    }, [isEditing, showOutline]);

    // 5-zone tap interaction in Read mode:
    // Top half: Left 1/3 => Page Up, Middle 1/3 => Outline TOC, Right 1/3 => Page Down
    // Bottom half: Left 1/3 => Page Up, Right 2/3 => Page Down
    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const hadSelectionOnDown = hadSelectionOnDownRef.current;
      hadSelectionOnDownRef.current = false;

      if (isEditing) return;

      const target = e.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select, [data-outline-modal="true"]')) return;

      // Do not turn page or open outline if text is currently selected OR this tap dismissed an active selection/popup
      if (hadSelectionOnDown || hasActiveSelection() || isMdictPopupOpenRef.current) {
        if (isMdictPopupOpenRef.current) {
          onClearMdictLookupRef.current?.();
        }
        return;
      }

      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const xRatio = (e.clientX - rect.left) / rect.width;
      const yRatio = (e.clientY - rect.top) / rect.height;

      if (yRatio < 0.5) {
        if (xRatio < 1 / 3) {
          performPageUp();
        } else if (xRatio <= 2 / 3) {
          if (blocks.length > 0) {
            setShowOutline(true);
          }
        } else {
          performPageDown();
        }
        return;
      }

      if (xRatio < 1 / 3) {
        performPageUp();
      } else {
        performPageDown();
      }
    };

    const { blocks, toc } = useMemo(
      () =>
        isEditing
          ? { blocks: [] as BlockNode[], toc: [] as TocItem[] }
          : parseDocumentBlocks(content),
      [content, isEditing]
    );

    const getActiveTocId = (): string | null => {
      if (toc.length === 0) return null;
      const scrollEl = scrollRef.current;
      const articleEl = articleRef.current;
      if (!scrollEl || !articleEl) return toc[0]?.id ?? null;

      const containerTop = scrollEl.getBoundingClientRect().top;
      const headingEls = articleEl.querySelectorAll<HTMLElement>('[data-toc-id]');
      let currentId: string | null = null;
      headingEls.forEach((el) => {
        const relTop = el.getBoundingClientRect().top - containerTop;
        if (relTop <= 56) {
          currentId = el.getAttribute('data-toc-id');
        }
      });
      return currentId ?? toc[0]?.id ?? null;
    };

    const jumpToElement = (el: HTMLElement | null) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl || !el) return;
      clearTypographyLock();
      const containerRect = scrollEl.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      const rawTop = elRect.top - containerRect.top + scrollEl.scrollTop - 4;
      const targetScrollTop = Math.min(maxScroll, Math.max(0, Math.round(rawTop)));
      lastProgrammaticScrollAtRef.current = performance.now();
      scrollEl.scrollTop = targetScrollTop;
      updateEdgeClips();
      emitCurrentViewState();
      setShowOutline(false);
    };

    const handleJumpToHeading = (tocId: string) => {
      const el = articleRef.current?.querySelector<HTMLElement>(`[data-toc-id="${tocId}"]`) ?? null;
      jumpToElement(el);
    };

    const renderInline = (raw: string) => {
      const tokens: Array<{ type: 'text' | 'code' | 'bold' | 'italic'; value: string }> = [];
      const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(raw)) !== null) {
        if (match.index > lastIndex) {
          tokens.push({ type: 'text', value: raw.slice(lastIndex, match.index) });
        }
        const m = match[0];
        if (m.startsWith('`')) tokens.push({ type: 'code', value: m.slice(1, -1) });
        else if (m.startsWith('**')) tokens.push({ type: 'bold', value: m.slice(2, -2) });
        else tokens.push({ type: 'italic', value: m.slice(1, -1) });
        lastIndex = regex.lastIndex;
      }
      if (lastIndex < raw.length) {
        tokens.push({ type: 'text', value: raw.slice(lastIndex) });
      }

      return tokens.map((token, idx) => {
        if (token.type === 'code') {
          return (
            <code
              key={idx}
              className="font-code text-[0.88em] px-1.5 py-0.5 rounded bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] dark:border-transparent text-[var(--fei-text-primary)]"
            >
              {token.value}
            </code>
          );
        }
        if (token.type === 'bold') {
          return (
            <strong key={idx} className="font-semibold text-[var(--fei-text-primary)]">
              {token.value}
            </strong>
          );
        }
        if (token.type === 'italic') {
          return <em key={idx}>{token.value}</em>;
        }
        return <React.Fragment key={idx}>{token.value}</React.Fragment>;
      });
    };

    const renderBlock = (block: BlockNode, idx: number) => {
      const offsetAttrs = {
        'data-block-idx': idx,
        'data-start-offset': block.startOffset,
        'data-end-offset': block.endOffset,
      };

      switch (block.type) {
        case 'heading': {
          if (block.level === 1) {
            return (
              <h1
                key={idx}
                data-toc-id={block.id}
                {...offsetAttrs}
                className="text-[1.15em] font-semibold leading-snug mt-5 mb-2 first:mt-0 text-[var(--fei-text-primary)] text-balance"
              >
                {block.text}
              </h1>
            );
          }
          if (block.level === 2) {
            return (
              <h2
                key={idx}
                data-toc-id={block.id}
                {...offsetAttrs}
                className="text-[1.03em] font-semibold leading-snug mt-4 mb-1.5 first:mt-0 text-[var(--fei-text-primary)]"
              >
                {block.text}
              </h2>
            );
          }
          return (
            <h3
              key={idx}
              data-toc-id={block.id}
              {...offsetAttrs}
              className="text-[1.03em] font-semibold leading-snug mt-4 mb-1.5 first:mt-0 text-[var(--fei-text-primary)]"
            >
              {block.text}
            </h3>
          );
        }
        case 'paragraph':
          return (
            <p key={idx} {...offsetAttrs} className="my-3 first:mt-0 whitespace-pre-line">
              {renderInline(block.text)}
            </p>
          );
        case 'blockquote':
          return (
            <blockquote
              key={idx}
              {...offsetAttrs}
              className="my-4 first:mt-0 px-4 py-3 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] dark:border-transparent text-[var(--fei-text-primary)] text-[0.94em]"
            >
              <span className="whitespace-pre-line">{renderInline(block.text)}</span>
            </blockquote>
          );
        case 'code':
          return (
            <pre
              key={idx}
              {...offsetAttrs}
              className="my-4 first:mt-0 p-4 max-w-full rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] dark:border-transparent overflow-x-auto text-[0.8125em] leading-relaxed font-code text-[var(--fei-text-primary)]"
            >
              <code>{block.code}</code>
            </pre>
          );
        case 'list':
          if (block.ordered) {
            return (
              <ol
                key={idx}
                {...offsetAttrs}
                className="my-3 first:mt-0 pl-5 list-decimal space-y-1.5 marker:text-[var(--fei-text-muted)]"
              >
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          }
          return (
            <ul
              key={idx}
              {...offsetAttrs}
              className="my-3 first:mt-0 pl-5 list-disc space-y-1.5 marker:text-[var(--fei-text-muted)]"
            >
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        case 'table':
          return (
            <div
              key={idx}
              {...offsetAttrs}
              className="my-4 first:mt-0 max-w-full w-full overflow-x-auto rounded-lg border border-[var(--fei-border)]"
            >
              <table className="w-full border-collapse text-[0.9em] leading-relaxed text-[var(--fei-text-primary)]">
                <thead>
                  <tr className="bg-[var(--fei-bg-subtle)] border-b border-[var(--fei-border)]">
                    {block.headers.map((header, colIdx) => {
                      const align = block.alignments[colIdx] || 'left';
                      const alignCls =
                        align === 'center'
                          ? 'text-center'
                          : align === 'right'
                            ? 'text-right'
                            : 'text-left';
                      return (
                        <th
                          key={colIdx}
                          className={`px-3 py-2 font-semibold border-r last:border-r-0 border-[var(--fei-border)] ${alignCls}`}
                        >
                          {renderInline(header)}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIdx) => (
                    <tr
                      key={rowIdx}
                      className="border-b last:border-b-0 border-[var(--fei-border)]"
                    >
                      {row.map((cell, colIdx) => {
                        const align = block.alignments[colIdx] || 'left';
                        const alignCls =
                          align === 'center'
                            ? 'text-center'
                            : align === 'right'
                              ? 'text-right'
                              : 'text-left';
                        return (
                          <td
                            key={colIdx}
                            className={`px-3 py-2 border-r last:border-r-0 border-[var(--fei-border)] align-middle ${alignCls}`}
                          >
                            {renderInline(cell)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        case 'hr':
          return (
            <hr
              key={idx}
              {...offsetAttrs}
              className="my-6 first:mt-0 border-t border-[var(--fei-border)]"
            />
          );
      }
    };

    const handleFetch = async () => {
      setFetching(true);
      setFetchError(null);
      try {
        await onFetchRemoteBody();
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : '拉取正文失败');
      } finally {
        setFetching(false);
      }
    };

    return (
      <div className="relative w-full h-full flex flex-col bg-[var(--fei-bg)] pt-6 overflow-x-hidden">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={content}
            onFocus={(e) => {
              const currentH = window.visualViewport?.height ?? window.innerHeight;
              if (baselineViewportHeightRef.current - currentH >= 100) {
                wasKeyboardOpenRef.current = true;
                scheduleCenterCursorAboveKeyboard(e.currentTarget);
              }
            }}
            onScroll={handleScroll}
            onWheel={clearTypographyLock}
            onTouchMove={clearTypographyLock}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && !e.altKey) {
                const key = e.key.toLowerCase();
                if (key === 'z') {
                  e.preventDefault();
                  if (e.shiftKey) {
                    performRedo();
                  } else {
                    performUndo();
                  }
                } else if (key === 'y' && !e.shiftKey) {
                  e.preventDefault();
                  performRedo();
                }
              }
            }}
            onChange={(e) => {
              clearTypographyLock();
              const prevVal = contentRef.current;
              const nextVal = e.target.value;
              const selStart = e.target.selectionStart ?? nextVal.length;
              const selEnd = e.target.selectionEnd ?? selStart;
              const delta = nextVal.length - prevVal.length;

              let editKind: 'typing' | 'delete' | 'other' = 'other';
              let coalesce = false;
              if (delta === 1) {
                const inserted = nextVal.slice(Math.max(0, selStart - 1), selStart);
                if (inserted && inserted !== '\n' && inserted !== '\r') {
                  editKind = 'typing';
                  coalesce = true;
                }
              } else if (delta === -1) {
                const removed = prevVal.slice(selStart, selStart + 1);
                if (removed && removed !== '\n' && removed !== '\r') {
                  editKind = 'delete';
                  coalesce = true;
                }
              }

              contentRef.current = nextVal;
              setContent(nextVal);
              recordEditHistory(nextVal, selStart, selEnd, coalesce, editKind);
              scheduleSave(titleRef.current, nextVal);
            }}
            placeholder="开始输入正文…"
            style={{
              fontSize: `${fontSize}px`,
              fontFamily: docFontFamily || 'var(--font-doc-body)',
            }}
            className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden overscroll-x-none pt-1 pb-[calc(100vh-110px)] px-[max(1.25rem,calc(50%-360px+1.25rem))] sm:px-[max(2rem,calc(50%-360px+2rem))] bg-transparent font-doc-body leading-[1.62] text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] break-words outline-none resize-none"
          />
        ) : (
          <div className="relative flex-1 min-h-0 w-full flex flex-col">
            <div
              ref={scrollRef}
              onPointerDownCapture={handleReadPointerDownCapture}
              onTouchStartCapture={handleReadTouchStartCapture}
              onTouchMove={clearTypographyLock}
              onWheel={clearTypographyLock}
              onPointerUp={handleReadPointerEnd}
              onTouchEnd={handleReadPointerEnd}
              onPointerCancel={() => {
                isPointerActiveRef.current = false;
              }}
              onTouchCancel={() => {
                isPointerActiveRef.current = false;
              }}
              onClick={handleContainerClick}
              onScroll={handleScroll}
              className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden overscroll-x-none"
            >
              <div
                className={`max-w-[720px] w-full min-w-0 mx-auto px-5 sm:px-8 min-h-full flex flex-col pt-1 ${
                  articleOverflow ? 'pb-[calc(100vh-110px)]' : 'pb-12'
                }`}
              >
                <article ref={articleRef} className="w-full min-w-0 font-doc-body">
                  {doc.syncStatus === 'remote-only' && !content ? (
                    <div className="py-12 text-center space-y-3">
                      <p className="text-[14px] text-[var(--fei-text-muted)]">
                        正文位于坚果云（约 {formatBytes(doc.byteSize)}），按需拉取后将缓存在本地。
                      </p>
                      {fetchError && (
                        <p className="text-[13px] text-[var(--fei-text-muted)]">{fetchError}</p>
                      )}
                      <button
                        type="button"
                        onClick={handleFetch}
                        disabled={fetching}
                        className="h-9 px-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] text-[13px] font-medium disabled:opacity-60"
                      >
                        <CloudDownload className="w-4 h-4" />
                        <span>{fetching ? '拉取中…' : '拉取正文'}</span>
                      </button>
                    </div>
                  ) : (
                    <div
                      style={{
                        fontSize: `${fontSize}px`,
                        fontFamily: docFontFamily || 'var(--font-doc-body)',
                      }}
                      className="leading-[1.62] text-[var(--fei-text-primary)] break-words"
                    >
                      {blocks.length === 0 ? (
                        <p className="text-[var(--fei-text-muted)]">
                          暂无内容，点击左下角浏览图标切换至编辑开始写作。
                        </p>
                      ) : (
                        blocks.map((b, i) => renderBlock(b, i))
                      )}
                    </div>
                  )}
                </article>
              </div>
            </div>

            {topClipPx > 0 && (
              <div
                aria-hidden="true"
                style={{ height: `${topClipPx}px` }}
                className="pointer-events-none absolute left-0 right-1.5 top-0 bg-[var(--fei-bg)] z-10"
              />
            )}

            {bottomClipPx > 0 && (
              <div
                aria-hidden="true"
                style={{ height: `${bottomClipPx}px` }}
                className="pointer-events-none absolute left-0 right-1.5 bottom-0 bg-[var(--fei-bg)] z-10"
              />
            )}
          </div>
        )}

        {!isEditing && showOutline && (
          <DocOutlineModal
            toc={toc}
            activeTocId={getActiveTocId()}
            onJumpToHeading={handleJumpToHeading}
            onClose={() => setShowOutline(false)}
          />
        )}
      </div>
    );
  }
);

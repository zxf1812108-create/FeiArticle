import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CloudDownload, Copy, Wifi, X } from 'lucide-react';
import { ArticleDoc } from '../types';
import { extractLookupWord } from '../utils/mdict';
import { DocImageBlock, DocImagePreviewPayload } from './DocImageBlock';
import { DocOutlineModal } from './DocOutlineModal';
import { BlockNode, formatBytes, parseDocumentBlocks, TocItem } from '../utils/textParser';
import { StorageDirectoryConfig } from '../utils/storage';
import {
  extractExactVisualLineText,
  findBlocksInClientYRange,
  findScrollTopForCharOffset,
  resolveReadViewportCharOffset,
} from '../utils/docAnchor';
import {
  NativeTouchPoint,
  setNativeVolumeKeyIntercept,
  subscribeNativeTouchMove,
  subscribeNativeTouchState,
  subscribeNativeVolumeKeys,
  VolumeKeyDirection,
} from '../utils/readerNative';
import { hyphenateEnglishWords } from '../utils/hyphenate';
import {
  compareDomPoints,
  DomRangePoints,
  expandRangeToFullSentences,
  getSentenceRangeAtPoint,
  getSentenceRangeAtViewportPoint,
  unionDomRanges,
} from '../utils/sentenceSelection';

export interface DocViewStateSnapshot {
  mode: 'read';
  scrollTop: number;
  charOffset: number;
  readProgress: number;
}

export interface DocReadMetrics {
  progress: number;
  progressDecimals: number;
  currentPage: number;
  totalPages: number;
}

export interface MinimalDocViewHandle {
  captureTypographyAnchor: () => void;
  flushAndCaptureViewState: () => DocViewStateSnapshot;
  turnPageDown: () => void;
  jumpToCharOffset: (charOffset: number) => void;
}

interface MinimalDocViewProps {
  doc: ArticleDoc;
  storageDir: StorageDirectoryConfig;
  docFolderName?: string | null;
  fontSize?: number;
  autoHyphenate?: boolean;
  hasActiveMdict?: boolean;
  isMdictPopupOpen?: boolean;
  isMdictLookupPending?: boolean;
  onEnglishWordSelected?: (payload: { word: string; placement: 'top' | 'bottom' }) => void;
  onClearMdictLookup?: () => void;
  onMdictPopupReleased?: () => void;
  onCopyFeedback?: (copied: boolean) => void;
  onMdictPopupVolumeKey?: (direction: VolumeKeyDirection) => void;
  onViewStateChange: (state: DocViewStateSnapshot) => void;
  onReadProgressChange?: (progress: number) => void;
  onReadMetricsChange?: (metrics: DocReadMetrics) => void;
  onFetchRemoteBody: () => Promise<void>;
  onReturnToTree: () => void;
}

interface CopyPopoverState {
  left: number;
  top: number;
  placement: 'above' | 'below';
  text: string;
}

interface VisualLine {
  top: number;
  bottom: number;
  text: string;
  isMedia?: boolean;
}

const DOC_LINE_HEIGHT = '1.62';
const DOC_LINE_HEIGHT_NUM = 1.62;
const VIRTUAL_THRESHOLD_BLOCKS = 200;
const CHUNK_SIZE = 40;
const OVERSCAN_CHUNKS = 3;

// Small LRU cache so reopening a large document from directory mode is instantaneous (0ms)
interface ParsedDocCacheEntry {
  docId: string;
  content: string;
  parsed: { blocks: BlockNode[]; toc: TocItem[] };
}
const parsedDocCache: ParsedDocCacheEntry[] = [];
const MAX_PARSED_CACHE = 4;

function getParsedDocumentCached(
  docId: string,
  content: string
): { blocks: BlockNode[]; toc: TocItem[] } {
  for (let i = 0; i < parsedDocCache.length; i++) {
    const entry = parsedDocCache[i];
    if (entry.docId === docId && entry.content === content) {
      if (i > 0) {
        parsedDocCache.splice(i, 1);
        parsedDocCache.unshift(entry);
      }
      return entry.parsed;
    }
  }
  const parsed = parseDocumentBlocks(content);
  parsedDocCache.unshift({ docId, content, parsed });
  if (parsedDocCache.length > MAX_PARSED_CACHE) {
    parsedDocCache.pop();
  }
  return parsed;
}

function findBlockIndexByCharOffset(blocks: BlockNode[], charOffset: number): number {
  const len = blocks.length;
  if (len === 0 || charOffset <= 0) return 0;
  let lo = 0;
  let hi = len - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid];
    if (charOffset >= b.startOffset && charOffset <= b.endOffset) {
      return mid;
    }
    if (b.startOffset <= charOffset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function estimateWrappedLines(text: string, fontSize: number, availWidth: number): number {
  const safeWidth = Math.max(180, availWidth);
  const emPerLine = Math.max(10, safeWidth / Math.max(10, fontSize));
  const hardLines = text.split('\n');
  let total = 0;
  for (let i = 0; i < hardLines.length; i++) {
    const line = hardLines[i];
    if (!line) {
      total += 1;
      continue;
    }
    let visualEms = 0;
    for (let j = 0; j < line.length; j++) {
      visualEms += line.charCodeAt(j) > 255 ? 1.0 : 0.56;
    }
    total += Math.max(1, Math.ceil(visualEms / emPerLine));
  }
  return Math.max(1, total);
}

function estimateBlockHeight(block: BlockNode, fontSize: number, contentWidth: number): number {
  const linePx = fontSize * DOC_LINE_HEIGHT_NUM;
  const safeWidth = Math.max(240, contentWidth);
  switch (block.type) {
    case 'heading': {
      const lines = estimateWrappedLines(block.text, fontSize * 1.08, safeWidth);
      return Math.round(lines * linePx * 1.1 + 26);
    }
    case 'paragraph': {
      const lines = estimateWrappedLines(block.text, fontSize, safeWidth);
      return Math.round(lines * linePx + 12);
    }
    case 'blockquote': {
      const lines = estimateWrappedLines(block.text, fontSize * 0.94, safeWidth - 32);
      return Math.round(lines * linePx + 36);
    }
    case 'code': {
      const lineCount = Math.max(1, block.code.split('\n').length);
      return Math.round(lineCount * fontSize * 1.32 + 48);
    }
    case 'list': {
      let total = 16;
      for (const item of block.items) {
        total += estimateWrappedLines(item, fontSize, safeWidth - 24) * linePx + 6;
      }
      return Math.round(total);
    }
    case 'table':
      return Math.round((block.rows.length + 1) * (fontSize * 1.8 + 16) + 28);
    case 'image':
      return 260;
    case 'hr':
      return 48;
  }
}

function estimateChunkHeight(
  blocks: BlockNode[],
  startIdx: number,
  endIdx: number,
  fontSize: number,
  contentWidth: number
): number {
  let sum = 0;
  for (let i = startIdx; i < endIdx; i++) {
    sum += estimateBlockHeight(blocks[i], fontSize, contentWidth);
  }
  return Math.max(40, Math.round(sum));
}

/**
 * Measure rendered visual lines ONLY within [minScrollY, maxScrollY] in scroll-content coordinates,
 * using binary search over rendered block elements so page turns take < 2ms on huge books.
 */
function collectVisualLinesInBand(
  scrollEl: HTMLElement,
  articleEl: HTMLElement,
  minScrollY: number,
  maxScrollY: number
): VisualLine[] {
  const containerRect = scrollEl.getBoundingClientRect();
  const baseOffset = scrollEl.scrollTop - containerRect.top;
  const minClientY = minScrollY - baseOffset;
  const maxClientY = maxScrollY - baseOffset;

  const candidateBlocks = findBlocksInClientYRange(articleEl, minClientY, maxClientY);
  if (candidateBlocks.length === 0) return [];

  const rawRects: VisualLine[] = [];
  const range = document.createRange();

  for (let b = 0; b < candidateBlocks.length; b++) {
    const blockEl = candidateBlocks[b];
    if (blockEl.tagName === 'HR') {
      const r = blockEl.getBoundingClientRect();
      if (r.height > 0) {
        rawRects.push({
          top: r.top + baseOffset,
          bottom: r.bottom + baseOffset,
          text: '',
        });
      }
      continue;
    }

    if (blockEl.getAttribute('data-image-block') === 'true') {
      const r = blockEl.getBoundingClientRect();
      if (r.height > 1 && r.width > 0 && r.bottom >= minClientY && r.top <= maxClientY) {
        rawRects.push({
          top: r.top + baseOffset,
          bottom: r.bottom + baseOffset,
          text: '',
          isMedia: true,
        });
      }
      continue;
    }

    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const val = node.nodeValue || '';
      if (val.trim().length > 0) {
        range.selectNodeContents(node);
        const clientRects = range.getClientRects();
        for (let i = 0; i < clientRects.length; i++) {
          const r = clientRects[i];
          if (r.height > 1 && r.width > 0 && r.bottom >= minClientY && r.top <= maxClientY) {
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
  }

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

function renderInline(raw: string, autoHyphenate = false) {
  const maybeHyphenate = (s: string) => (autoHyphenate ? hyphenateEnglishWords(s) : s);
  // Fast path: plain text without markdown inline markers skips regex loop entirely
  if (!raw.includes('`') && !raw.includes('*')) {
    return maybeHyphenate(raw);
  }
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
          className="font-code text-[0.88em] px-1.5 py-0.5 rounded bg-[var(--fei-bg-subtle)] border border-transparent eink:border-[var(--fei-border)] text-[var(--fei-text-primary)] hyphens-none"
        >
          {token.value}
        </code>
      );
    }
    if (token.type === 'bold') {
      return (
        <strong key={idx} className="font-semibold text-[var(--fei-text-primary)]">
          {maybeHyphenate(token.value)}
        </strong>
      );
    }
    if (token.type === 'italic') {
      return <em key={idx}>{maybeHyphenate(token.value)}</em>;
    }
    return <React.Fragment key={idx}>{maybeHyphenate(token.value)}</React.Fragment>;
  });
}

interface BlockRenderContext {
  storageDir: StorageDirectoryConfig;
  docFolderName?: string | null;
  onImageLoaded: () => void;
  onPreviewImage: (payload: DocImagePreviewPayload) => void;
}

function renderBlock(
  block: BlockNode,
  idx: number,
  isFirstOverall: boolean,
  autoHyphenate = false,
  renderCtx?: BlockRenderContext
) {
  const offsetAttrs = {
    'data-block-idx': idx,
    'data-start-offset': block.startOffset,
    'data-end-offset': block.endOffset,
  };
  const topZero = isFirstOverall ? 'mt-0' : '';
  const justifyCls = autoHyphenate ? 'text-justify' : '';
  const maybeHyphenate = (s: string) => (autoHyphenate ? hyphenateEnglishWords(s) : s);

  switch (block.type) {
    case 'heading': {
      if (block.level === 1) {
        return (
          <h1
            key={idx}
            data-toc-id={block.id}
            {...offsetAttrs}
            className={`text-[1.15em] font-semibold leading-snug ${topZero || 'mt-5'} mb-2 text-[var(--fei-text-primary)] text-balance`}
          >
            {maybeHyphenate(block.text)}
          </h1>
        );
      }
      if (block.level === 2) {
        return (
          <h2
            key={idx}
            data-toc-id={block.id}
            {...offsetAttrs}
            className={`text-[1.03em] font-semibold leading-snug ${topZero || 'mt-4'} mb-1.5 text-[var(--fei-text-primary)]`}
          >
            {maybeHyphenate(block.text)}
          </h2>
        );
      }
      return (
        <h3
          key={idx}
          data-toc-id={block.id}
          {...offsetAttrs}
          className={`text-[1em] font-semibold leading-snug ${topZero || 'mt-3.5'} mb-1.5 text-[var(--fei-text-primary)]`}
        >
          {maybeHyphenate(block.text)}
        </h3>
      );
    }
    case 'paragraph':
      return (
        <p
          key={idx}
          {...offsetAttrs}
          className={`${topZero || 'mt-3'} mb-3 whitespace-pre-line ${justifyCls}`}
        >
          {renderInline(block.text, autoHyphenate)}
        </p>
      );
    case 'blockquote':
      return (
        <blockquote
          key={idx}
          {...offsetAttrs}
          className={`${topZero || 'mt-4'} mb-4 px-4 py-3 rounded-lg bg-[var(--fei-bg-subtle)] border border-transparent eink:border-[var(--fei-border)] text-[var(--fei-text-primary)] text-[0.94em] ${justifyCls}`}
        >
          <span className="whitespace-pre-line">{renderInline(block.text, autoHyphenate)}</span>
        </blockquote>
      );
    case 'code':
      return (
        <pre
          key={idx}
          {...offsetAttrs}
          className={`${topZero || 'mt-4'} mb-4 p-4 max-w-full rounded-lg bg-[var(--fei-bg-subtle)] border border-transparent eink:border-[var(--fei-border)] overflow-x-auto text-[0.8125em] leading-relaxed font-code text-[var(--fei-text-primary)] hyphens-none text-left`}
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
            className={`${topZero || 'mt-3'} mb-3 pl-5 list-decimal space-y-1.5 marker:text-[var(--fei-text-muted)] ${justifyCls}`}
          >
            {block.items.map((item, i) => (
              <li key={i}>{renderInline(item, autoHyphenate)}</li>
            ))}
          </ol>
        );
      }
      return (
        <ul
          key={idx}
          {...offsetAttrs}
          className={`${topZero || 'mt-3'} mb-3 pl-5 list-disc space-y-1.5 marker:text-[var(--fei-text-muted)] ${justifyCls}`}
        >
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item, autoHyphenate)}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div
          key={idx}
          {...offsetAttrs}
          className={`${topZero || 'mt-4'} mb-4 max-w-full w-full overflow-x-auto rounded-lg border border-[var(--fei-border)]`}
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
                      {renderInline(header, autoHyphenate)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b last:border-b-0 border-[var(--fei-border)]">
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
                        {renderInline(cell, autoHyphenate)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'image':
      return renderCtx ? (
        <DocImageBlock
          key={idx}
          src={block.src}
          alt={block.alt}
          storageDir={renderCtx.storageDir}
          docFolderName={renderCtx.docFolderName}
          topZero={isFirstOverall}
          offsetAttrs={offsetAttrs}
          onImageLoaded={renderCtx.onImageLoaded}
          onPreview={renderCtx.onPreviewImage}
        />
      ) : null;
    case 'hr':
      return (
        <hr
          key={idx}
          {...offsetAttrs}
          className={`${topZero || 'mt-6'} mb-6 border-t border-[var(--fei-border)]`}
        />
      );
  }
}

// Memoized chunk prevents already-mounted chunks from re-rendering while sliding the virtual window
const DocBlockChunk = memo(function DocBlockChunk({
  blocks,
  startIdx,
  endIdx,
  autoHyphenate,
  storageDir,
  docFolderName,
  onImageLoaded,
  onPreviewImage,
}: {
  blocks: BlockNode[];
  startIdx: number;
  endIdx: number;
  autoHyphenate: boolean;
  storageDir: StorageDirectoryConfig;
  docFolderName?: string | null;
  onImageLoaded: () => void;
  onPreviewImage: (payload: DocImagePreviewPayload) => void;
}) {
  const renderCtx: BlockRenderContext = {
    storageDir,
    docFolderName,
    onImageLoaded,
    onPreviewImage,
  };
  const nodes: React.ReactNode[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    nodes.push(renderBlock(blocks[i], i, i === 0, autoHyphenate, renderCtx));
  }
  return <>{nodes}</>;
});

type PendingTypographyAnchor = { kind: 'top' } | { kind: 'read'; charOffset: number };

type PendingJumpTarget =
  | { kind: 'charOffset'; charOffset: number }
  | { kind: 'tocId'; tocId: string; blockIndex: number };

export const MinimalDocView = forwardRef<MinimalDocViewHandle, MinimalDocViewProps>(
  function MinimalDocView(
    {
      doc,
      storageDir,
      docFolderName = null,
      fontSize = 16,
      autoHyphenate = true,
      hasActiveMdict = false,
      isMdictPopupOpen = false,
      isMdictLookupPending = false,
      onEnglishWordSelected,
      onClearMdictLookup,
      onMdictPopupReleased,
      onCopyFeedback,
      onMdictPopupVolumeKey,
      onViewStateChange,
      onReadProgressChange,
      onReadMetricsChange,
      onFetchRemoteBody,
      onReturnToTree,
    },
    ref
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const articleRef = useRef<HTMLElement>(null);

    const [content, setContent] = useState(doc.content);
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [articleOverflow, setArticleOverflow] = useState(false);
    const articleOverflowRef = useRef(false);
    articleOverflowRef.current = articleOverflow;
    const [showOutline, setShowOutline] = useState(false);
    const showOutlineRef = useRef(false);
    showOutlineRef.current = showOutline;
    const [previewImage, setPreviewImage] = useState<DocImagePreviewPayload | null>(null);
    const [copyPopover, setCopyPopover] = useState<CopyPopoverState | null>(null);
    const copyPopoverRef = useRef<CopyPopoverState | null>(null);
    copyPopoverRef.current = copyPopover;
    const [topClipPx, setTopClipPx] = useState(0);
    const [bottomClipPx, setBottomClipPx] = useState(0);
    const topClipPxRef = useRef(0);
    const bottomClipPxRef = useRef(0);
    const clipRafRef = useRef<number | null>(null);
    const [contentWidth, setContentWidth] = useState<number>(() =>
      typeof window !== 'undefined' ? Math.min(680, Math.max(280, window.innerWidth - 40)) : 360
    );

    const contentRef = useRef(content);
    contentRef.current = content;

    const debounceScrollRef = useRef<number | null>(null);
    const pendingTypographyAnchorRef = useRef<PendingTypographyAnchor | null>(null);
    const typographyLockUntilRef = useRef(0);
    const lastProgrammaticScrollAtRef = useRef(0);
    const lastProgrammaticScrollTopRef = useRef(0);
    const restoredDocIdRef = useRef<string | null>(null);
    const hadSelectionOnDownRef = useRef(false);
    const lastPointerDownAtRef = useRef(0);
    const lastTouchStartAtRef = useRef(0);
    const nativeTouchActiveRef = useRef(false);
    const domTouchActiveRef = useRef(false);
    const domMouseActiveRef = useRef(false);
    const pressStartedInsidePopupRef = useRef(false);
    const lastPopupOpenedAtRef = useRef(0);
    const lastSelectionClearedOnReleaseAtRef = useRef(0);
    const selectionCheckTimerRef = useRef<number | null>(null);
    const clearSelectionTimerRef = useRef<number | null>(null);
    const lastReportedProgressRef = useRef<number>(-1);
    const lastReportedPageKeyRef = useRef<string>('');
    const gestureActiveRef = useRef(false);
    const gestureHadSelectionOnPressRef = useRef(false);
    const gesturePressStartRangeRef = useRef<{
      startContainer: Node;
      startOffset: number;
      endContainer: Node;
      endOffset: number;
    } | null>(null);
    const gestureInitialRangeRef = useRef<{
      startContainer: Node;
      startOffset: number;
      endContainer: Node;
      endOffset: number;
    } | null>(null);
    const anchorSentenceRangeRef = useRef<DomRangePoints | null>(null);
    const handleFixedSentenceRef = useRef<DomRangePoints | null>(null);
    const pressDownPointRef = useRef<NativeTouchPoint | null>(null);
    const sentenceSnapActiveRef = useRef(false);
    const lastSnappedRangeRef = useRef<DomRangePoints | null>(null);
    const isApplyingSentenceSnapRef = useRef(false);

    const hasActiveMdictRef = useRef(hasActiveMdict);
    hasActiveMdictRef.current = hasActiveMdict;
    const isMdictPopupOpenRef = useRef(isMdictPopupOpen);
    isMdictPopupOpenRef.current = isMdictPopupOpen;
    const isMdictLookupPendingRef = useRef(isMdictLookupPending);
    isMdictLookupPendingRef.current = isMdictLookupPending;
    const onEnglishWordSelectedRef = useRef(onEnglishWordSelected);
    onEnglishWordSelectedRef.current = onEnglishWordSelected;
    const onClearMdictLookupRef = useRef(onClearMdictLookup);
    onClearMdictLookupRef.current = onClearMdictLookup;
    const onMdictPopupReleasedRef = useRef(onMdictPopupReleased);
    onMdictPopupReleasedRef.current = onMdictPopupReleased;
    const onCopyFeedbackRef = useRef(onCopyFeedback);
    onCopyFeedbackRef.current = onCopyFeedback;
    const onMdictPopupVolumeKeyRef = useRef(onMdictPopupVolumeKey);
    onMdictPopupVolumeKeyRef.current = onMdictPopupVolumeKey;
    const onViewStateChangeRef = useRef(onViewStateChange);
    onViewStateChangeRef.current = onViewStateChange;
    const onReadProgressChangeRef = useRef(onReadProgressChange);
    onReadProgressChangeRef.current = onReadProgressChange;
    const onReadMetricsChangeRef = useRef(onReadMetricsChange);
    onReadMetricsChangeRef.current = onReadMetricsChange;

    const { blocks, toc } = useMemo(
      () => getParsedDocumentCached(doc.id, content),
      [doc.id, content]
    );

    const isVirtualized = blocks.length > VIRTUAL_THRESHOLD_BLOCKS;
    const chunkCount = isVirtualized ? Math.ceil(blocks.length / CHUNK_SIZE) : 0;

    // Estimated + measured chunk heights for large-doc virtualization
    const chunkEstimatedHeights = useMemo(() => {
      if (!isVirtualized) return [] as number[];
      const arr = new Array<number>(chunkCount);
      for (let c = 0; c < chunkCount; c++) {
        const start = c * CHUNK_SIZE;
        const end = Math.min(blocks.length, start + CHUNK_SIZE);
        arr[c] = estimateChunkHeight(blocks, start, end, fontSize, contentWidth);
      }
      return arr;
    }, [isVirtualized, chunkCount, blocks, fontSize, contentWidth]);

    const measuredChunkHeightsRef = useRef<number[]>([]);
    const chunkElMapRef = useRef<Map<number, HTMLDivElement>>(new Map());
    const pendingJumpRef = useRef<PendingJumpTarget | null>(null);
    const pendingWindowAnchorRef = useRef<{ chunkIdx: number; prevClientOffset: number } | null>(null);
    const prevLayoutMountedRangeRef = useRef<{ start: number; end: number } | null>(null);

    // Reset measured heights when document/typography/width changes
    const layoutKey = `${doc.id}|${content.length}|${fontSize}|${autoHyphenate ? '1' : '0'}|${Math.round(contentWidth)}`;
    const prevLayoutKeyRef = useRef(layoutKey);
    if (prevLayoutKeyRef.current !== layoutKey) {
      prevLayoutKeyRef.current = layoutKey;
      measuredChunkHeightsRef.current = [];
    }

    const computeInitialWindow = (): { start: number; end: number } => {
      if (!isVirtualized || chunkCount === 0) return { start: 0, end: 0 };
      const savedOffset =
        typeof doc.lastCharOffset === 'number' && Number.isFinite(doc.lastCharOffset)
          ? Math.max(0, Math.min(content.length, Math.round(doc.lastCharOffset)))
          : 0;
      const targetBlockIdx = findBlockIndexByCharOffset(blocks, savedOffset);
      const targetChunk = Math.floor(targetBlockIdx / CHUNK_SIZE);
      return {
        start: Math.max(0, targetChunk - OVERSCAN_CHUNKS),
        end: Math.min(chunkCount - 1, targetChunk + OVERSCAN_CHUNKS),
      };
    };

    const [mountedRange, setMountedRange] = useState<{ start: number; end: number }>(() =>
      computeInitialWindow()
    );
    const mountedRangeRef = useRef(mountedRange);
    mountedRangeRef.current = mountedRange;
    const prevChunkCountRef = useRef(chunkCount);

    useLayoutEffect(() => {
      const prev = prevChunkCountRef.current;
      prevChunkCountRef.current = chunkCount;
      if (!isVirtualized || chunkCount === 0) return;
      if (prev === 0 || mountedRangeRef.current.start >= chunkCount) {
        const next = computeInitialWindow();
        mountedRangeRef.current = next;
        setMountedRange(next);
      } else if (mountedRangeRef.current.end >= chunkCount) {
        const clamped = {
          start: Math.max(0, Math.min(mountedRangeRef.current.start, chunkCount - 1)),
          end: chunkCount - 1,
        };
        mountedRangeRef.current = clamped;
        setMountedRange(clamped);
      }
    }, [isVirtualized, chunkCount]);

    const getChunkHeight = (chunkIdx: number): number => {
      const measured = measuredChunkHeightsRef.current[chunkIdx];
      if (measured && measured > 0) return measured;
      return chunkEstimatedHeights[chunkIdx] ?? 1200;
    };

    const getChunkTopOffset = (chunkIdx: number): number => {
      let y = 0;
      for (let i = 0; i < chunkIdx; i++) {
        y += getChunkHeight(i);
      }
      return y;
    };

    const findChunkIndexAtY = (y: number): number => {
      if (chunkCount <= 0) return 0;
      let acc = 0;
      for (let i = 0; i < chunkCount; i++) {
        const h = getChunkHeight(i);
        if (y < acc + h) return i;
        acc += h;
      }
      return chunkCount - 1;
    };

    const measureMountedChunksNow = (): void => {
      if (!isVirtualized || chunkCount === 0) return;
      const cur = mountedRangeRef.current;
      const safeStart = Math.max(0, cur.start);
      const safeEnd = Math.min(chunkCount - 1, cur.end);
      for (let c = safeStart; c <= safeEnd; c++) {
        const node = chunkElMapRef.current.get(c);
        if (!node) continue;
        const measured = Math.round(node.offsetHeight);
        if (measured > 0) {
          measuredChunkHeightsRef.current[c] = measured;
        }
      }
    };
    const measureMountedChunksNowRef = useRef(measureMountedChunksNow);
    measureMountedChunksNowRef.current = measureMountedChunksNow;

    const syncMountedWindowToScroll = (scrollTop: number, viewHeight: number) => {
      if (!isVirtualized || chunkCount === 0) return;
      // Always sync live DOM chunk heights before computing window boundaries or unmounting top chunks
      measureMountedChunksNow();

      const cur = mountedRangeRef.current;
      const el = scrollRef.current;
      const safeViewHeight = Math.max(200, viewHeight);
      const safeStart = Math.max(0, Math.min(chunkCount - 1, cur.start));
      const safeEnd = Math.max(safeStart, Math.min(chunkCount - 1, cur.end));

      let firstVis = -1;
      let lastVis = -1;
      let needBottomExpand = false;
      let needTopExpand = false;
      let elRectTop = 0;

      let outBelowMounted = false;
      let outAboveMounted = false;

      // Primary path: inspect REAL DOM bounding rects of currently mounted chunks so stale estimates
      // or font/image reflows can NEVER strand the viewport inside an empty top/bottom spacer
      if (el) {
        elRectTop = el.getBoundingClientRect().top;
        const firstNode = chunkElMapRef.current.get(safeStart);
        const lastNode = chunkElMapRef.current.get(safeEnd);
        if (firstNode && lastNode) {
          const mountedTopClient = firstNode.getBoundingClientRect().top - elRectTop;
          const mountedBottomClient = lastNode.getBoundingClientRect().bottom - elRectTop;
          const overlapsViewport = mountedBottomClient >= -4 && mountedTopClient <= safeViewHeight + 4;

          if (overlapsViewport) {
            for (let c = safeStart; c <= safeEnd; c++) {
              const node = chunkElMapRef.current.get(c);
              if (!node) continue;
              const r = node.getBoundingClientRect();
              const topC = r.top - elRectTop;
              const bottomC = r.bottom - elRectTop;
              if (bottomC >= 0 && topC <= safeViewHeight) {
                if (firstVis === -1) firstVis = c;
                lastVis = c;
              }
            }
            if (firstVis === -1) {
              firstVis = mountedTopClient > safeViewHeight ? safeStart : safeEnd;
              lastVis = firstVis;
            }
            // Keep at least ~1.2 full screens of real DOM buffered both below and above viewport
            needBottomExpand = safeEnd < chunkCount - 1 && mountedBottomClient < safeViewHeight * 2.2;
            needTopExpand = safeStart > 0 && mountedTopClient > -safeViewHeight * 1.2;
          } else if (mountedBottomClient < -4) {
            outBelowMounted = true;
          } else if (mountedTopClient > safeViewHeight + 4) {
            outAboveMounted = true;
          }
        }
      }

      // Fallback path when viewport jumped completely outside the currently mounted DOM range
      if (firstVis === -1 || lastVis === -1) {
        firstVis = findChunkIndexAtY(Math.max(0, scrollTop));
        lastVis = findChunkIndexAtY(Math.max(0, scrollTop + safeViewHeight));
        if (outBelowMounted && safeEnd < chunkCount - 1) {
          firstVis = Math.max(firstVis, Math.min(chunkCount - 1, safeEnd + 1));
          lastVis = Math.max(lastVis, firstVis);
          needBottomExpand = true;
        } else if (outAboveMounted && safeStart > 0) {
          lastVis = Math.min(lastVis, Math.max(0, safeStart - 1));
          firstVis = Math.min(firstVis, lastVis);
          needTopExpand = true;
        }
      }

      const nearTop = firstVis <= safeStart && safeStart > 0;
      const nearBottom = lastVis >= safeEnd && safeEnd < chunkCount - 1;
      const outOfRange = firstVis > safeEnd || lastVis < safeStart;

      if (nearTop || nearBottom || outOfRange || needTopExpand || needBottomExpand) {
        let nextStart = Math.max(0, firstVis - OVERSCAN_CHUNKS);
        let nextEnd = Math.min(chunkCount - 1, lastVis + OVERSCAN_CHUNKS);

        // If DOM chunks are short and pixel buffer is still low even at OVERSCAN_CHUNKS, grow window further
        if (needBottomExpand && nextEnd <= safeEnd) {
          nextEnd = Math.min(chunkCount - 1, safeEnd + OVERSCAN_CHUNKS);
        }
        if (needTopExpand && nextStart >= safeStart) {
          nextStart = Math.max(0, safeStart - OVERSCAN_CHUNKS);
        }

        if (nextStart !== cur.start || nextEnd !== cur.end) {
          // Record a live DOM anchor chunk in the overlap so scroll position stays pixel-locked across window slides
          if (el && !pendingJumpRef.current) {
            const overlapStart = Math.max(safeStart, nextStart);
            const overlapEnd = Math.min(safeEnd, nextEnd);
            if (overlapStart <= overlapEnd) {
              const anchorIdx = Math.min(overlapEnd, Math.max(overlapStart, firstVis));
              const anchorNode = chunkElMapRef.current.get(anchorIdx);
              if (anchorNode) {
                pendingWindowAnchorRef.current = {
                  chunkIdx: anchorIdx,
                  prevClientOffset: anchorNode.getBoundingClientRect().top - elRectTop,
                };
              }
            }
          }
          mountedRangeRef.current = { start: nextStart, end: nextEnd };
          setMountedRange({ start: nextStart, end: nextEnd });
        }
      }
    };

    const clearTypographyLock = () => {
      pendingTypographyAnchorRef.current = null;
      typographyLockUntilRef.current = 0;
    };

    const computeReadMetrics = (): DocReadMetrics => {
      if (!contentRef.current.trim()) {
        return { progress: 0, progressDecimals: 0, currentPage: 1, totalPages: 1 };
      }
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) {
        return { progress: doc.readProgress ?? 0, progressDecimals: 0, currentPage: 1, totalPages: 1 };
      }

      const viewHeight = el.clientHeight;
      if (viewHeight <= 0) {
        return { progress: doc.readProgress ?? 0, progressDecimals: 0, currentPage: 1, totalPages: 1 };
      }

      const containerRect = el.getBoundingClientRect();
      const articleRect = articleEl.getBoundingClientRect();
      const baseOffset = el.scrollTop - containerRect.top;
      const articleBottom = articleRect.bottom + baseOffset;
      const effectiveMax = Math.max(0, articleBottom - viewHeight);

      if (effectiveMax <= 4) {
        return { progress: 100, progressDecimals: 0, currentPage: 1, totalPages: 1 };
      }

      // Effective height advanced per screen turn (accounting for edge-line alignment)
      const effectivePageStep = Math.max(100, viewHeight - Math.round(fontSize * 1.0));
      const totalPages = Math.max(2, 1 + Math.ceil(effectiveMax / effectivePageStep));

      // Minimum decimal places (0..3) such that 2 consecutive page turns ALWAYS change the displayed value
      const conservativePageStep = Math.max(80, viewHeight - Math.round(fontSize * 2.5));
      const twoPageDeltaPct = ((2 * conservativePageStep) / effectiveMax) * 100;
      let progressDecimals = 0;
      if (twoPageDeltaPct < 1) {
        if (twoPageDeltaPct >= 0.1) {
          progressDecimals = 1;
        } else if (twoPageDeltaPct >= 0.01) {
          progressDecimals = 2;
        } else {
          progressDecimals = 3;
        }
      }

      if (el.scrollTop <= 2) {
        return { progress: 0, progressDecimals, currentPage: 1, totalPages };
      }

      if (el.scrollTop >= effectiveMax - 4) {
        return { progress: 100, progressDecimals, currentPage: totalPages, totalPages };
      }

      const rawPct = Math.min(100, Math.max(0, (el.scrollTop / effectiveMax) * 100));
      const progress = Math.round(rawPct * 1000) / 1000;
      const currentPage = Math.min(
        totalPages,
        Math.max(1, 1 + Math.round(el.scrollTop / effectivePageStep))
      );

      return { progress, progressDecimals, currentPage, totalPages };
    };

    const computeReadProgress = (): number => computeReadMetrics().progress;

    const reportReadProgress = (): number => {
      const metrics = computeReadMetrics();
      if (metrics.progress !== lastReportedProgressRef.current) {
        lastReportedProgressRef.current = metrics.progress;
        onReadProgressChangeRef.current?.(metrics.progress);
      }
      const pageKey = `${metrics.progress}|${metrics.progressDecimals}|${metrics.currentPage}/${metrics.totalPages}`;
      if (pageKey !== lastReportedPageKeyRef.current) {
        lastReportedPageKeyRef.current = pageKey;
        onReadMetricsChangeRef.current?.(metrics);
      }
      return metrics.progress;
    };

    const captureCurrentCharOffset = (): number => {
      const raw = contentRef.current;
      if (!raw) return 0;

      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return 0;
      if (el.scrollTop <= 10) {
        return blocks[0]?.startOffset ?? 0;
      }

      const viewTop = el.scrollTop;
      const viewHeight = el.clientHeight;
      const lines = collectVisualLinesInBand(
        el,
        articleEl,
        Math.max(0, viewTop - 24),
        viewTop + Math.min(viewHeight, 260)
      );
      const effectiveViewTop = viewTop + topClipPxRef.current;
      let targetIdx = lines.findIndex((line) => {
        if (!line.text.trim()) return false;
        const lineHeight = Math.max(12, line.bottom - line.top);
        const minKeep = Math.min(10, Math.max(4, lineHeight * 0.45));
        return line.bottom > effectiveViewTop + minKeep;
      });
      if (targetIdx === -1) {
        for (let idx = lines.length - 1; idx >= 0; idx--) {
          if (lines[idx].text.trim()) {
            targetIdx = idx;
            break;
          }
        }
        if (targetIdx === -1) {
          // Fallback ratio when scrolled into bottom spacer
          const pct = computeReadProgress();
          return Math.round((pct / 100) * raw.length);
        }
      }

      const firstLine = lines[targetIdx];
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
      const el = scrollRef.current;
      const scrollTop = el?.scrollTop ?? 0;
      const charOffset = captureCurrentCharOffset();
      const readProgress = reportReadProgress();
      onViewStateChangeRef.current({ mode: 'read', scrollTop, charOffset, readProgress });
    };

    const scheduleEmitViewState = (delayMs = 380) => {
      if (debounceScrollRef.current) {
        window.clearTimeout(debounceScrollRef.current);
      }
      debounceScrollRef.current = window.setTimeout(() => {
        debounceScrollRef.current = null;
        emitCurrentViewState();
      }, delayMs);
    };

    // Sync local buffer when switching documents
    useEffect(() => {
      setContent(doc.content);
      contentRef.current = doc.content;
      hadSelectionOnDownRef.current = false;
      lastReportedProgressRef.current = -1;
      lastReportedPageKeyRef.current = '';
      restoredDocIdRef.current = null;
      pendingJumpRef.current = null;
      pendingWindowAnchorRef.current = null;
      prevLayoutMountedRangeRef.current = null;
      measuredChunkHeightsRef.current = [];
      clearTypographyLock();
      if (debounceScrollRef.current) {
        window.clearTimeout(debounceScrollRef.current);
        debounceScrollRef.current = null;
      }
      setFetchError(null);
      setArticleOverflow(false);
      setShowOutline(false);
      setCopyPopover(null);
      topClipPxRef.current = 0;
      bottomClipPxRef.current = 0;
      setTopClipPx(0);
      setBottomClipPx(0);
    }, [doc.id]);

    // Sync content when remote body arrives lazily or an external app edits the local file
    useEffect(() => {
      if (doc.content !== contentRef.current) {
        setContent(doc.content);
        contentRef.current = doc.content;
        restoredDocIdRef.current = null;
      }
    }, [doc.content]);

    // Measure whether rendered document overflows the reading viewport
    const measureReadOverflow = () => {
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return false;
      const needed = isVirtualized || articleEl.offsetHeight + 24 > el.clientHeight;
      if (needed !== articleOverflowRef.current) {
        articleOverflowRef.current = needed;
        setArticleOverflow(needed);
        return true;
      }
      return false;
    };

    // Mask partially clipped lines at both top and bottom edges of Browse viewport (fast edge-only scan)
    const updateEdgeClips = () => {
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
      const mediaBand = Math.max(72, Math.round(viewHeight * 0.78));

      // Top edge clip: scan lines/media touching the top edge
      let nextTop = 0;
      if (viewTop > 1.5) {
        const topLines = collectVisualLinesInBand(
          el,
          articleEl,
          Math.max(0, viewTop - mediaBand),
          viewTop + mediaBand
        );
        const topCutIdx = topLines.findIndex(
          (line) => line.top < viewTop - 0.5 && line.bottom > viewTop + 0.5
        );
        if (topCutIdx !== -1) {
          const topCutLine = topLines[topCutIdx];
          if (topCutLine.bottom < rawViewBottom - 4) {
            const nextLineTop =
              topCutIdx + 1 < topLines.length ? topLines[topCutIdx + 1].top : rawViewBottom;
            const safeTopCutY = Math.min(nextLineTop - 0.5, topCutLine.bottom + 1);
            const maxMask = topCutLine.isMedia ? Math.max(56, Math.floor(viewHeight * 0.5)) : 56;
            nextTop = Math.max(0, Math.min(maxMask, Math.ceil(safeTopCutY - viewTop)));
          }
        }
      }

      // Bottom edge clip: scan lines/media touching the bottom edge
      let nextBottom = 0;
      if (viewTop < maxScroll - 1.5) {
        const bottomLines = collectVisualLinesInBand(
          el,
          articleEl,
          Math.max(0, rawViewBottom - mediaBand),
          rawViewBottom + mediaBand
        );
        const bottomCutIdx = bottomLines.findIndex(
          (line) => line.top < rawViewBottom - 0.5 && line.bottom > rawViewBottom + 0.5
        );
        if (bottomCutIdx !== -1) {
          const bottomCutLine = bottomLines[bottomCutIdx];
          const minRemainingVisible = bottomCutLine.isMedia ? 64 : 4;
          if (bottomCutLine.top > viewTop + nextTop + minRemainingVisible) {
            const prevLineBottom =
              bottomCutIdx > 0 ? bottomLines[bottomCutIdx - 1].bottom : viewTop;
            const safeBottomCutY = Math.max(prevLineBottom + 0.5, bottomCutLine.top - 1);
            const maxMask = bottomCutLine.isMedia ? Math.max(56, Math.floor(viewHeight * 0.68)) : 56;
            nextBottom = Math.max(0, Math.min(maxMask, Math.ceil(rawViewBottom - safeBottomCutY)));
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

    const scheduleEdgeClipUpdateRef = useRef(scheduleEdgeClipUpdate);
    scheduleEdgeClipUpdateRef.current = scheduleEdgeClipUpdate;

    const handleDocImageLoaded = useCallback(() => {
      measureMountedChunksNowRef.current();
      scheduleEdgeClipUpdateRef.current();
    }, []);

    const handleDocImagePreview = useCallback((payload: DocImagePreviewPayload) => {
      setPreviewImage(payload);
    }, []);

    const ensureChunkMountedForBlock = (blockIdx: number): boolean => {
      if (!isVirtualized || chunkCount === 0) return false;
      const targetChunk = Math.min(
        chunkCount - 1,
        Math.max(0, Math.floor(blockIdx / CHUNK_SIZE))
      );
      const cur = mountedRangeRef.current;
      if (targetChunk >= cur.start && targetChunk <= cur.end) {
        return false;
      }
      const nextStart = Math.max(0, targetChunk - OVERSCAN_CHUNKS);
      const nextEnd = Math.min(chunkCount - 1, targetChunk + OVERSCAN_CHUNKS);
      mountedRangeRef.current = { start: nextStart, end: nextEnd };
      setMountedRange({ start: nextStart, end: nextEnd });
      return true;
    };

    const scrollReadToCharOffset = (charOffset: number): number => {
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return 0;

      if (isVirtualized && charOffset > 0) {
        const blockIdx = findBlockIndexByCharOffset(blocks, charOffset);
        if (ensureChunkMountedForBlock(blockIdx)) {
          pendingJumpRef.current = { kind: 'charOffset', charOffset };
          const estTop = getChunkTopOffset(Math.floor(blockIdx / CHUNK_SIZE));
          lastProgrammaticScrollAtRef.current = performance.now();
          el.scrollTop = estTop;
          lastProgrammaticScrollTopRef.current = el.scrollTop;
          return el.scrollTop;
        }
      }

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
      lastProgrammaticScrollTopRef.current = el.scrollTop;
      updateEdgeClips();
      return el.scrollTop;
    };

    const applyTypographyAnchorIfLocked = () => {
      const anchor = pendingTypographyAnchorRef.current;
      if (!anchor) return false;
      if (Date.now() > typographyLockUntilRef.current) {
        clearTypographyLock();
        return false;
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

    // Measure mounted virtual chunks synchronously & keep viewport pixel-locked across window slides
    useLayoutEffect(() => {
      if (!isVirtualized) {
        prevLayoutMountedRangeRef.current = null;
        return;
      }
      const el = scrollRef.current;
      if (!el) return;

      const prevRange = prevLayoutMountedRangeRef.current;
      const rangeChanged =
        prevRange !== null &&
        (prevRange.start !== mountedRange.start || prevRange.end !== mountedRange.end);
      prevLayoutMountedRangeRef.current = { start: mountedRange.start, end: mountedRange.end };

      const viewTop = el.scrollTop;
      const firstVisChunk = findChunkIndexAtY(Math.max(0, viewTop));
      let aboveDelta = 0;

      for (let c = mountedRange.start; c <= mountedRange.end; c++) {
        const node = chunkElMapRef.current.get(c);
        if (!node) continue;
        const measured = Math.round(node.offsetHeight);
        if (measured <= 0) continue;
        const prev = measuredChunkHeightsRef.current[c] || chunkEstimatedHeights[c] || 0;
        if (measured !== prev) {
          measuredChunkHeightsRef.current[c] = measured;
          // Only accumulate fallback aboveDelta for chunks that newly entered the mounted window above viewport
          const wasMounted = prevRange !== null && c >= prevRange.start && c <= prevRange.end;
          if (rangeChanged && !wasMounted && c < firstVisChunk && !pendingJumpRef.current) {
            aboveDelta += measured - prev;
          }
        }
      }

      // Prefer exact live DOM anchor compensation over estimated aboveDelta to prevent any drift/blank gap
      const winAnchor = pendingWindowAnchorRef.current;
      pendingWindowAnchorRef.current = null;
      if (winAnchor && !pendingJumpRef.current) {
        const anchorNode = chunkElMapRef.current.get(winAnchor.chunkIdx);
        if (anchorNode) {
          const elRectTop = el.getBoundingClientRect().top;
          const newClientOffset = anchorNode.getBoundingClientRect().top - elRectTop;
          const delta = Math.round(newClientOffset - winAnchor.prevClientOffset);
          if (Math.abs(delta) >= 1) {
            lastProgrammaticScrollAtRef.current = performance.now();
            el.scrollTop = Math.max(0, el.scrollTop + delta);
            lastProgrammaticScrollTopRef.current = el.scrollTop;
          }
        }
      } else if (aboveDelta !== 0 && !pendingJumpRef.current) {
        lastProgrammaticScrollAtRef.current = performance.now();
        el.scrollTop = Math.max(0, el.scrollTop + aboveDelta);
        lastProgrammaticScrollTopRef.current = el.scrollTop;
      }

      // Complete any deferred jump now that the target chunk is mounted in the DOM
      const jump = pendingJumpRef.current;
      if (jump && articleRef.current) {
        pendingJumpRef.current = null;
        if (jump.kind === 'tocId') {
          const targetEl = articleRef.current.querySelector<HTMLElement>(
            `[data-toc-id="${jump.tocId}"]`
          );
          if (targetEl) {
            const containerRect = el.getBoundingClientRect();
            const elRect = targetEl.getBoundingClientRect();
            const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
            const rawTop = elRect.top - containerRect.top + el.scrollTop - 4;
            lastProgrammaticScrollAtRef.current = performance.now();
            el.scrollTop = Math.min(maxScroll, Math.max(0, Math.round(rawTop)));
            lastProgrammaticScrollTopRef.current = el.scrollTop;
          }
        } else {
          scrollReadToCharOffset(jump.charOffset);
        }
        updateEdgeClips();
        reportReadProgress();
        return;
      }

      // Self-healing guard: if viewport is still not covered by real mounted DOM (e.g. ultra-short chunks),
      // immediately expand/re-center the window so a blank spacer page can never persist
      if (restoredDocIdRef.current === doc.id && el.clientHeight > 0) {
        const firstNode = chunkElMapRef.current.get(mountedRange.start);
        const lastNode = chunkElMapRef.current.get(mountedRange.end);
        if (firstNode && lastNode) {
          const elRectTop = el.getBoundingClientRect().top;
          const mountedTopClient = firstNode.getBoundingClientRect().top - elRectTop;
          const mountedBottomClient = lastNode.getBoundingClientRect().bottom - elRectTop;
          const uncoveredBottom =
            mountedRange.end < chunkCount - 1 && mountedBottomClient < el.clientHeight + 40;
          const uncoveredTop = mountedRange.start > 0 && mountedTopClient > -40;
          if (uncoveredBottom || uncoveredTop) {
            syncMountedWindowToScroll(el.scrollTop, el.clientHeight);
          }
        }
        updateEdgeClips();
        reportReadProgress();
      }
    }, [isVirtualized, mountedRange, fontSize, autoHyphenate, contentWidth, doc.id, content]);

    useLayoutEffect(() => {
      measureReadOverflow();
      if (!applyTypographyAnchorIfLocked()) {
        updateEdgeClips();
        reportReadProgress();
      }
    }, [content, doc.id, fontSize, autoHyphenate, articleOverflow]);

    useEffect(() => {
      if (typeof ResizeObserver === 'undefined') return;
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return;
      const ro = new ResizeObserver(() => {
        const nextW = Math.round(articleEl.clientWidth);
        if (nextW > 120) {
          setContentWidth((prev) => {
            if (Math.abs(prev - nextW) <= 6) return prev;
            // Capture reading anchor before contentWidth resets virtual chunk heights so scroll never drifts
            if (
              restoredDocIdRef.current === doc.id &&
              !pendingTypographyAnchorRef.current &&
              el.scrollTop > 10
            ) {
              const anchorOffset = captureCurrentCharOffset();
              pendingTypographyAnchorRef.current = { kind: 'read', charOffset: anchorOffset };
              typographyLockUntilRef.current = Date.now() + 1200;
            }
            return nextW;
          });
        }
        const needed = isVirtualized || articleEl.offsetHeight + 24 > el.clientHeight;
        setArticleOverflow((prev) => (prev === needed ? prev : needed));
        if (pendingTypographyAnchorRef.current && Date.now() <= typographyLockUntilRef.current) {
          applyTypographyAnchorIfLocked();
        } else {
          measureMountedChunksNowRef.current();
          scheduleEdgeClipUpdate();
        }
      });
      ro.observe(el);
      ro.observe(articleEl);
      return () => ro.disconnect();
    }, [doc.id, fontSize, isVirtualized]);

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
          measureMountedChunksNowRef.current();
          if (pendingTypographyAnchorRef.current && Date.now() <= typographyLockUntilRef.current) {
            applyTypographyAnchorIfLocked();
          } else {
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
    }, [fontSize, doc.id]);

    // Restore saved reading progress (preferring canonical synced charOffset over raw scrollTop)
    useLayoutEffect(() => {
      if (restoredDocIdRef.current === doc.id) return;
      if (measureReadOverflow()) return;
      restoredDocIdRef.current = doc.id;

      const savedCharOffset =
        typeof doc.lastCharOffset === 'number' && Number.isFinite(doc.lastCharOffset)
          ? Math.max(0, Math.min(contentRef.current.length, Math.round(doc.lastCharOffset)))
          : null;

      if (savedCharOffset !== null && savedCharOffset > 0) {
        scrollReadToCharOffset(savedCharOffset);
        pendingTypographyAnchorRef.current = { kind: 'read', charOffset: savedCharOffset };
        typographyLockUntilRef.current = Date.now() + 1800;
        reportReadProgress();
        return;
      }

      const targetEl = scrollRef.current;
      if (!targetEl) return;
      lastProgrammaticScrollAtRef.current = performance.now();
      targetEl.scrollTop = savedCharOffset === 0 ? 0 : (doc.lastScrollTop ?? 0);
      if (isVirtualized) {
        syncMountedWindowToScroll(targetEl.scrollTop, targetEl.clientHeight);
      }
      updateEdgeClips();
      reportReadProgress();
    }, [doc.id, doc.lastCharOffset, doc.lastScrollTop, articleOverflow, isVirtualized]);

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

    useEffect(() => {
      return () => {
        if (debounceScrollRef.current) window.clearTimeout(debounceScrollRef.current);
        if (clipRafRef.current !== null) window.cancelAnimationFrame(clipRafRef.current);
      };
    }, []);

    useImperativeHandle(ref, () => ({
      captureTypographyAnchor() {
        const now = Date.now();
        if (pendingTypographyAnchorRef.current && now <= typographyLockUntilRef.current) {
          typographyLockUntilRef.current = now + 2500;
          return;
        }
        const activeEl = scrollRef.current;
        if (!activeEl) return;

        if (activeEl.scrollTop <= 10 || !articleOverflowRef.current) {
          pendingTypographyAnchorRef.current = { kind: 'top' };
          typographyLockUntilRef.current = now + 2500;
          return;
        }

        const charOffset = captureCurrentCharOffset();
        pendingTypographyAnchorRef.current = {
          kind: 'read',
          charOffset,
        };
        typographyLockUntilRef.current = now + 2500;
      },
      flushAndCaptureViewState() {
        if (debounceScrollRef.current) {
          window.clearTimeout(debounceScrollRef.current);
          debounceScrollRef.current = null;
        }
        const activeEl = scrollRef.current;
        return {
          mode: 'read',
          scrollTop: activeEl?.scrollTop ?? 0,
          charOffset: captureCurrentCharOffset(),
          readProgress: computeReadProgress(),
        };
      },
      turnPageDown() {
        if (
          showOutlineRef.current ||
          isMdictPopupOpenRef.current ||
          document.querySelector('[role="dialog"]')
        ) {
          return;
        }
        performPageDownRef.current();
      },
      jumpToCharOffset(charOffset: number) {
        const clamped = Math.max(0, Math.min(contentRef.current.length, Math.round(charOffset)));
        if (clamped > 0) {
          scrollReadToCharOffset(clamped);
          pendingTypographyAnchorRef.current = { kind: 'read', charOffset: clamped };
          typographyLockUntilRef.current = Date.now() + 1500;
        } else {
          const targetEl = scrollRef.current;
          if (targetEl) {
            lastProgrammaticScrollAtRef.current = performance.now();
            targetEl.scrollTop = 0;
            lastProgrammaticScrollTopRef.current = 0;
            if (isVirtualized) {
              syncMountedWindowToScroll(0, targetEl.clientHeight);
            }
            updateEdgeClips();
          }
        }
        reportReadProgress();
      },
    }));

    const handleScroll = () => {
      const el = scrollRef.current;
      if (!el) return;
      if (isVirtualized) {
        syncMountedWindowToScroll(el.scrollTop, el.clientHeight);
      }
      scheduleEdgeClipUpdate();
      if (copyPopoverRef.current) {
        syncCopyPopover();
      }
      const isRecentProgrammatic = performance.now() - lastProgrammaticScrollAtRef.current < 140;
      if (isRecentProgrammatic) {
        return;
      }
      if (pendingTypographyAnchorRef.current) {
        if (Math.abs(el.scrollTop - lastProgrammaticScrollTopRef.current) > 8) {
          clearTypographyLock();
        } else if (Date.now() <= typographyLockUntilRef.current) {
          return;
        }
      }
      scheduleEmitViewState(260);
    };

    const isUserPressing = () =>
      nativeTouchActiveRef.current || domTouchActiveRef.current || domMouseActiveRef.current;

    const computeSelectionCopyPopover = (): CopyPopoverState | null => {
      const articleEl = articleRef.current;
      const scrollEl = scrollRef.current;
      const sel = window.getSelection();
      if (!articleEl || !scrollEl || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        return null;
      }

      const cleanText = sel.toString().replace(/\u00AD/g, '');
      if (!cleanText.trim()) return null;

      const range = sel.getRangeAt(0);
      if (!articleEl.contains(range.commonAncestorContainer)) {
        return null;
      }

      const clientRects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 0.5 && r.height > 0.5
      );
      const boundingRect = range.getBoundingClientRect();
      const rects =
        clientRects.length > 0 ? clientRects : boundingRect.height > 0 ? [boundingRect] : [];
      if (rects.length === 0) return null;

      const containerRect = scrollEl.getBoundingClientRect();
      let minTop = Infinity;
      let maxBottom = -Infinity;
      for (const r of rects) {
        if (r.top < minTop) minTop = r.top;
        if (r.bottom > maxBottom) maxBottom = r.bottom;
      }

      if (maxBottom < containerRect.top || minTop > containerRect.bottom) {
        return null;
      }

      let firstLineLeft = Infinity;
      let firstLineRight = -Infinity;
      for (const r of rects) {
        if (r.top <= minTop + 6) {
          if (r.left < firstLineLeft) firstLineLeft = r.left;
          if (r.right > firstLineRight) firstLineRight = r.right;
        }
      }

      const rawCenterX =
        firstLineLeft < firstLineRight
          ? (firstLineLeft + firstLineRight) / 2
          : (boundingRect.left + boundingRect.right) / 2;
      const vw = window.innerWidth || 360;
      const halfPopupWidth = 46;
      const left = Math.min(
        vw - halfPopupWidth - 12,
        Math.max(halfPopupWidth + 12, Math.round(rawCenterX))
      );

      const visibleTopAnchor = Math.max(minTop, containerRect.top);
      const minClearTop = Math.max(12, containerRect.top - 12) + 46;
      if (visibleTopAnchor >= minClearTop) {
        return {
          left,
          top: Math.round(visibleTopAnchor - 10),
          placement: 'above',
          text: cleanText,
        };
      }

      const vh = window.innerHeight || 800;
      const belowTop = Math.min(
        vh - 110,
        Math.round(Math.min(maxBottom, containerRect.bottom) + 10)
      );
      return {
        left,
        top: belowTop,
        placement: 'below',
        text: cleanText,
      };
    };

    const syncCopyPopover = () => {
      if (
        isUserPressing() ||
        isMdictPopupOpenRef.current ||
        isMdictLookupPendingRef.current ||
        showOutlineRef.current
      ) {
        setCopyPopover((prev) => (prev === null ? prev : null));
        return;
      }
      const next = computeSelectionCopyPopover();
      setCopyPopover((prev) => {
        if (prev === null && next === null) return prev;
        if (
          prev &&
          next &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.placement === next.placement &&
          prev.text === next.text
        ) {
          return prev;
        }
        return next;
      });
    };

    const handleCopyPopoverClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();

      const liveSel = window.getSelection()?.toString() || '';
      const textToCopy = (liveSel || copyPopoverRef.current?.text || '').replace(/\u00AD/g, '');
      setCopyPopover(null);

      let copied = false;
      if (textToCopy.trim()) {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(textToCopy);
            copied = true;
          }
        } catch {
          copied = false;
        }

        if (!copied) {
          try {
            const ta = document.createElement('textarea');
            ta.value = textToCopy;
            ta.setAttribute('readonly', 'true');
            ta.style.position = 'fixed';
            ta.style.top = '-9999px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, textToCopy.length);
            copied = document.execCommand('copy');
            document.body.removeChild(ta);
          } catch {
            copied = false;
          }
        }
      }

      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // ignore
      }
      lastSelectionClearedOnReleaseAtRef.current = performance.now();
      onCopyFeedbackRef.current?.(copied);
    };

    const cancelPendingSelectionClear = () => {
      if (clearSelectionTimerRef.current) {
        window.clearTimeout(clearSelectionTimerRef.current);
        clearSelectionTimerRef.current = null;
      }
    };

    const clearDocumentSelectionIfEligible = () => {
      if (isUserPressing() || !isMdictPopupOpenRef.current) return;
      const articleEl = articleRef.current;
      const sel = window.getSelection();
      if (!sel || (sel.isCollapsed && sel.rangeCount === 0)) return;
      if (articleEl && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (!articleEl.contains(range.commonAncestorContainer)) {
          return;
        }
        // If selection expanded beyond a single lookup word before release, keep it and close popup
        const word = extractLookupWord(sel.toString());
        if (!word) {
          onClearMdictLookupRef.current?.();
          return;
        }
      }
      try {
        sel.removeAllRanges();
        lastSelectionClearedOnReleaseAtRef.current = performance.now();
      } catch {
        // ignore
      }
    };

    const scheduleClearSelectionIfPopupOpen = (delayMs = 0) => {
      cancelPendingSelectionClear();
      if (delayMs <= 0) {
        clearDocumentSelectionIfEligible();
        // Follow-up pass in case WebView finishes touch-up selection finalization 1–2 frames later
        clearSelectionTimerRef.current = window.setTimeout(() => {
          clearSelectionTimerRef.current = null;
          clearDocumentSelectionIfEligible();
        }, 60);
        return;
      }
      clearSelectionTimerRef.current = window.setTimeout(() => {
        clearSelectionTimerRef.current = null;
        clearDocumentSelectionIfEligible();
      }, delayMs);
    };

    const evaluateSelectionForMdict = () => {
      if (!hasActiveMdictRef.current) return;
      const articleEl = articleRef.current;
      const sel = window.getSelection();
      if (!articleEl || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        return;
      }

      const range = sel.getRangeAt(0);
      const commonAncestor = range.commonAncestorContainer;
      if (!articleEl.contains(commonAncestor)) return;

      const word = extractLookupWord(sel.toString());
      if (!word) {
        // User expanded selection into a sentence / non-lookup text (e.g., to copy); dismiss lookup popup and keep selection
        if (isMdictPopupOpenRef.current) {
          onClearMdictLookupRef.current?.();
        }
        return;
      }

      const rect = range.getBoundingClientRect();
      const vh = window.innerHeight || 800;
      const wordMidY = rect.height > 0 ? (rect.top + rect.bottom) / 2 : vh * 0.25;
      const placement: 'top' | 'bottom' = wordMidY >= vh * 0.5 ? 'top' : 'bottom';
      lastPopupOpenedAtRef.current = performance.now();
      onEnglishWordSelectedRef.current?.({ word, placement });

      // Never clear selection while finger/mouse is still pressing the screen;
      // if already released and popup is open, clear on release/popup-open.
      if (!isUserPressing() && isMdictPopupOpenRef.current) {
        scheduleClearSelectionIfPopupOpen(40);
      }
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

    // Sync selection clearing / floating Copy popover whenever lookup popup or pending lookup state settles
    useEffect(() => {
      if (isMdictPopupOpen) {
        setCopyPopover(null);
        if (!isUserPressing()) {
          scheduleClearSelectionIfPopupOpen(30);
        }
        return;
      }
      if (isMdictLookupPending) {
        setCopyPopover(null);
        return;
      }
      if (!isUserPressing()) {
        syncCopyPopover();
      }
    }, [isMdictPopupOpen, isMdictLookupPending, showOutline]);

    useEffect(() => {
      const captureRangeSnap = (range: Range) => ({
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
      });

      const rangeMatchesSnap = (
        range: Range,
        snap: {
          startContainer: Node;
          startOffset: number;
          endContainer: Node;
          endOffset: number;
        } | null
      ): boolean =>
        Boolean(
          snap &&
            range.startContainer === snap.startContainer &&
            range.startOffset === snap.startOffset &&
            range.endContainer === snap.endContainer &&
            range.endOffset === snap.endOffset
        );

      const rangeMatchesDomPoints = (range: Range, pts: DomRangePoints | null): boolean =>
        Boolean(
          pts &&
            range.startContainer === pts.start.node &&
            range.startOffset === pts.start.offset &&
            range.endContainer === pts.end.node &&
            range.endOffset === pts.end.offset
        );

      const isSelectionBackward = (sel: Selection): boolean => {
        if (!sel.anchorNode || !sel.focusNode) return false;
        if (sel.anchorNode === sel.focusNode) {
          return sel.anchorOffset > sel.focusOffset;
        }
        return Boolean(
          sel.anchorNode.compareDocumentPosition(sel.focusNode) &
            Node.DOCUMENT_POSITION_PRECEDING
        );
      };

      const applySnappedSelection = (
        sel: Selection,
        target: DomRangePoints,
        backward: boolean
      ): boolean => {
        if (sel.rangeCount > 0 && rangeMatchesDomPoints(sel.getRangeAt(0), target)) {
          lastSnappedRangeRef.current = target;
          return false;
        }
        isApplyingSentenceSnapRef.current = true;
        lastSnappedRangeRef.current = target;
        try {
          if (typeof sel.setBaseAndExtent === 'function') {
            const base = backward ? target.end : target.start;
            const extent = backward ? target.start : target.end;
            sel.setBaseAndExtent(base.node, base.offset, extent.node, extent.offset);
          } else {
            const nextRange = document.createRange();
            nextRange.setStart(target.start.node, target.start.offset);
            nextRange.setEnd(target.end.node, target.end.offset);
            sel.removeAllRanges();
            sel.addRange(nextRange);
          }
          return true;
        } catch {
          return false;
        } finally {
          isApplyingSentenceSnapRef.current = false;
        }
      };

      const computeHandleFixedSentence = (
        articleEl: HTMLElement,
        range: Range,
        point: NativeTouchPoint | null
      ): DomRangePoints | null => {
        if (!point) return null;
        const rects = range.getClientRects();
        if (rects.length === 0) return null;
        const firstRect = rects[0];
        const lastRect = rects[rects.length - 1];
        const distStart = Math.hypot(point.x - firstRect.left, point.y - firstRect.bottom);
        const distEnd = Math.hypot(point.x - lastRect.right, point.y - lastRect.bottom);
        if (Math.min(distStart, distEnd) > 60) return null;
        if (distStart < distEnd) {
          // User grabbed the start handle -> end sentence stays fixed
          return getSentenceRangeAtPoint(articleEl, range.endContainer, range.endOffset, 'prev');
        }
        // User grabbed the end handle -> start sentence stays fixed
        return getSentenceRangeAtPoint(articleEl, range.startContainer, range.startOffset, 'next');
      };

      const beginSelectionGestureIfIdle = (point?: NativeTouchPoint) => {
        if (gestureActiveRef.current) {
          if (point && !pressDownPointRef.current) {
            pressDownPointRef.current = point;
            const articleEl = articleRef.current;
            const sel = window.getSelection();
            if (
              gestureHadSelectionOnPressRef.current &&
              !handleFixedSentenceRef.current &&
              articleEl &&
              sel &&
              !sel.isCollapsed &&
              sel.rangeCount > 0 &&
              articleEl.contains(sel.getRangeAt(0).commonAncestorContainer)
            ) {
              handleFixedSentenceRef.current = computeHandleFixedSentence(
                articleEl,
                sel.getRangeAt(0),
                point
              );
            }
          }
          return;
        }
        gestureActiveRef.current = true;
        pressDownPointRef.current = point ?? null;
        gestureInitialRangeRef.current = null;
        anchorSentenceRangeRef.current = null;
        handleFixedSentenceRef.current = null;
        sentenceSnapActiveRef.current = false;

        const articleEl = articleRef.current;
        const sel = window.getSelection();
        if (
          articleEl &&
          sel &&
          !sel.isCollapsed &&
          sel.rangeCount > 0 &&
          articleEl.contains(sel.getRangeAt(0).commonAncestorContainer)
        ) {
          const existingRange = sel.getRangeAt(0);
          gestureHadSelectionOnPressRef.current = true;
          gesturePressStartRangeRef.current = captureRangeSnap(existingRange);
          handleFixedSentenceRef.current = computeHandleFixedSentence(
            articleEl,
            existingRange,
            point ?? null
          );
        } else {
          gestureHadSelectionOnPressRef.current = false;
          gesturePressStartRangeRef.current = null;
        }
      };

      const resetSelectionGesture = () => {
        gestureActiveRef.current = false;
        pressDownPointRef.current = null;
        gestureHadSelectionOnPressRef.current = false;
        gesturePressStartRangeRef.current = null;
        gestureInitialRangeRef.current = null;
        anchorSentenceRangeRef.current = null;
        handleFixedSentenceRef.current = null;
        sentenceSnapActiveRef.current = false;
      };

      const dismissMdictForSentenceDrag = () => {
        if (selectionCheckTimerRef.current) {
          window.clearTimeout(selectionCheckTimerRef.current);
          selectionCheckTimerRef.current = null;
        }
        if (isMdictPopupOpenRef.current || isMdictLookupPendingRef.current) {
          onClearMdictLookupRef.current?.();
        }
        setCopyPopover((prev) => (prev === null ? prev : null));
      };

      const updateSentenceSelectionFromCoords = (clientX: number, clientY: number) => {
        if (!isUserPressing() || pressStartedInsidePopupRef.current) return;
        const articleEl = articleRef.current;
        const sel = window.getSelection();
        if (!articleEl || !sel) return;

        // Case 1: Fresh long-press-and-drag (anchorSentenceRangeRef captured on initial word selection)
        if (!gestureHadSelectionOnPressRef.current) {
          const anchorSentence = anchorSentenceRangeRef.current;
          if (!anchorSentence) return;

          if (!sentenceSnapActiveRef.current) {
            const downPt = pressDownPointRef.current;
            if (!downPt || Math.hypot(clientX - downPt.x, clientY - downPt.y) < 10) {
              return;
            }
            sentenceSnapActiveRef.current = true;
          }

          dismissMdictForSentenceDrag();
          const focusSentence = getSentenceRangeAtViewportPoint(articleEl, clientX, clientY);
          if (!focusSentence) return;
          const target = unionDomRanges(anchorSentence, focusSentence);
          const backward = compareDomPoints(focusSentence.start, anchorSentence.start) < 0;
          applySnappedSelection(sel, target, backward);
          return;
        }

        // Case 2: Dragging a selection handle on an existing selection
        const fixedSentence = handleFixedSentenceRef.current;
        if (!fixedSentence) return;

        if (!sentenceSnapActiveRef.current) {
          const downPt = pressDownPointRef.current;
          if (downPt && Math.hypot(clientX - downPt.x, clientY - downPt.y) < 8) {
            return;
          }
          sentenceSnapActiveRef.current = true;
        }

        dismissMdictForSentenceDrag();
        const focusSentence = getSentenceRangeAtViewportPoint(articleEl, clientX, clientY);
        if (!focusSentence) return;
        const target = unionDomRanges(fixedSentence, focusSentence);
        const backward = compareDomPoints(focusSentence.start, fixedSentence.start) < 0;
        applySnappedSelection(sel, target, backward);
      };

      const handleUserReleased = (releasePoint?: NativeTouchPoint) => {
        if (isUserPressing()) return;

        const wasSentenceSnapping = sentenceSnapActiveRef.current;
        const articleEl = articleRef.current;
        const sel = window.getSelection();

        // Final safeguard snap on finger lift using the exact release point or current selection
        if (wasSentenceSnapping && articleEl && sel) {
          const fixedBase = gestureHadSelectionOnPressRef.current
            ? handleFixedSentenceRef.current
            : anchorSentenceRangeRef.current;
          if (releasePoint && fixedBase) {
            const focusSentence = getSentenceRangeAtViewportPoint(
              articleEl,
              releasePoint.x,
              releasePoint.y
            );
            if (focusSentence) {
              const target = unionDomRanges(fixedBase, focusSentence);
              const backward = compareDomPoints(focusSentence.start, fixedBase.start) < 0;
              applySnappedSelection(sel, target, backward);
            }
          } else if (
            !sel.isCollapsed &&
            sel.rangeCount > 0 &&
            articleEl.contains(sel.getRangeAt(0).commonAncestorContainer)
          ) {
            const finalRange = sel.getRangeAt(0);
            if (!rangeMatchesDomPoints(finalRange, lastSnappedRangeRef.current)) {
              const snapped = expandRangeToFullSentences(articleEl, finalRange);
              if (snapped) {
                applySnappedSelection(sel, snapped, isSelectionBackward(sel));
              }
            }
          }
        }

        resetSelectionGesture();

        // Immediately inspect current selection in case user expanded into a sentence / multi-word phrase right before lifting
        if (articleEl && sel && !sel.isCollapsed && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (articleEl.contains(range.commonAncestorContainer)) {
            const word = wasSentenceSnapping ? null : extractLookupWord(sel.toString());
            if (!word) {
              if (selectionCheckTimerRef.current) {
                window.clearTimeout(selectionCheckTimerRef.current);
                selectionCheckTimerRef.current = null;
              }
              if (isMdictPopupOpenRef.current || isMdictLookupPendingRef.current) {
                onClearMdictLookupRef.current?.();
              }
              syncCopyPopover();
              // Follow-up pass in case WebView snaps selection rect 1–2 frames after finger lift
              cancelPendingSelectionClear();
              clearSelectionTimerRef.current = window.setTimeout(() => {
                clearSelectionTimerRef.current = null;
                syncCopyPopover();
              }, 60);
              return;
            }
          }
        }

        const startedInsidePopup = pressStartedInsidePopupRef.current;
        pressStartedInsidePopupRef.current = false;

        if (isMdictPopupOpenRef.current) {
          setCopyPopover(null);
          scheduleClearSelectionIfPopupOpen(0);
          if (!startedInsidePopup) {
            onMdictPopupReleasedRef.current?.();
          }
        } else if (hasActiveMdictRef.current) {
          if (selectionCheckTimerRef.current) {
            window.clearTimeout(selectionCheckTimerRef.current);
            selectionCheckTimerRef.current = null;
            evaluateSelectionForMdict();
            if (!startedInsidePopup) {
              onMdictPopupReleasedRef.current?.();
            }
          } else if (isMdictLookupPendingRef.current) {
            if (!startedInsidePopup) {
              onMdictPopupReleasedRef.current?.();
            }
          } else {
            syncCopyPopover();
            cancelPendingSelectionClear();
            clearSelectionTimerRef.current = window.setTimeout(() => {
              clearSelectionTimerRef.current = null;
              syncCopyPopover();
            }, 60);
          }
        } else {
          syncCopyPopover();
          cancelPendingSelectionClear();
          clearSelectionTimerRef.current = window.setTimeout(() => {
            clearSelectionTimerRef.current = null;
            syncCopyPopover();
          }, 60);
        }
      };

      const unsubscribeNativeTouch = subscribeNativeTouchState((pressed, point) => {
        nativeTouchActiveRef.current = pressed;
        if (pressed) {
          beginSelectionGestureIfIdle(point);
          cancelPendingSelectionClear();
        } else {
          // Physical finger lifted (ACTION_UP/ACTION_CANCEL); also clear any stale DOM touch flag left by WebView touchcancel
          domTouchActiveRef.current = false;
          handleUserReleased(point);
        }
      });

      // Live Android native touchMove coordinates keep expanding selection across unlimited sentences
      // even after WebView fires touchcancel or aborts native long-press-drag on programmatic selection snap
      const unsubscribeNativeTouchMove = subscribeNativeTouchMove((point) => {
        if (!nativeTouchActiveRef.current) return;
        updateSentenceSelectionFromCoords(point.x, point.y);
      });

      const onTouchStartGlobal = (e: TouchEvent) => {
        pressStartedInsidePopupRef.current =
          e.target instanceof Element && Boolean(e.target.closest('[data-mdict-popup="true"]'));
        domTouchActiveRef.current = e.touches.length > 0;
        if (domTouchActiveRef.current) {
          const t = e.touches[0];
          beginSelectionGestureIfIdle(t ? { x: t.clientX, y: t.clientY } : undefined);
          cancelPendingSelectionClear();
        }
      };

      const onTouchMoveGlobal = (e: TouchEvent) => {
        if (!domTouchActiveRef.current || e.touches.length !== 1) return;
        const t = e.touches[0];
        if (!t) return;
        updateSentenceSelectionFromCoords(t.clientX, t.clientY);
      };

      // IMPORTANT: Do NOT listen to touchcancel/pointercancel as "finger lifted".
      // On Android WebView & mobile Chrome, long-press text selection fires touchcancel/pointercancel
      // WHILE the user's finger is still physically pressing the screen.
      const onTouchEndGlobal = (e: TouchEvent) => {
        domTouchActiveRef.current = e.touches.length > 0;
        if (!domTouchActiveRef.current) {
          nativeTouchActiveRef.current = false;
          const t = e.changedTouches[0];
          handleUserReleased(t ? { x: t.clientX, y: t.clientY } : undefined);
        }
      };

      const onPointerDownGlobal = (e: PointerEvent) => {
        if (e.pointerType === 'touch') return;
        pressStartedInsidePopupRef.current =
          e.target instanceof Element && Boolean(e.target.closest('[data-mdict-popup="true"]'));
        domMouseActiveRef.current = true;
        beginSelectionGestureIfIdle({ x: e.clientX, y: e.clientY });
        cancelPendingSelectionClear();
      };

      const onPointerMoveGlobal = (e: PointerEvent) => {
        if (e.pointerType === 'touch' || !domMouseActiveRef.current) return;
        updateSentenceSelectionFromCoords(e.clientX, e.clientY);
      };

      const onPointerUpGlobal = (e: PointerEvent) => {
        if (e.pointerType === 'touch') return;
        domMouseActiveRef.current = false;
        handleUserReleased({ x: e.clientX, y: e.clientY });
      };

      const onWindowBlur = () => {
        nativeTouchActiveRef.current = false;
        domTouchActiveRef.current = false;
        domMouseActiveRef.current = false;
        pressStartedInsidePopupRef.current = false;
        resetSelectionGesture();
      };

      const handleSelectionChange = () => {
        if (isApplyingSentenceSnapRef.current) return;

        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl?.closest('[data-mdict-popup="true"]')) return;

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) {
          lastSnappedRangeRef.current = null;
          gestureInitialRangeRef.current = null;
          anchorSentenceRangeRef.current = null;
          sentenceSnapActiveRef.current = false;
          if (selectionCheckTimerRef.current) {
            window.clearTimeout(selectionCheckTimerRef.current);
            selectionCheckTimerRef.current = null;
          }
          setCopyPopover((prev) => (prev === null ? prev : null));
          return;
        }

        const articleEl = articleRef.current;
        const range = sel.getRangeAt(0);
        const insideArticle = Boolean(
          articleEl &&
            articleEl.contains(range.startContainer) &&
            articleEl.contains(range.endContainer)
        );

        // Sentence-level selection expansion when user drags finger/pointer or selection handles
        if (
          insideArticle &&
          articleEl &&
          isUserPressing() &&
          !pressStartedInsidePopupRef.current &&
          !rangeMatchesDomPoints(range, lastSnappedRangeRef.current)
        ) {
          if (!gestureHadSelectionOnPressRef.current) {
            // Fresh press: keep initial word selection intact (for single-word MDict lookup),
            // and snap to full sentences as soon as finger/pointer moves to expand selection.
            if (!gestureInitialRangeRef.current) {
              gestureInitialRangeRef.current = captureRangeSnap(range);
              anchorSentenceRangeRef.current = expandRangeToFullSentences(articleEl, range);
            } else if (!rangeMatchesSnap(range, gestureInitialRangeRef.current)) {
              sentenceSnapActiveRef.current = true;
              const backward = isSelectionBackward(sel);
              let target: DomRangePoints | null = null;
              if (
                anchorSentenceRangeRef.current &&
                sel.focusNode &&
                articleEl.contains(sel.focusNode)
              ) {
                const focusSentence = getSentenceRangeAtPoint(
                  articleEl,
                  sel.focusNode,
                  sel.focusOffset,
                  backward ? 'next' : 'prev'
                );
                if (focusSentence) {
                  target = unionDomRanges(anchorSentenceRangeRef.current, focusSentence);
                }
              }
              if (!target) {
                target = expandRangeToFullSentences(articleEl, range);
              }
              if (target) {
                applySnappedSelection(sel, target, backward);
              }
            }
          } else if (
            !gesturePressStartRangeRef.current ||
            !rangeMatchesSnap(range, gesturePressStartRangeRef.current)
          ) {
            // Existing selection adjusted via handles: lock fixed opposite sentence and snap to full sentences
            sentenceSnapActiveRef.current = true;
            if (!handleFixedSentenceRef.current && gesturePressStartRangeRef.current) {
              const prev = gesturePressStartRangeRef.current;
              const startUnchanged =
                range.startContainer === prev.startContainer &&
                range.startOffset === prev.startOffset;
              const endUnchanged =
                range.endContainer === prev.endContainer &&
                range.endOffset === prev.endOffset;
              if (startUnchanged && !endUnchanged) {
                handleFixedSentenceRef.current = getSentenceRangeAtPoint(
                  articleEl,
                  range.startContainer,
                  range.startOffset,
                  'next'
                );
              } else if (endUnchanged && !startUnchanged) {
                handleFixedSentenceRef.current = getSentenceRangeAtPoint(
                  articleEl,
                  range.endContainer,
                  range.endOffset,
                  'prev'
                );
              }
            }
            const backward = isSelectionBackward(sel);
            const target = expandRangeToFullSentences(articleEl, range);
            if (target) {
              applySnappedSelection(sel, target, backward);
            }
          }
        }

        // Hide floating Copy popover while actively dragging/adjusting selection handles
        if (isUserPressing()) {
          setCopyPopover((prev) => (prev === null ? prev : null));
        }

        if (!hasActiveMdictRef.current) {
          if (!isUserPressing()) {
            syncCopyPopover();
          }
          return;
        }

        // If user dragged selection into a sentence / non-lookup text, immediately close popup and keep selection
        if (insideArticle) {
          if (sentenceSnapActiveRef.current || !extractLookupWord(sel.toString())) {
            if (selectionCheckTimerRef.current) {
              window.clearTimeout(selectionCheckTimerRef.current);
              selectionCheckTimerRef.current = null;
            }
            if (isMdictPopupOpenRef.current || isMdictLookupPendingRef.current) {
              onClearMdictLookupRef.current?.();
            }
            if (!isUserPressing()) {
              syncCopyPopover();
            }
            return;
          }
        }

        scheduleMdictSelectionCheck(isUserPressing() ? 110 : 80);
      };

      window.addEventListener('touchstart', onTouchStartGlobal, { capture: true, passive: true });
      window.addEventListener('touchmove', onTouchMoveGlobal, { capture: true, passive: true });
      window.addEventListener('touchend', onTouchEndGlobal, { capture: true, passive: true });
      window.addEventListener('pointerdown', onPointerDownGlobal, true);
      window.addEventListener('pointermove', onPointerMoveGlobal, true);
      window.addEventListener('pointerup', onPointerUpGlobal, true);
      window.addEventListener('blur', onWindowBlur);
      document.addEventListener('selectionchange', handleSelectionChange);
      return () => {
        unsubscribeNativeTouch();
        unsubscribeNativeTouchMove();
        window.removeEventListener('touchstart', onTouchStartGlobal, true);
        window.removeEventListener('touchmove', onTouchMoveGlobal, true);
        window.removeEventListener('touchend', onTouchEndGlobal, true);
        window.removeEventListener('pointerdown', onPointerDownGlobal, true);
        window.removeEventListener('pointermove', onPointerMoveGlobal, true);
        window.removeEventListener('pointerup', onPointerUpGlobal, true);
        window.removeEventListener('blur', onWindowBlur);
        document.removeEventListener('selectionchange', handleSelectionChange);
        if (selectionCheckTimerRef.current) {
          window.clearTimeout(selectionCheckTimerRef.current);
          selectionCheckTimerRef.current = null;
        }
        cancelPendingSelectionClear();
      };
    }, []);

    const hasActiveSelection = () => {
      const sel = window.getSelection();
      return Boolean(sel && !sel.isCollapsed && sel.toString().length > 0);
    };

    const handleReadPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'touch') {
        domMouseActiveRef.current = true;
      }
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
      domTouchActiveRef.current = true;
      const now = performance.now();
      const active = hasActiveSelection() || isMdictPopupOpenRef.current;
      if (now - lastPointerDownAtRef.current < 40) {
        if (active) hadSelectionOnDownRef.current = true;
      } else {
        hadSelectionOnDownRef.current = active;
      }
      lastTouchStartAtRef.current = now;
    };

    const performPageUp = () => {
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return;

      const viewHeight = el.clientHeight;
      const currentTop = el.scrollTop;
      if (currentTop <= 0 || viewHeight <= 0) return;

      const currentBottom = currentTop + viewHeight;
      const effectiveTop = currentTop + topClipPxRef.current;
      const scanSpan = Math.max(260, Math.round(viewHeight * 0.85));
      // Scan lines & media blocks around the top edge — O(log K) & < 1ms
      const lines = collectVisualLinesInBand(
        el,
        articleEl,
        Math.max(0, currentTop - scanSpan),
        Math.min(currentBottom + 40, currentTop + scanSpan)
      );
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
      } else if (firstCompleteIdx === 0 && currentTop <= 160) {
        targetScrollTop = 0;
      }

      if (targetScrollTop >= currentTop) {
        targetScrollTop = Math.max(0, currentTop - viewHeight);
      }

      clearTypographyLock();
      lastProgrammaticScrollAtRef.current = performance.now();
      el.scrollTop = targetScrollTop;
      lastProgrammaticScrollTopRef.current = el.scrollTop;
      if (isVirtualized) {
        syncMountedWindowToScroll(el.scrollTop, viewHeight);
      }
      updateEdgeClips();
      reportReadProgress();
      // Defer heavier charOffset + storage persistence off the tap frame for instant zero-lag turns
      scheduleEmitViewState(420);
    };

    const performPageDown = () => {
      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return;

      const viewHeight = el.clientHeight;
      const maxScroll = Math.max(0, el.scrollHeight - viewHeight);
      const currentTop = el.scrollTop;
      if (currentTop >= maxScroll || viewHeight <= 0) return;

      const effectiveBottom = currentTop + viewHeight - bottomClipPxRef.current;
      const scanSpan = Math.max(220, Math.round(viewHeight * 0.85));
      // Scan lines & media blocks around the bottom edge — O(log K) & < 1ms
      const lines = collectVisualLinesInBand(
        el,
        articleEl,
        Math.max(0, effectiveBottom - scanSpan),
        effectiveBottom + scanSpan
      );
      const EPS = 0.5;

      const firstIncompleteIdx = lines.findIndex((line) => line.bottom > effectiveBottom + EPS);
      let targetScrollTop: number;

      if (firstIncompleteIdx === -1) {
        targetScrollTop = Math.min(maxScroll, currentTop + viewHeight);
      } else {
        const firstIncomplete = lines[firstIncompleteIdx];
        const prevComplete = firstIncompleteIdx > 0 ? lines[firstIncompleteIdx - 1] : null;
        const minSafeTop = prevComplete ? Math.ceil(prevComplete.bottom) : 0;
        const desiredTop = Math.floor(firstIncomplete.top) - 4;
        targetScrollTop = Math.min(maxScroll, Math.max(minSafeTop, desiredTop));
      }

      if (targetScrollTop <= currentTop) {
        targetScrollTop = Math.min(maxScroll, currentTop + viewHeight);
      }

      clearTypographyLock();
      lastProgrammaticScrollAtRef.current = performance.now();
      el.scrollTop = targetScrollTop;
      lastProgrammaticScrollTopRef.current = el.scrollTop;
      if (isVirtualized) {
        syncMountedWindowToScroll(el.scrollTop, viewHeight);
      }
      updateEdgeClips();
      reportReadProgress();
      // Defer heavier charOffset + storage persistence off the tap frame for instant zero-lag turns
      scheduleEmitViewState(420);
    };

    const performPageUpRef = useRef(performPageUp);
    performPageUpRef.current = performPageUp;
    const performPageDownRef = useRef(performPageDown);
    performPageDownRef.current = performPageDown;

    // Hardware volume keys: page dictionary popup when open, otherwise turn document pages
    useEffect(() => {
      if (showOutline) {
        void setNativeVolumeKeyIntercept(false);
        return;
      }

      void setNativeVolumeKeyIntercept(true);
      const unsubscribeNative = subscribeNativeVolumeKeys((direction) => {
        if (document.querySelector('[role="dialog"]')) return;
        if (isMdictPopupOpenRef.current) {
          onMdictPopupVolumeKeyRef.current?.(direction);
          return;
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
          if (isMdictPopupOpenRef.current) {
            onMdictPopupVolumeKeyRef.current?.('up');
            return;
          }
          performPageUpRef.current();
        } else if (e.key === 'AudioVolumeDown' || e.key === 'VolumeDown' || e.key === 'PageDown') {
          e.preventDefault();
          if (isMdictPopupOpenRef.current) {
            onMdictPopupVolumeKeyRef.current?.('down');
            return;
          }
          performPageDownRef.current();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        unsubscribeNative();
        void setNativeVolumeKeyIntercept(false);
      };
    }, [showOutline]);

    // 5-zone tap interaction in Read mode:
    // Top half: Left 1/3 => Page Up, Middle 1/3 => Outline TOC, Right 1/3 => Page Down
    // Bottom half: Left 1/2 => Page Up, Right 1/2 => Page Down
    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const hadSelectionOnDown = hadSelectionOnDownRef.current;
      hadSelectionOnDownRef.current = false;

      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          'button, a, img, input, textarea, select, [data-image-block="true"], [data-image-preview="true"], [data-outline-modal="true"], [data-copy-popover="true"]'
        )
      ) {
        return;
      }

      if (performance.now() - lastPopupOpenedAtRef.current < 350) {
        return;
      }

      const lastDownAt = Math.max(lastPointerDownAtRef.current, lastTouchStartAtRef.current);
      if (
        lastDownAt < lastSelectionClearedOnReleaseAtRef.current &&
        performance.now() - lastSelectionClearedOnReleaseAtRef.current < 300
      ) {
        return;
      }

      if (hadSelectionOnDown || hasActiveSelection() || isMdictPopupOpenRef.current) {
        if (isMdictPopupOpenRef.current) {
          onClearMdictLookupRef.current?.();
        }
        if (hasActiveSelection()) {
          try {
            window.getSelection()?.removeAllRanges();
          } catch {
            // ignore
          }
        }
        setCopyPopover(null);
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

      if (xRatio < 0.5) {
        performPageUp();
      } else {
        performPageDown();
      }
    };

    const getActiveTocId = (): string | null => {
      if (toc.length === 0) return null;
      const scrollEl = scrollRef.current;
      const articleEl = articleRef.current;
      if (!scrollEl || !articleEl) return toc[0]?.id ?? null;

      // Fast offset-based binary search works for both virtualized and non-virtualized docs
      const curOffset = captureCurrentCharOffset();
      let lo = 0;
      let hi = toc.length - 1;
      let active: string | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const itemOffset = toc[mid].startOffset ?? 0;
        if (itemOffset <= curOffset + 64) {
          active = toc[mid].id;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return active ?? toc[0]?.id ?? null;
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
      lastProgrammaticScrollTopRef.current = scrollEl.scrollTop;
      updateEdgeClips();
      emitCurrentViewState();
      setShowOutline(false);
    };

    const handleJumpToHeading = (tocId: string) => {
      const item = toc.find((t) => t.id === tocId);
      if (isVirtualized && item && typeof item.blockIndex === 'number') {
        const didSlide = ensureChunkMountedForBlock(item.blockIndex);
        if (didSlide) {
          pendingJumpRef.current = { kind: 'tocId', tocId, blockIndex: item.blockIndex };
          const scrollEl = scrollRef.current;
          if (scrollEl) {
            lastProgrammaticScrollAtRef.current = performance.now();
            scrollEl.scrollTop = getChunkTopOffset(Math.floor(item.blockIndex / CHUNK_SIZE));
            lastProgrammaticScrollTopRef.current = scrollEl.scrollTop;
          }
          setShowOutline(false);
          return;
        }
      }
      const el = articleRef.current?.querySelector<HTMLElement>(`[data-toc-id="${tocId}"]`) ?? null;
      jumpToElement(el);
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

    // Precompute top/bottom spacer heights for virtualized chunks
    let topSpacerHeight = 0;
    let bottomSpacerHeight = 0;
    if (isVirtualized && chunkCount > 0) {
      for (let i = 0; i < mountedRange.start; i++) {
        topSpacerHeight += getChunkHeight(i);
      }
      for (let i = mountedRange.end + 1; i < chunkCount; i++) {
        bottomSpacerHeight += getChunkHeight(i);
      }
    }

    const mountedChunkIndices: number[] = [];
    if (isVirtualized && chunkCount > 0) {
      const safeEnd = Math.min(chunkCount - 1, mountedRange.end);
      for (let c = Math.max(0, mountedRange.start); c <= safeEnd; c++) {
        mountedChunkIndices.push(c);
      }
    }

    return (
      <div className="relative w-full h-full flex flex-col bg-[var(--fei-bg)] pt-6 overflow-x-hidden">
        <div className="relative flex-1 min-h-0 w-full flex flex-col">
          <div
            ref={scrollRef}
            onPointerDownCapture={handleReadPointerDownCapture}
            onTouchStartCapture={handleReadTouchStartCapture}
            onTouchMove={clearTypographyLock}
            onWheel={clearTypographyLock}
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
                    {doc.cloudBodySynced ? (
                      <>
                        <p className="text-[14px] text-[var(--fei-text-muted)]">
                          正文已存云端（约 {formatBytes(doc.byteSize)}），点击拉取后将缓存在本机。
                        </p>
                        {fetchError && (
                          <p className="text-[13px] text-[var(--fei-text-muted)]">{fetchError}</p>
                        )}
                        <button
                          type="button"
                          onClick={handleFetch}
                          disabled={fetching}
                          className={`h-9 px-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[13px] transition-colors ${
                            fetching
                              ? 'text-[var(--fei-text-muted)]/65 cursor-wait'
                              : 'text-[var(--fei-text-primary)] font-medium hover:bg-[var(--fei-bg-selected)] active:bg-[var(--fei-bg-selected)] cursor-pointer'
                          }`}
                        >
                          <CloudDownload className="w-4 h-4" />
                          <span>{fetching ? '拉取中…' : '从云端拉取正文'}</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="text-[14px] text-[var(--fei-text-muted)]">
                          本机暂无此文档正文（约 {formatBytes(doc.byteSize)}），两台设备同 Wi-Fi 停留在目录界面即可自动同步。
                        </p>
                        <button
                          type="button"
                          onClick={onReturnToTree}
                          className="h-9 px-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[13px] text-[var(--fei-text-primary)] font-medium hover:bg-[var(--fei-bg-selected)] active:bg-[var(--fei-bg-selected)] transition-colors cursor-pointer"
                        >
                          <Wifi className="w-4 h-4" />
                          <span>返回目录自动同步</span>
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <div
                    lang={autoHyphenate ? 'en' : undefined}
                    style={{
                      fontSize: `${fontSize}px`,
                      lineHeight: DOC_LINE_HEIGHT,
                      hyphens: autoHyphenate ? 'auto' : 'none',
                      WebkitHyphens: autoHyphenate ? 'auto' : 'none',
                    }}
                    className="text-[var(--fei-text-primary)] break-words"
                  >
                    {blocks.length === 0 ? (
                      <p className="text-[var(--fei-text-muted)]">暂无内容</p>
                    ) : isVirtualized ? (
                      <>
                        {topSpacerHeight > 0 && (
                          <div aria-hidden="true" style={{ height: `${topSpacerHeight}px` }} />
                        )}
                        {mountedChunkIndices.map((chunkIdx) => {
                          const startIdx = chunkIdx * CHUNK_SIZE;
                          const endIdx = Math.min(blocks.length, startIdx + CHUNK_SIZE);
                          return (
                            <div
                              key={chunkIdx}
                              data-chunk-idx={chunkIdx}
                              ref={(node) => {
                                if (node) {
                                  chunkElMapRef.current.set(chunkIdx, node);
                                } else {
                                  chunkElMapRef.current.delete(chunkIdx);
                                }
                              }}
                              className="flow-root"
                            >
                              <DocBlockChunk
                                blocks={blocks}
                                startIdx={startIdx}
                                endIdx={endIdx}
                                autoHyphenate={autoHyphenate}
                                storageDir={storageDir}
                                docFolderName={docFolderName}
                                onImageLoaded={handleDocImageLoaded}
                                onPreviewImage={handleDocImagePreview}
                              />
                            </div>
                          );
                        })}
                        {bottomSpacerHeight > 0 && (
                          <div aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }} />
                        )}
                      </>
                    ) : (
                      blocks.map((b, i) =>
                        renderBlock(b, i, i === 0, autoHyphenate, {
                          storageDir,
                          docFolderName,
                          onImageLoaded: handleDocImageLoaded,
                          onPreviewImage: handleDocImagePreview,
                        })
                      )
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

        {copyPopover && !isMdictPopupOpen && !showOutline && (
          <div
            data-copy-popover="true"
            style={{
              left: `${copyPopover.left}px`,
              top: `${copyPopover.top}px`,
              transform:
                copyPopover.placement === 'above'
                  ? 'translate(-50%, -100%)'
                  : 'translate(-50%, 0)',
            }}
            onContextMenu={(e) => e.preventDefault()}
            className="fixed z-40 select-none"
          >
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              onTouchStart={(e) => {
                e.stopPropagation();
              }}
              onClick={handleCopyPopoverClick}
              aria-label="复制选中内容"
              className="h-9 px-3.5 rounded-xl inline-flex items-center gap-1.5 bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] text-[13px] font-medium text-[var(--fei-text-primary)] shadow-md dark:shadow-xl eink:shadow-none hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] transition-colors whitespace-nowrap select-none cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5 text-[var(--fei-text-muted)]" strokeWidth={1.9} />
              <span>复制</span>
            </button>
          </div>
        )}

        {showOutline && (
          <DocOutlineModal
            toc={toc}
            activeTocId={getActiveTocId()}
            onJumpToHeading={handleJumpToHeading}
            onClose={() => setShowOutline(false)}
          />
        )}

        {previewImage && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="图片预览"
            data-image-preview="true"
            onClick={() => setPreviewImage(null)}
            className="fixed inset-0 z-50 bg-black/85 eink:bg-[var(--fei-bg)] flex flex-col items-center justify-center p-4 select-none"
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setPreviewImage(null);
              }}
              aria-label="关闭图片预览"
              className="fixed top-[max(1rem,env(safe-area-inset-top))] right-4 z-10 w-10 h-10 rounded-full bg-black/50 eink:bg-[var(--fei-bg-surface)] eink:border eink:border-[var(--fei-border-strong)] text-white eink:text-[var(--fei-text-primary)] inline-flex items-center justify-center cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
            <img
              src={previewImage.url}
              alt={previewImage.alt || ''}
              className="max-w-full max-h-[86vh] w-auto h-auto object-contain rounded-lg eink:rounded-none"
            />
            {previewImage.alt && (
              <div className="mt-3 max-w-[90vw] text-[13px] text-white/85 eink:text-[var(--fei-text-primary)] text-center truncate">
                {previewImage.alt}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
);

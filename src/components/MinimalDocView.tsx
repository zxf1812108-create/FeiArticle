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
import { BlockNode, formatBytes, parseDocumentBlocks } from '../utils/textParser';

export type EditFormatKind = 'h1' | 'h2' | 'ul' | 'ol' | 'hr';

export interface MinimalDocViewHandle {
  prepareModeSwitch: (nextEditing: boolean) => void;
  flushAndCaptureViewState: () => { mode: 'read' | 'edit'; scrollTop: number };
  applyMarkdownFormat: (kind: EditFormatKind) => void;
}

interface MinimalDocViewProps {
  doc: ArticleDoc;
  isEditing: boolean;
  onSaveDraft: (updates: { title: string; content: string }) => void;
  onViewStateChange: (state: { mode: 'read' | 'edit'; scrollTop: number }) => void;
  onFetchRemoteBody: () => Promise<void>;
}

interface VisualLine {
  top: number;
  bottom: number;
  text: string;
}

function normalizeForMatch(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Measure rendered visual lines in scroll-content coordinates, keeping text snippets
 * for both exact line-accurate pagination and Read <-> Edit content synchronization.
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
 * Create a temporary off-screen mirror element matching a textarea's exact typography & width
 * to convert between character offsets and pixel Y offsets accurately.
 */
function createTextareaMirror(textarea: HTMLTextAreaElement): HTMLDivElement {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  mirror.style.position = 'fixed';
  mirror.style.top = '-9999px';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.boxSizing = 'border-box';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.fontWeight = style.fontWeight;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.padding = style.padding;
  document.body.appendChild(mirror);
  return mirror;
}

function measureCharOffsetY(textarea: HTMLTextAreaElement, text: string, charIndex: number): number {
  if (charIndex <= 0) return 0;
  const mirror = createTextareaMirror(textarea);
  try {
    const prefix = text.slice(0, charIndex);
    mirror.textContent = prefix;
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    return marker.offsetTop;
  } finally {
    document.body.removeChild(mirror);
  }
}

function findCharOffsetAtY(textarea: HTMLTextAreaElement, text: string, targetY: number): number {
  if (targetY <= 0 || !text) return 0;
  const mirror = createTextareaMirror(textarea);
  try {
    // Binary search over line boundaries first for speed & clean line alignment
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') lineStarts.push(i + 1);
    }

    let lo = 0;
    let hi = lineStarts.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const idx = lineStarts[mid];
      mirror.textContent = text.slice(0, idx);
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      mirror.appendChild(marker);
      const y = marker.offsetTop;
      if (y <= targetY + 4) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return lineStarts[best];
  } finally {
    document.body.removeChild(mirror);
  }
}

function findCharIndexForSnippet(
  rawContent: string,
  snippet: string,
  fallbackRatio: number
): number {
  if (!rawContent) return 0;
  const targetNorm = normalizeForMatch(snippet).slice(0, 20);
  if (!targetNorm) {
    return Math.round(fallbackRatio * rawContent.length);
  }

  const lines = rawContent.split('\n');
  let offset = 0;
  const candidates: Array<{ offset: number; dist: number }> = [];

  for (const line of lines) {
    const normLine = normalizeForMatch(line);
    if (normLine.length > 0 && (normLine.includes(targetNorm) || targetNorm.includes(normLine.slice(0, 14)))) {
      const ratio = offset / Math.max(1, rawContent.length);
      candidates.push({ offset, dist: Math.abs(ratio - fallbackRatio) });
    }
    offset += line.length + 1;
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates[0].offset;
  }

  return Math.round(fallbackRatio * rawContent.length);
}

type PendingAnchor =
  | { kind: 'top' }
  | { kind: 'to-edit'; charIndex: number; fallbackRatio: number }
  | { kind: 'to-read'; snippet: string; fallbackRatio: number };

export const MinimalDocView = forwardRef<MinimalDocViewHandle, MinimalDocViewProps>(
  function MinimalDocView(
    { doc, isEditing, onSaveDraft, onViewStateChange, onFetchRemoteBody },
    ref
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const articleRef = useRef<HTMLElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const [content, setContent] = useState(doc.content);
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);

    const titleRef = useRef(doc.title);
    const contentRef = useRef(content);
    titleRef.current = doc.title;
    contentRef.current = content;

    const debounceSaveRef = useRef<number | null>(null);
    const debounceScrollRef = useRef<number | null>(null);
    const hasUnsavedDraftRef = useRef(false);
    const pendingAnchorRef = useRef<PendingAnchor | null>(null);
    const restoredDocIdRef = useRef<string | null>(null);

    // Sync local buffer when switching documents
    useEffect(() => {
      setContent(doc.content);
      titleRef.current = doc.title;
      contentRef.current = doc.content;
      hasUnsavedDraftRef.current = false;
      setFetchError(null);
    }, [doc.id, doc.title]);

    // Sync content if remote body arrives lazily while document is open
    useEffect(() => {
      if (!hasUnsavedDraftRef.current && doc.content !== contentRef.current) {
        setContent(doc.content);
        contentRef.current = doc.content;
      }
    }, [doc.content]);

    // Auto-size textarea height to match full content so scrollRef is the single shared scroll container
    const resizeTextarea = () => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(360, ta.scrollHeight)}px`;
    };

    useLayoutEffect(() => {
      if (isEditing) {
        resizeTextarea();
      }
    }, [isEditing, content, doc.id]);

    // Restore saved scrollTop when opening a document
    useLayoutEffect(() => {
      if (restoredDocIdRef.current === doc.id) return;
      restoredDocIdRef.current = doc.id;
      const el = scrollRef.current;
      if (!el) return;
      if (isEditing) {
        resizeTextarea();
      }
      el.scrollTop = doc.lastScrollTop ?? 0;
    }, [doc.id, doc.lastScrollTop, isEditing]);

    // Apply anchored scroll alignment right after Read <-> Edit mode toggle commits
    useLayoutEffect(() => {
      const anchor = pendingAnchorRef.current;
      if (!anchor) return;
      pendingAnchorRef.current = null;

      const el = scrollRef.current;
      if (!el) return;

      if (anchor.kind === 'top') {
        el.scrollTop = 0;
        onViewStateChange({ mode: isEditing ? 'edit' : 'read', scrollTop: 0 });
        return;
      }

      if (isEditing && anchor.kind === 'to-edit') {
        const ta = textareaRef.current;
        if (!ta) return;
        resizeTextarea();
        const taTop =
          ta.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        const measuredY = measureCharOffsetY(ta, contentRef.current, anchor.charIndex);
        const targetTop = Math.max(0, Math.floor(taTop + measuredY) - 6);
        el.scrollTop = targetTop;
        try {
          ta.setSelectionRange(anchor.charIndex, anchor.charIndex);
          ta.focus({ preventScroll: true });
        } catch {
          // ignore focus errors on mobile
        }
        onViewStateChange({ mode: 'edit', scrollTop: el.scrollTop });
        return;
      }

      if (!isEditing && anchor.kind === 'to-read') {
        const articleEl = articleRef.current;
        if (!articleEl) return;
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        const targetNorm = normalizeForMatch(anchor.snippet).slice(0, 18);
        let matchedTop: number | null = null;

        if (targetNorm) {
          const lines = collectVisualLines(el, articleEl);
          const candidates: Array<{ top: number; dist: number }> = [];
          for (const line of lines) {
            const lineNorm = normalizeForMatch(line.text);
            if (
              lineNorm &&
              (lineNorm.includes(targetNorm) || targetNorm.includes(lineNorm.slice(0, 12)))
            ) {
              const ratio = line.top / Math.max(1, el.scrollHeight);
              candidates.push({ top: line.top, dist: Math.abs(ratio - anchor.fallbackRatio) });
            }
          }
          if (candidates.length > 0) {
            candidates.sort((a, b) => a.dist - b.dist);
            matchedTop = candidates[0].top;
          }
        }

        const targetTop =
          matchedTop !== null
            ? Math.min(maxScroll, Math.max(0, Math.floor(matchedTop) - 4))
            : Math.round(anchor.fallbackRatio * maxScroll);
        el.scrollTop = targetTop;
        onViewStateChange({ mode: 'read', scrollTop: el.scrollTop });
      }
    }, [isEditing]);

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
      };
    }, []);

    useImperativeHandle(ref, () => ({
      prepareModeSwitch(nextEditing: boolean) {
        const el = scrollRef.current;
        if (!el) return;

        if (el.scrollTop <= 10) {
          flushDraftNow();
          pendingAnchorRef.current = { kind: 'top' };
          return;
        }

        const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
        const fallbackRatio = Math.min(1, Math.max(0, el.scrollTop / maxScroll));

        if (nextEditing) {
          // Capturing from Read mode -> target Edit mode
          const articleEl = articleRef.current;
          let snippet = '';
          if (articleEl) {
            const lines = collectVisualLines(el, articleEl);
            const firstVisible = lines.find((line) => line.bottom > el.scrollTop + 4);
            if (firstVisible) {
              snippet = firstVisible.text;
            }
          }
          const charIndex = findCharIndexForSnippet(contentRef.current, snippet, fallbackRatio);
          pendingAnchorRef.current = { kind: 'to-edit', charIndex, fallbackRatio };
        } else {
          // Capturing from Edit mode -> target Read mode
          flushDraftNow();
          const ta = textareaRef.current;
          let snippet = '';
          let charRatio = fallbackRatio;
          if (ta) {
            const taTop =
              ta.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
            const offsetInsideTa = Math.max(0, el.scrollTop - taTop);
            const charIdx = findCharOffsetAtY(ta, contentRef.current, offsetInsideTa);
            charRatio = charIdx / Math.max(1, contentRef.current.length);
            const rest = contentRef.current.slice(charIdx);
            const firstLine = rest.split('\n').find((l) => l.trim().length > 0) || '';
            snippet = firstLine.trim();
          }
          pendingAnchorRef.current = { kind: 'to-read', snippet, fallbackRatio: charRatio };
        }
      },
      flushAndCaptureViewState() {
        flushDraftNow();
        return {
          mode: isEditing ? 'edit' : 'read',
          scrollTop: scrollRef.current?.scrollTop ?? 0,
        };
      },
      applyMarkdownFormat(kind: EditFormatKind) {
        const ta = textareaRef.current;
        if (!ta) return;

        const current = contentRef.current;
        const selStart = ta.selectionStart ?? current.length;
        const selEnd = ta.selectionEnd ?? selStart;

        let nextContent = current;
        let nextSelStart = selStart;
        let nextSelEnd = selEnd;

        if (kind === 'hr') {
          const lineStart = current.lastIndexOf('\n', Math.max(0, selStart - 1)) + 1;
          const lineEndRaw = current.indexOf('\n', selEnd);
          const lineEnd = lineEndRaw === -1 ? current.length : lineEndRaw;
          const currentLine = current.slice(lineStart, lineEnd);

          if (currentLine.trim().length === 0) {
            const insert = '---\n';
            nextContent = current.slice(0, lineStart) + insert + current.slice(lineEnd);
            nextSelStart = lineStart + insert.length;
            nextSelEnd = nextSelStart;
          } else {
            const needsLeadingNewline = selStart > 0 && current[selStart - 1] !== '\n';
            const insert = `${needsLeadingNewline ? '\n' : ''}---\n`;
            nextContent = current.slice(0, selStart) + insert + current.slice(selEnd);
            nextSelStart = selStart + insert.length;
            nextSelEnd = nextSelStart;
          }
        } else {
          const blockStart = current.lastIndexOf('\n', Math.max(0, selStart - 1)) + 1;
          const blockEndRaw = current.indexOf('\n', selEnd);
          const blockEnd = blockEndRaw === -1 ? current.length : blockEndRaw;
          const selectedBlock = current.slice(blockStart, blockEnd);
          const lines = selectedBlock.split('\n');

          const targetPrefix =
            kind === 'h1'
              ? '# '
              : kind === 'h2'
                ? '## '
                : kind === 'ul'
                  ? '- '
                  : '1. ';

          const transformed = lines.map((line, idx) => {
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
            if (kind === 'ol' && /^\d+\.\s+$/.test(existingPrefix)) {
              return indent + body;
            }
            const prefix = kind === 'ol' ? `${idx + 1}. ` : targetPrefix;
            return `${indent}${prefix}${body}`;
          });

          const replacedBlock = transformed.join('\n');
          nextContent = current.slice(0, blockStart) + replacedBlock + current.slice(blockEnd);

          if (selStart === selEnd) {
            const delta = replacedBlock.length - selectedBlock.length;
            nextSelStart = Math.max(blockStart, selStart + delta);
            nextSelEnd = nextSelStart;
          } else {
            nextSelStart = blockStart;
            nextSelEnd = blockStart + replacedBlock.length;
          }
        }

        contentRef.current = nextContent;
        setContent(nextContent);
        scheduleSave(titleRef.current, nextContent);

        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          resizeTextarea();
          try {
            el.focus({ preventScroll: true });
            el.setSelectionRange(nextSelStart, nextSelEnd);
          } catch {
            // ignore focus errors on mobile
          }
        });
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
      const el = scrollRef.current;
      if (!el) return;
      if (debounceScrollRef.current) window.clearTimeout(debounceScrollRef.current);
      debounceScrollRef.current = window.setTimeout(() => {
        onViewStateChange({
          mode: isEditing ? 'edit' : 'read',
          scrollTop: el.scrollTop,
        });
      }, 220);
    };

    // Exact visual-line-accurate tap pagination in Read mode:
    // Left 1/3 => Page Up, Right 2/3 => Page Down (zero repeated complete lines)
    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (isEditing) return;

      const target = e.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select')) return;

      const selText = window.getSelection()?.toString().trim();
      if (selText && selText.length > 0) return;

      const el = scrollRef.current;
      const articleEl = articleRef.current;
      if (!el || !articleEl) return;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;

      const ratio = (e.clientX - rect.left) / rect.width;
      const viewHeight = el.clientHeight;
      const maxScroll = Math.max(0, el.scrollHeight - viewHeight);
      const currentTop = el.scrollTop;
      const currentBottom = currentTop + viewHeight;
      const lines = collectVisualLines(el, articleEl);
      const EPS = 1.5;

      if (ratio < 1 / 3) {
        if (currentTop <= 0) return;

        const firstCompleteIdx = lines.findIndex(
          (line) => line.top >= currentTop - EPS && line.bottom <= currentBottom + EPS
        );

        let targetScrollTop = Math.max(0, currentTop - viewHeight);

        if (firstCompleteIdx > 0) {
          const firstComplete = lines[firstCompleteIdx];
          const prevLine = lines[firstCompleteIdx - 1];
          const maxAllowedBottom = Math.floor(firstComplete.top);
          const minNeededBottom = Math.ceil(prevLine.bottom);
          const desiredBottom =
            minNeededBottom <= maxAllowedBottom
              ? Math.min(maxAllowedBottom, minNeededBottom + 4)
              : maxAllowedBottom;
          targetScrollTop = Math.max(0, desiredBottom - viewHeight);
        } else if (firstCompleteIdx === 0) {
          targetScrollTop = 0;
        }

        if (targetScrollTop >= currentTop) {
          targetScrollTop = Math.max(0, currentTop - viewHeight);
        }

        el.scrollTop = targetScrollTop;
        onViewStateChange({ mode: 'read', scrollTop: targetScrollTop });
      } else {
        if (currentTop >= maxScroll) return;

        const firstIncompleteIdx = lines.findIndex((line) => line.bottom > currentBottom + EPS);
        if (firstIncompleteIdx === -1) return;

        const firstIncomplete = lines[firstIncompleteIdx];
        const prevComplete = firstIncompleteIdx > 0 ? lines[firstIncompleteIdx - 1] : null;
        const minSafeTop = prevComplete ? Math.ceil(prevComplete.bottom) : 0;
        const desiredTop = Math.floor(firstIncomplete.top) - 4;
        let targetScrollTop = Math.min(maxScroll, Math.max(minSafeTop, desiredTop));

        if (targetScrollTop <= currentTop) {
          targetScrollTop = Math.min(maxScroll, currentTop + viewHeight);
        }

        el.scrollTop = targetScrollTop;
        onViewStateChange({ mode: 'read', scrollTop: targetScrollTop });
      }
    };

    const { blocks } = useMemo(() => parseDocumentBlocks(content), [content]);

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
              className="font-code text-[0.88em] px-1.5 py-0.5 rounded bg-[var(--fei-bg-subtle)] text-[var(--fei-text-primary)]"
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
      switch (block.type) {
        case 'heading': {
          if (block.level === 1) {
            return (
              <h1
                key={idx}
                className="text-[22px] font-semibold leading-snug mt-7 mb-3.5 first:mt-0 text-[var(--fei-text-primary)] text-balance"
              >
                {block.text}
              </h1>
            );
          }
          if (block.level === 2) {
            return (
              <h2
                key={idx}
                className="text-[18.5px] font-semibold leading-snug mt-7 mb-3 text-[var(--fei-text-primary)] text-balance"
              >
                {block.text}
              </h2>
            );
          }
          return (
            <h3
              key={idx}
              className="text-[16.5px] font-semibold leading-snug mt-5 mb-2 text-[var(--fei-text-primary)]"
            >
              {block.text}
            </h3>
          );
        }
        case 'paragraph':
          return (
            <p key={idx} className="my-4 whitespace-pre-line">
              {renderInline(block.text)}
            </p>
          );
        case 'blockquote':
          return (
            <blockquote
              key={idx}
              className="my-5 px-4 py-3.5 rounded-lg bg-[var(--fei-bg-subtle)] text-[var(--fei-text-primary)] text-[15px]"
            >
              <span className="whitespace-pre-line">{renderInline(block.text)}</span>
            </blockquote>
          );
        case 'code':
          return (
            <pre
              key={idx}
              className="my-5 p-4 rounded-lg bg-[var(--fei-bg-subtle)] overflow-x-auto text-[13px] leading-relaxed font-code text-[var(--fei-text-primary)]"
            >
              <code>{block.code}</code>
            </pre>
          );
        case 'list':
          if (block.ordered) {
            return (
              <ol key={idx} className="my-4 pl-5 list-decimal space-y-2 marker:text-[var(--fei-text-muted)]">
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          }
          return (
            <ul key={idx} className="my-4 pl-5 list-disc space-y-2 marker:text-[var(--fei-text-muted)]">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        case 'table':
          return (
            <div
              key={idx}
              className="my-5 w-full overflow-x-auto rounded-lg border border-[var(--fei-border)]"
            >
              <table className="w-full border-collapse text-[14.5px] leading-relaxed text-[var(--fei-text-primary)]">
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
                            className={`px-3 py-2 border-r last:border-r-0 border-[var(--fei-border)] align-top ${alignCls}`}
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
          return <hr key={idx} className="my-7 border-t border-[var(--fei-border)]" />;
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
      <div className="w-full h-full flex flex-col bg-[var(--fei-bg)] pt-6">
        <div
          ref={scrollRef}
          onClick={handleContainerClick}
          onScroll={handleScroll}
          className="flex-1 min-h-0 w-full overflow-y-auto"
        >
          <div className="max-w-[720px] mx-auto px-5 sm:px-8 pt-1 pb-[calc(100vh-110px)]">
            {isEditing ? (
              <div>
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value);
                    scheduleSave(titleRef.current, e.target.value);
                  }}
                  placeholder="开始输入正文…"
                  className="w-full bg-transparent text-[16px] leading-[1.85] text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none resize-none overflow-hidden"
                />
              </div>
            ) : (
              <article ref={articleRef}>
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
                  <div className="text-[16px] leading-[1.85] text-[var(--fei-text-primary)]">
                    {blocks.length === 0 ? (
                      <p className="text-[var(--fei-text-muted)]">
                        暂无内容，点击右下角编辑图标开始写作。
                      </p>
                    ) : (
                      blocks.map((b, i) => renderBlock(b, i))
                    )}
                  </div>
                )}
              </article>
            )}
          </div>
        </div>
      </div>
    );
  }
);

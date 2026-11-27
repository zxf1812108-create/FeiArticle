import React, { useEffect, useMemo, useRef } from 'react';
import { Bookmark, X } from 'lucide-react';
import { ReadingNote } from '../types';
import { TocItem } from '../utils/textParser';

interface DocOutlineModalProps {
  toc: TocItem[];
  bookmarks: ReadingNote[];
  activeTocId: string | null;
  onJumpToHeading: (tocId: string) => void;
  onJumpToBookmark: (bookmark: ReadingNote) => void;
  onClose: () => void;
}

export const DocOutlineModal: React.FC<DocOutlineModalProps> = ({
  toc,
  bookmarks,
  activeTocId,
  onJumpToHeading,
  onJumpToBookmark,
  onClose,
}) => {
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const sortedBookmarks = useMemo(
    () =>
      [...bookmarks]
        .filter((b) => !b.deleted && b.content.trim().length > 0)
        .sort((a, b) => a.charOffset - b.charOffset || a.createdAt - b.createdAt),
    [bookmarks]
  );

  // Group bookmarks into leading (before first chapter) and per-chapter buckets by charOffset
  const { leadingBookmarks, bookmarksBySection } = useMemo(() => {
    const leading: ReadingNote[] = [];
    const bySection = new Map<number, ReadingNote[]>();

    if (toc.length === 0) {
      return { leadingBookmarks: sortedBookmarks, bookmarksBySection: bySection };
    }

    const firstHeadingOffset = toc[0].startOffset ?? 0;
    for (const bm of sortedBookmarks) {
      if (bm.charOffset < firstHeadingOffset) {
        leading.push(bm);
        continue;
      }
      // Binary search for the last heading whose startOffset <= bm.charOffset
      let lo = 0;
      let hi = toc.length - 1;
      let sectionIdx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const offset = toc[mid].startOffset ?? 0;
        if (offset <= bm.charOffset) {
          sectionIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const list = bySection.get(sectionIdx);
      if (list) {
        list.push(bm);
      } else {
        bySection.set(sectionIdx, [bm]);
      }
    }

    return { leadingBookmarks: leading, bookmarksBySection: bySection };
  }, [toc, sortedBookmarks]);

  const hasContent = toc.length > 0 || sortedBookmarks.length > 0;

  const renderBookmarkRow = (bm: ReadingNote, indentCls: string, sizeCls: string) => {
    const label = bm.content.replace(/[\r\n]+/g, ' ').trim();
    return (
      <button
        key={`bm-${bm.id}`}
        type="button"
        onClick={() => onJumpToBookmark(bm)}
        className={`w-full text-left py-2 pr-3 rounded-xl transition-colors flex items-center gap-2 border border-transparent text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] eink:text-[var(--fei-text-primary)] ${indentCls} ${sizeCls}`}
      >
        <Bookmark
          className="w-3.5 h-3.5 shrink-0 text-[var(--fei-text-muted)] eink:text-[var(--fei-text-primary)]"
          strokeWidth={1.9}
        />
        <span className="truncate leading-snug">{label}</span>
      </button>
    );
  };

  return (
    <div
      data-outline-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 dark:bg-black/45 eink:bg-transparent p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[400px] max-h-[76vh] flex flex-col bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] rounded-2xl shadow-xl eink:shadow-none overflow-hidden text-[var(--fei-text-primary)]"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--fei-border)] flex items-center justify-between gap-3 shrink-0">
          <div className="text-[13.5px] font-medium text-[var(--fei-text-primary)] leading-tight">
            文档结构
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭文档结构"
            className="w-8 h-8 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          {hasContent ? (
            <>
              {leadingBookmarks.map((bm) => renderBookmarkRow(bm, 'pl-3', 'text-[14px]'))}
              {toc.map((item, idx) => {
                const isActive = item.id === activeTocId;
                const sizeCls =
                  item.level === 1
                    ? 'text-[14px]'
                    : item.level === 2
                      ? 'text-[13.5px]'
                      : 'text-[13px]';
                const indentCls =
                  item.level === 1
                    ? 'pl-3 font-medium'
                    : item.level === 2
                      ? 'pl-6'
                      : 'pl-9';
                const bmIndentCls =
                  item.level === 1 ? 'pl-6' : item.level === 2 ? 'pl-9' : 'pl-11';
                const sectionBookmarks = bookmarksBySection.get(idx);

                return (
                  <React.Fragment key={item.id}>
                    <button
                      ref={isActive ? activeItemRef : undefined}
                      type="button"
                      onClick={() => onJumpToHeading(item.id)}
                      className={`w-full text-left py-2 pr-3 rounded-xl transition-colors flex items-center gap-2 border ${indentCls} ${sizeCls} ${
                        isActive
                          ? 'bg-[var(--fei-bg-selected)] border-transparent eink:border-[var(--fei-border-strong)] text-[var(--fei-text-primary)] font-semibold'
                          : item.level === 3
                            ? 'border-transparent text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)]'
                            : 'border-transparent text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)]'
                      }`}
                    >
                      <span className="truncate leading-snug">{item.text}</span>
                    </button>
                    {sectionBookmarks?.map((bm) => renderBookmarkRow(bm, bmIndentCls, sizeCls))}
                  </React.Fragment>
                );
              })}
            </>
          ) : (
            <div className="py-10 text-center text-[13px] text-[var(--fei-text-muted)]">
              当前文档无明显章节目录
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

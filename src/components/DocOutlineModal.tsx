import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { TocItem } from '../utils/textParser';

export interface FallbackJumpAnchor {
  label: string;
  preview: string;
  blockIndex: number;
}

interface DocOutlineModalProps {
  docTitle: string;
  toc: TocItem[];
  fallbackAnchors: FallbackJumpAnchor[];
  activeTocId: string | null;
  onJumpToHeading: (tocId: string) => void;
  onJumpToBlock: (blockIndex: number) => void;
  onClose: () => void;
}

export const DocOutlineModal: React.FC<DocOutlineModalProps> = ({
  docTitle,
  toc,
  fallbackAnchors,
  activeTocId,
  onJumpToHeading,
  onJumpToBlock,
  onClose,
}) => {
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const hasHeadings = toc.length > 0;

  return (
    <div
      data-outline-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[1px] p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[400px] max-h-[76vh] flex flex-col bg-[var(--fei-bg-surface)] border border-[var(--fei-border)] rounded-2xl shadow-xl overflow-hidden text-[var(--fei-text-primary)]"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--fei-border)] flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="text-[12px] text-[var(--fei-text-muted)] leading-tight">
              文档结构{hasHeadings ? ` · ${toc.length}` : ''}
            </div>
            <div className="text-[14px] font-medium text-[var(--fei-text-primary)] truncate mt-0.5">
              {docTitle || '无标题文档'}
            </div>
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
          {hasHeadings ? (
            toc.map((item) => {
              const isActive = item.id === activeTocId;
              const indentCls =
                item.level === 1
                  ? 'pl-3 font-medium text-[14px]'
                  : item.level === 2
                    ? 'pl-6 text-[13.5px]'
                    : 'pl-9 text-[13px]';
              return (
                <button
                  key={item.id}
                  ref={isActive ? activeItemRef : undefined}
                  type="button"
                  onClick={() => onJumpToHeading(item.id)}
                  className={`w-full text-left py-2 pr-3 rounded-xl transition-colors flex items-center gap-2 ${indentCls} ${
                    isActive
                      ? 'bg-[var(--fei-bg-selected)] text-[var(--fei-text-primary)] font-medium'
                      : item.level === 3
                        ? 'text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)]'
                        : 'text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)]'
                  }`}
                >
                  <span className="truncate leading-snug">{item.text}</span>
                </button>
              );
            })
          ) : fallbackAnchors.length > 0 ? (
            <>
              <div className="px-3 py-1.5 text-[11.5px] text-[var(--fei-text-muted)]">
                未识别到明显章节标题，可按位置快速跳转
              </div>
              {fallbackAnchors.map((anchor) => (
                <button
                  key={`${anchor.blockIndex}-${anchor.label}`}
                  type="button"
                  onClick={() => onJumpToBlock(anchor.blockIndex)}
                  className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-[var(--fei-bg-hover)] transition-colors flex items-baseline gap-2.5"
                >
                  <span className="text-[11.5px] font-code text-[var(--fei-text-muted)] shrink-0 w-9">
                    {anchor.label}
                  </span>
                  <span className="flex-1 min-w-0 text-[13.5px] text-[var(--fei-text-primary)] truncate">
                    {anchor.preview}
                  </span>
                </button>
              ))}
            </>
          ) : (
            <div className="py-10 text-center text-[13px] text-[var(--fei-text-muted)]">
              暂无可跳转的内容
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

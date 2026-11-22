import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { TocItem } from '../utils/textParser';

interface DocOutlineModalProps {
  toc: TocItem[];
  activeTocId: string | null;
  onJumpToHeading: (tocId: string) => void;
  onClose: () => void;
}

export const DocOutlineModal: React.FC<DocOutlineModalProps> = ({
  toc,
  activeTocId,
  onJumpToHeading,
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
                  className={`w-full text-left py-2 pr-3 rounded-xl transition-colors flex items-center gap-2 border ${indentCls} ${
                    isActive
                      ? 'bg-[var(--fei-bg-selected)] border-transparent eink:border-[var(--fei-border-strong)] text-[var(--fei-text-primary)] font-semibold'
                      : item.level === 3
                        ? 'border-transparent text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)]'
                        : 'border-transparent text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)]'
                  }`}
                >
                  <span className="truncate leading-snug">{item.text}</span>
                </button>
              );
            })
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

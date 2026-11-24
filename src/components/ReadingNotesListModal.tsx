import React, { useMemo } from 'react';
import { Download, Trash2, X } from 'lucide-react';
import { ReadingNote } from '../types';
import { formatNotesAsPureMarkdown, getActiveNotes } from '../utils/notes';

interface ReadingNotesListModalProps {
  docTitle: string;
  docContentLength: number;
  notes?: ReadingNote[];
  onJumpToNote: (note: ReadingNote) => void;
  onDeleteNote: (noteId: string) => void;
  onCopySuccess: (message: string) => void;
  onClose: () => void;
}

export const ReadingNotesListModal: React.FC<ReadingNotesListModalProps> = ({
  docTitle,
  docContentLength,
  notes,
  onJumpToNote,
  onDeleteNote,
  onCopySuccess,
  onClose,
}) => {
  const activeNotes = useMemo(() => getActiveNotes(notes), [notes]);

  const handleDownloadMarkdown = () => {
    const md = formatNotesAsPureMarkdown(docTitle, activeNotes);
    if (!md) return;
    const safeTitle = (docTitle || '读书笔记').replace(/[\\/:*?"<>|]+/g, '_').trim() || '读书笔记';
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeTitle}-笔记.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onCopySuccess('已导出 Markdown 笔记');
  };

  const formatNotePercent = (charOffset: number): string => {
    if (docContentLength <= 0) return '0%';
    const pct = Math.min(100, Math.max(0, (charOffset / docContentLength) * 100));
    return pct === 0 || pct === 100 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
  };

  return (
    <div
      data-notes-list-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 dark:bg-black/45 eink:bg-transparent p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] max-h-[78vh] flex flex-col bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] rounded-2xl shadow-xl eink:shadow-none overflow-hidden text-[var(--fei-text-primary)]"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--fei-border)] flex items-center justify-between gap-2 shrink-0 select-none">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[13.5px] font-medium text-[var(--fei-text-primary)] leading-tight">
              读书笔记
            </span>
            {activeNotes.length > 0 && (
              <span className="text-[12px] tabular-nums text-[var(--fei-text-muted)]">
                · {activeNotes.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {activeNotes.length > 0 && (
              <button
                type="button"
                onClick={handleDownloadMarkdown}
                title="导出为 Markdown 文件（仅含个人笔记正文）"
                aria-label="导出为 Markdown"
                className="h-7 px-2 inline-flex items-center gap-1 rounded-lg text-[12px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" strokeWidth={1.8} />
                <span>导出</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭笔记列表"
              className="w-8 h-8 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Notes List */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
          {activeNotes.length > 0 ? (
            activeNotes.map((note) => (
              <div
                key={note.id}
                role="button"
                tabIndex={0}
                onClick={() => onJumpToNote(note)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onJumpToNote(note);
                  }
                }}
                className="group w-full text-left px-3 py-2.5 rounded-xl border border-transparent hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] eink:border-b eink:border-b-[var(--fei-border)] eink:rounded-none transition-colors cursor-pointer"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="flex-1 min-w-0 text-[13.5px] leading-[1.55] text-[var(--fei-text-primary)] whitespace-pre-wrap break-words line-clamp-3 font-doc-body">
                    {note.content}
                  </p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteNote(note.id);
                    }}
                    aria-label="删除这条笔记"
                    title="删除"
                    className="w-6 h-6 -mr-1 -mt-0.5 inline-flex items-center justify-center rounded-md text-[var(--fei-text-muted)]/60 hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] transition-colors shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                </div>

                <div className="mt-1.5 flex items-center justify-between gap-3 text-[11.5px] text-[var(--fei-text-muted)]">
                  <span className="truncate min-w-0">
                    {note.anchorText ? `“${note.anchorText}”` : '段落锚点'}
                  </span>
                  <span className="tabular-nums shrink-0">{formatNotePercent(note.charOffset)}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="py-12 px-4 text-center space-y-1.5">
              <div className="text-[13.5px] text-[var(--fei-text-muted)]">当前文档暂无读书笔记</div>
              <div className="text-[12px] text-[var(--fei-text-muted)]/75">
                点击底部笔记图标即可在当前页记录
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

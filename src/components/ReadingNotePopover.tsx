import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, StickyNote, Trash2, X } from 'lucide-react';
import { ReadingNote } from '../types';

export interface NoteAnchorTarget {
  charOffset: number;
  anchorText: string;
}

interface ReadingNotePopoverProps {
  /** Existing notes currently visible on screen (ordered by charOffset) */
  screenNotes: ReadingNote[];
  /** Currently selected note id, or null if creating a new note at defaultAnchor */
  initialNoteId: string | null;
  /** Default anchor (first complete paragraph on current screen) when creating a new note */
  defaultAnchor: NoteAnchorTarget;
  /** Whether the defaultAnchor paragraph does not yet have a note (enables "+ 新建" when viewing another note) */
  canCreateAtDefaultAnchor: boolean;
  fontSize?: number;
  onSaveNote: (payload: {
    noteId: string | null;
    charOffset: number;
    anchorText: string;
    content: string;
  }) => void;
  onDeleteNote: (noteId: string) => void;
  onClose: () => void;
}

export const ReadingNotePopover: React.FC<ReadingNotePopoverProps> = ({
  screenNotes,
  initialNoteId,
  defaultAnchor,
  canCreateAtDefaultAnchor,
  fontSize = 16,
  onSaveNote,
  onDeleteNote,
  onClose,
}) => {
  const resolveInitialNote = (): ReadingNote | null => {
    if (initialNoteId) {
      return screenNotes.find((n) => n.id === initialNoteId) || null;
    }
    return null;
  };

  const initialNote = resolveInitialNote();
  const [activeNoteId, setActiveNoteId] = useState<string | null>(initialNote?.id ?? null);
  const [anchor, setAnchor] = useState<NoteAnchorTarget>(() =>
    initialNote
      ? { charOffset: initialNote.charOffset, anchorText: initialNote.anchorText }
      : defaultAnchor
  );
  const [draft, setDraft] = useState<string>(initialNote?.content ?? '');
  const [keyboardLiftPx, setKeyboardLiftPx] = useState<number>(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeNoteIdRef = useRef<string | null>(activeNoteId);
  const anchorRef = useRef<NoteAnchorTarget>(anchor);
  const draftRef = useRef<string>(draft);
  const initialContentRef = useRef<string>(initialNote?.content ?? '');
  const skipNextCommitRef = useRef<boolean>(false);
  const onSaveNoteRef = useRef(onSaveNote);

  activeNoteIdRef.current = activeNoteId;
  anchorRef.current = anchor;
  draftRef.current = draft;
  onSaveNoteRef.current = onSaveNote;

  const commitCurrentDraft = useCallback(() => {
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false;
      return;
    }
    const trimmed = draftRef.current.trim();
    const origTrimmed = initialContentRef.current.trim();
    const curId = activeNoteIdRef.current;

    // Skip no-op when creating a new note with empty input or nothing changed
    if (!curId && !trimmed) return;
    if (curId && trimmed === origTrimmed) return;

    onSaveNoteRef.current({
      noteId: curId,
      charOffset: anchorRef.current.charOffset,
      anchorText: anchorRef.current.anchorText,
      content: trimmed,
    });
    initialContentRef.current = trimmed;
  }, []);

  // Auto-save cleanly if unmounted externally (e.g. toggling toolbar icon or returning to tree)
  useEffect(() => {
    return () => {
      commitCurrentDraft();
    };
  }, [commitCurrentDraft]);

  // Focus textarea & place caret at end whenever switching active note
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const raf = window.requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        // ignore selection errors on older webviews
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeNoteId, anchor.charOffset]);

  // Lift popover above soft keyboard on mobile viewports when visualViewport shrinks
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const syncViewport = () => {
      const occluded = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardLiftPx(occluded > 60 ? Math.round(occluded) : 0);
    };
    syncViewport();
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
    return () => {
      vv.removeEventListener('resize', syncViewport);
      vv.removeEventListener('scroll', syncViewport);
    };
  }, []);

  const handleSaveAndClose = useCallback(() => {
    commitCurrentDraft();
    skipNextCommitRef.current = true;
    onClose();
  }, [commitCurrentDraft, onClose]);

  const handleDeleteCurrent = () => {
    const curId = activeNoteIdRef.current;
    if (!curId) return;
    skipNextCommitRef.current = true;
    onDeleteNote(curId);
    onClose();
  };

  const switchToNote = (target: ReadingNote) => {
    if (target.id === activeNoteIdRef.current) return;
    commitCurrentDraft();
    setActiveNoteId(target.id);
    setAnchor({ charOffset: target.charOffset, anchorText: target.anchorText });
    setDraft(target.content);
    initialContentRef.current = target.content;
  };

  const switchToNewAtDefault = () => {
    if (activeNoteIdRef.current === null) return;
    commitCurrentDraft();
    setActiveNoteId(null);
    setAnchor(defaultAnchor);
    setDraft('');
    initialContentRef.current = '';
  };

  // Global Escape key closes & auto-saves
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleSaveAndClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSaveAndClose]);

  const activeIdx = activeNoteId ? screenNotes.findIndex((n) => n.id === activeNoteId) : -1;
  const hasMultipleScreenNotes = screenNotes.length > 1 && activeIdx !== -1;
  const inputFontSize = Math.max(14, Math.min(18, Math.round(fontSize - 1)));
  const bottomStyle = keyboardLiftPx > 0 ? `${keyboardLiftPx + 10}px` : '64px';

  return (
    <>
      {/* Transparent click-away layer over reading area (keeps bottom toolbar interactive) */}
      <div
        data-note-popover-backdrop="true"
        onClick={(e) => {
          e.stopPropagation();
          handleSaveAndClose();
        }}
        className="fixed inset-x-0 top-0 bottom-[56px] z-30 bg-transparent"
      />

      <div
        data-note-popover="true"
        style={{ bottom: bottomStyle }}
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="fixed left-3 right-3 z-40 flex justify-center pointer-events-none"
      >
        <div className="pointer-events-auto w-full max-w-[720px] flex flex-col bg-[var(--fei-popup-bg)] border-[1.5px] border-[var(--fei-popup-border)] rounded-2xl shadow-[0_12px_32px_-6px_rgba(0,0,0,0.14)] dark:ring-1 dark:ring-white/10 dark:shadow-[0_14px_36px_-4px_rgba(0,0,0,0.75)] eink:shadow-none overflow-hidden text-[var(--fei-text-primary)]">
          {/* Minimal Top Header */}
          <div className="px-3.5 py-2 bg-[var(--fei-popup-header-bg)] border-b border-[var(--fei-popup-divider)] flex items-center justify-between gap-2 shrink-0 select-none">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <StickyNote
                className="w-3.5 h-3.5 text-[var(--fei-text-muted)] shrink-0"
                strokeWidth={1.8}
              />
              <span className="text-[12px] text-[var(--fei-text-muted)] truncate">
                {anchor.anchorText ? `“${anchor.anchorText}”` : '当前页笔记'}
              </span>
            </div>

            <div className="flex items-center gap-0.5 shrink-0">
              {hasMultipleScreenNotes && (
                <div className="flex items-center mr-1">
                  <button
                    type="button"
                    onClick={() => {
                      const prevIdx = (activeIdx - 1 + screenNotes.length) % screenNotes.length;
                      switchToNote(screenNotes[prevIdx]);
                    }}
                    aria-label="上一条本页笔记"
                    title="上一条本页笔记"
                    className="w-6 h-6 inline-flex items-center justify-center rounded-md text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[11px] tabular-nums text-[var(--fei-text-muted)] px-0.5">
                    {activeIdx + 1}/{screenNotes.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const nextIdx = (activeIdx + 1) % screenNotes.length;
                      switchToNote(screenNotes[nextIdx]);
                    }}
                    aria-label="下一条本页笔记"
                    title="下一条本页笔记"
                    className="w-6 h-6 inline-flex items-center justify-center rounded-md text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {activeNoteId && canCreateAtDefaultAnchor && (
                <button
                  type="button"
                  onClick={switchToNewAtDefault}
                  aria-label="在当前首段新建笔记"
                  title="在当前首段新建笔记"
                  className="w-7 h-7 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" strokeWidth={1.9} />
                </button>
              )}

              {activeNoteId && (
                <button
                  type="button"
                  onClick={handleDeleteCurrent}
                  aria-label="删除这条笔记"
                  title="删除这条笔记"
                  className="w-7 h-7 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.8} />
                </button>
              )}

              <button
                type="button"
                onClick={handleSaveAndClose}
                aria-label="保存并关闭笔记"
                title="关闭（自动保存）"
                className="w-7 h-7 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Borderless Auto-save Textarea */}
          <div className="px-3.5 py-2.5 bg-[var(--fei-popup-bg)]">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSaveAndClose();
                }
              }}
              rows={4}
              placeholder="写下读书笔记，关闭后自动保存…"
              style={{ fontSize: `${inputFontSize}px` }}
              className="w-full min-h-[112px] max-h-[34vh] resize-none bg-transparent text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)]/60 leading-[1.6] font-doc-body outline-none border-0 p-0"
            />
          </div>
        </div>
      </div>
    </>
  );
};

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ReadingNote } from '../types';

export interface NoteAnchorTarget {
  charOffset: number;
  anchorText: string;
}

interface ReadingNotePopoverProps {
  /** Existing bookmark being edited, or null when creating a new bookmark */
  initialNote: ReadingNote | null;
  /** Default anchor (first complete paragraph on current screen) when creating a new bookmark */
  defaultAnchor: NoteAnchorTarget;
  fontSize?: number;
  onSaveNote: (payload: {
    noteId: string | null;
    charOffset: number;
    anchorText: string;
    content: string;
  }) => void;
  onClose: () => void;
}

function normalizeSingleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

export const ReadingNotePopover: React.FC<ReadingNotePopoverProps> = ({
  initialNote,
  defaultAnchor,
  fontSize = 16,
  onSaveNote,
  onClose,
}) => {
  const initialSingleLine = normalizeSingleLine(initialNote?.content ?? '');
  const anchor: NoteAnchorTarget = initialNote
    ? { charOffset: initialNote.charOffset, anchorText: initialNote.anchorText }
    : defaultAnchor;

  const [draft, setDraft] = useState<string>(initialSingleLine);
  const [keyboardLiftPx, setKeyboardLiftPx] = useState<number>(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<string>(draft);
  const initialContentRef = useRef<string>(initialSingleLine);
  const noteIdRef = useRef<string | null>(initialNote?.id ?? null);
  const anchorRef = useRef<NoteAnchorTarget>(anchor);
  const skipNextCommitRef = useRef<boolean>(false);
  const onSaveNoteRef = useRef(onSaveNote);

  draftRef.current = draft;
  anchorRef.current = anchor;
  onSaveNoteRef.current = onSaveNote;

  const commitCurrentDraft = useCallback(() => {
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false;
      return;
    }
    const trimmed = normalizeSingleLine(draftRef.current).trim();
    const origTrimmed = normalizeSingleLine(initialContentRef.current).trim();
    const curId = noteIdRef.current;

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

  // Auto-commit cleanly if unmounted externally (non-empty saves; empty cancels pending marker or deletes existing)
  useEffect(() => {
    return () => {
      commitCurrentDraft();
    };
  }, [commitCurrentDraft]);

  // Synchronously focus single-line input inside the tap gesture so mobile keyboards reliably open
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    try {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    } catch {
      // ignore selection errors on older webviews
    }
  }, []);

  // Lift input bar cleanly above soft keyboard on mobile viewports when visualViewport shrinks
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

  const handleConfirmAndClose = useCallback(() => {
    commitCurrentDraft();
    skipNextCommitRef.current = true;
    inputRef.current?.blur();
    onClose();
  }, [commitCurrentDraft, onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleConfirmAndClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleConfirmAndClose]);

  const inputFontSize = Math.max(14, Math.min(17, Math.round(fontSize - 1)));
  const bottomStyle = keyboardLiftPx > 0 ? `${keyboardLiftPx + 12}px` : '68px';

  return (
    <>
      {/* Full-viewport click-away backdrop */}
      <div
        data-note-popover-backdrop="true"
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          handleConfirmAndClose();
        }}
        className="fixed inset-0 z-30 bg-transparent"
      />

      {/* Centered single-line bookmark input (50% viewport width with min/max width protection) */}
      <div
        data-note-popover="true"
        style={{ bottom: bottomStyle }}
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="fixed inset-x-3 z-40 flex justify-center pointer-events-none"
      >
        <div className="pointer-events-auto w-1/2 min-w-[260px] max-w-[min(420px,calc(100vw-24px))] bg-[var(--fei-popup-bg)] border-[1.5px] border-[var(--fei-popup-border)] rounded-xl shadow-[0_10px_28px_-6px_rgba(0,0,0,0.14)] dark:ring-1 dark:ring-white/10 dark:shadow-[0_14px_34px_-4px_rgba(0,0,0,0.75)] eink:shadow-none overflow-hidden text-[var(--fei-text-primary)]">
          <div className="px-3.5 py-2.5 bg-[var(--fei-popup-bg)]">
            <input
              ref={inputRef}
              type="text"
              enterKeyHint="done"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(normalizeSingleLine(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  handleConfirmAndClose();
                }
              }}
              aria-label="书签内容"
              style={{ fontSize: `${inputFontSize}px` }}
              className="block w-full bg-transparent text-[var(--fei-text-primary)] leading-snug font-doc-body outline-none border-0 p-0"
            />
          </div>
        </div>
      </div>
    </>
  );
};

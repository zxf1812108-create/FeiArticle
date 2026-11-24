import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ReadingNote } from '../types';

export interface NoteAnchorTarget {
  charOffset: number;
  anchorText: string;
}

interface ReadingNotePopoverProps {
  /** All active notes in the current document, ordered by charOffset */
  allNotes: ReadingNote[];
  /** Currently selected note id (default: first note on current screen), or null if creating a new note */
  initialNoteId: string | null;
  /** Default anchor (first complete paragraph on current screen) when creating a new note */
  defaultAnchor: NoteAnchorTarget;
  fontSize?: number;
  /** Jump reading viewport so the switched note's paragraph appears on the first line */
  onSwitchNote?: (charOffset: number) => void;
  onSaveNote: (payload: {
    noteId: string | null;
    charOffset: number;
    anchorText: string;
    content: string;
  }) => void;
  onClose: () => void;
}

/**
 * Determine whether a tap in browse mode landed directly on text (returning exact char index)
 * or in blank space inside the note box (returning text.length to place caret at the end).
 */
function resolveTapCaretOffset(
  textEl: HTMLElement | null,
  text: string,
  clientX: number,
  clientY: number
): number {
  if (!text || !textEl) return text.length;
  const textNode = textEl.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return text.length;

  const textRect = textEl.getBoundingClientRect();
  if (clientY > textRect.bottom + 6 || clientY < textRect.top - 6) {
    return text.length;
  }

  const docAny = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
  };

  let node: Node | null = null;
  let offset = -1;

  if (typeof docAny.caretRangeFromPoint === 'function') {
    const range = docAny.caretRangeFromPoint(clientX, clientY);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  } else if (typeof docAny.caretPositionFromPoint === 'function') {
    const pos = docAny.caretPositionFromPoint(clientX, clientY);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  }

  if (node !== textNode || offset < 0) {
    return text.length;
  }

  const clamped = Math.max(0, Math.min(text.length, offset));
  const probeIdx =
    clamped > 0 && (clamped >= text.length || text[clamped] === '\n')
      ? clamped - 1
      : Math.min(text.length - 1, clamped);

  if (probeIdx >= 0 && text[probeIdx] !== '\n') {
    try {
      const charRange = document.createRange();
      charRange.setStart(textNode, probeIdx);
      charRange.setEnd(textNode, probeIdx + 1);
      const charRect = charRange.getBoundingClientRect();
      if (charRect.height > 0) {
        if (clientY > charRect.bottom + 8 || clientY < charRect.top - 8) {
          return text.length;
        }
        if (clientX > charRect.right + 18 || clientX < charRect.left - 18) {
          return text.length;
        }
      }
    } catch {
      return text.length;
    }
  } else if (clamped >= text.length) {
    return text.length;
  }

  return clamped;
}

export const ReadingNotePopover: React.FC<ReadingNotePopoverProps> = ({
  allNotes,
  initialNoteId,
  defaultAnchor,
  fontSize = 16,
  onSwitchNote,
  onSaveNote,
  onClose,
}) => {
  const initialNote = initialNoteId
    ? allNotes.find((n) => n.id === initialNoteId) || null
    : null;
  const isInitialNewNote = initialNote === null;

  const [activeNoteId, setActiveNoteId] = useState<string | null>(initialNote?.id ?? null);
  const [anchor, setAnchor] = useState<NoteAnchorTarget>(() =>
    initialNote
      ? { charOffset: initialNote.charOffset, anchorText: initialNote.anchorText }
      : defaultAnchor
  );
  const [draft, setDraft] = useState<string>(initialNote?.content ?? '');
  // New notes enter edit mode immediately; existing notes open in browse mode without keyboard
  const [isEditing, setIsEditing] = useState<boolean>(() => isInitialNewNote);
  const [keyboardLiftPx, setKeyboardLiftPx] = useState<number>(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const browseScrollRef = useRef<HTMLDivElement>(null);
  const browseTextRef = useRef<HTMLDivElement>(null);

  const activeNoteIdRef = useRef<string | null>(activeNoteId);
  const anchorRef = useRef<NoteAnchorTarget>(anchor);
  const draftRef = useRef<string>(draft);
  const isEditingRef = useRef<boolean>(isEditing);
  const allNotesRef = useRef<ReadingNote[]>(allNotes);
  const initialContentRef = useRef<string>(initialNote?.content ?? '');
  const skipNextCommitRef = useRef<boolean>(false);
  const onSaveNoteRef = useRef(onSaveNote);
  const onSwitchNoteRef = useRef(onSwitchNote);

  const swipeStartRef = useRef<{
    pointerId: number;
    pointerType: string;
    x: number;
    y: number;
    time: number;
    triggered: boolean;
  } | null>(null);
  const suppressNextClickRef = useRef<boolean>(false);

  activeNoteIdRef.current = activeNoteId;
  anchorRef.current = anchor;
  draftRef.current = draft;
  isEditingRef.current = isEditing;
  allNotesRef.current = allNotes;
  onSaveNoteRef.current = onSaveNote;
  onSwitchNoteRef.current = onSwitchNote;

  const commitCurrentDraft = useCallback(() => {
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false;
      return;
    }
    const trimmed = draftRef.current.trim();
    const origTrimmed = initialContentRef.current.trim();
    const curId = activeNoteIdRef.current;

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

  // Auto-save cleanly if unmounted externally
  useEffect(() => {
    return () => {
      commitCurrentDraft();
    };
  }, [commitCurrentDraft]);

  // Synchronously focus textarea inside the tap gesture when opening a brand-new note
  useLayoutEffect(() => {
    if (!isInitialNewNote) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.readOnly = false;
    ta.focus({ preventScroll: true });
  }, [isInitialNewNote]);

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

  const switchToNote = useCallback((target: ReadingNote) => {
    if (target.id === activeNoteIdRef.current) return;
    commitCurrentDraft();
    // Return to browse mode when switching notes so the keyboard stays dismissed
    const ta = textareaRef.current;
    if (ta) {
      ta.readOnly = true;
      ta.blur();
    }
    setIsEditing(false);
    setActiveNoteId(target.id);
    setAnchor({ charOffset: target.charOffset, anchorText: target.anchorText });
    setDraft(target.content);
    initialContentRef.current = target.content;
    if (browseScrollRef.current) {
      browseScrollRef.current.scrollTop = 0;
    }
    onSwitchNoteRef.current?.(target.charOffset);
  }, [commitCurrentDraft]);

  const navigateRelativeNote = useCallback(
    (direction: 'prev' | 'next'): boolean => {
      const notes = allNotesRef.current;
      if (notes.length === 0) return false;

      const curId = activeNoteIdRef.current;
      if (curId) {
        const idx = notes.findIndex((n) => n.id === curId);
        if (idx !== -1) {
          const targetIdx = direction === 'next' ? idx + 1 : idx - 1;
          if (targetIdx < 0 || targetIdx >= notes.length) return false;
          switchToNote(notes[targetIdx]);
          return true;
        }
      }

      // Currently on a brand-new (unsaved) note: jump to nearest note after/before its anchor
      const curOffset = anchorRef.current.charOffset;
      if (direction === 'next') {
        const nextNote = notes.find((n) => n.charOffset >= curOffset);
        if (!nextNote) return false;
        switchToNote(nextNote);
        return true;
      } else {
        for (let i = notes.length - 1; i >= 0; i--) {
          if (notes[i].charOffset <= curOffset) {
            switchToNote(notes[i]);
            return true;
          }
        }
        return false;
      }
    },
    [switchToNote]
  );

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

  const handleCardPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // In edit mode, only track touch swipes so desktop mouse drag-selection inside textarea works normally
    if (isEditingRef.current && e.pointerType !== 'touch') return;
    swipeStartRef.current = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      x: e.clientX,
      y: e.clientY,
      time: performance.now(),
      triggered: false,
    };
  };

  const handleCardPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start || start.pointerId !== e.pointerId) return;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const elapsed = performance.now() - start.time;

    const inEditMode = isEditingRef.current;
    if (inEditMode) {
      const ta = textareaRef.current;
      // Don't hijack swipe if user has an active text selection
      if (ta && ta.selectionStart !== ta.selectionEnd) return;
      if (absX >= 56 && absX > absY * 1.8 && elapsed < 500) {
        const switched = navigateRelativeNote(dx < 0 ? 'next' : 'prev');
        if (switched) {
          suppressNextClickRef.current = true;
          window.setTimeout(() => {
            suppressNextClickRef.current = false;
          }, 260);
        }
      }
      return;
    }

    // Browse mode: clean horizontal swipe switches to next/previous note
    if (absX >= 42 && absX > absY * 1.35) {
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 260);
      navigateRelativeNote(dx < 0 ? 'next' : 'prev');
    }
  };

  const handleCardPointerCancel = () => {
    swipeStartRef.current = null;
  };

  const handleBrowseClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    const caretPos = resolveTapCaretOffset(
      browseTextRef.current,
      draftRef.current,
      e.clientX,
      e.clientY
    );
    const browseScrollTop = browseScrollRef.current?.scrollTop ?? 0;

    // Clear any accidental browser selection on the browse overlay
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      // ignore
    }

    // Focus textarea synchronously inside the user tap gesture so mobile keyboards reliably open
    const ta = textareaRef.current;
    if (ta) {
      ta.readOnly = false;
      ta.scrollTop = browseScrollTop;
      ta.focus({ preventScroll: true });
      try {
        ta.setSelectionRange(caretPos, caretPos);
      } catch {
        // ignore selection errors on older webviews
      }
    }
    setIsEditing(true);
  };

  const inputFontSize = Math.max(14, Math.min(18, Math.round(fontSize - 1)));
  const bottomStyle = keyboardLiftPx > 0 ? `${keyboardLiftPx + 10}px` : '64px';

  return (
    <>
      {/* Full-viewport click-away layer (including bottom toolbar) to close & auto-save */}
      <div
        data-note-popover-backdrop="true"
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          handleSaveAndClose();
        }}
        className="fixed inset-0 z-30 bg-transparent"
      />

      <div
        data-note-popover="true"
        style={{ bottom: bottomStyle }}
        onPointerDown={handleCardPointerDown}
        onPointerUp={handleCardPointerUp}
        onPointerCancel={handleCardPointerCancel}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="fixed left-3 right-3 z-40 flex justify-center pointer-events-none"
      >
        <div className="pointer-events-auto w-full max-w-[720px] flex flex-col bg-[var(--fei-popup-bg)] border-[1.5px] border-[var(--fei-popup-border)] rounded-2xl shadow-[0_12px_32px_-6px_rgba(0,0,0,0.14)] dark:ring-1 dark:ring-white/10 dark:shadow-[0_14px_36px_-4px_rgba(0,0,0,0.75)] eink:shadow-none overflow-hidden text-[var(--fei-text-primary)]">
          {/* Pure Borderless Note Box (Browse Mode by default; tap to edit at caret or end) */}
          <div className="relative px-4 py-3 bg-[var(--fei-popup-bg)]">
            <textarea
              ref={textareaRef}
              value={draft}
              autoFocus={isInitialNewNote}
              readOnly={!isEditing}
              tabIndex={isEditing ? 0 : -1}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSaveAndClose();
                }
              }}
              rows={4}
              aria-label="读书笔记"
              style={{ fontSize: `${inputFontSize}px` }}
              className={`block w-full min-h-[112px] max-h-[34vh] resize-none bg-transparent text-[var(--fei-text-primary)] leading-[1.6] font-doc-body outline-none border-0 p-0 ${
                isEditing ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
              }`}
            />

            {!isEditing && (
              <div
                ref={browseScrollRef}
                onClick={handleBrowseClick}
                style={{ fontSize: `${inputFontSize}px` }}
                className="absolute inset-0 px-4 py-3 overflow-y-auto touch-pan-y leading-[1.6] font-doc-body cursor-text"
              >
                {draft && (
                  <div
                    ref={browseTextRef}
                    className="text-[var(--fei-text-primary)] whitespace-pre-wrap break-words"
                  >
                    {draft}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

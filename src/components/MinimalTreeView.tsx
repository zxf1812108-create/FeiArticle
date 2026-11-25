import React, {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  FilePlus,
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wifi,
} from 'lucide-react';
import { ArticleDoc, FolderNode } from '../types';
import { INBOX_FOLDER_ID, INBOX_FOLDER_NAME } from '../utils/inbox';

export type InsertPosition = 'before' | 'after' | 'end';

export type TreeSelection =
  | { kind: 'folder'; id: string }
  | { kind: 'doc'; id: string };

export interface MinimalTreeViewHandle {
  getScrollTop: () => number;
  startRenameTarget: (target: TreeSelection) => 'ok' | 'inbox' | 'missing';
  flushRename: () => void;
}

interface MinimalTreeViewProps {
  folders: FolderNode[];
  docs: ArticleDoc[];
  collapsedIds: Set<string>;
  initialScrollTop: number;
  activeTarget: TreeSelection | null;
  cutItem: TreeSelection | null;
  pickCutMode: boolean;
  onToggleCollapse: (id: string) => void;
  onExpandFolder: (id: string) => void;
  onScrollTopChange: (scrollTop: number) => void;
  onSelectTarget: (target: TreeSelection) => void;
  onClearSelection?: () => void;
  onOpenDoc?: (docId: string) => void;
  onCancelCut: () => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRenameDoc: (docId: string, title: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onCreateDocInFolder: (folderId: string | null) => void;
  onMoveFolderToPosition: (
    sourceFolderId: string,
    targetFolderId: string,
    position: 'before' | 'after'
  ) => void;
  onMoveDocToPosition: (
    docId: string,
    targetFolderId: string | null,
    targetDocId: string | null,
    position: InsertPosition
  ) => void;
  onDragPayloadChange?: (payload: DragPayload | null) => void;
  onTrashDrop?: (payload: DragPayload) => void;
  onTrashDragHoverChange?: (hovering: boolean) => void;
  onPullRefresh?: () => void;
  isPullRefreshing?: boolean;
}

export type DragPayload =
  | { kind: 'folder'; id: string }
  | { kind: 'doc'; id: string };

const LONG_PRESS_RENAME_MS = 320;

export const MinimalTreeView = forwardRef<MinimalTreeViewHandle, MinimalTreeViewProps>(
  function MinimalTreeView(
    {
      folders,
      docs,
      collapsedIds,
      initialScrollTop,
      activeTarget,
      cutItem,
      pickCutMode,
      onToggleCollapse,
      onExpandFolder,
      onScrollTopChange,
      onSelectTarget,
      onClearSelection,
      onCancelCut,
      onCreateFolder,
      onRenameFolder,
      onRenameDoc,
      onDeleteFolder,
      onCreateDocInFolder,
      onMoveFolderToPosition,
      onMoveDocToPosition,
      onDragPayloadChange,
      onTrashDrop,
      onTrashDragHoverChange,
      onPullRefresh,
      isPullRefreshing = false,
    },
    ref
  ) {
  const PULL_REFRESH_THRESHOLD = 52;
  const scrollRef = useRef<HTMLDivElement>(null);
  const debounceScrollRef = useRef<number | null>(null);
  const restoredScrollRef = useRef(false);
  const renameHoldCleanupRef = useRef<(() => void) | null>(null);
  const handleDragCleanupRef = useRef<(() => void) | null>(null);
  const folderHeaderRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const folderGroupRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const docRowRefs = useRef<Map<string, { el: HTMLDivElement | null; folderId: string | null }>>(
    new Map()
  );
  const uncategorizedHeaderRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const pullStartRef = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const pullDistanceRef = useRef(0);
  const onPullRefreshRef = useRef(onPullRefresh);
  onPullRefreshRef.current = onPullRefresh;
  const isPullRefreshingRef = useRef(isPullRefreshing);
  isPullRefreshingRef.current = isPullRefreshing;

  const [pullDistance, setPullDistance] = useState(0);
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingItem, setEditingItem] = useState<TreeSelection | null>(null);
  const [editingName, setEditingName] = useState('');
  const editingItemRef = useRef<TreeSelection | null>(null);
  editingItemRef.current = editingItem;
  const editingNameRef = useRef('');
  editingNameRef.current = editingName;
  const editingActiveRef = useRef(false);
  editingActiveRef.current = Boolean(editingItem || addingFolder);

  // Restore saved directory scroll position synchronously on entering tree mode
  useLayoutEffect(() => {
    if (restoredScrollRef.current) return;
    restoredScrollRef.current = true;
    const el = scrollRef.current;
    if (el && initialScrollTop > 0) {
      el.scrollTop = initialScrollTop;
    }
  }, [initialScrollTop]);

  React.useEffect(() => {
    return () => {
      if (debounceScrollRef.current) {
        window.clearTimeout(debounceScrollRef.current);
      }
      renameHoldCleanupRef.current?.();
      renameHoldCleanupRef.current = null;
      handleDragCleanupRef.current?.();
      handleDragCleanupRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    getScrollTop() {
      return scrollRef.current?.scrollTop ?? 0;
    },
    startRenameTarget(target: TreeSelection) {
      if (target.kind === 'folder') {
        if (target.id === INBOX_FOLDER_ID) return 'inbox';
        const folder = folders.find((f) => !f.deleted && f.id === target.id);
        if (!folder) return 'missing';
        setEditingItem(target);
        setEditingName(folder.name);
        return 'ok';
      }
      const doc = docs.find((d) => !d.deleted && d.id === target.id);
      if (!doc) return 'missing';
      if (doc.folderId && collapsedIds.has(doc.folderId)) {
        onExpandFolder(doc.folderId);
      } else if (!doc.folderId && collapsedIds.has('__uncategorized__')) {
        onExpandFolder('__uncategorized__');
      }
      setEditingItem(target);
      setEditingName(doc.title || '');
      return 'ok';
    },
    flushRename() {
      const current = editingItemRef.current;
      if (!current) return;
      commitRename(current);
    },
  }));

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (debounceScrollRef.current) window.clearTimeout(debounceScrollRef.current);
    debounceScrollRef.current = window.setTimeout(() => {
      onScrollTopChange(el.scrollTop);
    }, 180);
  };

  // Unified pointer-based drag-and-drop state supporting BOTH folders and articles on desktop & touch
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [folderDrop, setFolderDrop] = useState<{
    targetFolderId: string;
    position: 'before' | 'after';
  } | null>(null);
  const [docDrop, setDocDrop] = useState<{
    folderId: string | null;
    docId: string | null;
    position: InsertPosition;
  } | null>(null);
  const dragActiveRef = useRef(false);
  dragActiveRef.current = Boolean(dragging);

  // Pull-to-refresh at the top of Directory Mode (touch gesture, E-Ink friendly low-repaint steps)
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const resetPull = () => {
      pullStartRef.current = null;
      if (pullDistanceRef.current !== 0) {
        pullDistanceRef.current = 0;
        setPullDistance(0);
      }
    };

    const handlePullTouchStart = (e: TouchEvent) => {
      const targetEl = e.target instanceof Element ? e.target : null;
      if (
        !onPullRefreshRef.current ||
        isPullRefreshingRef.current ||
        dragActiveRef.current ||
        editingActiveRef.current ||
        targetEl?.closest('[data-tree-drag-handle="true"]') ||
        e.touches.length !== 1 ||
        el.scrollTop > 1
      ) {
        pullStartRef.current = null;
        return;
      }
      const t = e.touches[0];
      pullStartRef.current = { x: t.clientX, y: t.clientY, active: false };
    };

    const handlePullTouchMove = (e: TouchEvent) => {
      const start = pullStartRef.current;
      if (!start) return;
      if (
        !onPullRefreshRef.current ||
        isPullRefreshingRef.current ||
        dragActiveRef.current ||
        editingActiveRef.current ||
        e.touches.length !== 1
      ) {
        resetPull();
        return;
      }

      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;

      if (!start.active) {
        if (el.scrollTop > 1 || dy < -6 || (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy))) {
          pullStartRef.current = null;
          return;
        }
        if (dy >= 8 && dy > Math.abs(dx) * 1.2) {
          start.active = true;
          renameHoldCleanupRef.current?.();
          renameHoldCleanupRef.current = null;
        } else {
          return;
        }
      }

      if (dy <= 0) {
        if (pullDistanceRef.current !== 0) {
          pullDistanceRef.current = 0;
          setPullDistance(0);
        }
        return;
      }

      e.preventDefault();
      const damped = Math.min(80, Math.round(dy * 0.48));
      const crossedThreshold =
        (pullDistanceRef.current < PULL_REFRESH_THRESHOLD && damped >= PULL_REFRESH_THRESHOLD) ||
        (pullDistanceRef.current >= PULL_REFRESH_THRESHOLD && damped < PULL_REFRESH_THRESHOLD);
      if (crossedThreshold || Math.abs(damped - pullDistanceRef.current) >= 4) {
        pullDistanceRef.current = damped;
        setPullDistance(damped);
      }
    };

    const handlePullTouchEnd = () => {
      const shouldTrigger =
        Boolean(pullStartRef.current?.active) &&
        pullDistanceRef.current >= PULL_REFRESH_THRESHOLD &&
        !isPullRefreshingRef.current;
      resetPull();
      if (shouldTrigger) {
        onPullRefreshRef.current?.();
      }
    };

    el.addEventListener('touchstart', handlePullTouchStart, { passive: true });
    el.addEventListener('touchmove', handlePullTouchMove, { passive: false });
    el.addEventListener('touchend', handlePullTouchEnd, { passive: true });
    el.addEventListener('touchcancel', resetPull, { passive: true });
    return () => {
      el.removeEventListener('touchstart', handlePullTouchStart);
      el.removeEventListener('touchmove', handlePullTouchMove);
      el.removeEventListener('touchend', handlePullTouchEnd);
      el.removeEventListener('touchcancel', resetPull);
    };
  }, []);

  const liveDocs = useMemo(() => docs.filter((d) => !d.deleted), [docs]);
  const sortedFolders = useMemo(
    () => [...folders].filter((f) => !f.deleted).sort((a, b) => a.order - b.order),
    [folders]
  );

  const getDocsForFolder = (folderId: string | null) =>
    liveDocs
      .filter((d) => d.folderId === folderId)
      .sort((a, b) => a.order - b.order || b.updatedAt - a.updatedAt);

  const inboxDocs = getDocsForFolder(INBOX_FOLDER_ID);
  const uncategorizedDocs = getDocsForFolder(null);

  const cutLabel = useMemo(() => {
    if (!cutItem) return null;
    if (cutItem.kind === 'folder') {
      const f = folders.find((item) => item.id === cutItem.id);
      return f ? `目录「${f.name}」` : null;
    }
    const d = liveDocs.find((item) => item.id === cutItem.id);
    return d ? `文章「${d.title || '无标题文档'}」` : null;
  }, [cutItem, folders, liveDocs]);

  const toggleExpand = (id: string) => {
    onToggleCollapse(id);
  };

  const commitNewFolder = () => {
    const trimmed = newFolderName.trim();
    if (trimmed) {
      onCreateFolder(trimmed);
    }
    setNewFolderName('');
    setAddingFolder(false);
  };

  const commitRename = (target: TreeSelection) => {
    const active = editingItemRef.current;
    if (!active || active.kind !== target.kind || active.id !== target.id) return;
    editingItemRef.current = null;
    const trimmed = editingNameRef.current.trim();
    if (trimmed) {
      if (target.kind === 'folder') {
        onRenameFolder(target.id, trimmed);
      } else {
        onRenameDoc(target.id, trimmed);
      }
    }
    setEditingItem(null);
    setEditingName('');
  };

  const clearDragState = () => {
    setDragging(null);
    setFolderDrop(null);
    setDocDrop(null);
    onDragPayloadChange?.(null);
    onTrashDragHoverChange?.(false);
  };

  // Safety guard: immediately clear drag state if the dragged doc/folder disappears
  React.useEffect(() => {
    if (!dragging) return;
    const stillExists =
      dragging.kind === 'doc'
        ? liveDocs.some((d) => d.id === dragging.id)
        : sortedFolders.some((f) => f.id === dragging.id);
    if (!stillExists) {
      handleDragCleanupRef.current?.();
      clearDragState();
    }
  }, [dragging, liveDocs, sortedFolders]);

  // Long-press on a folder or document name enters inline rename mode (320ms, no dragging)
  const handleNameLongPressStart = (
    e: React.PointerEvent<HTMLButtonElement>,
    target: TreeSelection,
    currentName: string
  ) => {
    if (pickCutMode || Boolean(cutItem)) return;
    if (target.kind === 'folder' && target.id === INBOX_FOLDER_ID) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    renameHoldCleanupRef.current?.();

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let timer: number | null = window.setTimeout(() => {
      timer = null;
      detach();
      suppressClickRef.current = true;
      try {
        navigator.vibrate?.(10);
      } catch {
        // ignore
      }
      onSelectTarget(target);
      setEditingItem(target);
      setEditingName(currentName);
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 260);
    }, LONG_PRESS_RENAME_MS);

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >= 8) {
        detach();
      }
    };

    const onPointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      detach();
    };

    const detach = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      if (renameHoldCleanupRef.current === detach) {
        renameHoldCleanupRef.current = null;
      }
    };

    renameHoldCleanupRef.current = detach;
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true });
  };

  // Unified drag handle interaction (works identically on desktop mouse & mobile touch):
  // - Dragging >= 6px reorders / moves between folders / drops into Trash
  // - Short tap without dragging on a folder handle still toggles expand/collapse (Plan 1A)
  const handleDragHandlePointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    payload: DragPayload,
    onShortTap?: () => void
  ) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();

    renameHoldCleanupRef.current?.();
    handleDragCleanupRef.current?.();

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    let overTrash = false;
    let activeFolderDrop: { targetFolderId: string; position: 'before' | 'after' } | null = null;
    let activeDocDrop: {
      folderId: string | null;
      docId: string | null;
      position: InsertPosition;
    } | null = null;

    const updateTrashHover = (next: boolean) => {
      if (overTrash !== next) {
        overTrash = next;
        onTrashDragHoverChange?.(next);
      }
    };

    const resolveDropTargets = (clientX: number, clientY: number) => {
      const hitEl = document.elementFromPoint(clientX, clientY);
      const isOverTrash = Boolean(hitEl?.closest('[data-trash-dropzone="true"]'));
      updateTrashHover(isOverTrash);

      if (isOverTrash) {
        if (activeFolderDrop !== null) {
          activeFolderDrop = null;
          setFolderDrop(null);
        }
        if (activeDocDrop !== null) {
          activeDocDrop = null;
          setDocDrop(null);
        }
        return;
      }

      const listEl = scrollRef.current;
      if (!listEl) return;
      const listRect = listEl.getBoundingClientRect();
      if (
        clientX < listRect.left ||
        clientX > listRect.right ||
        clientY < listRect.top ||
        clientY > listRect.bottom
      ) {
        if (activeFolderDrop !== null) {
          activeFolderDrop = null;
          setFolderDrop(null);
        }
        if (activeDocDrop !== null) {
          activeDocDrop = null;
          setDocDrop(null);
        }
        return;
      }

      // Gently auto-scroll list near top/bottom edge while dragging
      if (clientY < listRect.top + 44) {
        listEl.scrollTop -= 8;
      } else if (clientY > listRect.bottom - 44) {
        listEl.scrollTop += 8;
      }

      if (payload.kind === 'folder') {
        let nextFolderDrop: { targetFolderId: string; position: 'before' | 'after' } | null = null;
        let closestDist = Infinity;
        for (const f of sortedFolders) {
          if (f.id === payload.id) continue;
          const groupEl = folderGroupRefs.current.get(f.id);
          if (!groupEl) continue;
          const rect = groupEl.getBoundingClientRect();
          if (clientY >= rect.top - 4 && clientY <= rect.bottom + 4) {
            nextFolderDrop = {
              targetFolderId: f.id,
              position: clientY < rect.top + rect.height / 2 ? 'before' : 'after',
            };
            break;
          }
          const dist = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
          if (dist < closestDist) {
            closestDist = dist;
            nextFolderDrop = {
              targetFolderId: f.id,
              position: clientY < rect.top ? 'before' : 'after',
            };
          }
        }
        activeFolderDrop = nextFolderDrop;
        activeDocDrop = null;
        setFolderDrop(nextFolderDrop);
        setDocDrop(null);
        return;
      }

      // payload.kind === 'doc': check document rows first, then folder headers & uncategorized header
      let nextDocDrop: {
        folderId: string | null;
        docId: string | null;
        position: InsertPosition;
      } | null = null;

      for (const [targetDocId, entry] of docRowRefs.current.entries()) {
        if (!entry.el || targetDocId === payload.id || entry.folderId === INBOX_FOLDER_ID) continue;
        const rect = entry.el.getBoundingClientRect();
        if (rect.height <= 0) continue;
        if (clientY >= rect.top - 2 && clientY <= rect.bottom + 2) {
          nextDocDrop = {
            folderId: entry.folderId,
            docId: targetDocId,
            position: clientY < rect.top + rect.height / 2 ? 'before' : 'after',
          };
          break;
        }
      }

      if (!nextDocDrop) {
        for (const f of sortedFolders) {
          const headerEl = folderHeaderRefs.current.get(f.id);
          if (!headerEl) continue;
          const rect = headerEl.getBoundingClientRect();
          if (rect.height <= 0) continue;
          if (clientY >= rect.top - 2 && clientY <= rect.bottom + 2) {
            nextDocDrop = { folderId: f.id, docId: null, position: 'end' };
            break;
          }
        }
      }

      if (!nextDocDrop && uncategorizedHeaderRef.current) {
        const rect = uncategorizedHeaderRef.current.getBoundingClientRect();
        if (rect.height > 0 && clientY >= rect.top - 2 && clientY <= rect.bottom + 2) {
          nextDocDrop = { folderId: null, docId: null, position: 'end' };
        }
      }

      activeDocDrop = nextDocDrop;
      activeFolderDrop = null;
      setDocDrop(nextDocDrop);
      setFolderDrop(null);
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (!isDragging) {
        if (Math.hypot(dx, dy) < 6) return;
        isDragging = true;
        suppressClickRef.current = true;
        setDragging(payload);
        onDragPayloadChange?.(payload);
        try {
          navigator.vibrate?.(10);
        } catch {
          // ignore
        }
      }

      if (moveEvent.cancelable) {
        moveEvent.preventDefault();
      }
      resolveDropTargets(moveEvent.clientX, moveEvent.clientY);
    };

    const onTouchMoveGuard = (touchEvent: TouchEvent) => {
      if (touchEvent.cancelable) {
        touchEvent.preventDefault();
      }
    };

    const detach = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('touchmove', onTouchMoveGuard);
      if (handleDragCleanupRef.current === detach) {
        handleDragCleanupRef.current = null;
      }
    };

    const onPointerUp = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      detach();
      if (!isDragging) {
        onShortTap?.();
        return;
      }
      const droppedOnTrash = overTrash;
      const finalFolderDrop = activeFolderDrop;
      const finalDocDrop = activeDocDrop;
      clearDragState();

      if (droppedOnTrash) {
        onTrashDrop?.(payload);
      } else if (payload.kind === 'folder' && finalFolderDrop) {
        onMoveFolderToPosition(payload.id, finalFolderDrop.targetFolderId, finalFolderDrop.position);
      } else if (payload.kind === 'doc' && finalDocDrop) {
        onMoveDocToPosition(
          payload.id,
          finalDocDrop.folderId,
          finalDocDrop.docId,
          finalDocDrop.position
        );
        if (finalDocDrop.docId === null && finalDocDrop.folderId) {
          onExpandFolder(finalDocDrop.folderId);
        }
      }

      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 150);
    };

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      detach();
      if (isDragging) {
        clearDragState();
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 150);
      }
    };

    handleDragCleanupRef.current = detach;
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('touchmove', onTouchMoveGuard, { passive: false });
  };

  const renderArticleRow = (doc: ArticleDoc, folderId: string | null) => {
    const isTarget = activeTarget?.kind === 'doc' && activeTarget.id === doc.id;
    const isCut = cutItem?.kind === 'doc' && cutItem.id === doc.id;
    const isDragging = dragging?.kind === 'doc' && dragging.id === doc.id;
    const isDropBefore = docDrop?.docId === doc.id && docDrop.position === 'before';
    const isDropAfter = docDrop?.docId === doc.id && docDrop.position === 'after';
    const isEditingThisDoc = editingItem?.kind === 'doc' && editingItem.id === doc.id;
    const showDragHandle = isTarget && !isEditingThisDoc && !pickCutMode && !cutItem;

    return (
      <div
        key={doc.id}
        data-tree-row="true"
        ref={(el) => {
          if (el) {
            docRowRefs.current.set(doc.id, { el, folderId });
          } else {
            docRowRefs.current.delete(doc.id);
          }
        }}
        className={`relative group flex items-center gap-1.5 px-2 min-h-[44px] rounded-lg transition-colors duration-150 ${
          isDragging ? 'opacity-35' : ''
        } ${
          isCut
            ? 'opacity-45 border border-dashed border-[var(--fei-text-muted)]'
            : isTarget
              ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)]'
              : 'border border-transparent hover:bg-[var(--fei-bg-hover)]'
        }`}
      >
        {isDropBefore && (
          <div className="pointer-events-none absolute -top-[1px] left-11 right-2 h-[2px] bg-[var(--fei-text-primary)] rounded-full z-10" />
        )}
        {isDropAfter && (
          <div className="pointer-events-none absolute -bottom-[1px] left-11 right-2 h-[2px] bg-[var(--fei-text-primary)] rounded-full z-10" />
        )}

        {showDragHandle ? (
          <button
            type="button"
            data-tree-drag-handle="true"
            onPointerDown={(e) =>
              handleDragHandlePointerDown(e, { kind: 'doc', id: doc.id })
            }
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            aria-label="拖动调整文档顺序或移入回收站"
            title="按住拖动可调整顺序、移入其他目录或拖入回收站"
            className="w-9 h-9 -ml-1 flex items-center justify-center rounded-md text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] cursor-grab active:cursor-grabbing touch-none shrink-0"
          >
            <GripVertical className="w-4 h-4" strokeWidth={1.9} />
          </button>
        ) : (
          <span aria-hidden="true" className="w-9 h-9 -ml-1 shrink-0" />
        )}

        {isEditingThisDoc ? (
          <input
            autoFocus
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={() => commitRename({ kind: 'doc', id: doc.id })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename({ kind: 'doc', id: doc.id });
              if (e.key === 'Escape') {
                editingItemRef.current = null;
                setEditingItem(null);
                setEditingName('');
              }
            }}
            className="flex-1 min-w-0 bg-transparent border-b border-[var(--fei-text-muted)] text-[15px] leading-snug text-[var(--fei-text-primary)] outline-none py-1 select-text"
          />
        ) : (
          <button
            type="button"
            onPointerDown={(e) =>
              handleNameLongPressStart(e, { kind: 'doc', id: doc.id }, doc.title || '')
            }
            onContextMenu={(e) => e.preventDefault()}
            onClick={() => {
              if (suppressClickRef.current) return;
              onSelectTarget({ kind: 'doc', id: doc.id });
            }}
            className={`flex-1 min-w-0 text-left text-[15px] leading-snug truncate py-2.5 ${
              doc.syncStatus === 'remote-only' && !doc.content
                ? 'text-[var(--fei-text-muted)]'
                : 'text-[var(--fei-text-primary)]'
            }`}
          >
            {doc.title || '无标题文档'}
          </button>
        )}

        {doc.syncStatus === 'remote-only' && !doc.content && (
          <span
            title={
              doc.cloudBodySynced
                ? '正文在云端，打开后可拉取'
                : '本机暂无正文，请在同 Wi-Fi 下同步'
            }
            aria-label={doc.cloudBodySynced ? '待从云端拉取正文' : '待 Wi-Fi 同步正文'}
            className="mr-1 inline-flex items-center justify-center text-[var(--fei-text-muted)] shrink-0"
          >
            {doc.cloudBodySynced ? (
              <CloudDownload className="w-[13.5px] h-[13.5px]" strokeWidth={1.75} />
            ) : (
              <Wifi className="w-[13.5px] h-[13.5px]" strokeWidth={1.75} />
            )}
          </span>
        )}

        {doc.encrypted && (
          <span
            aria-label="已加密"
            className="mr-1.5 min-w-[16px] text-center text-[14px] leading-none font-code text-[var(--fei-text-muted)] shrink-0"
          >
            *
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onClick={(e) => {
        if (suppressClickRef.current) return;
        if (
          e.target instanceof Element &&
          e.target.closest('[data-tree-row="true"], button, input, [data-cut-strip="true"]')
        ) {
          return;
        }
        if (editingItemRef.current) {
          commitRename(editingItemRef.current);
        }
        if (addingFolder) {
          commitNewFolder();
        }
        if (!pickCutMode && !cutItem && activeTarget !== null) {
          onClearSelection?.();
        }
      }}
      className="w-full h-full overflow-y-auto overscroll-y-contain bg-[var(--fei-bg)] select-none"
    >
      {(pullDistance > 0 || isPullRefreshing) && (
        <div
          style={{ height: isPullRefreshing ? 36 : pullDistance }}
          className="flex items-center justify-center overflow-hidden text-[12.5px] text-[var(--fei-text-muted)] border-b border-[var(--fei-border)] bg-[var(--fei-bg)] select-none"
        >
          <span className="inline-flex items-center gap-1.5">
            {isPullRefreshing ? (
              <>
                <RefreshCw
                  className="w-3.5 h-3.5 animate-spin eink:animate-none"
                  strokeWidth={1.8}
                />
                <span>正在同步云端…</span>
              </>
            ) : pullDistance >= PULL_REFRESH_THRESHOLD ? (
              <>
                <ArrowUp className="w-3.5 h-3.5" strokeWidth={1.8} />
                <span>松手立即同步</span>
              </>
            ) : (
              <>
                <ArrowDown className="w-3.5 h-3.5" strokeWidth={1.8} />
                <span>下拉同步云端</span>
              </>
            )}
          </span>
        </div>
      )}
      <div className="max-w-[760px] mx-auto px-4 sm:px-8 pt-6 pb-10 space-y-1.5">
        {/* Status strip only when cutting or selecting item to cut */}
        {(pickCutMode || cutLabel) && (
          <div
            data-cut-strip="true"
            className="mb-3 px-3.5 py-2.5 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] flex items-center justify-between gap-3 text-[13px]"
          >
            <span className="text-[var(--fei-text-muted)] truncate">
              {cutLabel
                ? `已剪切 ${cutLabel} — 点选目标位置后，点击底部插入图标插入其下方`
                : '请点击要剪切的目录或文章'}
            </span>
            <button
              type="button"
              onClick={onCancelCut}
              className="text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] shrink-0 whitespace-nowrap transition-colors"
            >
              取消
            </button>
          </div>
        )}

        {/* Dynamic inbox dropbox directory (visible only when it contains documents; disappears once emptied) */}
        {inboxDocs.length > 0 && (() => {
          const isInboxExpanded = !collapsedIds.has(INBOX_FOLDER_ID);
          const isInboxTarget =
            activeTarget?.kind === 'folder' && activeTarget.id === INBOX_FOLDER_ID;
          return (
            <div className="relative space-y-0.5">
              <div
                data-tree-row="true"
                className={`flex items-center gap-1.5 px-2 min-h-[44px] rounded-lg transition-colors duration-150 ${
                  isInboxTarget
                    ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)]'
                    : 'border border-transparent hover:bg-[var(--fei-bg-hover)]'
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(INBOX_FOLDER_ID);
                  }}
                  aria-label={isInboxExpanded ? '收起 inbox' : '展开 inbox'}
                  className="w-9 h-9 -ml-1 flex items-center justify-center text-[var(--fei-text-muted)] shrink-0"
                >
                  {isInboxExpanded ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </button>

                <button
                  type="button"
                  onContextMenu={(e) => e.preventDefault()}
                  onClick={() => onSelectTarget({ kind: 'folder', id: INBOX_FOLDER_ID })}
                  className="flex-1 min-w-0 text-left text-[14.5px] font-medium truncate py-2 text-[var(--fei-text-primary)]"
                >
                  {INBOX_FOLDER_NAME}
                </button>

                <span className="mr-1.5 min-w-[16px] text-center text-[12px] font-code tabular-nums text-[var(--fei-text-muted)] shrink-0">
                  {inboxDocs.length}
                </span>
              </div>

              {isInboxExpanded && (
                <div className="space-y-0.5">
                  {inboxDocs.map((doc) => renderArticleRow(doc, INBOX_FOLDER_ID))}
                </div>
              )}
            </div>
          );
        })()}

        {/* Single-Level Directory List */}
        {sortedFolders.map((folder) => {
          const folderDocs = getDocsForFolder(folder.id);
          const isExpanded = !collapsedIds.has(folder.id);
          const isTarget = activeTarget?.kind === 'folder' && activeTarget.id === folder.id;
          const isCut = cutItem?.kind === 'folder' && cutItem.id === folder.id;
          const isDragging = dragging?.kind === 'folder' && dragging.id === folder.id;
          const isFolderDropBefore =
            folderDrop?.targetFolderId === folder.id && folderDrop.position === 'before';
          const isFolderDropAfter =
            folderDrop?.targetFolderId === folder.id && folderDrop.position === 'after';
          const isDocDropIntoFolder =
            docDrop?.folderId === folder.id && docDrop.docId === null;
          const isEditingThisFolder =
            editingItem?.kind === 'folder' && editingItem.id === folder.id;
          const showDragHandle = isTarget && !isEditingThisFolder && !pickCutMode && !cutItem;

          return (
            <div
              key={folder.id}
              ref={(el) => {
                if (el) {
                  folderGroupRefs.current.set(folder.id, el);
                } else {
                  folderGroupRefs.current.delete(folder.id);
                }
              }}
              className="relative space-y-0.5"
            >
              {isFolderDropBefore && (
                <div className="pointer-events-none absolute -top-[2px] left-2 right-2 h-[2px] bg-[var(--fei-text-primary)] rounded-full z-10" />
              )}

              {/* Directory Header (Plan 1A: chevron becomes drag handle when selected; short tap still toggles expand/collapse) */}
              <div
                data-tree-row="true"
                ref={(el) => {
                  if (el) {
                    folderHeaderRefs.current.set(folder.id, el);
                  } else {
                    folderHeaderRefs.current.delete(folder.id);
                  }
                }}
                className={`group flex items-center gap-1.5 px-2 min-h-[44px] rounded-lg transition-colors duration-150 ${
                  isDragging ? 'opacity-35' : ''
                } ${
                  isCut
                    ? 'opacity-45 border border-dashed border-[var(--fei-text-muted)]'
                    : isDocDropIntoFolder || isTarget
                      ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)]'
                      : 'border border-transparent hover:bg-[var(--fei-bg-hover)]'
                }`}
              >
                {showDragHandle ? (
                  <button
                    type="button"
                    data-tree-drag-handle="true"
                    onPointerDown={(e) =>
                      handleDragHandlePointerDown(
                        e,
                        { kind: 'folder', id: folder.id },
                        () => toggleExpand(folder.id)
                      )
                    }
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                    aria-label={
                      isExpanded
                        ? '拖动调整目录顺序或移入回收站，短按收起目录'
                        : '拖动调整目录顺序或移入回收站，短按展开目录'
                    }
                    title="按住拖动可调整顺序或移入回收站，短按可展开/收起目录"
                    className="w-9 h-9 -ml-1 flex items-center justify-center rounded-md text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] cursor-grab active:cursor-grabbing touch-none shrink-0"
                  >
                    <GripVertical className="w-4 h-4" strokeWidth={1.9} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpand(folder.id);
                    }}
                    aria-label={isExpanded ? '收起目录' : '展开目录'}
                    className="w-9 h-9 -ml-1 flex items-center justify-center text-[var(--fei-text-muted)] shrink-0"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </button>
                )}

                {isEditingThisFolder ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => commitRename({ kind: 'folder', id: folder.id })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename({ kind: 'folder', id: folder.id });
                      if (e.key === 'Escape') {
                        editingItemRef.current = null;
                        setEditingItem(null);
                        setEditingName('');
                      }
                    }}
                    className="flex-1 min-w-0 bg-transparent border-b border-[var(--fei-text-muted)] text-[14.5px] font-medium text-[var(--fei-text-primary)] outline-none py-0.5 select-text"
                  />
                ) : (
                  <button
                    type="button"
                    onPointerDown={(e) =>
                      handleNameLongPressStart(e, { kind: 'folder', id: folder.id }, folder.name)
                    }
                    onContextMenu={(e) => e.preventDefault()}
                    onClick={() => {
                      if (suppressClickRef.current) return;
                      onSelectTarget({ kind: 'folder', id: folder.id });
                    }}
                    className="flex-1 min-w-0 text-left text-[14.5px] font-medium truncate py-2 text-[var(--fei-text-primary)]"
                  >
                    {folder.name}
                  </button>
                )}

                <span
                  className={`mr-1.5 min-w-[16px] text-center text-[12px] text-[var(--fei-text-muted)] group-hover:hidden shrink-0 ${
                    folderDocs.length === 0 ? '' : 'font-code tabular-nums'
                  }`}
                >
                  {folderDocs.length === 0 ? '空' : folderDocs.length}
                </span>

                <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    title="在此目录新建文章"
                    onClick={(e) => {
                      e.stopPropagation();
                      onExpandFolder(folder.id);
                      onCreateDocInFolder(folder.id);
                    }}
                    className="w-7 h-7 inline-flex items-center justify-center rounded text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] transition-colors"
                  >
                    <FilePlus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="重命名目录"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingItem({ kind: 'folder', id: folder.id });
                      setEditingName(folder.name);
                    }}
                    className="w-7 h-7 inline-flex items-center justify-center rounded text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="删除目录"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteFolder(folder.id);
                    }}
                    className="w-7 h-7 inline-flex items-center justify-center rounded text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Articles directly underneath directory */}
              {isExpanded && folderDocs.length > 0 && (
                <div className="space-y-0.5">
                  {folderDocs.map((doc) => renderArticleRow(doc, folder.id))}
                </div>
              )}

              {isFolderDropAfter && (
                <div className="pointer-events-none absolute -bottom-[2px] left-2 right-2 h-[2px] bg-[var(--fei-text-primary)] rounded-full z-10" />
              )}
            </div>
          );
        })}

        {/* Uncategorized Articles (shown only when orphaned docs exist) */}
        {uncategorizedDocs.length > 0 && (
          <div className="space-y-0.5 pt-2">
            <div
              data-tree-row="true"
              ref={uncategorizedHeaderRef}
              className={`flex items-center gap-1.5 px-2 min-h-[44px] rounded-lg transition-colors ${
                docDrop?.folderId === null && docDrop.docId === null
                  ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)]'
                  : 'border border-transparent hover:bg-[var(--fei-bg-hover)]'
              }`}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand('__uncategorized__');
                }}
                aria-label={!collapsedIds.has('__uncategorized__') ? '收起未分类' : '展开未分类'}
                className="w-9 h-9 -ml-1 flex items-center justify-center text-[var(--fei-text-muted)] shrink-0"
              >
                {!collapsedIds.has('__uncategorized__') ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>
              <button
                type="button"
                onClick={() => toggleExpand('__uncategorized__')}
                className="flex-1 min-w-0 text-left text-[14.5px] font-medium text-[var(--fei-text-primary)] truncate py-2"
              >
                未分类
              </button>
              <span className="mr-1.5 min-w-[16px] text-center text-[12px] font-code tabular-nums text-[var(--fei-text-muted)] shrink-0">
                {uncategorizedDocs.length}
              </span>
            </div>

            {!collapsedIds.has('__uncategorized__') && (
              <div className="space-y-0.5">
                {uncategorizedDocs.map((doc) => renderArticleRow(doc, null))}
              </div>
            )}
          </div>
        )}

        {/* Quiet Inline New Directory Trigger */}
        <div className="pt-3 pl-2">
          {addingFolder ? (
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onBlur={commitNewFolder}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNewFolder();
                if (e.key === 'Escape') {
                  setNewFolderName('');
                  setAddingFolder(false);
                }
              }}
              placeholder="输入目录名称，回车确认…"
              className="w-full h-10 px-3 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border-strong)] text-[14.5px] text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setAddingFolder(true)}
              className="h-9 px-2 inline-flex items-center gap-1.5 text-[13.5px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>新建目录</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

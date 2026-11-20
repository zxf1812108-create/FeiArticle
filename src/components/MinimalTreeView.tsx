import React, {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { ArticleDoc, FolderNode } from '../types';
import { INBOX_FOLDER_ID, INBOX_FOLDER_NAME } from '../utils/inbox';

export type InsertPosition = 'before' | 'after' | 'end';

export type TreeSelection =
  | { kind: 'folder'; id: string }
  | { kind: 'doc'; id: string };

export interface MinimalTreeViewHandle {
  getScrollTop: () => number;
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
  onOpenDoc: (docId: string) => void;
  onCancelCut: () => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
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
}

type DragPayload =
  | { kind: 'folder'; id: string }
  | { kind: 'doc'; id: string };

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
      onOpenDoc,
      onCancelCut,
      onCreateFolder,
      onRenameFolder,
      onDeleteFolder,
      onCreateDocInFolder,
      onMoveFolderToPosition,
      onMoveDocToPosition,
    },
    ref
  ) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const debounceScrollRef = useRef<number | null>(null);
  const restoredScrollRef = useRef(false);

  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

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
    };
  }, []);

  useImperativeHandle(ref, () => ({
    getScrollTop() {
      return scrollRef.current?.scrollTop ?? 0;
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

  // Drag-and-drop state supporting BOTH folders and articles
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

  const liveDocs = useMemo(() => docs.filter((d) => !d.deleted), [docs]);
  const sortedFolders = useMemo(
    () => [...folders].sort((a, b) => a.order - b.order),
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

  const commitRename = (folderId: string) => {
    const trimmed = editingName.trim();
    if (trimmed) {
      onRenameFolder(folderId, trimmed);
    }
    setEditingFolderId(null);
    setEditingName('');
  };

  const clearDragState = () => {
    setDragging(null);
    setFolderDrop(null);
    setDocDrop(null);
  };

  // Folder Drag Handlers
  const handleFolderDragStart = (e: React.DragEvent, folderId: string) => {
    const payload: DragPayload = { kind: 'folder', id: folderId };
    setDragging(payload);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-feiartical', JSON.stringify(payload));
  };

  const handleFolderDragOver = (e: React.DragEvent, targetFolderId: string | null) => {
    if (!dragging || targetFolderId === INBOX_FOLDER_ID) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (dragging.kind === 'folder') {
      if (!targetFolderId || dragging.id === targetFolderId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const position: 'before' | 'after' =
        e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
      setFolderDrop({ targetFolderId, position });
      setDocDrop(null);
    } else if (dragging.kind === 'doc') {
      setDocDrop({ folderId: targetFolderId, docId: null, position: 'end' });
      setFolderDrop(null);
    }
  };

  const handleFolderDrop = (e: React.DragEvent, targetFolderId: string | null) => {
    e.preventDefault();
    if (targetFolderId === INBOX_FOLDER_ID) {
      clearDragState();
      return;
    }
    let payload = dragging;
    if (!payload) {
      try {
        payload = JSON.parse(e.dataTransfer.getData('application/x-feiartical')) as DragPayload;
      } catch {
        payload = null;
      }
    }
    if (!payload) {
      clearDragState();
      return;
    }

    if (payload.kind === 'folder' && targetFolderId && payload.id !== targetFolderId) {
      const rect = e.currentTarget.getBoundingClientRect();
      const position: 'before' | 'after' =
        e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
      onMoveFolderToPosition(payload.id, targetFolderId, position);
    } else if (payload.kind === 'doc') {
      onMoveDocToPosition(payload.id, targetFolderId, null, 'end');
      if (targetFolderId) {
        onExpandFolder(targetFolderId);
      }
    }
    clearDragState();
  };

  // Article Drag Handlers
  const handleDocDragStart = (e: React.DragEvent, docId: string) => {
    const payload: DragPayload = { kind: 'doc', id: docId };
    setDragging(payload);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-feiartical', JSON.stringify(payload));
  };

  const handleDocDragOver = (
    e: React.DragEvent,
    folderId: string | null,
    targetDocId: string
  ) => {
    if (
      !dragging ||
      dragging.kind !== 'doc' ||
      dragging.id === targetDocId ||
      folderId === INBOX_FOLDER_ID
    ) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const position: InsertPosition =
      e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
    setDocDrop({ folderId, docId: targetDocId, position });
    setFolderDrop(null);
  };

  const handleDocDrop = (
    e: React.DragEvent,
    folderId: string | null,
    targetDocId: string
  ) => {
    e.preventDefault();
    if (folderId === INBOX_FOLDER_ID) {
      clearDragState();
      return;
    }
    let payload = dragging;
    if (!payload) {
      try {
        payload = JSON.parse(e.dataTransfer.getData('application/x-feiartical')) as DragPayload;
      } catch {
        payload = null;
      }
    }
    if (payload?.kind === 'doc' && payload.id !== targetDocId) {
      const rect = e.currentTarget.getBoundingClientRect();
      const position: InsertPosition =
        e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
      onMoveDocToPosition(payload.id, folderId, targetDocId, position);
    }
    clearDragState();
  };

  const renderArticleRow = (doc: ArticleDoc, folderId: string | null) => {
    const isTarget = activeTarget?.kind === 'doc' && activeTarget.id === doc.id;
    const isCut = cutItem?.kind === 'doc' && cutItem.id === doc.id;
    const isDragging = dragging?.kind === 'doc' && dragging.id === doc.id;
    const isDropBefore = docDrop?.docId === doc.id && docDrop.position === 'before';
    const isDropAfter = docDrop?.docId === doc.id && docDrop.position === 'after';

    return (
      <div
        key={doc.id}
        draggable
        onDragStart={(e) => handleDocDragStart(e, doc.id)}
        onDragEnd={clearDragState}
        onDragOver={(e) => handleDocDragOver(e, folderId, doc.id)}
        onDrop={(e) => handleDocDrop(e, folderId, doc.id)}
        className={`relative group flex items-center gap-1.5 pl-9 pr-2 min-h-[44px] rounded-lg transition-colors duration-150 ${
          isDragging ? 'opacity-35' : ''
        } ${
          isCut
            ? 'opacity-45 border border-dashed border-[var(--fei-text-muted)]'
            : isTarget
              ? 'bg-[var(--fei-bg-selected)]'
              : 'hover:bg-[var(--fei-bg-hover)]'
        }`}
      >
        {isDropBefore && (
          <div className="pointer-events-none absolute -top-[1px] left-9 right-2 h-[2px] bg-[var(--fei-text-primary)] rounded-full z-10" />
        )}
        {isDropAfter && (
          <div className="pointer-events-none absolute -bottom-[1px] left-9 right-2 h-[2px] bg-[var(--fei-text-primary)] rounded-full z-10" />
        )}

        <button
          type="button"
          onClick={() => {
            if (pickCutMode || cutItem) {
              onSelectTarget({ kind: 'doc', id: doc.id });
              return;
            }
            // First click selects the document; second click on an already-selected document opens it
            if (isTarget) {
              onOpenDoc(doc.id);
            } else {
              onSelectTarget({ kind: 'doc', id: doc.id });
            }
          }}
          className="flex-1 min-w-0 text-left text-[15px] leading-snug truncate py-2.5 text-[var(--fei-text-primary)]"
        >
          {doc.title || '无标题文档'}
        </button>

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
      className="w-full h-full overflow-y-auto bg-[var(--fei-bg)] select-none"
    >
      <div className="max-w-[760px] mx-auto px-4 sm:px-8 pt-6 pb-10 space-y-1.5">
        {/* Status strip only when cutting or selecting item to cut */}
        {(pickCutMode || cutLabel) && (
          <div className="mb-3 px-3.5 py-2.5 rounded-lg bg-[var(--fei-bg-subtle)] flex items-center justify-between gap-3 text-[13px]">
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
                className={`flex items-center gap-1.5 px-2 min-h-[44px] rounded-lg transition-colors duration-150 ${
                  isInboxTarget ? 'bg-[var(--fei-bg-selected)]' : 'hover:bg-[var(--fei-bg-hover)]'
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(INBOX_FOLDER_ID);
                  }}
                  aria-label={isInboxExpanded ? '收起 inbox' : '展开 inbox'}
                  className="w-6 h-8 flex items-center justify-center text-[var(--fei-text-muted)] shrink-0"
                >
                  {isInboxExpanded ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </button>

                <button
                  type="button"
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

          return (
            <div key={folder.id} className="relative space-y-0.5">
              {isFolderDropBefore && (
                <div className="pointer-events-none absolute -top-[2px] left-2 right-2 h-[2px] bg-[var(--fei-text-primary)] rounded-full z-10" />
              )}

              {/* Directory Header (Draggable, no leading dots) */}
              <div
                draggable={editingFolderId !== folder.id}
                onDragStart={(e) => handleFolderDragStart(e, folder.id)}
                onDragEnd={clearDragState}
                onDragOver={(e) => handleFolderDragOver(e, folder.id)}
                onDrop={(e) => handleFolderDrop(e, folder.id)}
                className={`group flex items-center gap-1.5 px-2 min-h-[44px] rounded-lg transition-colors duration-150 ${
                  isDragging ? 'opacity-35' : ''
                } ${
                  isCut
                    ? 'opacity-45 border border-dashed border-[var(--fei-text-muted)]'
                    : isDocDropIntoFolder || isTarget
                      ? 'bg-[var(--fei-bg-selected)]'
                      : 'hover:bg-[var(--fei-bg-hover)]'
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(folder.id);
                  }}
                  aria-label={isExpanded ? '收起目录' : '展开目录'}
                  className="w-6 h-8 flex items-center justify-center text-[var(--fei-text-muted)] shrink-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </button>

                {editingFolderId === folder.id ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => commitRename(folder.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(folder.id);
                      if (e.key === 'Escape') setEditingFolderId(null);
                    }}
                    className="flex-1 min-w-0 bg-transparent border-b border-[var(--fei-text-muted)] text-[14.5px] font-medium text-[var(--fei-text-primary)] outline-none py-0.5"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (pickCutMode || cutItem) {
                        onSelectTarget({ kind: 'folder', id: folder.id });
                        return;
                      }
                      // First click selects the directory; clicking an already-selected directory enters rename mode
                      if (isTarget) {
                        setEditingFolderId(folder.id);
                        setEditingName(folder.name);
                      } else {
                        onSelectTarget({ kind: 'folder', id: folder.id });
                      }
                    }}
                    className="flex-1 min-w-0 text-left text-[14.5px] font-medium truncate py-2 text-[var(--fei-text-primary)]"
                  >
                    {folder.name}
                  </button>
                )}

                <span className="mr-1.5 min-w-[16px] text-center text-[12px] font-code tabular-nums text-[var(--fei-text-muted)] group-hover:hidden shrink-0">
                  {folderDocs.length}
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
                      setEditingFolderId(folder.id);
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
              onDragOver={(e) => handleFolderDragOver(e, null)}
              onDrop={(e) => handleFolderDrop(e, null)}
              className={`flex items-center justify-between gap-1.5 px-2 min-h-[44px] rounded-lg transition-colors ${
                docDrop?.folderId === null && docDrop.docId === null
                  ? 'bg-[var(--fei-bg-selected)]'
                  : 'hover:bg-[var(--fei-bg-hover)]'
              }`}
            >
              <button
                type="button"
                onClick={() => toggleExpand('__uncategorized__')}
                className="flex items-center gap-1.5 flex-1 min-w-0 text-left py-2"
              >
                <span className="w-6 h-6 flex items-center justify-center text-[var(--fei-text-muted)] shrink-0">
                  {!collapsedIds.has('__uncategorized__') ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </span>
                <span className="text-[14.5px] font-medium text-[var(--fei-text-primary)] truncate">
                  未分类
                </span>
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

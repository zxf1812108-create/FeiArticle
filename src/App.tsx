import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronsUp,
  Download,
  Eye,
  FolderTree,
  Heading1,
  Heading2,
  List,
  Lock,
  LockOpen,
  Minus,
  Pencil,
  RefreshCw,
  Scissors,
} from 'lucide-react';
import { ImportModal } from './components/ImportModal';
import {
  EditFormatKind,
  MinimalDocView,
  MinimalDocViewHandle,
} from './components/MinimalDocView';
import {
  InsertPosition,
  MinimalTreeView,
  MinimalTreeViewHandle,
  TreeSelection,
} from './components/MinimalTreeView';
import { StorageFolderModal } from './components/StorageFolderModal';
import { SyncModal } from './components/SyncModal';
import {
  ArticleDoc,
  FolderNode,
  QuotaStats,
  SyncedTreeState,
  SyncLogEntry,
  WebDavConfig,
} from './types';
import {
  loadDocs,
  loadFolders,
  loadFoldersDirty,
  loadLastOpenedDocId,
  loadQuotaStats,
  loadStorageDirConfig,
  loadSyncLogs,
  loadTreeViewState,
  loadWebDavConfig,
  saveDocs,
  saveFolders,
  saveFoldersDirty,
  saveLastOpenedDocId,
  saveQuotaStats,
  saveStorageDirConfig,
  saveSyncLogs,
  saveTreeViewState,
  saveWebDavConfig,
  StorageDirectoryConfig,
} from './utils/storage';
import {
  extractExcerpt,
  getByteSize,
  readTextFileSmart,
  sha256Hex,
} from './utils/textParser';
import {
  INBOX_FOLDER_ID,
  isReservedInboxName,
  resolveDuplicateDocImport,
} from './utils/inbox';
import {
  fetchRemoteDocBody,
  runIncrementalWebDavSync,
} from './utils/webdavSync';
import {
  LanDirectAction,
  pushLanDirectState,
  startLanDirectServer,
  stopLanDirectServer,
  subscribeLanDirectActions,
} from './utils/lanDirect';

type MainView = 'tree' | 'doc';

// Document mode icon styled after FeiArtical's folded-page + tree-line emblem in toolbar monochrome stroke style
const ArticleDocIcon: React.FC<{ className?: string; strokeWidth?: number }> = ({
  className = 'w-[19px] h-[19px]',
  strokeWidth = 1.75,
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M6.5 3.5h8L19 8v11.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5V5a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="M14.5 3.5V8H19" />
    <path d="M8.5 11.2h7" />
    <circle cx="8.8" cy="14.3" r="0.9" fill="currentColor" stroke="none" />
    <path d="M11.3 14.3h4.2" />
    <circle cx="8.8" cy="17.3" r="0.9" fill="currentColor" stroke="none" />
    <path d="M11.3 17.3h3.2" />
  </svg>
);

// Insert-below icon depicting placing the cut folder/article beneath the currently selected row
const InsertBelowIcon: React.FC<{ className?: string; strokeWidth?: number }> = ({
  className = 'w-[19px] h-[19px]',
  strokeWidth = 1.75,
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M5 4h14" />
    <path d="M12 7.5V13" />
    <path d="m9.5 10.5 2.5 2.5 2.5-2.5" />
    <rect x="5" y="16.5" width="14" height="3.8" rx="1.2" />
  </svg>
);

export default function App() {
  const [folders, setFolders] = useState<FolderNode[]>(() => loadFolders());
  const [docs, setDocs] = useState<ArticleDoc[]>(() => loadDocs());
  const [foldersDirty, setFoldersDirty] = useState<boolean>(() => loadFoldersDirty());
  const [webDavConfig, setWebDavConfig] = useState<WebDavConfig>(() => loadWebDavConfig());
  const [quotaStats, setQuotaStats] = useState<QuotaStats>(() => loadQuotaStats());
  const [syncLogs, setSyncLogs] = useState<SyncLogEntry[]>(() => loadSyncLogs());

  const initialTreeState = useMemo(() => loadTreeViewState(), []);

  const [mainView, setMainView] = useState<MainView>('tree');
  const [selectedDocId, setSelectedDocId] = useState<string | null>(() => loadLastOpenedDocId());
  const [isEditing, setIsEditing] = useState(false);

  const [collapsedFolderIds, setCollapsedFolderIds] = useState<string[]>(
    () => initialTreeState.collapsedIds
  );
  const [treeScrollTop, setTreeScrollTop] = useState<number>(() => initialTreeState.scrollTop);
  const [treeStateUpdatedAt, setTreeStateUpdatedAt] = useState<number>(
    () => initialTreeState.updatedAt
  );
  const [activeTarget, setActiveTarget] = useState<TreeSelection | null>(
    () => initialTreeState.activeTarget
  );
  const [cutItem, setCutItem] = useState<TreeSelection | null>(null);
  const [pickCutMode, setPickCutMode] = useState(false);

  const [storageDir, setStorageDir] = useState<StorageDirectoryConfig>(() =>
    loadStorageDirConfig()
  );
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lanRunning, setLanRunning] = useState(false);
  const [lanUrl, setLanUrl] = useState('');
  const [lanLoading, setLanLoading] = useState(false);
  const [toast, setToast] = useState<{ msg: string } | null>(null);
  const [windowDragging, setWindowDragging] = useState(false);

  const docViewRef = useRef<MinimalDocViewHandle>(null);
  const treeViewRef = useRef<MinimalTreeViewHandle>(null);
  const syncLongPressTimerRef = useRef<number | null>(null);
  const syncLongPressedRef = useRef(false);
  const docsRef = useRef<ArticleDoc[]>(docs);
  docsRef.current = docs;

  const collapsedFolderSet = useMemo(() => new Set(collapsedFolderIds), [collapsedFolderIds]);

  // Automatically follow OS light/dark system theme
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applySystemTheme = (dark: boolean) => {
      document.documentElement.classList.toggle('dark', dark);
    };
    applySystemTheme(media.matches);
    const handler = (e: MediaQueryListEvent) => applySystemTheme(e.matches);
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    return () => {
      if (syncLongPressTimerRef.current) {
        window.clearTimeout(syncLongPressTimerRef.current);
      }
    };
  }, []);

  // Persist locally
  useEffect(() => saveFolders(folders), [folders]);
  useEffect(() => saveDocs(docs), [docs]);
  useEffect(() => saveFoldersDirty(foldersDirty), [foldersDirty]);
  useEffect(() => saveWebDavConfig(webDavConfig), [webDavConfig]);
  useEffect(() => saveQuotaStats(quotaStats), [quotaStats]);
  useEffect(() => saveSyncLogs(syncLogs), [syncLogs]);
  useEffect(() => saveLastOpenedDocId(selectedDocId), [selectedDocId]);
  useEffect(
    () =>
      saveTreeViewState({
        collapsedIds: collapsedFolderIds,
        activeTarget,
        scrollTop: treeScrollTop,
        updatedAt: treeStateUpdatedAt,
      }),
    [collapsedFolderIds, activeTarget, treeScrollTop, treeStateUpdatedAt]
  );

  // Keep PC Direct Connect snapshot in sync while LAN server is active
  useEffect(() => {
    if (!lanRunning) return;
    pushLanDirectState(folders, docs);
  }, [lanRunning, folders, docs]);

  // Stop LAN server on unmount
  useEffect(() => {
    return () => {
      stopLanDirectServer();
    };
  }, []);

  // Receive live edits / imports from PC browser while 电脑直连 is enabled
  useEffect(() => {
    if (!lanRunning) return;
    return subscribeLanDirectActions(true, async (action: LanDirectAction) => {
      const now = Date.now();
      if (action.type === 'createFolder') {
        const name = action.name?.trim();
        if (!name || isReservedInboxName(name)) return;
        setFolders((prev) => {
          if (prev.some((f) => f.id === action.id)) return prev;
          const maxOrder = prev.reduce((m, f) => Math.max(m, f.order), -1);
          return [
            ...prev,
            {
              id: action.id || `folder_${now}`,
              name,
              parentId: null,
              order: maxOrder + 1,
              updatedAt: now,
            },
          ];
        });
        setFoldersDirty(true);
        return;
      }

      if (action.type === 'createDoc') {
        if (action.folderId === INBOX_FOLDER_ID) return;
        const content = action.content ?? '';
        const hash = await sha256Hex(content);
        setDocs((prev) => {
          if (prev.some((d) => d.id === action.id)) return prev;
          const siblings = prev.filter((d) => !d.deleted && d.folderId === action.folderId);
          const maxOrder = siblings.reduce((m, d) => Math.max(m, d.order), -1);
          return [
            ...prev,
            {
              id: action.id || `doc_${now}`,
              title: action.title?.trim() || '无标题文档',
              folderId: action.folderId ?? null,
              order: maxOrder + 1,
              content,
              contentHash: hash,
              excerpt: extractExcerpt(content),
              tags: [],
              starred: false,
              readProgress: 0,
              lastReadAt: null,
              lastMode: 'read',
              lastScrollTop: 0,
              format: 'txt',
              createdAt: now,
              updatedAt: now,
              syncStatus: 'dirty',
              highlights: [],
              byteSize: getByteSize(content),
            },
          ];
        });
        return;
      }

      if (action.type === 'saveDoc') {
        const content = action.content ?? '';
        const title = action.title?.trim() || '无标题文档';
        const hash = await sha256Hex(content);
        const byteSize = getByteSize(content);
        const excerpt = extractExcerpt(content);
        setDocs((prev) =>
          prev.map((d) =>
            d.id === action.docId
              ? {
                  ...d,
                  title,
                  content,
                  contentHash: hash,
                  byteSize,
                  excerpt,
                  updatedAt: now,
                  syncStatus: 'dirty',
                }
              : d
          )
        );
        return;
      }

      if (action.type === 'deleteDoc') {
        setDocs((prev) =>
          prev.map((d) =>
            d.id === action.docId
              ? { ...d, deleted: true, updatedAt: now, syncStatus: 'dirty' }
              : d
          )
        );
        if (selectedDocId === action.docId) {
          setSelectedDocId(null);
          setMainView('tree');
        }
        return;
      }

      if (action.type === 'importDocs' && Array.isArray(action.items) && action.items.length > 0) {
        const created: ArticleDoc[] = [];
        for (let i = 0; i < action.items.length; i++) {
          const item = action.items[i];
          if (item.folderId === INBOX_FOLDER_ID) continue;
          const content = item.content ?? '';
          const dupRes = await resolveDuplicateDocImport(
            item.title?.trim() || '导入文档',
            content,
            [...docsRef.current, ...created]
          );
          if (dupRes.action === 'skip') continue;
          created.push({
            id: `doc_${now + i}_${Math.random().toString(36).slice(2, 6)}`,
            title: dupRes.title,
            folderId: item.folderId ?? null,
            order: now + i,
            content,
            contentHash: dupRes.contentHash,
            excerpt: extractExcerpt(content),
            tags: [],
            starred: false,
            readProgress: 0,
            lastReadAt: null,
            lastMode: 'read',
            lastScrollTop: 0,
            format: 'txt',
            createdAt: now + i,
            updatedAt: now + i,
            syncStatus: 'dirty',
            highlights: [],
            byteSize: getByteSize(content),
          });
        }
        if (created.length > 0) {
          setDocs((prev) => [...prev, ...created]);
        }
      }
    });
  }, [lanRunning, selectedDocId]);

  const showToast = (msg: string) => {
    setToast({ msg });
    window.setTimeout(() => {
      setToast((prev) => (prev?.msg === msg ? null : prev));
    }, 3800);
  };

  const dirtyCount = useMemo(
    () => docs.filter((d) => d.syncStatus === 'dirty').length,
    [docs]
  );

  const hasPendingSync = dirtyCount > 0 || foldersDirty;

  const selectedDoc = useMemo(
    () => docs.find((d) => d.id === selectedDocId && !d.deleted) ?? null,
    [docs, selectedDocId]
  );

  // Folder CRUD & Drag Reorder
  const handleCreateFolder = (name: string): FolderNode | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (isReservedInboxName(trimmed)) {
      showToast('inbox 为云端投递箱保留名称');
      return null;
    }
    const maxOrder = folders.reduce((m, f) => Math.max(m, f.order), -1);
    const next: FolderNode = {
      id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      parentId: null,
      order: maxOrder + 1,
      updatedAt: Date.now(),
    };
    setFolders((prev) => [...prev, next]);
    setFoldersDirty(true);
    return next;
  };

  const handleRenameFolder = (folderId: string, name: string) => {
    if (folderId === INBOX_FOLDER_ID) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (isReservedInboxName(trimmed)) {
      showToast('inbox 为云端投递箱保留名称');
      return;
    }
    setFolders((prev) =>
      prev.map((f) => (f.id === folderId ? { ...f, name: trimmed, updatedAt: Date.now() } : f))
    );
    setFoldersDirty(true);
  };

  const handleDeleteFolder = (folderId: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    setDocs((prev) =>
      prev.map((d) =>
        d.folderId === folderId
          ? { ...d, folderId: null, updatedAt: Date.now(), syncStatus: 'dirty' }
          : d
      )
    );
    setFoldersDirty(true);
    setCollapsedFolderIds((prev) => prev.filter((id) => id !== folderId));
    if (activeTarget?.kind === 'folder' && activeTarget.id === folderId) {
      setActiveTarget(null);
    }
    if (cutItem?.kind === 'folder' && cutItem.id === folderId) {
      setCutItem(null);
    }
  };

  const handleToggleFolderCollapse = (id: string) => {
    setCollapsedFolderIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
    setTreeStateUpdatedAt(Date.now());
    setFoldersDirty(true);
  };

  const handleExpandFolder = (id: string) => {
    if (!collapsedFolderIds.includes(id)) return;
    setCollapsedFolderIds((prev) => prev.filter((item) => item !== id));
    setTreeStateUpdatedAt(Date.now());
    setFoldersDirty(true);
  };

  const handleCollapseAllFolders = () => {
    setCollapsedFolderIds([...folders.map((f) => f.id), INBOX_FOLDER_ID, '__uncategorized__']);
    setTreeStateUpdatedAt(Date.now());
    setFoldersDirty(true);
  };

  const handleTreeScrollTopChange = (nextScrollTop: number) => {
    if (Math.round(nextScrollTop) !== Math.round(treeScrollTop)) {
      setTreeScrollTop(nextScrollTop);
      setTreeStateUpdatedAt(Date.now());
      setFoldersDirty(true);
    }
  };

  const captureAndSaveTreeState = (
    overrideTarget?: TreeSelection | null,
    overrideCollapsed?: string[]
  ) => {
    const currentScroll = treeViewRef.current?.getScrollTop() ?? treeScrollTop;
    const nextTarget = overrideTarget !== undefined ? overrideTarget : activeTarget;
    const nextCollapsed = overrideCollapsed !== undefined ? overrideCollapsed : collapsedFolderIds;
    const changed =
      Math.round(currentScroll) !== Math.round(treeScrollTop) ||
      nextTarget?.kind !== activeTarget?.kind ||
      nextTarget?.id !== activeTarget?.id ||
      nextCollapsed !== collapsedFolderIds;
    const nextUpdatedAt = changed ? Date.now() : treeStateUpdatedAt;
    if (changed) {
      setTreeStateUpdatedAt(nextUpdatedAt);
      setFoldersDirty(true);
    }
    setTreeScrollTop(currentScroll);
    saveTreeViewState({
      collapsedIds: nextCollapsed,
      activeTarget: nextTarget,
      scrollTop: currentScroll,
      updatedAt: nextUpdatedAt,
    });
  };

  const handleMoveFolderToPosition = (
    sourceFolderId: string,
    targetFolderId: string,
    position: 'before' | 'after'
  ) => {
    if (
      sourceFolderId === targetFolderId ||
      sourceFolderId === INBOX_FOLDER_ID ||
      targetFolderId === INBOX_FOLDER_ID
    ) {
      return;
    }
    const now = Date.now();
    setFolders((prev) => {
      const sorted = [...prev].sort((a, b) => a.order - b.order);
      const source = sorted.find((f) => f.id === sourceFolderId);
      if (!source) return prev;

      const withoutSource = sorted.filter((f) => f.id !== sourceFolderId);
      const targetIdx = withoutSource.findIndex((f) => f.id === targetFolderId);
      if (targetIdx < 0) return prev;

      const insertIdx = position === 'before' ? targetIdx : targetIdx + 1;
      withoutSource.splice(insertIdx, 0, source);

      return withoutSource.map((f, idx) => ({
        ...f,
        order: idx,
        updatedAt: f.id === sourceFolderId || f.order !== idx ? now : f.updatedAt,
      }));
    });
    setFoldersDirty(true);
  };

  // Article Drag-to-Reorder / Move across folders
  const handleMoveDocToPosition = (
    docId: string,
    targetFolderId: string | null,
    targetDocId: string | null,
    position: InsertPosition
  ) => {
    if (targetFolderId === INBOX_FOLDER_ID) return;
    const now = Date.now();
    setDocs((prev) => {
      const movingDoc = prev.find((d) => d.id === docId);
      if (!movingDoc) return prev;

      const targetSiblings = prev
        .filter((d) => !d.deleted && d.folderId === targetFolderId && d.id !== docId)
        .sort((a, b) => a.order - b.order || b.updatedAt - a.updatedAt);

      let insertIdx = targetSiblings.length;
      if (targetDocId && position !== 'end') {
        const targetIdx = targetSiblings.findIndex((d) => d.id === targetDocId);
        if (targetIdx >= 0) {
          insertIdx = position === 'before' ? targetIdx : targetIdx + 1;
        }
      } else if (targetDocId === null && position === 'before') {
        insertIdx = 0;
      }

      const nextSiblings = [...targetSiblings];
      nextSiblings.splice(insertIdx, 0, {
        ...movingDoc,
        folderId: targetFolderId,
        updatedAt: now,
        syncStatus: 'dirty',
      });

      const orderMap = new Map(nextSiblings.map((d, i) => [d.id, i]));

      return prev.map((d) => {
        if (d.id === docId) {
          return {
            ...d,
            folderId: targetFolderId,
            order: orderMap.get(d.id) ?? insertIdx,
            updatedAt: now,
            syncStatus: 'dirty',
          };
        }
        if (orderMap.has(d.id)) {
          const nextOrder = orderMap.get(d.id)!;
          if (nextOrder !== d.order) {
            return { ...d, order: nextOrder, updatedAt: now, syncStatus: 'dirty' };
          }
        }
        return d;
      });
    });
  };

  // Bottom Toolbar: Selection, Cut, Paste & Encrypt Handlers
  const handleSelectTreeTarget = (target: TreeSelection) => {
    if (pickCutMode) {
      if (target.kind === 'folder' && target.id === INBOX_FOLDER_ID) {
        showToast('inbox 目录不可剪切');
        return;
      }
      setCutItem(target);
      setActiveTarget(target);
      setPickCutMode(false);
      setTreeStateUpdatedAt(Date.now());
      setFoldersDirty(true);
      return;
    }
    if (activeTarget?.kind !== target.kind || activeTarget?.id !== target.id) {
      setActiveTarget(target);
      setTreeStateUpdatedAt(Date.now());
      setFoldersDirty(true);
    }
  };

  const isSelectedEncrypted = useMemo(() => {
    if (!activeTarget) return false;
    if (activeTarget.kind === 'doc') {
      const targetDoc = docs.find((d) => d.id === activeTarget.id && !d.deleted);
      return Boolean(targetDoc?.encrypted);
    }
    const folderDocs = docs.filter((d) => !d.deleted && d.folderId === activeTarget.id);
    return folderDocs.length > 0 && folderDocs.every((d) => Boolean(d.encrypted));
  }, [activeTarget, docs]);

  const handleEncryptButtonClick = () => {
    if (!activeTarget) {
      showToast('请先点选要加密或解密的文档或目录');
      return;
    }

    const now = Date.now();
    const hasPassword = Boolean(webDavConfig.encryptionPassword?.trim());

    if (activeTarget.kind === 'doc') {
      const targetDoc = docs.find((d) => d.id === activeTarget.id && !d.deleted);
      if (!targetDoc) return;
      const nextEncrypted = !targetDoc.encrypted;

      setDocs((prev) =>
        prev.map((d) =>
          d.id === targetDoc.id
            ? {
                ...d,
                encrypted: nextEncrypted,
                updatedAt: now,
                syncStatus: 'dirty',
              }
            : d
        )
      );

      if (nextEncrypted && !hasPassword) {
        showToast('已标记加密，同步前请长按同步图标设置加密密码');
      }
      return;
    }

    // Selected target is a directory
    const folderDocs = docs.filter((d) => !d.deleted && d.folderId === activeTarget.id);
    if (folderDocs.length === 0) {
      showToast('该目录下暂无文档');
      return;
    }

    const encryptedCount = folderDocs.filter((d) => d.encrypted).length;
    const nextEncrypted = encryptedCount < folderDocs.length;
    const targetIds = new Set(folderDocs.map((d) => d.id));

    setDocs((prev) =>
      prev.map((d) =>
        targetIds.has(d.id)
          ? {
              ...d,
              encrypted: nextEncrypted,
              updatedAt: now,
              syncStatus: 'dirty',
            }
          : d
      )
    );

    if (nextEncrypted && !hasPassword) {
      showToast('已加密目录下全部文档，同步前请长按同步图标设置加密密码');
    }
  };

  const handleCutOrInsertClick = () => {
    if (!cutItem) {
      if (pickCutMode) {
        setPickCutMode(false);
        return;
      }
      if (activeTarget) {
        if (activeTarget.kind === 'folder' && activeTarget.id === INBOX_FOLDER_ID) {
          showToast('inbox 目录不可剪切');
          return;
        }
        setCutItem(activeTarget);
      } else {
        setPickCutMode(true);
        showToast('请点选要剪切的目录或文章');
      }
      return;
    }

    if (!activeTarget) {
      showToast('请先点选要插入其下方的目标目录或文章');
      return;
    }

    if (cutItem.kind === 'folder') {
      let targetFolderId: string | null = null;
      if (activeTarget.kind === 'folder') {
        targetFolderId = activeTarget.id;
      } else {
        const targetDoc = docs.find((d) => d.id === activeTarget.id);
        targetFolderId = targetDoc?.folderId ?? null;
      }

      if (!targetFolderId || targetFolderId === INBOX_FOLDER_ID) {
        showToast('请点选一个常规目标目录以插入其下方');
        return;
      }
      if (targetFolderId === cutItem.id) {
        setCutItem(null);
        return;
      }
      handleMoveFolderToPosition(cutItem.id, targetFolderId, 'after');
      setActiveTarget(cutItem);
      setCutItem(null);
      return;
    }

    if (activeTarget.kind === 'doc') {
      if (activeTarget.id === cutItem.id) {
        setCutItem(null);
        return;
      }
      const targetDoc = docs.find((d) => d.id === activeTarget.id);
      if (!targetDoc) return;
      if (targetDoc.folderId === INBOX_FOLDER_ID) {
        showToast('不能将文档移入 inbox 目录');
        return;
      }
      handleMoveDocToPosition(cutItem.id, targetDoc.folderId, targetDoc.id, 'after');
      setActiveTarget(cutItem);
      setCutItem(null);
    } else {
      if (activeTarget.id === INBOX_FOLDER_ID) {
        showToast('不能将文档移入 inbox 目录');
        return;
      }
      handleMoveDocToPosition(cutItem.id, activeTarget.id, null, 'before');
      handleExpandFolder(activeTarget.id);
      setActiveTarget(cutItem);
      setCutItem(null);
    }
  };

  // Document CRUD & View State Persistence
  const handleCreateDoc = async (targetFolderId?: string | null) => {
    const requestedFolderId =
      targetFolderId !== undefined ? targetFolderId : folders[0]?.id ?? null;
    const folderId =
      requestedFolderId === INBOX_FOLDER_ID ? (folders[0]?.id ?? null) : requestedFolderId;
    const now = Date.now();
    const hash = await sha256Hex('');
    const siblings = docs.filter((d) => !d.deleted && d.folderId === folderId);
    const maxOrder = siblings.reduce((m, d) => Math.max(m, d.order), -1);

    const newDoc: ArticleDoc = {
      id: `doc_${now}_${Math.random().toString(36).slice(2, 6)}`,
      title: '无标题文档',
      folderId,
      order: maxOrder + 1,
      content: '',
      contentHash: hash,
      excerpt: '',
      tags: [],
      starred: false,
      readProgress: 0,
      lastReadAt: now,
      lastMode: 'edit',
      lastScrollTop: 0,
      format: 'txt',
      createdAt: now,
      updatedAt: now,
      syncStatus: 'dirty',
      highlights: [],
      byteSize: 0,
    };

    const nextTarget: TreeSelection = { kind: 'doc', id: newDoc.id };
    const nextCollapsed =
      folderId && collapsedFolderIds.includes(folderId)
        ? collapsedFolderIds.filter((id) => id !== folderId)
        : collapsedFolderIds;
    if (nextCollapsed !== collapsedFolderIds) {
      setCollapsedFolderIds(nextCollapsed);
    }
    captureAndSaveTreeState(nextTarget, nextCollapsed);

    setDocs((prev) => [...prev, newDoc]);
    setSelectedDocId(newDoc.id);
    setActiveTarget(nextTarget);
    setMainView('doc');
    setIsEditing(true);
  };

  const handleSaveDraft = async (
    docId: string,
    updates: { title: string; content: string }
  ) => {
    const hash = await sha256Hex(updates.content);
    const byteSize = getByteSize(updates.content);
    const excerpt = extractExcerpt(updates.content);
    const now = Date.now();

    setDocs((prev) =>
      prev.map((d) =>
        d.id === docId
          ? {
              ...d,
              title: updates.title,
              content: updates.content,
              contentHash: hash,
              byteSize,
              excerpt,
              updatedAt: now,
              syncStatus: 'dirty',
            }
          : d
      )
    );
  };

  const handleUpdateDocViewState = (
    docId: string,
    state: { mode: 'read' | 'edit'; scrollTop: number }
  ) => {
    const current = docs.find((d) => d.id === docId);
    if (!current) return;
    const nextScroll = Math.round(state.scrollTop);
    const prevScroll = Math.round(current.lastScrollTop ?? 0);
    const prevMode = current.lastMode ?? 'read';
    if (prevMode === state.mode && prevScroll === nextScroll) {
      return;
    }
    const now = Date.now();
    setDocs((prev) =>
      prev.map((d) =>
        d.id === docId
          ? {
              ...d,
              lastMode: state.mode,
              lastScrollTop: nextScroll,
              updatedAt: now,
            }
          : d
      )
    );
    setFoldersDirty(true);
  };

  const handleOpenDoc = (docId: string) => {
    const target = docs.find((d) => d.id === docId);
    const nextTarget: TreeSelection = { kind: 'doc', id: docId };
    captureAndSaveTreeState(nextTarget);
    setActiveTarget(nextTarget);
    setSelectedDocId(docId);
    setIsEditing(target?.lastMode === 'edit');
    setMainView('doc');
    setDocs((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, lastReadAt: Date.now() } : d))
    );
  };

  const handleExitDocToTree = () => {
    if (mainView === 'doc' && selectedDoc && docViewRef.current) {
      const captured = docViewRef.current.flushAndCaptureViewState();
      handleUpdateDocViewState(selectedDoc.id, captured);
    }
    setMainView('tree');
  };

  const handleToggleTreeDocView = () => {
    if (mainView === 'doc') {
      handleExitDocToTree();
      return;
    }
    const liveDocs = docs.filter((d) => !d.deleted);
    let targetDoc = selectedDocId
      ? liveDocs.find((d) => d.id === selectedDocId) ?? null
      : null;
    if (!targetDoc && activeTarget?.kind === 'doc') {
      targetDoc = liveDocs.find((d) => d.id === activeTarget.id) ?? null;
    }
    if (!targetDoc && liveDocs.length > 0) {
      targetDoc = [...liveDocs].sort(
        (a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0) || b.updatedAt - a.updatedAt
      )[0];
    }
    if (!targetDoc) {
      showToast('暂无可打开的文档');
      return;
    }
    setPickCutMode(false);
    handleOpenDoc(targetDoc.id);
  };

  const handleToggleEditMode = () => {
    const nextEditing = !isEditing;
    docViewRef.current?.prepareModeSwitch(nextEditing);
    setIsEditing(nextEditing);
  };

  // Batch Import .txt / .md / pasted text (defaults to .txt storage format, silently deduplicates)
  const handleImportDocs = async (
    items: Array<{ title: string; content: string; folderId: string | null; format?: 'txt' | 'md' }>
  ) => {
    const now = Date.now();
    const maxOrder = docsRef.current.reduce((m, d) => Math.max(m, d.order), -1);
    const created: ArticleDoc[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.folderId === INBOX_FOLDER_ID) continue;

      const dupRes = await resolveDuplicateDocImport(item.title, item.content, [
        ...docsRef.current,
        ...created,
      ]);
      if (dupRes.action === 'skip') continue;

      created.push({
        id: `doc_${now + i}_${Math.random().toString(36).slice(2, 6)}`,
        title: dupRes.title,
        folderId: item.folderId,
        order: maxOrder + 1 + created.length,
        content: item.content,
        contentHash: dupRes.contentHash,
        excerpt: extractExcerpt(item.content),
        tags: [],
        starred: false,
        readProgress: 0,
        lastReadAt: null,
        lastMode: 'read',
        lastScrollTop: 0,
        format: item.format ?? 'txt',
        createdAt: now + i,
        updatedAt: now + i,
        syncStatus: 'dirty',
        highlights: [],
        byteSize: getByteSize(item.content),
      });
    }

    if (created.length > 0) {
      setDocs((prev) => [...prev, ...created]);
    }
  };

  // WebDAV Manual Sync
  const applyQuotaDelta = (delta: {
    uploadBytes: number;
    downloadBytes: number;
    requestCount: number;
    skippedByEtag304: number;
    skippedByHashMatch: number;
  }) => {
    setQuotaStats((prev) => ({
      ...prev,
      uploadBytes: prev.uploadBytes + delta.uploadBytes,
      downloadBytes: prev.downloadBytes + delta.downloadBytes,
      requestCount: prev.requestCount + delta.requestCount,
      skippedByEtag304: prev.skippedByEtag304 + delta.skippedByEtag304,
      skippedByHashMatch: prev.skippedByHashMatch + delta.skippedByHashMatch,
    }));
  };

  const handleSaveSyncConfig = (nextConfig: WebDavConfig) => {
    const prevEnc = webDavConfig.encryptionPassword || '';
    const nextEnc = nextConfig.encryptionPassword || '';
    const encChanged = prevEnc !== nextEnc;

    setWebDavConfig(nextConfig);
    setFoldersDirty(true);

    if (encChanged) {
      const now = Date.now();
      setDocs((prev) =>
        prev.map((d) =>
          d.encrypted && !d.deleted
            ? { ...d, updatedAt: now, syncStatus: 'dirty' }
            : d
        )
      );
    }
    showToast('同步设置已保存');
  };

  const handleToggleLanDirect = async (next: boolean) => {
    setLanLoading(true);
    try {
      if (next) {
        const res = await startLanDirectServer(folders, docs);
        setLanRunning(res.running);
        setLanUrl(res.url);
        if (res.running && res.url) {
          showToast('电脑直连已开启');
        }
      } else {
        await stopLanDirectServer();
        setLanRunning(false);
        setLanUrl('');
        showToast('电脑直连已关闭');
      }
    } catch (err) {
      setLanRunning(false);
      setLanUrl('');
      showToast(err instanceof Error ? err.message : '开启电脑直连失败');
    } finally {
      setLanLoading(false);
    }
  };

  const handleCopyLanUrl = async (url: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast('已复制直连地址');
    } catch {
      showToast('请长按地址手动复制');
    }
  };

  const handleRunLiveSync = async () => {
    setIsSyncing(true);
    try {
      const currentTreeScroll =
        mainView === 'tree'
          ? treeViewRef.current?.getScrollTop() ?? treeScrollTop
          : treeScrollTop;
      const localTreeState: SyncedTreeState = {
        collapsedIds: collapsedFolderIds,
        activeTarget,
        scrollTop: currentTreeScroll,
        updatedAt: treeStateUpdatedAt,
      };
      const outcome = await runIncrementalWebDavSync(
        webDavConfig,
        folders,
        docs,
        localTreeState,
        foldersDirty
      );
      setFolders(outcome.folders.map((f) => ({ ...f, parentId: null })));
      setDocs(outcome.docs);
      setCollapsedFolderIds(outcome.treeState.collapsedIds);
      setActiveTarget(outcome.treeState.activeTarget);
      setTreeScrollTop(outcome.treeState.scrollTop);
      setTreeStateUpdatedAt(outcome.treeState.updatedAt);
      setFoldersDirty(false);
      setWebDavConfig(outcome.config);
      applyQuotaDelta(outcome.quotaDelta);
      setSyncLogs((prev) => [outcome.log, ...prev].slice(0, 20));
    } catch (err) {
      const msg = err instanceof Error ? err.message : '坚果云同步失败';
      setSyncLogs((prev) =>
        [
          {
            id: `err_${Date.now()}`,
            timestamp: Date.now(),
            mode: 'live' as const,
            summary: msg,
            requests: 1,
            uploadBytes: 0,
            downloadBytes: 0,
            status: 'error' as const,
          },
          ...prev,
        ].slice(0, 20)
      );
      throw err;
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDirectSyncClick = async () => {
    if (syncLongPressedRef.current) {
      syncLongPressedRef.current = false;
      return;
    }
    if (webDavConfig.username.trim() && webDavConfig.password.trim()) {
      try {
        await handleRunLiveSync();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '同步失败');
      }
    } else {
      showToast('请长按同步图标设置坚果云同步参数');
    }
  };

  const handleSyncPointerDown = () => {
    syncLongPressedRef.current = false;
    if (syncLongPressTimerRef.current) {
      window.clearTimeout(syncLongPressTimerRef.current);
    }
    syncLongPressTimerRef.current = window.setTimeout(() => {
      syncLongPressedRef.current = true;
      setShowSyncModal(true);
    }, 300);
  };

  const cancelSyncLongPress = () => {
    if (syncLongPressTimerRef.current) {
      window.clearTimeout(syncLongPressTimerRef.current);
      syncLongPressTimerRef.current = null;
    }
  };

  const handleFetchRemoteBody = async (docId: string) => {
    const targetDoc = docs.find((d) => d.id === docId);
    const { content, bytes } = await fetchRemoteDocBody(
      webDavConfig,
      docId,
      Boolean(targetDoc?.encrypted),
      targetDoc?.format ?? 'txt'
    );
    const hash = await sha256Hex(content);
    setDocs((prev) =>
      prev.map((d) =>
        d.id === docId
          ? {
              ...d,
              content,
              contentHash: hash,
              excerpt: d.encrypted ? '' : extractExcerpt(content),
              byteSize: getByteSize(content),
              syncStatus: 'synced',
            }
          : d
      )
    );
    applyQuotaDelta({
      uploadBytes: 0,
      downloadBytes: bytes,
      requestCount: 1,
      skippedByEtag304: 0,
      skippedByHashMatch: 0,
    });
  };

  const defaultImportFolderId = useMemo(() => {
    const regularFolders = folders.filter((f) => f.id !== INBOX_FOLDER_ID);
    const fallbackId = regularFolders[0]?.id ?? null;
    if (activeTarget?.kind === 'folder') {
      return activeTarget.id === INBOX_FOLDER_ID ? fallbackId : activeTarget.id;
    }
    if (activeTarget?.kind === 'doc') {
      const docFolder = docs.find((d) => d.id === activeTarget.id)?.folderId ?? null;
      if (docFolder && docFolder !== INBOX_FOLDER_ID) return docFolder;
    }
    return fallbackId;
  }, [activeTarget, docs, folders]);

  const handleWindowDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    setWindowDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      /\.(txt|md|markdown|text)$/i.test(f.name)
    );
    if (files.length === 0) return;
    const parsed: Array<{ title: string; content: string; folderId: string | null }> = [];
    for (const file of files) {
      const content = await readTextFileSmart(file);
      const title = file.name.replace(/\.(txt|md|markdown|text)$/i, '').trim() || '导入文档';
      parsed.push({ title, content, folderId: defaultImportFolderId });
    }
    await handleImportDocs(parsed);
  };

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setWindowDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setWindowDragging(false);
      }}
      onDrop={handleWindowDrop}
      className="h-full w-full flex flex-col overflow-hidden bg-[var(--fei-bg)] text-[var(--fei-text-primary)] pt-[env(safe-area-inset-top,0px)]"
    >
      {/* Main Area (Above Bottom Toolbar) */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {mainView === 'doc' && selectedDoc ? (
          <MinimalDocView
            ref={docViewRef}
            doc={selectedDoc}
            isEditing={isEditing}
            onSaveDraft={(updates) => handleSaveDraft(selectedDoc.id, updates)}
            onViewStateChange={(state) => handleUpdateDocViewState(selectedDoc.id, state)}
            onFetchRemoteBody={() => handleFetchRemoteBody(selectedDoc.id)}
          />
        ) : (
          <MinimalTreeView
            ref={treeViewRef}
            folders={folders}
            docs={docs}
            collapsedIds={collapsedFolderSet}
            initialScrollTop={treeScrollTop}
            activeTarget={activeTarget}
            cutItem={cutItem}
            pickCutMode={pickCutMode}
            onToggleCollapse={handleToggleFolderCollapse}
            onExpandFolder={handleExpandFolder}
            onScrollTopChange={handleTreeScrollTopChange}
            onSelectTarget={handleSelectTreeTarget}
            onOpenDoc={handleOpenDoc}
            onCancelCut={() => {
              setCutItem(null);
              setPickCutMode(false);
            }}
            onCreateFolder={handleCreateFolder}
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
            onCreateDocInFolder={(folderId) => handleCreateDoc(folderId)}
            onMoveFolderToPosition={handleMoveFolderToPosition}
            onMoveDocToPosition={handleMoveDocToPosition}
          />
        )}
      </main>

      {/* Bottom Toolbar (All icons use FeiNote muted trash-can monochrome tone, ordered left-to-right) */}
      <footer
        aria-label="底部工具栏"
        className="shrink-0 bg-[var(--fei-bg-bar)] border-t border-[var(--fei-border)] pb-[env(safe-area-inset-bottom,0px)]"
      >
        <div className="h-[52px] max-w-[760px] mx-auto px-3 sm:px-6 flex items-center justify-start gap-0.5 sm:gap-1">
          {/* 1. 最左侧：目录图标 <-> 文档图标 */}
          <button
            type="button"
            onClick={handleToggleTreeDocView}
            aria-label={mainView === 'tree' ? '切换到文档模式' : '切换到目录树'}
            title={mainView === 'tree' ? '切换到文档模式（打开上次文档）' : '返回目录树'}
            className="w-[42px] sm:w-[44px] h-[44px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors shrink-0"
          >
            {mainView === 'tree' ? (
              <FolderTree className="w-[19px] h-[19px]" strokeWidth={1.75} />
            ) : (
              <ArticleDocIcon className="w-[19px] h-[19px]" strokeWidth={1.75} />
            )}
          </button>

          {mainView === 'tree' ? (
            <>
              {/* 2. 目录图标后面：导入图标 */}
              <button
                type="button"
                onClick={() => setShowImportModal(true)}
                aria-label="导入文本文档"
                title="导入 .txt / .md 文档或粘贴文本"
                className="w-[42px] sm:w-[44px] h-[44px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                <Download className="w-[19px] h-[19px]" strokeWidth={1.75} />
              </button>

              {/* 3. 剪切 / 插入切换图标 */}
              <button
                type="button"
                onClick={handleCutOrInsertClick}
                aria-label={cutItem ? '插入到当前选中位置的下方' : '剪切目录或文章'}
                title={
                  cutItem
                    ? '插入到当前选中位置的下方'
                    : pickCutMode
                      ? '取消选择剪切项'
                      : '剪切选定的目录或文章'
                }
                className={`w-[42px] sm:w-[44px] h-[44px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] transition-colors ${
                  cutItem || pickCutMode
                    ? 'bg-[var(--fei-bg-selected)]'
                    : 'hover:bg-[var(--fei-bg-hover)]'
                }`}
              >
                {cutItem ? (
                  <InsertBelowIcon className="w-[19px] h-[19px]" strokeWidth={1.75} />
                ) : (
                  <Scissors className="w-[19px] h-[19px]" strokeWidth={1.75} />
                )}
              </button>

              {/* 4. 加密 / 解密切换图标（闭锁代表已加密，开锁代表未加密/已解密） */}
              <button
                type="button"
                onClick={handleEncryptButtonClick}
                aria-label={isSelectedEncrypted ? '解密选中的文档或目录' : '加密选中的文档或目录'}
                title={isSelectedEncrypted ? '当前已加密，点击解密' : '当前未加密，点击加密'}
                className="w-[42px] sm:w-[44px] h-[44px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                {isSelectedEncrypted ? (
                  <Lock className="w-[18.5px] h-[18.5px]" strokeWidth={1.75} />
                ) : (
                  <LockOpen className="w-[18.5px] h-[18.5px]" strokeWidth={1.75} />
                )}
              </button>

              {/* 5. 收起图标：收起所有内容，只显示目录 */}
              <button
                type="button"
                onClick={handleCollapseAllFolders}
                aria-label="收起所有目录"
                title="收起所有内容，只显示目录"
                className="w-[42px] sm:w-[44px] h-[44px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                <ChevronsUp className="w-[19px] h-[19px]" strokeWidth={1.75} />
              </button>

              {/* 6. 同步图标（点击直接同步，长按打开同步设置；右上角淡化小圆点提示待同步） */}
              <button
                type="button"
                onClick={handleDirectSyncClick}
                onPointerDown={handleSyncPointerDown}
                onPointerUp={cancelSyncLongPress}
                onPointerLeave={cancelSyncLongPress}
                onPointerCancel={cancelSyncLongPress}
                onContextMenu={(e) => e.preventDefault()}
                disabled={isSyncing}
                aria-label={hasPendingSync ? '点击同步，长按打开同步设置（有未同步变更）' : '点击同步，长按打开同步设置'}
                title={
                  hasPendingSync
                    ? '有内容未同步至坚果云，点击直接同步，长按打开同步设置'
                    : '点击直接同步，长按打开同步设置'
                }
                className="relative w-[42px] sm:w-[44px] h-[44px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors disabled:opacity-50 select-none"
              >
                <RefreshCw
                  className={`w-[19px] h-[19px] ${isSyncing ? 'animate-spin' : ''}`}
                  strokeWidth={1.75}
                />
                {hasPendingSync && (
                  <span
                    aria-hidden="true"
                    className="absolute top-[10px] right-[10px] w-[5.5px] h-[5.5px] rounded-full bg-[var(--fei-text-muted)]"
                  />
                )}
              </button>
            </>
          ) : (
            /* 文档模式：文档图标后面放置 浏览(Eye) <-> 编辑(Pencil) 图标；编辑状态下后面依次放置 一级标题、二级标题、无序列表、分割线 */
            <>
              {/* 2. 文档图标后面：浏览态显示 Eye，点击进入编辑变为 Pencil；再点击回到 Eye 并切回浏览 */}
              <button
                type="button"
                onClick={handleToggleEditMode}
                aria-label={isEditing ? '当前处于编辑状态，点击切回浏览' : '当前处于浏览状态，点击进入编辑'}
                title={isEditing ? '编辑状态（点击切回浏览）' : '浏览状态（点击进入编辑）'}
                className="w-[42px] sm:w-[44px] h-[44px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                {isEditing ? (
                  <Pencil className="w-[18px] h-[18px]" strokeWidth={1.75} />
                ) : (
                  <Eye className="w-[19px] h-[19px]" strokeWidth={1.75} />
                )}
              </button>

              {/* 3–6. 编辑状态下，编辑图标后面依次放置：一级标题、二级标题、无序列表、分割线 */}
              {isEditing && (
                <>
                  {(
                    [
                      { kind: 'h1', label: '一级标题', Icon: Heading1 },
                      { kind: 'h2', label: '二级标题', Icon: Heading2 },
                      { kind: 'ul', label: '无序列表', Icon: List },
                      { kind: 'hr', label: '分割线', Icon: Minus },
                    ] as Array<{
                      kind: EditFormatKind;
                      label: string;
                      Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
                    }>
                  ).map(({ kind, label, Icon }) => (
                    <button
                      key={kind}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => docViewRef.current?.applyMarkdownFormat(kind)}
                      aria-label={label}
                      title={label}
                      className="w-[42px] sm:w-[44px] h-[44px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] transition-colors"
                    >
                      <Icon className="w-[18px] h-[18px]" strokeWidth={1.75} />
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </footer>

      {/* First-Launch Storage Folder Selector Modal */}
      {!storageDir.initialized && (
        <StorageFolderModal
          initialPath={storageDir.folderPath}
          onConfirm={(folderPath) => {
            const next: StorageDirectoryConfig = {
              initialized: true,
              folderPath,
              selectedAt: Date.now(),
            };
            setStorageDir(next);
            saveStorageDirConfig(next);
            showToast(`文档存放目录已设为 ${folderPath}`);
          }}
        />
      )}

      {/* Sync Settings, PC Direct Connect & Encryption Modal */}
      {showSyncModal && (
        <SyncModal
          config={webDavConfig}
          lanRunning={lanRunning}
          lanUrl={lanUrl}
          lanLoading={lanLoading}
          onToggleLan={handleToggleLanDirect}
          onCopyLanUrl={handleCopyLanUrl}
          onSaveConfig={handleSaveSyncConfig}
          onClose={() => setShowSyncModal(false)}
        />
      )}

      {/* Import Directory Picker + Paste Box + Multi-file Modal */}
      {showImportModal && (
        <ImportModal
          folders={folders}
          defaultFolderId={defaultImportFolderId}
          onCreateFolder={handleCreateFolder}
          onImportDocs={handleImportDocs}
          onClose={() => setShowImportModal(false)}
        />
      )}

      {/* Drag Overlay */}
      {windowDragging && (
        <div className="fixed inset-0 z-50 bg-black/15 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
          <div className="px-5 py-3 rounded-xl bg-[var(--fei-bg-surface)] border border-[var(--fei-border)] shadow-lg text-[14px] text-[var(--fei-text-primary)]">
            松开导入 .txt / .md 文档
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-32px)] px-4 py-2 rounded-lg bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] text-[12.5px] leading-snug text-center shadow-md">
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

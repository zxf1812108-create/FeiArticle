import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ALargeSmall,
  BookA,
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
  Plus,
  Redo2,
  RefreshCw,
  Scissors,
  Trash2,
  Undo2,
} from 'lucide-react';
import { ImportModal } from './components/ImportModal';
import { MdictDictModal } from './components/MdictDictModal';
import { MdictLookupPopup } from './components/MdictLookupPopup';
import {
  DocViewStateSnapshot,
  EditFormatKind,
  MinimalDocView,
  MinimalDocViewHandle,
} from './components/MinimalDocView';
import {
  DragPayload,
  InsertPosition,
  MinimalTreeView,
  MinimalTreeViewHandle,
  TreeSelection,
} from './components/MinimalTreeView';
import { StorageFolderModal } from './components/StorageFolderModal';
import { SyncModal } from './components/SyncModal';
import { TrashModal } from './components/TrashModal';
import {
  ArticleDoc,
  DocFontId,
  FolderNode,
  MdictDictionarySummary,
  MdictLookupResult,
  PurgedSyncRecords,
  QuotaStats,
  SyncedTreeState,
  SyncLogEntry,
  WebDavConfig,
} from './types';
import {
  buildDocFontFamily,
  DOC_FONT_OPTIONS,
  resolveDefaultDocFont,
  resolveDocFont,
} from './utils/fonts';
import {
  attachMdictCss,
  deleteMdictDictionary,
  importMdictFile,
  listMdictDictionaries,
  lookupMdictWordAcrossAll,
  stripDictExt,
} from './utils/mdictStorage';
import {
  DEFAULT_READER_SETTINGS,
  loadActiveMdictId,
  loadDocFontsMap,
  loadDocs,
  loadFolders,
  loadFoldersDirty,
  loadLastOpenedDocId,
  loadPurgedSyncRecords,
  loadQuotaStats,
  loadReaderSettings,
  loadStorageDirConfig,
  loadSyncLogs,
  loadTreeViewState,
  loadWebDavConfig,
  MAX_DOC_FONT_SIZE,
  MIN_DOC_FONT_SIZE,
  saveActiveMdictId,
  saveDocFontsMap,
  saveDocs,
  saveFolders,
  saveFoldersDirty,
  saveLastOpenedDocId,
  savePurgedSyncRecords,
  saveQuotaStats,
  saveReaderSettings,
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
import { purgeExpiredTrash } from './utils/trash';
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
  className = 'w-[22px] h-[22px]',
  strokeWidth = 1.8,
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
  className = 'w-[22px] h-[22px]',
  strokeWidth = 1.8,
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
  const [purgedRecords, setPurgedRecords] = useState<PurgedSyncRecords>(() =>
    loadPurgedSyncRecords()
  );
  const [webDavConfig, setWebDavConfig] = useState<WebDavConfig>(() => loadWebDavConfig());
  const [quotaStats, setQuotaStats] = useState<QuotaStats>(() => loadQuotaStats());
  const [syncLogs, setSyncLogs] = useState<SyncLogEntry[]>(() => loadSyncLogs());

  const initialTreeState = useMemo(() => loadTreeViewState(), []);

  const [mainView, setMainView] = useState<MainView>('tree');
  const [selectedDocId, setSelectedDocId] = useState<string | null>(() => loadLastOpenedDocId());
  const [isEditing, setIsEditing] = useState(false);
  const [liveReadProgress, setLiveReadProgress] = useState<number>(0);
  const [editHistoryState, setEditHistoryState] = useState<{
    canUndo: boolean;
    canRedo: boolean;
  }>({ canUndo: false, canRedo: false });

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
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [showMdictModal, setShowMdictModal] = useState(false);
  const [showFontSizeBar, setShowFontSizeBar] = useState(false);
  const [fontSize, setFontSize] = useState<number>(() => {
    const raw = loadReaderSettings().fontSize;
    if (!Number.isFinite(raw)) return DEFAULT_READER_SETTINGS.fontSize;
    return Math.min(MAX_DOC_FONT_SIZE, Math.max(MIN_DOC_FONT_SIZE, Math.round(raw)));
  });
  const [defaultDocFont, setDefaultDocFont] = useState<DocFontId>(() =>
    resolveDefaultDocFont(loadReaderSettings().defaultDocFont)
  );
  const [docFontsMap, setDocFontsMap] = useState<Record<string, string>>(() =>
    loadDocFontsMap()
  );
  const [mdictDicts, setMdictDicts] = useState<MdictDictionarySummary[]>([]);
  const [activeMdictId, setActiveMdictId] = useState<string | null>(() => loadActiveMdictId());
  const [mdictLookup, setMdictLookup] = useState<{
    queryWord: string;
    placement: 'top' | 'bottom';
    loading: boolean;
    results: MdictLookupResult[];
    currentIndex: number;
    error: string | null;
  } | null>(null);
  const [activeDragPayload, setActiveDragPayload] = useState<DragPayload | null>(null);
  const [trashDragOver, setTrashDragOver] = useState(false);
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
  const mdictLookupReqRef = useRef(0);
  const docsRef = useRef<ArticleDoc[]>(docs);
  docsRef.current = docs;
  const foldersRef = useRef<FolderNode[]>(folders);
  foldersRef.current = folders;

  useEffect(() => {
    let cancelled = false;
    listMdictDictionaries()
      .then((list) => {
        if (cancelled) return;
        setMdictDicts(list);
        setActiveMdictId((prev) => {
          if (list.length === 0) {
            saveActiveMdictId(null);
            return null;
          }
          if (prev && list.some((d) => d.id === prev)) return prev;
          saveActiveMdictId(list[0].id);
          return list[0].id;
        });
      })
      .catch(() => {
        // Ignore IndexedDB unavailable errors on startup
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeFolders = useMemo(() => folders.filter((f) => !f.deleted), [folders]);
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
  useEffect(() => savePurgedSyncRecords(purgedRecords), [purgedRecords]);
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

  // Automatically permanently delete Trash items older than 30 days on launch and periodically
  const runExpiredTrashCleanup = () => {
    const now = Date.now();
    const res = purgeExpiredTrash(foldersRef.current, docsRef.current, now);
    if (!res.changed) return;
    setFolders(res.folders);
    setDocs(res.docs);
    setPurgedRecords((prev) => {
      const nextDocs = { ...prev.docs };
      const nextDocFormats = { ...(prev.docFormats || {}) };
      const nextFolders = { ...prev.folders };
      for (const fid of res.expiredFolderIds) nextFolders[fid] = now;
      for (const d of res.expiredDocs) {
        nextDocs[d.id] = now;
        nextDocFormats[d.id] = d.format === 'md' ? 'md' : 'txt';
      }
      return { docs: nextDocs, docFormats: nextDocFormats, folders: nextFolders };
    });
    setFoldersDirty(true);
  };

  useEffect(() => {
    runExpiredTrashCleanup();
    const interval = window.setInterval(runExpiredTrashCleanup, 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Keep PC Direct Connect snapshot in sync while LAN server is active
  useEffect(() => {
    if (!lanRunning) return;
    pushLanDirectState(activeFolders, docs);
  }, [lanRunning, activeFolders, docs]);

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
              lastCharOffset: 0,
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
            lastCharOffset: 0,
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
    const maxOrder = activeFolders.reduce((m, f) => Math.max(m, f.order), -1);
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

  // Trash: Move Doc or Folder (with all docs inside it) to 30-day Trash
  const handleMoveToTrash = (payload: DragPayload) => {
    const now = Date.now();
    if (payload.kind === 'doc') {
      setDocs((prev) =>
        prev.map((d) =>
          d.id === payload.id
            ? {
                ...d,
                deleted: true,
                deletedAt: now,
                deletedByFolderId: undefined,
                updatedAt: now,
                syncStatus: 'dirty',
              }
            : d
        )
      );
      if (selectedDocId === payload.id) setSelectedDocId(null);
      if (activeTarget?.kind === 'doc' && activeTarget.id === payload.id) {
        setActiveTarget(null);
      }
      if (cutItem?.kind === 'doc' && cutItem.id === payload.id) {
        setCutItem(null);
      }
      return;
    }

    const folderId = payload.id;
    if (folderId === INBOX_FOLDER_ID) {
      showToast('inbox 目录不可删除');
      return;
    }

    const docIdsInFolder = new Set(
      docsRef.current.filter((d) => !d.deleted && d.folderId === folderId).map((d) => d.id)
    );

    setFolders((prev) =>
      prev.map((f) =>
        f.id === folderId
          ? { ...f, deleted: true, deletedAt: now, updatedAt: now }
          : f
      )
    );
    setDocs((prev) =>
      prev.map((d) =>
        docIdsInFolder.has(d.id)
          ? {
              ...d,
              deleted: true,
              deletedAt: now,
              deletedByFolderId: folderId,
              updatedAt: now,
              syncStatus: 'dirty',
            }
          : d
      )
    );
    setFoldersDirty(true);
    setCollapsedFolderIds((prev) => prev.filter((id) => id !== folderId));

    if (selectedDocId && docIdsInFolder.has(selectedDocId)) {
      setSelectedDocId(null);
    }
    if (
      activeTarget &&
      ((activeTarget.kind === 'folder' && activeTarget.id === folderId) ||
        (activeTarget.kind === 'doc' && docIdsInFolder.has(activeTarget.id)))
    ) {
      setActiveTarget(null);
    }
    if (
      cutItem &&
      ((cutItem.kind === 'folder' && cutItem.id === folderId) ||
        (cutItem.kind === 'doc' && docIdsInFolder.has(cutItem.id)))
    ) {
      setCutItem(null);
    }
  };

  const handleRestoreFolderFromTrash = (folderId: string) => {
    const now = Date.now();
    const maxOrder = activeFolders.reduce((m, f) => Math.max(m, f.order), -1);
    setFolders((prev) =>
      prev.map((f) =>
        f.id === folderId
          ? {
              ...f,
              deleted: false,
              deletedAt: undefined,
              order: maxOrder + 1,
              updatedAt: now,
            }
          : f
      )
    );
    setDocs((prev) =>
      prev.map((d) =>
        d.deleted &&
        (d.deletedByFolderId === folderId || (!d.deletedByFolderId && d.folderId === folderId))
          ? {
              ...d,
              folderId,
              deleted: false,
              deletedAt: undefined,
              deletedByFolderId: undefined,
              updatedAt: now,
              syncStatus: 'dirty',
            }
          : d
      )
    );
    setFoldersDirty(true);
  };

  const handleRestoreDocFromTrash = (docId: string) => {
    const now = Date.now();
    const activeFolderIdSet = new Set(activeFolders.map((f) => f.id));
    setDocs((prev) =>
      prev.map((d) => {
        if (d.id !== docId) return d;
        const canKeepOriginFolder =
          d.folderId === INBOX_FOLDER_ID ||
          (d.folderId !== null && activeFolderIdSet.has(d.folderId));
        return {
          ...d,
          folderId: canKeepOriginFolder ? d.folderId : null,
          deleted: false,
          deletedAt: undefined,
          deletedByFolderId: undefined,
          updatedAt: now,
          syncStatus: 'dirty',
        };
      })
    );
  };

  const handleEmptyTrash = () => {
    const now = Date.now();
    const deletedFolderIds = foldersRef.current.filter((f) => f.deleted).map((f) => f.id);
    const deletedDocs = docsRef.current.filter((d) => d.deleted);
    if (deletedFolderIds.length === 0 && deletedDocs.length === 0) return;

    setFolders((prev) => prev.filter((f) => !f.deleted));
    setDocs((prev) => prev.filter((d) => !d.deleted));
    setPurgedRecords((prev) => {
      const nextDocs = { ...prev.docs };
      const nextDocFormats = { ...(prev.docFormats || {}) };
      const nextFolders = { ...prev.folders };
      for (const d of deletedDocs) {
        nextDocs[d.id] = now;
        nextDocFormats[d.id] = d.format === 'md' ? 'md' : 'txt';
      }
      for (const id of deletedFolderIds) nextFolders[id] = now;
      return { docs: nextDocs, docFormats: nextDocFormats, folders: nextFolders };
    });
    setFoldersDirty(true);
  };

  const handleDeleteFolder = (folderId: string) => {
    handleMoveToTrash({ kind: 'folder', id: folderId });
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
    setCollapsedFolderIds([
      ...activeFolders.map((f) => f.id),
      INBOX_FOLDER_ID,
      '__uncategorized__',
    ]);
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
      targetFolderId !== undefined ? targetFolderId : activeFolders[0]?.id ?? null;
    const folderId =
      requestedFolderId === INBOX_FOLDER_ID ? (activeFolders[0]?.id ?? null) : requestedFolderId;
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
      lastCharOffset: 0,
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

  const handleUpdateDocViewState = (docId: string, state: DocViewStateSnapshot) => {
    const current = docsRef.current.find((d) => d.id === docId);
    if (!current) return;
    const nextScroll = Math.max(0, Math.round(state.scrollTop));
    const nextCharOffset = Math.max(0, Math.round(state.charOffset));
    const nextProgress = Math.min(100, Math.max(0, Math.round(state.readProgress)));
    const prevScroll = Math.round(current.lastScrollTop ?? 0);
    const prevCharOffset = Math.round(current.lastCharOffset ?? 0);
    const prevProgress = Math.round(current.readProgress ?? 0);
    const prevMode = current.lastMode ?? 'read';
    if (
      prevMode === state.mode &&
      prevScroll === nextScroll &&
      prevCharOffset === nextCharOffset &&
      prevProgress === nextProgress
    ) {
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
              lastCharOffset: nextCharOffset,
              readProgress: nextProgress,
              updatedAt: now,
            }
          : d
      )
    );
    setFoldersDirty(true);
  };

  const handleOpenDoc = (docId: string) => {
    const target = docsRef.current.find((d) => d.id === docId);
    const nextTarget: TreeSelection = { kind: 'doc', id: docId };
    captureAndSaveTreeState(nextTarget);
    setActiveTarget(nextTarget);
    setSelectedDocId(docId);
    // Always open documents in Browse mode by default from the directory tree
    setIsEditing(false);
    setLiveReadProgress(target?.readProgress ?? 0);
    setEditHistoryState({ canUndo: false, canRedo: false });
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
    setMdictLookup(null);
    setShowFontSizeBar(false);
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
    if (nextEditing) {
      setMdictLookup(null);
      setShowFontSizeBar(false);
    }
    docViewRef.current?.prepareModeSwitch(nextEditing);
    setIsEditing(nextEditing);
  };

  const handleChangeFontSize = (nextSize: number) => {
    docViewRef.current?.captureTypographyAnchor();
    const clamped = Math.min(MAX_DOC_FONT_SIZE, Math.max(MIN_DOC_FONT_SIZE, Math.round(nextSize)));
    setFontSize(clamped);
    const prev = loadReaderSettings();
    saveReaderSettings({ ...prev, fontSize: clamped });
  };

  const currentDocFont = useMemo<DocFontId>(() => {
    if (!selectedDocId) return defaultDocFont;
    return resolveDocFont(docFontsMap[selectedDocId], defaultDocFont);
  }, [selectedDocId, docFontsMap, defaultDocFont]);

  const currentDocFontFamily = useMemo(
    () => buildDocFontFamily(currentDocFont, defaultDocFont),
    [currentDocFont, defaultDocFont]
  );

  const handleChangeDocFont = (nextFontId: DocFontId) => {
    if (!selectedDocId) return;
    docViewRef.current?.captureTypographyAnchor();
    setDocFontsMap((prev) => {
      const nextMap = {
        ...prev,
        [selectedDocId]: nextFontId,
      };
      saveDocFontsMap(nextMap);
      return nextMap;
    });
  };

  const handleSetDefaultDocFont = () => {
    setDefaultDocFont(currentDocFont);
    const prev = loadReaderSettings();
    saveReaderSettings({
      ...prev,
      defaultDocFont: currentDocFont,
    });
    showToast('已设为默认字体');
  };

  const runMdictLookup = async (
    word: string,
    placement: 'top' | 'bottom',
    preferredDictId?: string | null,
    dictListOverride?: MdictDictionarySummary[]
  ) => {
    const sourceDicts = dictListOverride || mdictDicts;
    if (sourceDicts.length === 0) return;

    const firstId =
      preferredDictId && sourceDicts.some((d) => d.id === preferredDictId)
        ? preferredDictId
        : activeMdictId && sourceDicts.some((d) => d.id === activeMdictId)
          ? activeMdictId
          : sourceDicts[0].id;
    const orderedIds = [
      firstId,
      ...sourceDicts.map((d) => d.id).filter((id) => id !== firstId),
    ];

    const reqId = ++mdictLookupReqRef.current;

    try {
      const results = await lookupMdictWordAcrossAll(orderedIds, word);
      if (mdictLookupReqRef.current !== reqId) return;
      if (results.length === 0) {
        // Close dictionary popup when selected text has no match so native Copy/Paste restores immediately
        setMdictLookup(null);
        return;
      }
      setMdictLookup({
        queryWord: word,
        placement,
        loading: false,
        results,
        currentIndex: 0,
        error: null,
      });
    } catch {
      if (mdictLookupReqRef.current !== reqId) return;
      setMdictLookup(null);
    }
  };

  const handleCycleMdictResult = () => {
    setMdictLookup((prev) => {
      if (!prev || prev.results.length <= 1) return prev;
      return {
        ...prev,
        currentIndex: (prev.currentIndex + 1) % prev.results.length,
      };
    });
  };

  const handleSelectActiveMdict = (dictId: string) => {
    setActiveMdictId(dictId);
    saveActiveMdictId(dictId);
  };

  const handleImportMdictFiles = async (files: FileList) => {
    const dictFiles: File[] = [];
    const cssFiles: File[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.mdx')) {
        dictFiles.push(f);
      } else if (lower.endsWith('.css')) {
        cssFiles.push(f);
      } else {
        throw new Error(`不支持的文件「${f.name}」，请选择 .mdx 词典或 .css 样式文件`);
      }
    }

    const imported: MdictDictionarySummary[] = [];
    for (const f of dictFiles) {
      const summary = await importMdictFile(f);
      imported.push(summary);
    }

    let currentList = await listMdictDictionaries();
    let nextActiveId = activeMdictId;
    if (imported.length > 0 && (!nextActiveId || !currentList.some((d) => d.id === nextActiveId))) {
      nextActiveId = imported[0].id;
      setActiveMdictId(nextActiveId);
      saveActiveMdictId(nextActiveId);
    }

    // Match each selected .css file to its corresponding .mdx dictionary
    for (const cssFile of cssFiles) {
      const cssBase = cssFile.name.replace(/\.css$/i, '').toLowerCase();
      const matched =
        imported.find((d) => stripDictExt(d.fileName).toLowerCase() === cssBase) ||
        currentList.find((d) => stripDictExt(d.fileName).toLowerCase() === cssBase) ||
        (imported.length === 1 ? imported[0] : null) ||
        (currentList.length === 1 ? currentList[0] : null) ||
        (dictFiles.length === 0 && nextActiveId
          ? currentList.find((d) => d.id === nextActiveId) || null
          : null);

      if (!matched) {
        throw new Error(
          `未找到与「${cssFile.name}」同名的词典，请点击对应词典右侧的「样式」按钮手动导入`
        );
      }
      await attachMdictCss(matched.id, cssFile);
    }

    if (cssFiles.length > 0) {
      currentList = await listMdictDictionaries();
    }
    setMdictDicts(currentList);
    if (mdictLookup && (cssFiles.length > 0 || imported.length > 0)) {
      const currentDictId =
        mdictLookup.results[mdictLookup.currentIndex]?.dictId || nextActiveId;
      void runMdictLookup(mdictLookup.queryWord, mdictLookup.placement, currentDictId, currentList);
    }
  };

  const handleAttachMdictCss = async (dictId: string, cssFile: File) => {
    await attachMdictCss(dictId, cssFile);
    const updatedList = await listMdictDictionaries();
    setMdictDicts(updatedList);
    if (mdictLookup) {
      const currentDictId = mdictLookup.results[mdictLookup.currentIndex]?.dictId || dictId;
      void runMdictLookup(mdictLookup.queryWord, mdictLookup.placement, currentDictId, updatedList);
    }
  };

  const handleDeleteMdictDict = async (id: string) => {
    await deleteMdictDictionary(id);
    const updatedList = await listMdictDictionaries();
    setMdictDicts(updatedList);
    let nextActive = activeMdictId;
    if (activeMdictId === id) {
      nextActive = updatedList[0]?.id || null;
      setActiveMdictId(nextActive);
      saveActiveMdictId(nextActive);
    }
    if (updatedList.length === 0) {
      setMdictLookup(null);
    } else if (mdictLookup) {
      const currentDictId = mdictLookup.results[mdictLookup.currentIndex]?.dictId;
      const preferred = currentDictId && currentDictId !== id ? currentDictId : nextActive;
      void runMdictLookup(mdictLookup.queryWord, mdictLookup.placement, preferred, updatedList);
    }
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
        const res = await startLanDirectServer(activeFolders, docs);
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
        foldersDirty,
        purgedRecords
      );
      setFolders(outcome.folders.map((f) => ({ ...f, parentId: null })));
      setDocs(outcome.docs);
      setCollapsedFolderIds(outcome.treeState.collapsedIds);
      setActiveTarget(outcome.treeState.activeTarget);
      setTreeScrollTop(outcome.treeState.scrollTop);
      setTreeStateUpdatedAt(outcome.treeState.updatedAt);
      setFoldersDirty(false);
      setPurgedRecords({ docs: {}, docFormats: {}, folders: {} });
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
    const regularFolders = activeFolders.filter((f) => f.id !== INBOX_FOLDER_ID);
    const fallbackId = regularFolders[0]?.id ?? null;
    if (activeTarget?.kind === 'folder') {
      if (activeTarget.id === INBOX_FOLDER_ID) return fallbackId;
      if (regularFolders.some((f) => f.id === activeTarget.id)) return activeTarget.id;
      return fallbackId;
    }
    if (activeTarget?.kind === 'doc') {
      const docFolder = docs.find((d) => d.id === activeTarget.id)?.folderId ?? null;
      if (docFolder && docFolder !== INBOX_FOLDER_ID && regularFolders.some((f) => f.id === docFolder)) {
        return docFolder;
      }
    }
    return fallbackId;
  }, [activeTarget, docs, activeFolders]);

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
            fontSize={fontSize}
            docFontFamily={currentDocFontFamily}
            hasActiveMdict={mdictDicts.length > 0}
            isMdictPopupOpen={mdictLookup !== null}
            onEnglishWordSelected={({ word, placement }) => {
              setShowFontSizeBar(false);
              void runMdictLookup(word, placement);
            }}
            onClearMdictLookup={() => setMdictLookup(null)}
            onSaveDraft={(updates) => handleSaveDraft(selectedDoc.id, updates)}
            onViewStateChange={(state) => handleUpdateDocViewState(selectedDoc.id, state)}
            onReadProgressChange={setLiveReadProgress}
            onHistoryChange={setEditHistoryState}
            onFetchRemoteBody={() => handleFetchRemoteBody(selectedDoc.id)}
          />
        ) : (
          <MinimalTreeView
            ref={treeViewRef}
            folders={activeFolders}
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
            onDragPayloadChange={setActiveDragPayload}
            onTrashDrop={handleMoveToTrash}
            onTrashDragHoverChange={setTrashDragOver}
          />
        )}
      </main>

      {/* Bottom Toolbar (All icons use FeiNote muted trash-can monochrome tone, ordered left-to-right) */}
      <footer
        aria-label="底部工具栏"
        className="shrink-0 bg-[var(--fei-bg-bar)] border-t border-[var(--fei-border)] pb-[env(safe-area-inset-bottom,0px)]"
      >
        <div className="h-[54px] max-w-[760px] mx-auto px-3 sm:px-6 flex items-center justify-start gap-0.5 sm:gap-1">
          {/* 1. 最左侧：目录图标 <-> 文档图标 */}
          <button
            type="button"
            onClick={handleToggleTreeDocView}
            aria-label={mainView === 'tree' ? '切换到文档模式' : '切换到目录树'}
            title={mainView === 'tree' ? '切换到文档模式（打开上次文档）' : '返回目录树'}
            className="w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors shrink-0"
          >
            {mainView === 'tree' ? (
              <FolderTree className="w-[22px] h-[22px]" strokeWidth={1.8} />
            ) : (
              <ArticleDocIcon className="w-[22px] h-[22px]" strokeWidth={1.8} />
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
                className="w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                <Download className="w-[22px] h-[22px]" strokeWidth={1.8} />
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
                className={`w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] transition-colors ${
                  cutItem || pickCutMode
                    ? 'bg-[var(--fei-bg-selected)] border border-[var(--fei-border-strong)] dark:border-transparent text-[var(--fei-text-primary)]'
                    : 'hover:bg-[var(--fei-bg-hover)]'
                }`}
              >
                {cutItem ? (
                  <InsertBelowIcon className="w-[22px] h-[22px]" strokeWidth={1.8} />
                ) : (
                  <Scissors className="w-[22px] h-[22px]" strokeWidth={1.8} />
                )}
              </button>

              {/* 4. 加密 / 解密切换图标（闭锁代表已加密，开锁代表未加密/已解密） */}
              <button
                type="button"
                onClick={handleEncryptButtonClick}
                aria-label={isSelectedEncrypted ? '解密选中的文档或目录' : '加密选中的文档或目录'}
                title={isSelectedEncrypted ? '当前已加密，点击解密' : '当前未加密，点击加密'}
                className="w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                {isSelectedEncrypted ? (
                  <Lock className="w-[21px] h-[21px]" strokeWidth={1.8} />
                ) : (
                  <LockOpen className="w-[21px] h-[21px]" strokeWidth={1.8} />
                )}
              </button>

              {/* 5. 收起图标：收起所有内容，只显示目录 */}
              <button
                type="button"
                onClick={handleCollapseAllFolders}
                aria-label="收起所有目录"
                title="收起所有内容，只显示目录"
                className="w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                <ChevronsUp className="w-[22px] h-[22px]" strokeWidth={1.8} />
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
                className="relative w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors disabled:opacity-50 select-none"
              >
                <RefreshCw
                  className={`w-[22px] h-[22px] ${isSyncing ? 'animate-spin' : ''}`}
                  strokeWidth={1.8}
                />
                {hasPendingSync && (
                  <span
                    aria-hidden="true"
                    className="absolute top-[9px] right-[9px] w-[6px] h-[6px] rounded-full bg-[var(--fei-text-muted)]"
                  />
                )}
              </button>

              {/* 7. 最右侧：回收站图标（拖入文档/目录即删除，点击打开回收站） */}
              <button
                type="button"
                data-trash-dropzone="true"
                onClick={() => {
                  runExpiredTrashCleanup();
                  setShowTrashModal(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (!trashDragOver) setTrashDragOver(true);
                }}
                onDragLeave={() => setTrashDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setTrashDragOver(false);
                  let payload = activeDragPayload;
                  if (!payload) {
                    try {
                      payload = JSON.parse(
                        e.dataTransfer.getData('application/x-feiartical')
                      ) as DragPayload;
                    } catch {
                      payload = null;
                    }
                  }
                  if (payload) {
                    handleMoveToTrash(payload);
                  }
                  setActiveDragPayload(null);
                }}
                aria-label="回收站（拖入目录或文档可删除，点击查看回收站）"
                title="回收站（拖入文档或目录可删除，内容保留 30 天）"
                className={`ml-auto w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg transition-all duration-150 shrink-0 ${
                  trashDragOver
                    ? 'bg-[var(--fei-bg-selected)] border border-[var(--fei-border-strong)] dark:border-transparent text-[var(--fei-text-primary)] scale-105'
                    : 'text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)]'
                }`}
              >
                <Trash2 className="w-[22px] h-[22px]" strokeWidth={1.8} />
              </button>
            </>
          ) : (
            /* 文档模式：文档图标后面放置 浏览(Eye) <-> 编辑(Pencil) 图标；浏览态最右侧显示阅读进度百分比 */
            <>
              {/* 2. 文档图标后面：浏览态显示 Eye，点击进入编辑变为 Pencil；再点击回到 Eye 并切回浏览 */}
              <button
                type="button"
                onClick={handleToggleEditMode}
                aria-label={isEditing ? '当前处于编辑状态，点击切回浏览' : '当前处于浏览状态，点击进入编辑'}
                title={isEditing ? '编辑状态（点击切回浏览）' : '浏览状态（点击进入编辑）'}
                className="w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors"
              >
                {isEditing ? (
                  <Pencil className="w-[21px] h-[21px]" strokeWidth={1.8} />
                ) : (
                  <Eye className="w-[22px] h-[22px]" strokeWidth={1.8} />
                )}
              </button>

              {/* 浏览状态下，浏览图标后面放置词典图标和调节字体大小图标，最右侧显示数字百分比进度 */}
              {!isEditing && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setShowFontSizeBar(false);
                      setShowMdictModal(true);
                    }}
                    aria-label="词典设置与切换"
                    title="词典（导入与切换 .mdx 词库）"
                    className="w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-colors"
                  >
                    <BookA className="w-[22px] h-[22px]" strokeWidth={1.8} />
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowFontSizeBar((prev) => !prev)}
                    aria-label="调节字体与字号"
                    title="调节字体与字号"
                    className={`w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg transition-colors ${
                      showFontSizeBar
                        ? 'bg-[var(--fei-bg-selected)] border border-[var(--fei-border-strong)] dark:border-transparent text-[var(--fei-text-primary)]'
                        : 'text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)]'
                    }`}
                  >
                    <ALargeSmall className="w-[22px] h-[22px]" strokeWidth={1.8} />
                  </button>

                  <span
                    aria-label={`当前阅读进度 ${liveReadProgress}%`}
                    className="ml-auto pr-1 text-[14px] font-medium tabular-nums text-[var(--fei-text-muted)] select-none whitespace-nowrap shrink-0"
                  >
                    {liveReadProgress}%
                  </span>
                </>
              )}

              {/* 3–7. 编辑状态下，编辑图标后面依次放置：一级标题、二级标题、无序列表、撤销、恢复 */}
              {isEditing && (
                <>
                  {(
                    [
                      { kind: 'h1', label: '一级标题', Icon: Heading1 },
                      { kind: 'h2', label: '二级标题', Icon: Heading2 },
                      { kind: 'ul', label: '无序列表', Icon: List },
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
                      className="w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] transition-colors"
                    >
                      <Icon className="w-[22px] h-[22px]" strokeWidth={1.8} />
                    </button>
                  ))}

                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => docViewRef.current?.undo()}
                    disabled={!editHistoryState.canUndo}
                    aria-label="撤销上一步编辑"
                    title="撤销"
                    className="w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] disabled:opacity-35 disabled:pointer-events-none transition-colors"
                  >
                    <Undo2 className="w-[22px] h-[22px]" strokeWidth={1.8} />
                  </button>

                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => docViewRef.current?.redo()}
                    disabled={!editHistoryState.canRedo}
                    aria-label="恢复上一步编辑"
                    title="恢复"
                    className="w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] disabled:opacity-35 disabled:pointer-events-none transition-colors"
                  >
                    <Redo2 className="w-[22px] h-[22px]" strokeWidth={1.8} />
                  </button>
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
          folders={activeFolders}
          defaultFolderId={defaultImportFolderId}
          onCreateFolder={handleCreateFolder}
          onImportDocs={handleImportDocs}
          onClose={() => setShowImportModal(false)}
        />
      )}

      {/* FeiNote-styled 30-Day Trash Modal */}
      {showTrashModal && (
        <TrashModal
          folders={folders}
          docs={docs}
          onRestoreFolder={handleRestoreFolderFromTrash}
          onRestoreDoc={handleRestoreDocFromTrash}
          onEmptyTrash={handleEmptyTrash}
          onClose={() => setShowTrashModal(false)}
        />
      )}

      {/* MDict Dictionary Import & Switch Modal */}
      {showMdictModal && (
        <MdictDictModal
          dictionaries={mdictDicts}
          activeDictId={activeMdictId}
          onImportFiles={handleImportMdictFiles}
          onAttachCss={handleAttachMdictCss}
          onSelectDict={(id) => {
            handleSelectActiveMdict(id);
            if (mdictLookup) {
              void runMdictLookup(mdictLookup.queryWord, mdictLookup.placement, id);
            }
          }}
          onDeleteDict={handleDeleteMdictDict}
          onClose={() => setShowMdictModal(false)}
        />
      )}

      {/* Font Size & Font Family Adjuster Popover in Browse/Read Mode (Applies to Read & Edit) */}
      {mainView === 'doc' && !isEditing && showFontSizeBar && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setShowFontSizeBar(false)}
          />
          <div
            role="dialog"
            aria-label="调节字体与字号"
            onClick={(e) => e.stopPropagation()}
            className="fixed bottom-[64px] left-1/2 -translate-x-1/2 z-40 w-[min(340px,calc(100vw-24px))] px-3.5 py-2.5 rounded-2xl bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] shadow-none dark:shadow-lg flex flex-col gap-2.5"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleChangeFontSize(fontSize - 1)}
                disabled={fontSize <= MIN_DOC_FONT_SIZE}
                aria-label="减小字号"
                className="w-10 h-10 inline-flex items-center justify-center rounded-xl text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] disabled:opacity-35 transition-colors shrink-0"
              >
                <Minus className="w-4 h-4" strokeWidth={1.75} />
              </button>

              <input
                type="range"
                min={MIN_DOC_FONT_SIZE}
                max={MAX_DOC_FONT_SIZE}
                step={1}
                value={fontSize}
                onChange={(e) => handleChangeFontSize(Number(e.target.value))}
                aria-label="字号滑块"
                className="flex-1 min-w-0 h-1.5 accent-[var(--fei-btn-primary-bg)] cursor-pointer"
              />

              <button
                type="button"
                onClick={() => handleChangeFontSize(fontSize + 1)}
                disabled={fontSize >= MAX_DOC_FONT_SIZE}
                aria-label="增大字号"
                className="w-10 h-10 inline-flex items-center justify-center rounded-xl text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] disabled:opacity-35 transition-colors shrink-0"
              >
                <Plus className="w-4 h-4" strokeWidth={1.75} />
              </button>

              <span className="text-[12px] font-code tabular-nums text-[var(--fei-text-muted)] w-8 text-right shrink-0">
                {fontSize}
              </span>
            </div>

            <div className="pt-2 border-t border-[var(--fei-border)] flex items-center gap-2.5">
              <span className="text-[12px] text-[var(--fei-text-muted)] shrink-0">
                字体
              </span>
              <select
                value={currentDocFont}
                onChange={(e) => handleChangeDocFont(e.target.value as DocFontId)}
                aria-label="文档字体"
                className="flex-1 min-w-0 h-9 px-2.5 rounded-lg bg-[var(--fei-bg)] border border-[var(--fei-border)] text-[12.5px] text-[var(--fei-text-primary)] outline-none focus:border-[var(--fei-border-strong)] cursor-pointer"
              >
                {DOC_FONT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleSetDefaultDocFont}
                className="h-9 px-2 inline-flex items-center justify-center rounded-lg text-[12px] font-medium whitespace-nowrap shrink-0 text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] active:bg-[var(--fei-bg-selected)] underline decoration-[var(--fei-border-strong)] underline-offset-[3px] transition-colors cursor-pointer"
              >
                设为默认
              </button>
            </div>
          </div>
        </>
      )}

      {/* Adaptive MDict Lookup Popup in Read Mode */}
      {mainView === 'doc' && !isEditing && mdictLookup && (
        <MdictLookupPopup
          queryWord={mdictLookup.queryWord}
          placement={mdictLookup.placement}
          fontSize={fontSize}
          loading={mdictLookup.loading}
          result={mdictLookup.results[mdictLookup.currentIndex] ?? null}
          matchCount={mdictLookup.results.length}
          error={mdictLookup.error}
          dictionaries={mdictDicts}
          activeDictId={activeMdictId}
          onCycleDict={handleCycleMdictResult}
          onLookupWord={(nextWord) => {
            const currentDictId =
              mdictLookup.results[mdictLookup.currentIndex]?.dictId || activeMdictId;
            void runMdictLookup(nextWord, mdictLookup.placement, currentDictId);
          }}
          onClose={() => setMdictLookup(null)}
        />
      )}

      {/* Drag Overlay */}
      {windowDragging && (
        <div className="fixed inset-0 z-50 bg-transparent dark:bg-black/25 flex items-center justify-center pointer-events-none">
          <div className="px-5 py-3 rounded-xl bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] shadow-none dark:shadow-lg text-[14px] text-[var(--fei-text-primary)]">
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

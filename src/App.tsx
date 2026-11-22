import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ALargeSmall,
  ArrowLeft,
  ChevronsUp,
  Download,
  Lock,
  LockOpen,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Scissors,
  Settings,
  Trash2,
} from 'lucide-react';
import { ImportModal } from './components/ImportModal';
import { MdictLookupPopup, MdictLookupPopupHandle } from './components/MdictLookupPopup';
import {
  DocReadMetrics,
  DocViewStateSnapshot,
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
import {
  StorageFolderConfirmResult,
  StorageFolderModal,
} from './components/StorageFolderModal';
import { SyncModal } from './components/SyncModal';
import { TrashModal } from './components/TrashModal';
import {
  checkAndPullExternalLocalFsChanges,
  resetLocalFsSyncManifest,
  scanAndMergeFromLocalFs,
  subscribeLocalStorageResume,
  syncWorkspaceToLocalFs,
  verifyLocalStorageReady,
} from './utils/localFs';
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
  DocToolbarIconId,
  loadActiveMdictId,
  loadDocFontsMap,
  loadDocs,
  loadDocToolbarOrder,
  loadFolders,
  loadFoldersDirty,
  loadLastOpenedDocId,
  loadPurgedSyncRecords,
  loadQuotaStats,
  loadReaderSettings,
  loadStorageDirConfig,
  loadSyncLogs,
  loadTreeToolbarOrder,
  loadTreeViewState,
  loadWebDavConfig,
  MAX_DOC_FONT_SIZE,
  MIN_DOC_FONT_SIZE,
  saveActiveMdictId,
  saveDocFontsMap,
  saveDocs,
  saveDocToolbarOrder,
  saveFolders,
  saveFoldersDirty,
  saveLastOpenedDocId,
  savePurgedSyncRecords,
  saveQuotaStats,
  saveReaderSettings,
  saveStorageDirConfig,
  saveSyncLogs,
  saveTreeToolbarOrder,
  saveTreeViewState,
  saveWebDavConfig,
  StorageDirectoryConfig,
  TreeToolbarIconId,
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
  const [liveReadProgress, setLiveReadProgress] = useState<number>(0);
  const [treeToolbarOrder, setTreeToolbarOrder] = useState<TreeToolbarIconId[]>(() =>
    loadTreeToolbarOrder()
  );
  const [docToolbarOrder, setDocToolbarOrder] = useState<DocToolbarIconId[]>(() =>
    loadDocToolbarOrder()
  );
  const [draggingToolbarIconId, setDraggingToolbarIconId] = useState<string | null>(null);

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
  const [showStorageFolderModal, setShowStorageFolderModal] = useState(false);
  const [storageModalSubtitle, setStorageModalSubtitle] = useState<string | undefined>(undefined);
  const [localFsReady, setLocalFsReady] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [showFontSizeBar, setShowFontSizeBar] = useState(false);
  const [fontSize, setFontSize] = useState<number>(() => {
    const raw = loadReaderSettings().fontSize;
    if (!Number.isFinite(raw)) return DEFAULT_READER_SETTINGS.fontSize;
    return Math.min(MAX_DOC_FONT_SIZE, Math.max(MIN_DOC_FONT_SIZE, Math.round(raw)));
  });
  const [defaultDocFont, setDefaultDocFont] = useState<DocFontId>(() =>
    resolveDefaultDocFont(loadReaderSettings().defaultDocFont)
  );
  const [autoHyphenate, setAutoHyphenate] = useState<boolean>(() =>
    Boolean(loadReaderSettings().autoHyphenate)
  );
  const [progressDisplayMode, setProgressDisplayMode] = useState<'percent' | 'pages'>(() =>
    loadReaderSettings().progressDisplayMode === 'pages' ? 'pages' : 'percent'
  );
  const [livePageInfo, setLivePageInfo] = useState<{ currentPage: number; totalPages: number }>({
    currentPage: 1,
    totalPages: 1,
  });
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
  const [mdictLookupPending, setMdictLookupPending] = useState(false);
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
  const mdictPopupRef = useRef<MdictLookupPopupHandle>(null);
  const toolbarBtnRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const suppressToolbarClickRef = useRef(false);
  const treeToolbarOrderRef = useRef<TreeToolbarIconId[]>(treeToolbarOrder);
  treeToolbarOrderRef.current = treeToolbarOrder;
  const docToolbarOrderRef = useRef<DocToolbarIconId[]>(docToolbarOrder);
  docToolbarOrderRef.current = docToolbarOrder;
  const mdictLookupReqRef = useRef(0);
  const docsRef = useRef<ArticleDoc[]>(docs);
  docsRef.current = docs;
  const foldersRef = useRef<FolderNode[]>(folders);
  foldersRef.current = folders;
  const storageDirRef = useRef<StorageDirectoryConfig>(storageDir);
  storageDirRef.current = storageDir;
  const localFsTimerRef = useRef<number | null>(null);
  const saveDocsTimerRef = useRef<number | null>(null);
  const isPullingLocalFsRef = useRef(false);

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

  // Suppress all browser / WebView context menus triggered by text selection or long-press
  useEffect(() => {
    const blockContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener('contextmenu', blockContextMenu, { capture: true });
    return () => {
      window.removeEventListener('contextmenu', blockContextMenu, { capture: true });
    };
  }, []);

  // Persist locally (debounce large docs serialization so opening/turning pages never stalls UI)
  useEffect(() => saveFolders(folders), [folders]);
  useEffect(() => {
    if (saveDocsTimerRef.current !== null) {
      window.clearTimeout(saveDocsTimerRef.current);
    }
    saveDocsTimerRef.current = window.setTimeout(() => {
      saveDocsTimerRef.current = null;
      saveDocs(docsRef.current);
    }, 500);
    return () => {
      if (saveDocsTimerRef.current !== null) {
        window.clearTimeout(saveDocsTimerRef.current);
        saveDocsTimerRef.current = null;
      }
    };
  }, [docs]);
  useEffect(() => {
    const flushDocsNow = () => {
      if (saveDocsTimerRef.current !== null) {
        window.clearTimeout(saveDocsTimerRef.current);
        saveDocsTimerRef.current = null;
      }
      saveDocs(docsRef.current);
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flushDocsNow();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flushDocsNow);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flushDocsNow);
    };
  }, []);
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

  // Pull external edits / new files / renames / deletions from the bound phone/local folder
  const pullExternalLocalChanges = async (options?: { forceScan?: boolean; silent?: boolean }) => {
    if (isPullingLocalFsRef.current) return;
    if (!storageDirRef.current.initialized) return;
    // Wait until any debounced in-app write has flushed first so we never race our own edits
    if (localFsTimerRef.current !== null && !options?.forceScan) return;

    isPullingLocalFsRef.current = true;
    try {
      const res = await checkAndPullExternalLocalFsChanges(
        foldersRef.current,
        docsRef.current,
        storageDirRef.current,
        {
          protectedDocId: null,
          forceScan: options?.forceScan,
        }
      );

      if (res.changed) {
        setFolders(res.folders);
        setDocs(res.docs);
        setFoldersDirty(true);

        if (!options?.silent) {
          const parts: string[] = [];
          if (res.updatedCount > 0) parts.push(`更新 ${res.updatedCount} 篇`);
          if (res.addedCount > 0) parts.push(`新增 ${res.addedCount} 篇`);
          if (res.renamedCount > 0) parts.push(`重命名 ${res.renamedCount} 篇`);
          if (res.removedCount > 0) parts.push(`移入回收站 ${res.removedCount} 篇`);
          if (parts.length > 0) {
            showToast(`已同步本地变更（${parts.join('，')}）`);
          }
        }
      }
    } catch {
      // Ignore transient disk polling errors
    } finally {
      isPullingLocalFsRef.current = false;
    }
  };

  // Verify real local folder binding on startup, pull external edits, and prompt migration if upgrading
  useEffect(() => {
    if (!storageDir.initialized) return;
    let cancelled = false;
    verifyLocalStorageReady(storageDir)
      .then(async (status) => {
        if (cancelled) return;
        if (status.needsRebind) {
          setLocalFsReady(false);
          setStorageModalSubtitle(
            '请授权并创建手机本地目录，原有文档将自动保存为该目录中的 .md / .txt 文件'
          );
          setShowStorageFolderModal(true);
          return;
        }
        const effectiveConfig = status.updatedConfig ?? storageDir;
        if (status.updatedConfig) {
          setStorageDir(status.updatedConfig);
          saveStorageDirConfig(status.updatedConfig);
          storageDirRef.current = status.updatedConfig;
        }
        setLocalFsReady(status.ready);

        if (status.ready && status.isRealDisk) {
          const pulled = await checkAndPullExternalLocalFsChanges(
            foldersRef.current,
            docsRef.current,
            effectiveConfig,
            { forceScan: true }
          );
          if (cancelled) return;
          if (pulled.changed) {
            setFolders(pulled.folders);
            setDocs(pulled.docs);
            setFoldersDirty(true);
          }
          await syncWorkspaceToLocalFs(pulled.folders, pulled.docs, effectiveConfig);
        }
      })
      .catch(() => {
        if (!cancelled) setLocalFsReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Continuously mirror folder & document mutations to the bound local folder on disk
  useEffect(() => {
    if (!storageDir.initialized || !localFsReady) return;
    if (localFsTimerRef.current !== null) {
      window.clearTimeout(localFsTimerRef.current);
    }
    localFsTimerRef.current = window.setTimeout(() => {
      localFsTimerRef.current = null;
      void syncWorkspaceToLocalFs(foldersRef.current, docsRef.current, storageDirRef.current);
    }, 280);
    return () => {
      if (localFsTimerRef.current !== null) {
        window.clearTimeout(localFsTimerRef.current);
        localFsTimerRef.current = null;
      }
    };
  }, [folders, docs, storageDir, localFsReady]);

  // Real-time two-way sync: check for external edits immediately on app resume & every 3s in foreground
  useEffect(() => {
    if (!storageDir.initialized || !localFsReady) return;

    const unsubscribeResume = subscribeLocalStorageResume(() => {
      void pullExternalLocalChanges();
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void pullExternalLocalChanges();
      }
    }, 3000);

    return () => {
      unsubscribeResume();
      window.clearInterval(interval);
    };
  }, [storageDir.initialized, localFsReady]);

  // Flush pending local disk writes immediately when app goes to background or closes
  useEffect(() => {
    if (!storageDir.initialized || !localFsReady) return;
    const flushNow = () => {
      if (localFsTimerRef.current !== null) {
        window.clearTimeout(localFsTimerRef.current);
        localFsTimerRef.current = null;
      }
      void syncWorkspaceToLocalFs(foldersRef.current, docsRef.current, storageDirRef.current);
    };
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') {
        flushNow();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    window.addEventListener('pagehide', flushNow);
    return () => {
      document.removeEventListener('visibilitychange', onVisChange);
      window.removeEventListener('pagehide', flushNow);
    };
  }, [storageDir.initialized, localFsReady]);

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

  const handleRenameDoc = (docId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setDocs((prev) =>
      prev.map((d) =>
        d.id === docId
          ? { ...d, title: trimmed, updatedAt: Date.now(), syncStatus: 'dirty' }
          : d
      )
    );
  };

  const handleToolbarEditClick = () => {
    if (!activeTarget) {
      showToast('请先点选要重命名的目录或文档');
      return;
    }
    const res = treeViewRef.current?.startRenameTarget(activeTarget);
    if (res === 'inbox') {
      showToast('inbox 目录不可重命名');
    } else if (res === 'missing') {
      showToast('请先点选要重命名的目录或文档');
    }
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
        showToast('已标记加密，同步前请点击设置图标设置加密密码');
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
      showToast('已加密目录下全部文档，同步前请点击设置图标设置加密密码');
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
      lastMode: 'read',
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
    setLiveReadProgress(target?.readProgress ?? 0);
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
    mdictLookupReqRef.current++;
    setMdictLookupPending(false);
    setMdictLookup(null);
    setShowFontSizeBar(false);
    setMainView('tree');
  };

  const handleChangeFontSize = (nextSize: number) => {
    docViewRef.current?.captureTypographyAnchor();
    const clamped = Math.min(MAX_DOC_FONT_SIZE, Math.max(MIN_DOC_FONT_SIZE, Math.round(nextSize)));
    setFontSize(clamped);
    const prev = loadReaderSettings();
    saveReaderSettings({ ...prev, fontSize: clamped });
  };

  const handleToggleAutoHyphenate = () => {
    docViewRef.current?.captureTypographyAnchor();
    setAutoHyphenate((prev) => {
      const next = !prev;
      const current = loadReaderSettings();
      saveReaderSettings({ ...current, autoHyphenate: next });
      return next;
    });
  };

  const handleToggleProgressDisplayMode = () => {
    setProgressDisplayMode((prev) => {
      const next: 'percent' | 'pages' = prev === 'percent' ? 'pages' : 'percent';
      const current = loadReaderSettings();
      saveReaderSettings({ ...current, progressDisplayMode: next });
      return next;
    });
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
    setMdictLookupPending(true);

    try {
      const results = await lookupMdictWordAcrossAll(orderedIds, word);
      if (mdictLookupReqRef.current !== reqId) return;
      if (results.length === 0) {
        // Close dictionary popup when selected text has no match so floating Copy popover can appear
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
    } finally {
      if (mdictLookupReqRef.current === reqId) {
        setMdictLookupPending(false);
      }
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
    if (suppressToolbarClickRef.current) return;
    if (webDavConfig.username.trim() && webDavConfig.password.trim()) {
      try {
        await handleRunLiveSync();
      } catch (err) {
        showToast(err instanceof Error ? err.message : '同步失败');
      }
    } else {
      showToast('请先在目录模式点击设置图标配置坚果云同步参数');
    }
  };

  // Drag-to-reorder handler for all movable bottom toolbar icons (both touch & mouse)
  const handleToolbarIconPointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    iconId: TreeToolbarIconId | DocToolbarIconId,
    mode: MainView
  ) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (!dragging) {
        if (Math.abs(dx) >= 10 || Math.hypot(dx, dy) >= 14) {
          dragging = true;
          suppressToolbarClickRef.current = true;
          setDraggingToolbarIconId(`${mode}:${iconId}`);
        } else {
          return;
        }
      }

      if (moveEvent.cancelable) {
        moveEvent.preventDefault();
      }

      const currentOrder: string[] =
        mode === 'tree' ? treeToolbarOrderRef.current : docToolbarOrderRef.current;
      const fromIdx = currentOrder.indexOf(iconId);
      if (fromIdx === -1) return;

      let toIdx = 0;
      for (let i = 0; i < currentOrder.length; i++) {
        const otherId = currentOrder[i];
        if (otherId === iconId) continue;
        const btn = toolbarBtnRefs.current.get(`${mode}:${otherId}`);
        if (!btn) continue;
        const rect = btn.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (moveEvent.clientX > midX) {
          toIdx++;
        }
      }

      if (toIdx !== fromIdx) {
        const nextOrder = [...currentOrder];
        nextOrder.splice(fromIdx, 1);
        nextOrder.splice(toIdx, 0, iconId);
        if (mode === 'tree') {
          const typed = nextOrder as TreeToolbarIconId[];
          treeToolbarOrderRef.current = typed;
          setTreeToolbarOrder(typed);
          saveTreeToolbarOrder(typed);
        } else {
          const typed = nextOrder as DocToolbarIconId[];
          docToolbarOrderRef.current = typed;
          setDocToolbarOrder(typed);
          saveDocToolbarOrder(typed);
        }
      }
    };

    const cleanup = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      if (dragging) {
        setDraggingToolbarIconId(null);
        window.setTimeout(() => {
          suppressToolbarClickRef.current = false;
        }, 120);
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
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
            key={selectedDoc.id}
            ref={docViewRef}
            doc={selectedDoc}
            fontSize={fontSize}
            docFontFamily={currentDocFontFamily}
            autoHyphenate={autoHyphenate}
            hasActiveMdict={mdictDicts.length > 0}
            isMdictPopupOpen={mdictLookup !== null}
            isMdictLookupPending={mdictLookupPending}
            onEnglishWordSelected={({ word, placement }) => {
              setShowFontSizeBar(false);
              void runMdictLookup(word, placement);
            }}
            onClearMdictLookup={() => {
              mdictLookupReqRef.current++;
              setMdictLookupPending(false);
              setMdictLookup(null);
            }}
            onCopyFeedback={(copied) =>
              showToast(copied ? '已复制选中内容' : '复制失败，请重试')
            }
            onMdictPopupVolumeKey={(direction) => {
              if (direction === 'up') {
                mdictPopupRef.current?.pageUp();
              } else {
                mdictPopupRef.current?.pageDown();
              }
            }}
            onViewStateChange={(state) => handleUpdateDocViewState(selectedDoc.id, state)}
            onReadProgressChange={setLiveReadProgress}
            onReadMetricsChange={(metrics: DocReadMetrics) => {
              setLiveReadProgress(metrics.progress);
              setLivePageInfo((prev) =>
                prev.currentPage === metrics.currentPage && prev.totalPages === metrics.totalPages
                  ? prev
                  : { currentPage: metrics.currentPage, totalPages: metrics.totalPages }
              );
            }}
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
            onRenameDoc={handleRenameDoc}
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

      {/* Bottom Toolbar (All icons use monochrome tone; all non-rightmost icons support drag reordering) */}
      <footer
        aria-label="底部工具栏"
        onPointerDownCapture={() => {
          if (mdictLookup) {
            setMdictLookup(null);
          }
        }}
        onClickCapture={() => {
          if (mdictLookup) {
            setMdictLookup(null);
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
        className="shrink-0 bg-[var(--fei-bg-bar)] border-t border-[var(--fei-border)] pb-[env(safe-area-inset-bottom,0px)] select-none"
      >
        <div className="h-[54px] max-w-[760px] mx-auto px-3 sm:px-6 flex items-center justify-start gap-0.5 sm:gap-1">
          {mainView === 'tree' ? (
            <>
              {treeToolbarOrder.map((iconId) => {
                const key = `tree:${iconId}`;
                const isDraggingThis = draggingToolbarIconId === key;
                const dragCls = isDraggingThis
                  ? 'bg-[var(--fei-bg-selected)] border border-[var(--fei-border-strong)] dark:border-transparent text-[var(--fei-text-primary)] scale-105 opacity-90'
                  : '';
                const bindRef = (el: HTMLButtonElement | null) => {
                  toolbarBtnRefs.current.set(key, el);
                };

                if (iconId === 'edit') {
                  return (
                    <button
                      key={iconId}
                      ref={bindRef}
                      type="button"
                      onPointerDown={(e) => handleToolbarIconPointerDown(e, 'edit', 'tree')}
                      onClick={() => {
                        if (suppressToolbarClickRef.current) return;
                        handleToolbarEditClick();
                      }}
                      aria-label="重命名选中的目录或文档"
                      title="重命名选中的目录或文档（可拖动调整图标位置）"
                      className={`w-[42px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-all shrink-0 touch-none select-none ${dragCls}`}
                    >
                      <Pencil className="w-[21px] h-[21px]" strokeWidth={1.8} />
                    </button>
                  );
                }

                if (iconId === 'import') {
                  return (
                    <button
                      key={iconId}
                      ref={bindRef}
                      type="button"
                      onPointerDown={(e) => handleToolbarIconPointerDown(e, 'import', 'tree')}
                      onClick={() => {
                        if (suppressToolbarClickRef.current) return;
                        setShowImportModal(true);
                      }}
                      aria-label="导入文本文档"
                      title="导入 .txt / .md 文档或粘贴文本（可拖动调整图标位置）"
                      className={`w-[42px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-all shrink-0 touch-none select-none ${dragCls}`}
                    >
                      <Download className="w-[22px] h-[22px]" strokeWidth={1.8} />
                    </button>
                  );
                }

                if (iconId === 'cut') {
                  return (
                    <button
                      key={iconId}
                      ref={bindRef}
                      type="button"
                      onPointerDown={(e) => handleToolbarIconPointerDown(e, 'cut', 'tree')}
                      onClick={() => {
                        if (suppressToolbarClickRef.current) return;
                        handleCutOrInsertClick();
                      }}
                      aria-label={cutItem ? '插入到当前选中位置的下方' : '剪切目录或文章'}
                      title={
                        cutItem
                          ? '插入到当前选中位置的下方'
                          : pickCutMode
                            ? '取消选择剪切项'
                            : '剪切选定的目录或文章（可拖动调整图标位置）'
                      }
                      className={`w-[42px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] transition-all shrink-0 touch-none select-none ${
                        isDraggingThis
                          ? dragCls
                          : cutItem || pickCutMode
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
                  );
                }

                if (iconId === 'encrypt') {
                  return (
                    <button
                      key={iconId}
                      ref={bindRef}
                      type="button"
                      onPointerDown={(e) => handleToolbarIconPointerDown(e, 'encrypt', 'tree')}
                      onClick={() => {
                        if (suppressToolbarClickRef.current) return;
                        handleEncryptButtonClick();
                      }}
                      aria-label={
                        isSelectedEncrypted ? '解密选中的文档或目录' : '加密选中的文档或目录'
                      }
                      title={
                        isSelectedEncrypted
                          ? '当前已加密，点击解密（可拖动调整图标位置）'
                          : '当前未加密，点击加密（可拖动调整图标位置）'
                      }
                      className={`w-[42px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-all shrink-0 touch-none select-none ${dragCls}`}
                    >
                      {isSelectedEncrypted ? (
                        <Lock className="w-[21px] h-[21px]" strokeWidth={1.8} />
                      ) : (
                        <LockOpen className="w-[21px] h-[21px]" strokeWidth={1.8} />
                      )}
                    </button>
                  );
                }

                if (iconId === 'collapse') {
                  return (
                    <button
                      key={iconId}
                      ref={bindRef}
                      type="button"
                      onPointerDown={(e) => handleToolbarIconPointerDown(e, 'collapse', 'tree')}
                      onClick={() => {
                        if (suppressToolbarClickRef.current) return;
                        handleCollapseAllFolders();
                      }}
                      aria-label="收起所有目录"
                      title="收起所有内容，只显示目录（可拖动调整图标位置）"
                      className={`w-[42px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-all shrink-0 touch-none select-none ${dragCls}`}
                    >
                      <ChevronsUp className="w-[22px] h-[22px]" strokeWidth={1.8} />
                    </button>
                  );
                }

                return (
                  <button
                    key={iconId}
                    ref={bindRef}
                    type="button"
                    onPointerDown={(e) => handleToolbarIconPointerDown(e, 'settings', 'tree')}
                    onClick={() => {
                      if (suppressToolbarClickRef.current) return;
                      setShowSyncModal(true);
                    }}
                    aria-label="设置（同步、存储与词典）"
                    title="设置（同步、存储与词典，可拖动调整图标位置）"
                    className={`w-[42px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-all shrink-0 touch-none select-none ${dragCls}`}
                  >
                    <Settings className="w-[21px] h-[21px]" strokeWidth={1.8} />
                  </button>
                );
              })}

              {/* 最右侧固定：回收站图标（拖入文档/目录即删除，点击打开回收站，不参与拖动排序） */}
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
                className={`ml-auto w-[42px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg transition-all duration-150 shrink-0 ${
                  trashDragOver
                    ? 'bg-[var(--fei-bg-selected)] border border-[var(--fei-border-strong)] dark:border-transparent text-[var(--fei-text-primary)] scale-105'
                    : 'text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)]'
                }`}
              >
                <Trash2 className="w-[22px] h-[22px]" strokeWidth={1.8} />
              </button>
            </>
          ) : (
            /* 文档浏览模式：默认依次为 返回、字体设置、同步（均可拖动排序），最右侧固定显示阅读进度 */
            <>
              {docToolbarOrder.map((iconId) => {
                const key = `doc:${iconId}`;
                const isDraggingThis = draggingToolbarIconId === key;
                const dragCls = isDraggingThis
                  ? 'bg-[var(--fei-bg-selected)] border border-[var(--fei-border-strong)] dark:border-transparent text-[var(--fei-text-primary)] scale-105 opacity-90'
                  : '';
                const bindRef = (el: HTMLButtonElement | null) => {
                  toolbarBtnRefs.current.set(key, el);
                };

                if (iconId === 'back') {
                  return (
                    <button
                      key={iconId}
                      ref={bindRef}
                      type="button"
                      onPointerDown={(e) => handleToolbarIconPointerDown(e, 'back', 'doc')}
                      onClick={() => {
                        if (suppressToolbarClickRef.current) return;
                        handleExitDocToTree();
                      }}
                      aria-label="返回目录"
                      title="返回目录（可拖动调整图标位置）"
                      className={`w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-all shrink-0 touch-none select-none ${dragCls}`}
                    >
                      <ArrowLeft className="w-[22px] h-[22px]" strokeWidth={1.8} />
                    </button>
                  );
                }

                if (iconId === 'font') {
                  return (
                    <button
                      key={iconId}
                      ref={bindRef}
                      type="button"
                      onPointerDown={(e) => handleToolbarIconPointerDown(e, 'font', 'doc')}
                      onClick={() => {
                        if (suppressToolbarClickRef.current) return;
                        setShowFontSizeBar((prev) => !prev);
                      }}
                      aria-label="调节字体与字号"
                      title="调节字体与字号（可拖动调整图标位置）"
                      className={`w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg transition-all shrink-0 touch-none select-none ${
                        isDraggingThis
                          ? dragCls
                          : showFontSizeBar
                            ? 'bg-[var(--fei-bg-selected)] border border-[var(--fei-border-strong)] dark:border-transparent text-[var(--fei-text-primary)]'
                            : 'text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)]'
                      }`}
                    >
                      <ALargeSmall className="w-[22px] h-[22px]" strokeWidth={1.8} />
                    </button>
                  );
                }

                return (
                  <button
                    key={iconId}
                    ref={bindRef}
                    type="button"
                    onPointerDown={(e) => handleToolbarIconPointerDown(e, 'sync', 'doc')}
                    onClick={handleDirectSyncClick}
                    onContextMenu={(e) => e.preventDefault()}
                    disabled={isSyncing}
                    aria-label={
                      hasPendingSync
                        ? '点击同步（有未同步变更）'
                        : '点击同步'
                    }
                    title={
                      hasPendingSync
                        ? '有内容未同步至坚果云，点击直接同步（可拖动调整图标位置）'
                        : '点击直接同步（可拖动调整图标位置）'
                    }
                    className={`relative w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)] transition-all disabled:opacity-50 shrink-0 touch-none select-none ${dragCls}`}
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
                );
              })}

              {/* 最右侧固定：阅读进度（点击在百分比与当前页数/总页数之间切换，不参与拖动排序） */}
              <button
                type="button"
                onClick={handleToggleProgressDisplayMode}
                aria-label={
                  progressDisplayMode === 'pages'
                    ? `当前第 ${livePageInfo.currentPage} 页，共 ${livePageInfo.totalPages} 页，点击切换为百分比进度`
                    : `当前阅读进度 ${liveReadProgress}%，点击切换为页数显示`
                }
                title={
                  progressDisplayMode === 'pages'
                    ? '点击切换为百分比进度'
                    : '点击切换为 当前页数/总页数'
                }
                className="ml-auto h-[40px] px-1.5 -mr-0.5 inline-flex items-center justify-center rounded-lg text-[14px] font-medium tabular-nums text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors select-none whitespace-nowrap shrink-0 cursor-pointer"
              >
                {progressDisplayMode === 'pages'
                  ? `${livePageInfo.currentPage}/${livePageInfo.totalPages}`
                  : `${liveReadProgress}%`}
              </button>
            </>
          )}
        </div>
      </footer>

      {/* First-Launch or User-Triggered Real Storage Folder Selector Modal */}
      {(!storageDir.initialized || showStorageFolderModal) && (
        <StorageFolderModal
          initialPath={storageDir.folderPath}
          allowCancel={storageDir.initialized && !storageModalSubtitle}
          subtitle={storageModalSubtitle}
          onCancel={() => {
            setShowStorageFolderModal(false);
            setStorageModalSubtitle(undefined);
          }}
          onConfirm={async (result: StorageFolderConfirmResult) => {
            const next: StorageDirectoryConfig = {
              initialized: true,
              folderPath: result.folderPath,
              storageMode: result.storageMode,
              treeUri: result.treeUri,
              selectedAt: Date.now(),
            };
            resetLocalFsSyncManifest();
            setStorageDir(next);
            saveStorageDirConfig(next);
            storageDirRef.current = next;
            setLocalFsReady(true);
            setShowStorageFolderModal(false);
            setStorageModalSubtitle(undefined);

            if (result.storageMode !== 'browser-only') {
              const merged = await scanAndMergeFromLocalFs(
                foldersRef.current,
                docsRef.current,
                next
              );
              if (merged.importedFolderCount > 0 || merged.importedDocCount > 0) {
                setFolders(merged.folders);
                setDocs(merged.docs);
              }
              const synced = await syncWorkspaceToLocalFs(
                merged.folders,
                merged.docs,
                next,
                { forceFull: true }
              );
              if (!synced.ok) {
                showToast(synced.error || '目录已绑定，但写入文件失败');
              } else if (merged.importedDocCount > 0) {
                showToast(
                  `已绑定 ${result.folderPath}，载入 ${merged.importedDocCount} 篇本地文档`
                );
              } else {
                showToast(`已创建并绑定目录 ${result.folderPath}`);
              }
            } else {
              showToast(`文档目录已设为 ${result.folderPath}`);
            }
          }}
        />
      )}

      {/* Settings Modal: Sync, Encryption, PC Direct Connect, Local Folder & Dictionary */}
      {showSyncModal && (
        <SyncModal
          config={webDavConfig}
          storageFolderPath={storageDir.folderPath}
          onChangeStorageFolder={() => {
            setShowSyncModal(false);
            setStorageModalSubtitle(undefined);
            setShowStorageFolderModal(true);
          }}
          lanRunning={lanRunning}
          lanUrl={lanUrl}
          lanLoading={lanLoading}
          onToggleLan={handleToggleLanDirect}
          onCopyLanUrl={handleCopyLanUrl}
          dictionaries={mdictDicts}
          activeDictId={activeMdictId}
          onImportDictFiles={handleImportMdictFiles}
          onAttachDictCss={handleAttachMdictCss}
          onSelectDict={(id) => {
            handleSelectActiveMdict(id);
            if (mdictLookup) {
              void runMdictLookup(mdictLookup.queryWord, mdictLookup.placement, id);
            }
          }}
          onDeleteDict={handleDeleteMdictDict}
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

      {/* Font Size & Font Family Adjuster Popover in Browse Mode */}
      {mainView === 'doc' && showFontSizeBar && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setShowFontSizeBar(false)}
          />
          <div
            role="dialog"
            aria-label="调节字体与字号"
            onClick={(e) => e.stopPropagation()}
            className="fixed bottom-[64px] left-1/2 -translate-x-1/2 z-40 w-[min(340px,calc(100vw-24px))] px-3.5 py-2.5 rounded-2xl bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] shadow-none dark:shadow-lg flex flex-col gap-2.5 select-none"
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

            <div className="pt-2 border-t border-[var(--fei-border)] flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12.5px] text-[var(--fei-text-primary)]">自动断字</div>
                <div className="text-[11px] text-[var(--fei-text-muted)] leading-tight">
                  行末英文长词自动按音节连字符断行
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoHyphenate}
                aria-label="自动断字"
                onClick={handleToggleAutoHyphenate}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors cursor-pointer ${
                  autoHyphenate
                    ? 'bg-[var(--fei-btn-primary-bg)] border-[var(--fei-btn-primary-bg)]'
                    : 'bg-[var(--fei-bg-subtle)] border-[var(--fei-border-strong)]'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-block h-4 w-4 rounded-full transition-transform ${
                    autoHyphenate
                      ? 'translate-x-[22px] bg-[var(--fei-btn-primary-text)]'
                      : 'translate-x-[3px] bg-[var(--fei-text-muted)]'
                  }`}
                />
              </button>
            </div>
          </div>
        </>
      )}

      {/* Adaptive MDict Lookup Popup in Read Mode */}
      {mainView === 'doc' && mdictLookup && (
        <MdictLookupPopup
          ref={mdictPopupRef}
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

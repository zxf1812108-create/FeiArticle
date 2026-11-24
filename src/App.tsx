import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ALargeSmall,
  ArrowLeft,
  Download,
  Lock,
  LockOpen,
  Minus,
  Music2,
  Pencil,
  Plus,
  Scissors,
  Settings,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { ImportModal } from './components/ImportModal';
import { InputPastePopover } from './components/InputPastePopover';
import { MdictLookupPopup, MdictLookupPopupHandle } from './components/MdictLookupPopup';
import {
  DocReadMetrics,
  DocViewStateSnapshot,
  MinimalDocView,
  MinimalDocViewHandle,
} from './components/MinimalDocView';
import { NoteAnchorTarget, ReadingNotePopover } from './components/ReadingNotePopover';
import { ReadingNotesListModal } from './components/ReadingNotesListModal';
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
  saveLocalImageFiles,
  scanAndMergeFromLocalFs,
  subscribeLocalStorageResume,
  syncWorkspaceToLocalFs,
  verifyLocalStorageReady,
} from './utils/localFs';
import {
  ArticleDoc,
  FolderNode,
  MdictDictionarySummary,
  MdictLookupResult,
  PurgedSyncRecords,
  QuotaStats,
  ReadingNote,
  SyncedTreeState,
  WebDavConfig,
  WhistleSensitivity,
} from './types';
import { getActiveNotes, sanitizeNotesList } from './utils/notes';
import {
  attachMdictCss,
  deleteMdictDictionary,
  importMdictFile,
  listMdictDictionaries,
  lookupMdictWordAcrossAll,
  stripDictExt,
} from './utils/mdictStorage';
import {
  applyThemeMode,
  AppThemeMode,
  DEFAULT_READER_SETTINGS,
  DocToolbarIconId,
  loadActiveMdictId,
  loadDocs,
  loadDocToolbarOrder,
  loadFolders,
  loadFoldersDirty,
  loadLastOpenedDocId,
  loadPurgedSyncRecords,
  loadQuotaStats,
  loadReaderSettings,
  loadStorageDirConfig,
  loadTheme,
  loadTreeToolbarOrder,
  loadTreeViewState,
  loadWebDavConfig,
  MAX_DOC_FONT_SIZE,
  MIN_DOC_FONT_SIZE,
  saveActiveMdictId,
  saveDocs,
  saveDocToolbarOrder,
  saveFolders,
  saveFoldersDirty,
  saveLastOpenedDocId,
  savePurgedSyncRecords,
  saveQuotaStats,
  saveReaderSettings,
  saveStorageDirConfig,
  saveTheme,
  saveTreeToolbarOrder,
  saveTreeViewState,
  saveWebDavConfig,
  StorageDirectoryConfig,
  TreeToolbarIconId,
} from './utils/storage';
import {
  ExtractedEbookImage,
  isEbookFile,
  isSupportedImportFile,
  parseEbookFile,
} from './utils/ebookParser';
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
import { pruneExpiredPurgedRecords, purgeExpiredTrash } from './utils/trash';
import {
  fetchRemoteDocBody,
  isDocBodyMissing,
  runAutoMetadataProgressSync,
} from './utils/webdavSync';
import {
  applyWifiReceivedDocToDocs,
  computeWifiSyncFingerprint,
  isWifiSyncNativeAvailable,
  runWifiBidirectionalSync,
  startWifiSyncHost,
  updateWifiSyncStateHash,
  WifiDocBodyPayload,
  WifiPeer,
  WifiServerInfo,
} from './utils/wifiSync';
import {
  LanDirectAction,
  pushLanDirectState,
  startLanDirectServer,
  stopLanDirectServer,
  subscribeLanDirectActions,
} from './utils/lanDirect';
import { formatMicErrorMessage, WhistleDetector } from './utils/whistleDetector';
import {
  extractReadAnchorText,
  relocateCharOffsetByAnchor,
  resolveComparableProgressPercent,
} from './utils/progressSync';
import { ProgressConflictModal } from './components/ProgressConflictModal';

type MainView = 'tree' | 'doc';

type SilentAutoSyncResult =
  | { status: 'skipped' }
  | { status: 'offline' }
  | { status: 'auth-error' }
  | { status: 'rate-limited' }
  | { status: 'error' }
  | {
      status: 'ok';
      didPull: boolean;
      didPush: boolean;
      addedDocsCount: number;
      oversizedInboxCount: number;
    };

const AUTO_PROGRESS_SYNC_INTERVAL_MS = 60 * 1000;
const AUTO_TREE_POLL_INTERVAL_MS = 45 * 1000;
const AUTO_CATALOG_DEBOUNCE_MS = 5000;
const AUTO_PULL_COOLDOWN_MS = 15_000;
const AUTO_SYNC_BACKOFF_STEPS_MS = [30_000, 60_000, 180_000, 300_000];
const TOOLBAR_TOAST_DURATION_MS = 1200;

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

function formatAdaptiveProgressPercent(progress: number, decimals: number): string {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0));
  if (clamped <= 0) return '0%';
  if (clamped >= 100) return '100%';
  const safeDecimals = Math.min(3, Math.max(0, Math.round(decimals)));
  const factor = 10 ** safeDecimals;
  const rounded = Math.round(clamped * factor) / factor;
  if (rounded <= 0) return '0%';
  if (rounded >= 100) return '100%';
  return `${rounded.toFixed(safeDecimals)}%`;
}

export default function App() {
  const [folders, setFolders] = useState<FolderNode[]>(() => loadFolders());
  const [docs, setDocs] = useState<ArticleDoc[]>(() => loadDocs());
  const [foldersDirty, setFoldersDirty] = useState<boolean>(() => loadFoldersDirty());
  const [purgedRecords, setPurgedRecords] = useState<PurgedSyncRecords>(() =>
    loadPurgedSyncRecords()
  );
  const [webDavConfig, setWebDavConfig] = useState<WebDavConfig>(() => loadWebDavConfig());
  const [quotaStats, setQuotaStats] = useState<QuotaStats>(() => loadQuotaStats());

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
  const [visibleNoteIds, setVisibleNoteIds] = useState<string[]>([]);
  const [notePopoverState, setNotePopoverState] = useState<{
    screenNoteIds: string[];
    initialNoteId: string | null;
    defaultAnchor: NoteAnchorTarget;
    canCreateAtDefaultAnchor: boolean;
  } | null>(null);
  const [showNotesListModal, setShowNotesListModal] = useState(false);
  const [fontSize, setFontSize] = useState<number>(() => {
    const raw = loadReaderSettings().fontSize;
    if (!Number.isFinite(raw)) return DEFAULT_READER_SETTINGS.fontSize;
    return Math.min(MAX_DOC_FONT_SIZE, Math.max(MIN_DOC_FONT_SIZE, Math.round(raw)));
  });
  const [autoHyphenate, setAutoHyphenate] = useState<boolean>(
    () => loadReaderSettings().autoHyphenate ?? true
  );
  const [whistleSensitivity, setWhistleSensitivity] = useState<WhistleSensitivity>(() => {
    const raw = loadReaderSettings().whistleSensitivity;
    return raw === 'low' || raw === 'high' ? raw : 'medium';
  });
  const [whistleEnabled, setWhistleEnabled] = useState(false);
  const [whistleStarting, setWhistleStarting] = useState(false);
  const whistleDetectorRef = useRef<WhistleDetector | null>(null);
  const whistleIdleTimerRef = useRef<number | null>(null);
  const [liveProgressDecimals, setLiveProgressDecimals] = useState<number>(0);
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
  const [lanRunning, setLanRunning] = useState(false);
  const [lanUrl, setLanUrl] = useState('');
  const [lanLoading, setLanLoading] = useState(false);
  const [wifiServerInfo, setWifiServerInfo] = useState<WifiServerInfo | null>(null);
  const [wifiPeers, setWifiPeers] = useState<WifiPeer[]>([]);
  const wifiPeersRef = useRef<WifiPeer[]>([]);
  const [wifiLocalStateHash, setWifiLocalStateHash] = useState('');
  const wifiLocalStateHashRef = useRef('');
  const [wifiImageVersion, setWifiImageVersion] = useState(0);
  const [wifiQuickBubble, setWifiQuickBubble] = useState<{
    status: 'syncing' | 'done' | 'error';
    text?: string;
    action?: 'settings';
  } | null>(null);
  const wifiQuickBubbleRef = useRef(wifiQuickBubble);
  wifiQuickBubbleRef.current = wifiQuickBubble;
  const wifiServerInfoRef = useRef<WifiServerInfo | null>(wifiServerInfo);
  wifiServerInfoRef.current = wifiServerInfo;
  const [wifiBubbleDots, setWifiBubbleDots] = useState(1);
  const wifiAutoSyncingRef = useRef(false);
  const wifiBubbleTimerRef = useRef<number | null>(null);
  const wifiIncomingSyncTimerRef = useRef<number | null>(null);
  const wifiResolutionPushTimerRef = useRef<number | null>(null);
  const wifiLastSyncedPairRef = useRef<
    Map<
      string,
      {
        localHash: string;
        peerHash: string;
        at: number;
        isError?: boolean;
        isAuthError?: boolean;
      }
    >
  >(new Map());
  const [toast, setToast] = useState<{ msg: string } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [windowDragging, setWindowDragging] = useState(false);
  const [dismissedConflictKeys, setDismissedConflictKeys] = useState<Record<string, string>>({});
  const [wifiConflictBatchTotal, setWifiConflictBatchTotal] = useState(0);

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
  const pendingMdictAutoExpandRef = useRef(false);
  const docsRef = useRef<ArticleDoc[]>(docs);
  docsRef.current = docs;
  const foldersRef = useRef<FolderNode[]>(folders);
  foldersRef.current = folders;
  const webDavConfigRef = useRef<WebDavConfig>(webDavConfig);
  webDavConfigRef.current = webDavConfig;
  const purgedRecordsRef = useRef<PurgedSyncRecords>(purgedRecords);
  purgedRecordsRef.current = purgedRecords;
  const mainViewRef = useRef<MainView>(mainView);
  mainViewRef.current = mainView;
  const selectedDocIdRef = useRef<string | null>(selectedDocId);
  selectedDocIdRef.current = selectedDocId;
  const collapsedFolderIdsRef = useRef<string[]>(collapsedFolderIds);
  collapsedFolderIdsRef.current = collapsedFolderIds;
  const activeTargetRef = useRef<TreeSelection | null>(activeTarget);
  activeTargetRef.current = activeTarget;
  const treeScrollTopRef = useRef<number>(treeScrollTop);
  treeScrollTopRef.current = treeScrollTop;
  const treeStateUpdatedAtRef = useRef<number>(treeStateUpdatedAt);
  treeStateUpdatedAtRef.current = treeStateUpdatedAt;
  const activeAutoSyncPromiseRef = useRef<Promise<SilentAutoSyncResult> | null>(null);
  const [treePullRefreshing, setTreePullRefreshing] = useState(false);
  const treePullRefreshingRef = useRef(false);
  const autoProgressDirtyRef = useRef(false);
  const autoCatalogDirtyRef = useRef(false);
  const autoMutationSeqRef = useRef(0);
  const autoCatalogDebounceTimerRef = useRef<number | null>(null);
  const lastAutoPullAtRef = useRef(0);
  const autoSyncFailCountRef = useRef(0);
  const autoSyncBackoffUntilRef = useRef(0);
  const lastAuthErrorKeyRef = useRef('');
  const lastOversizedInboxNoticeAtRef = useRef(0);
  const lastWifiPeerCloudConfiguredRef = useRef(false);
  const wifiCloudSyncNeededRef = useRef(false);
  const triggerPostWifiCloudSyncRef = useRef<
    (isInitiator: boolean, peerCloudConfigured: boolean) => void
  >(() => {});
  const storageDirRef = useRef<StorageDirectoryConfig>(storageDir);
  storageDirRef.current = storageDir;
  const localFsTimerRef = useRef<number | null>(null);
  const saveDocsTimerRef = useRef<number | null>(null);
  const isPullingLocalFsRef = useRef(false);

  useEffect(() => {
    if (mainView === 'doc' && mdictLookup && pendingMdictAutoExpandRef.current) {
      pendingMdictAutoExpandRef.current = false;
      mdictPopupRef.current?.autoExpandIfOverflowing();
    } else if (!mdictLookup && !mdictLookupPending) {
      pendingMdictAutoExpandRef.current = false;
    }
  }, [mainView, mdictLookup, mdictLookupPending]);

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

  const [themeMode, setThemeMode] = useState<AppThemeMode>(() => loadTheme());

  // Apply and persist user-selected color mode (light / dark / eink)
  useEffect(() => {
    applyThemeMode(themeMode);
    saveTheme(themeMode);
  }, [themeMode]);

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
        foldersRef.current = res.folders;
        docsRef.current = res.docs;
        setFolders(res.folders);
        setDocs(res.docs);
        setFoldersDirty(true);
        markAutoCatalogDirty();

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

  // Automatically permanently delete Trash items & expired purge tombstones older than 30 days
  const runExpiredTrashCleanup = () => {
    const now = Date.now();
    const res = purgeExpiredTrash(foldersRef.current, docsRef.current, now);
    const prevPurged = purgedRecordsRef.current;
    const prunedPrev = pruneExpiredPurgedRecords(prevPurged, now);
    const prunedChanged =
      Object.keys(prunedPrev.docs).length !== Object.keys(prevPurged.docs).length ||
      Object.keys(prunedPrev.folders).length !== Object.keys(prevPurged.folders).length;

    if (!res.changed) {
      if (prunedChanged) {
        purgedRecordsRef.current = prunedPrev;
        setPurgedRecords(prunedPrev);
      }
      return;
    }
    foldersRef.current = res.folders;
    docsRef.current = res.docs;
    setFolders(res.folders);
    setDocs(res.docs);
    setPurgedRecords((prev) => {
      const base = pruneExpiredPurgedRecords(prev, now);
      const nextDocs = { ...base.docs };
      const nextDocFormats = { ...(base.docFormats || {}) };
      const nextFolders = { ...base.folders };
      for (const fid of res.expiredFolderIds) nextFolders[fid] = now;
      for (const d of res.expiredDocs) {
        nextDocs[d.id] = now;
        nextDocFormats[d.id] = d.format === 'md' ? 'md' : 'txt';
      }
      const next = { docs: nextDocs, docFormats: nextDocFormats, folders: nextFolders };
      purgedRecordsRef.current = next;
      return next;
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
        markAutoCatalogDirty();
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
        markAutoCatalogDirty();
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
        markAutoCatalogDirty();
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
        markAutoCatalogDirty();
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
            format: item.format ?? 'txt',
            createdAt: now + i,
            updatedAt: now + i,
            syncStatus: 'dirty',
            highlights: [],
            byteSize: getByteSize(content),
          });
        }
        if (created.length > 0) {
          setDocs((prev) => [...prev, ...created]);
          markAutoCatalogDirty();
        }
        return;
      }

      if (action.type === 'importEbook' && action.fileName && action.base64) {
        if (action.folderId === INBOX_FOLDER_ID) return;
        try {
          const binStr = window.atob(action.base64);
          const bytes = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) {
            bytes[i] = binStr.charCodeAt(i);
          }
          const file = new File([bytes], action.fileName);
          const parsed = await parseEbookFile(file);
          await handleImportDocs([
            {
              title: parsed.title,
              content: parsed.content,
              folderId: action.folderId ?? null,
              format: parsed.images && parsed.images.length > 0 ? 'md' : 'txt',
              images: parsed.images,
            },
          ]);
        } catch (err) {
          showToast(err instanceof Error ? err.message : `解析电子书「${action.fileName}」失败`);
        }
      }
    });
  }, [lanRunning, selectedDocId]);

  const showToast = (msg: string, durationMs = TOOLBAR_TOAST_DURATION_MS) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    if (wifiQuickBubbleRef.current && wifiQuickBubbleRef.current.status !== 'syncing') {
      if (wifiBubbleTimerRef.current !== null) {
        window.clearTimeout(wifiBubbleTimerRef.current);
        wifiBubbleTimerRef.current = null;
      }
      setWifiQuickBubble(null);
    }
    setToast({ msg });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast((prev) => (prev?.msg === msg ? null : prev));
    }, durationMs);
  };

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
    markAutoCatalogDirty();
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
    markAutoCatalogDirty();
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
    markAutoCatalogDirty();
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
      markAutoCatalogDirty();
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
    markAutoCatalogDirty();
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
    markAutoCatalogDirty();
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
    markAutoCatalogDirty();
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
    markAutoCatalogDirty();
  };

  const handleExpandFolder = (id: string) => {
    if (!collapsedFolderIds.includes(id)) return;
    setCollapsedFolderIds((prev) => prev.filter((item) => item !== id));
    setTreeStateUpdatedAt(Date.now());
    setFoldersDirty(true);
    markAutoCatalogDirty();
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
    markAutoCatalogDirty();
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
    markAutoCatalogDirty();
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
      markAutoCatalogDirty();
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
    markAutoCatalogDirty();

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
    markAutoCatalogDirty();
    setSelectedDocId(newDoc.id);
    setActiveTarget(nextTarget);
    setMainView('doc');
  };

  const handleUpdateDocViewState = (docId: string, state: DocViewStateSnapshot) => {
    const current = docsRef.current.find((d) => d.id === docId);
    if (!current) return;
    const nextScroll = Math.max(0, Math.round(state.scrollTop));
    const nextCharOffset = Math.max(0, Math.round(state.charOffset));
    const nextProgress = Math.min(100, Math.max(0, Math.round(state.readProgress * 1000) / 1000));
    const prevScroll = Math.round(current.lastScrollTop ?? 0);
    const prevCharOffset = Math.round(current.lastCharOffset ?? 0);
    const prevProgress = Math.round((current.readProgress ?? 0) * 1000) / 1000;
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
    const nextAnchor = current.content
      ? extractReadAnchorText(current.content, nextCharOffset) || current.readAnchorText
      : current.readAnchorText;
    const nextDocs = docsRef.current.map((d) =>
      d.id === docId
        ? {
            ...d,
            lastMode: state.mode,
            lastScrollTop: nextScroll,
            lastCharOffset: nextCharOffset,
            readProgress: nextProgress,
            readAnchorText: nextAnchor,
            lastReadAt: now,
            updatedAt: now,
          }
        : d
    );
    docsRef.current = nextDocs;
    setDocs(nextDocs);
    setFoldersDirty(true);
    autoProgressDirtyRef.current = true;
    autoMutationSeqRef.current++;
  };

  const handleOpenDoc = (docId: string) => {
    const target = docsRef.current.find((d) => d.id === docId);
    const nextTarget: TreeSelection = { kind: 'doc', id: docId };
    captureAndSaveTreeState(nextTarget);
    setActiveTarget(nextTarget);
    setSelectedDocId(docId);
    setLiveReadProgress(target?.readProgress ?? 0);
    setLiveProgressDecimals(0);
    setVisibleNoteIds([]);
    setNotePopoverState(null);
    setShowNotesListModal(false);
    // Plan B: clear session dismissal on book open so any unresolved pending progress prompts cleanly
    setDismissedConflictKeys((prev) => {
      if (!prev[docId]) return prev;
      const next = { ...prev };
      delete next[docId];
      return next;
    });
    setMainView('doc');
    // Pull any newer reading progress / directory changes silently (304 = 0 bytes if unchanged)
    void runSilentAutoSyncRef.current({ forcePullCheck: true });
  };

  const getConflictSnapshotKey = (doc: ArticleDoc): string => {
    const p = doc.pendingRemoteProgress;
    if (!p) return '';
    return `${Math.round(p.lastCharOffset)}:${Math.round(p.readProgress * 1000)}:${p.lastReadAt}:${p.source}`;
  };

  const wifiConflictDocs = useMemo(() => {
    if (mainView !== 'tree') return [];
    return docs.filter(
      (d) =>
        !d.deleted &&
        d.pendingRemoteProgress?.source === 'wifi' &&
        dismissedConflictKeys[d.id] !== getConflictSnapshotKey(d)
    );
  }, [mainView, docs, dismissedConflictKeys]);

  const hasPendingWifiConflicts = wifiConflictDocs.length > 0;

  useEffect(() => {
    if (wifiConflictDocs.length === 0) {
      setWifiConflictBatchTotal(0);
    } else if (wifiConflictDocs.length > wifiConflictBatchTotal) {
      setWifiConflictBatchTotal(wifiConflictDocs.length);
    }
  }, [wifiConflictDocs.length, wifiConflictBatchTotal]);

  const scheduleWifiPushAfterResolution = (
    nextDocs: ArticleDoc[],
    nextDismissed: Record<string, string>
  ) => {
    wifiLastSyncedPairRef.current.clear();
    if (wifiResolutionPushTimerRef.current !== null) {
      window.clearTimeout(wifiResolutionPushTimerRef.current);
      wifiResolutionPushTimerRef.current = null;
    }

    // Wait until the user resolves all queued Wi-Fi conflicts before pushing in one clean round-trip
    const remainingWifiConflicts = nextDocs.filter(
      (d) =>
        !d.deleted &&
        d.pendingRemoteProgress?.source === 'wifi' &&
        nextDismissed[d.id] !== getConflictSnapshotKey(d)
    );
    if (remainingWifiConflicts.length > 0 || mainViewRef.current !== 'tree') {
      return;
    }

    // Fallback direct push for the non-leader (host) device if the leader hasn't already initiated sync
    wifiResolutionPushTimerRef.current = window.setTimeout(() => {
      wifiResolutionPushTimerRef.current = null;
      if (
        !appMountedRef.current ||
        mainViewRef.current !== 'tree' ||
        wifiAutoSyncingRef.current ||
        wifiQuickBubbleRef.current?.status === 'syncing'
      ) {
        return;
      }
      const password = (webDavConfigRef.current.encryptionPassword || '').trim();
      const myInfo = wifiServerInfoRef.current;
      const peer = wifiPeersRef.current[0];
      if (!password || !myInfo?.running || !peer) {
        triggerPostWifiCloudSyncRef.current(true, false);
        return;
      }
      // Leader automatically syncs via effect once fingerprint updates; non-leader pushes directly
      if (myInfo.instanceId < peer.id) return;

      const pushToPeer = async () => {
        wifiAutoSyncingRef.current = true;
        if (wifiBubbleTimerRef.current !== null) {
          window.clearTimeout(wifiBubbleTimerRef.current);
          wifiBubbleTimerRef.current = null;
        }
        setWifiQuickBubble({ status: 'syncing' });
        try {
          const summary = await runWifiBidirectionalSync({
            host: peer.ip,
            port: peer.port,
            password,
            storageDir: storageDirRef.current,
            getLocalState: () => wifiCallbacksRef.current.getLocalState(),
            applyMergedCatalog: (...args) => wifiCallbacksRef.current.applyMergedCatalog(...args),
            applyReceivedDocBody: (payload) =>
              wifiCallbacksRef.current.applyReceivedDocBody(payload),
          });
          setWifiImageVersion((v) => v + 1);
          const stillHasWifiConflict = docsRef.current.some(
            (d) => !d.deleted && d.pendingRemoteProgress?.source === 'wifi'
          );
          if (appMountedRef.current && mainViewRef.current === 'tree') {
            if (stillHasWifiConflict) {
              setWifiQuickBubble(null);
            } else {
              setWifiQuickBubble({ status: 'done', text: '同步完成' });
              scheduleHideWifiBubble(TOOLBAR_TOAST_DURATION_MS);
            }
          }
          if (!stillHasWifiConflict) {
            triggerPostWifiCloudSyncRef.current(true, summary.peerCloudConfigured);
          }
        } catch {
          if (appMountedRef.current && mainViewRef.current === 'tree') {
            setWifiQuickBubble(null);
          }
          const stillHasWifiConflict = docsRef.current.some(
            (d) => !d.deleted && d.pendingRemoteProgress?.source === 'wifi'
          );
          if (!stillHasWifiConflict) {
            triggerPostWifiCloudSyncRef.current(true, false);
          }
        } finally {
          wifiAutoSyncingRef.current = false;
        }
      };
      void pushToPeer();
    }, 650);
  };

  const handleAcceptRemoteProgress = (docId: string) => {
    const target = docsRef.current.find((d) => d.id === docId);
    const pending = target?.pendingRemoteProgress;
    if (!target || !pending) return;

    const relocated = target.content
      ? relocateCharOffsetByAnchor(target.content, pending.lastCharOffset, pending.anchorText)
      : null;
    const finalOffset = relocated?.matched
      ? relocated.offset
      : Math.max(0, Math.round(pending.lastCharOffset));
    const finalProgress = target.content
      ? resolveComparableProgressPercent(
          target.content.length,
          finalOffset,
          pending.readProgress,
          true
        )
      : pending.readProgress;
    const finalAnchor =
      (target.content ? extractReadAnchorText(target.content, finalOffset) : '') ||
      pending.anchorText ||
      target.readAnchorText;
    const resolvedOverrideAt =
      pending.source === 'wifi'
        ? Math.max(
            Date.now(),
            (pending.lastReadAt || 0) + 1000,
            (target.lastReadAt || 0) + 1000,
            (target.progressOverrideAt || 0) + 1
          )
        : target.progressOverrideAt;

    const nextDocs = docsRef.current.map((d) =>
      d.id === docId
        ? {
            ...d,
            readProgress: finalProgress,
            lastCharOffset: finalOffset,
            lastScrollTop: relocated?.matched ? 0 : Math.max(0, Math.round(pending.lastScrollTop)),
            lastMode: pending.lastMode ?? d.lastMode ?? 'read',
            lastReadAt: pending.lastReadAt || Date.now(),
            readAnchorText: finalAnchor || undefined,
            lastSyncedCharOffset: Math.max(0, Math.round(pending.lastCharOffset)),
            lastSyncedProgress: pending.readProgress,
            lastSyncedReadAt: pending.lastReadAt,
            progressOverrideAt: resolvedOverrideAt,
            pendingRemoteProgress: null,
          }
        : d
    );
    docsRef.current = nextDocs;
    setDocs(nextDocs);
    const nextDismissed = { ...dismissedConflictKeys };
    delete nextDismissed[docId];
    setDismissedConflictKeys(nextDismissed);
    if (selectedDocIdRef.current === docId) {
      setLiveReadProgress(finalProgress);
    }
    if (mainViewRef.current === 'doc' && selectedDocIdRef.current === docId) {
      docViewRef.current?.jumpToCharOffset(finalOffset);
    }
    if (pending.source === 'wifi') {
      autoProgressDirtyRef.current = true;
      autoMutationSeqRef.current++;
      wifiCloudSyncNeededRef.current = true;
      scheduleWifiPushAfterResolution(nextDocs, nextDismissed);
    }
    showToast(pending.source === 'wifi' ? '已采用对端阅读进度' : '已同步至云端阅读进度');
  };

  const handleKeepLocalProgress = (docId: string) => {
    const target = docsRef.current.find((d) => d.id === docId);
    const pending = target?.pendingRemoteProgress;
    if (!target || !pending) return;

    // Flush the very latest viewport position so recent page turns aren't lost
    let localOffset = Math.max(0, Math.round(target.lastCharOffset ?? 0));
    let localProgress = target.readProgress ?? 0;
    let localScrollTop = Math.max(0, Math.round(target.lastScrollTop ?? 0));
    if (mainViewRef.current === 'doc' && selectedDocIdRef.current === docId && docViewRef.current) {
      const live = docViewRef.current.flushAndCaptureViewState();
      localOffset = Math.max(0, Math.round(live.charOffset));
      localProgress = Math.min(100, Math.max(0, Math.round(live.readProgress * 1000) / 1000));
      localScrollTop = Math.max(0, Math.round(live.scrollTop));
    }

    const overrideTs = Math.max(
      Date.now(),
      (pending.lastReadAt || 0) + 1000,
      (target.lastReadAt || 0) + 1000,
      (target.progressOverrideAt || 0) + 1
    );
    const localAnchor = target.content
      ? extractReadAnchorText(target.content, localOffset) || target.readAnchorText
      : target.readAnchorText;

    const nextDocs = docsRef.current.map((d) =>
      d.id === docId
        ? {
            ...d,
            readProgress: localProgress,
            lastCharOffset: localOffset,
            lastScrollTop: localScrollTop,
            readAnchorText: localAnchor,
            lastReadAt: overrideTs,
            updatedAt: Math.max(d.updatedAt, overrideTs),
            progressOverrideAt: overrideTs,
            // Acknowledge rejected remote snapshot as baseline so next sync pushes local cleanly even if offline right now
            lastSyncedCharOffset: Math.max(0, Math.round(pending.lastCharOffset)),
            lastSyncedProgress: pending.readProgress,
            lastSyncedReadAt: pending.lastReadAt,
            pendingRemoteProgress: null,
          }
        : d
    );
    docsRef.current = nextDocs;
    setDocs(nextDocs);
    const nextDismissed = { ...dismissedConflictKeys };
    delete nextDismissed[docId];
    setDismissedConflictKeys(nextDismissed);
    setFoldersDirty(true);
    autoProgressDirtyRef.current = true;
    autoMutationSeqRef.current++;
    if (pending.source === 'wifi') {
      wifiCloudSyncNeededRef.current = true;
      scheduleWifiPushAfterResolution(nextDocs, nextDismissed);
    } else {
      void runSilentAutoSyncRef.current({ bypassThrottle: true });
    }
    showToast(pending.source === 'wifi' ? '已保留本机进度并覆盖对端' : '已保留本机进度并覆盖云端');
  };

  const handleDismissProgressConflict = (doc: ArticleDoc) => {
    const key = getConflictSnapshotKey(doc);
    if (!key) return;
    setDismissedConflictKeys((prev) => ({ ...prev, [doc.id]: key }));
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
    setNotePopoverState(null);
    setShowNotesListModal(false);
    setVisibleNoteIds([]);
    setWhistleEnabled(false);
    setMainView('tree');
    if (autoProgressDirtyRef.current || autoCatalogDirtyRef.current) {
      void runSilentAutoSyncRef.current({ bypassThrottle: true });
    }
  };

  const handleSaveReadingNote = (payload: {
    noteId: string | null;
    charOffset: number;
    anchorText: string;
    content: string;
  }) => {
    const docId = selectedDocIdRef.current;
    if (!docId) return;
    const now = Date.now();
    const trimmed = payload.content.trim();

    let changed = false;
    const nextDocs = docsRef.current.map((doc) => {
      if (doc.id !== docId) return doc;
      const existing = sanitizeNotesList(doc.notes) ?? [];

      if (payload.noteId) {
        const idx = existing.findIndex((n) => n.id === payload.noteId);
        if (idx === -1) {
          if (!trimmed) return doc;
          const created: ReadingNote = {
            id: payload.noteId,
            charOffset: Math.max(0, Math.round(payload.charOffset)),
            anchorText: payload.anchorText.trim(),
            content: trimmed,
            createdAt: now,
            updatedAt: now,
          };
          changed = true;
          return { ...doc, notes: sanitizeNotesList([...existing, created]) };
        }
        const prevNote = existing[idx];
        if (!trimmed) {
          // Emptying an existing note soft-deletes it so sync propagates cleanly
          const updated: ReadingNote = {
            ...prevNote,
            deleted: true,
            deletedAt: now,
            updatedAt: now,
          };
          const nextNotes = [...existing];
          nextNotes[idx] = updated;
          changed = true;
          return { ...doc, notes: sanitizeNotesList(nextNotes) };
        }
        if (prevNote.content === trimmed && !prevNote.deleted) return doc;
        const updated: ReadingNote = {
          ...prevNote,
          content: trimmed,
          updatedAt: now,
          deleted: undefined,
          deletedAt: undefined,
        };
        const nextNotes = [...existing];
        nextNotes[idx] = updated;
        changed = true;
        return { ...doc, notes: sanitizeNotesList(nextNotes) };
      }

      if (!trimmed) return doc;
      const created: ReadingNote = {
        id: `note-${now}-${Math.random().toString(36).slice(2, 8)}`,
        charOffset: Math.max(0, Math.round(payload.charOffset)),
        anchorText: payload.anchorText.trim(),
        content: trimmed,
        createdAt: now,
        updatedAt: now,
      };
      changed = true;
      return { ...doc, notes: sanitizeNotesList([...existing, created]) };
    });

    if (!changed) return;
    docsRef.current = nextDocs;
    setDocs(nextDocs);
    markAutoCatalogDirty();
  };

  const handleDeleteReadingNote = (noteId: string) => {
    const docId = selectedDocIdRef.current;
    if (!docId) return;
    const now = Date.now();
    let changed = false;
    const nextDocs = docsRef.current.map((doc) => {
      if (doc.id !== docId) return doc;
      const existing = sanitizeNotesList(doc.notes) ?? [];
      const idx = existing.findIndex((n) => n.id === noteId);
      if (idx === -1 || existing[idx].deleted) return doc;
      const nextNotes = [...existing];
      nextNotes[idx] = {
        ...existing[idx],
        deleted: true,
        deletedAt: now,
        updatedAt: now,
      };
      changed = true;
      return { ...doc, notes: sanitizeNotesList(nextNotes) };
    });
    if (!changed) return;
    docsRef.current = nextDocs;
    setDocs(nextDocs);
    markAutoCatalogDirty();
    showToast('已删除笔记');
  };

  const handleOpenNotePopover = () => {
    if (notePopoverState) {
      setNotePopoverState(null);
      return;
    }
    if (!selectedDoc) return;
    setShowFontSizeBar(false);
    setShowNotesListModal(false);
    setMdictLookup(null);

    const ctx = docViewRef.current?.captureNoteAnchorContext();
    const defaultAnchor: NoteAnchorTarget = ctx?.defaultAnchor ?? {
      charOffset: Math.max(0, Math.round(selectedDoc.lastCharOffset ?? 0)),
      anchorText: '',
    };
    const screenNoteIds = ctx?.screenNoteIds ?? [];
    const defaultAnchorHasNote = ctx?.defaultAnchorHasNote ?? false;

    setNotePopoverState({
      screenNoteIds,
      initialNoteId: screenNoteIds[0] ?? null,
      defaultAnchor,
      canCreateAtDefaultAnchor: !defaultAnchorHasNote,
    });
  };

  const handleOpenNoteFromMargin = (noteId: string) => {
    if (!selectedDoc) return;
    setShowFontSizeBar(false);
    setShowNotesListModal(false);
    setMdictLookup(null);

    const ctx = docViewRef.current?.captureNoteAnchorContext();
    const defaultAnchor: NoteAnchorTarget = ctx?.defaultAnchor ?? {
      charOffset: Math.max(0, Math.round(selectedDoc.lastCharOffset ?? 0)),
      anchorText: '',
    };
    const rawVisible = ctx?.screenNoteIds ?? [];
    const screenNoteIds = rawVisible.includes(noteId) ? rawVisible : [noteId, ...rawVisible];
    const defaultAnchorHasNote = ctx?.defaultAnchorHasNote ?? false;

    setNotePopoverState({
      screenNoteIds,
      initialNoteId: noteId,
      defaultAnchor,
      canCreateAtDefaultAnchor: !defaultAnchorHasNote,
    });
  };

  const handleOpenNotesListModal = () => {
    setShowFontSizeBar(false);
    setNotePopoverState(null);
    setMdictLookup(null);
    setShowNotesListModal(true);
  };

  const handleJumpToNoteFromList = (note: ReadingNote) => {
    setShowNotesListModal(false);
    docViewRef.current?.jumpToCharOffset(note.charOffset);
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

  const handleChangeWhistleSensitivity = (next: WhistleSensitivity) => {
    setWhistleSensitivity(next);
    const current = loadReaderSettings();
    saveReaderSettings({ ...current, whistleSensitivity: next });
  };

  const stopWhistleDetector = () => {
    if (whistleIdleTimerRef.current !== null) {
      window.clearTimeout(whistleIdleTimerRef.current);
      whistleIdleTimerRef.current = null;
    }
    if (whistleDetectorRef.current) {
      whistleDetectorRef.current.stop();
      whistleDetectorRef.current = null;
    }
  };

  const resetWhistleIdleTimer = () => {
    if (whistleIdleTimerRef.current !== null) {
      window.clearTimeout(whistleIdleTimerRef.current);
    }
    // Auto-stop after 15 minutes of inactivity to conserve battery
    whistleIdleTimerRef.current = window.setTimeout(() => {
      stopWhistleDetector();
      setWhistleEnabled(false);
      showToast('声控翻页长时间未使用，已自动关闭');
    }, 15 * 60 * 1000);
  };

  const handleToggleWhistlePageTurn = async () => {
    if (whistleStarting) return;
    if (whistleEnabled) {
      stopWhistleDetector();
      setWhistleEnabled(false);
      showToast('已关闭', 1200);
      return;
    }

    setWhistleStarting(true);
    const detector = new WhistleDetector({
      sensitivity: whistleSensitivity,
      onWhistle: () => {
        resetWhistleIdleTimer();
        docViewRef.current?.turnPageDown();
      },
    });
    whistleDetectorRef.current = detector;

    try {
      await detector.start();
      if (whistleDetectorRef.current === detector) {
        setWhistleEnabled(true);
        resetWhistleIdleTimer();
        showToast('吹口哨翻下一页', 1200);
      } else {
        detector.stop();
      }
    } catch (err) {
      if (whistleDetectorRef.current === detector) {
        whistleDetectorRef.current = null;
      }
      setWhistleEnabled(false);
      showToast(formatMicErrorMessage(err));
    } finally {
      setWhistleStarting(false);
    }
  };

  useEffect(() => {
    if (whistleDetectorRef.current) {
      whistleDetectorRef.current.setSensitivity(whistleSensitivity);
    }
  }, [whistleSensitivity]);

  // Release microphone automatically when leaving doc view, opening modals, or backgrounding app
  useEffect(() => {
    if (!whistleEnabled) {
      stopWhistleDetector();
      return;
    }
    if (
      mainView !== 'doc' ||
      showSyncModal ||
      showImportModal ||
      showTrashModal ||
      showStorageFolderModal
    ) {
      stopWhistleDetector();
      setWhistleEnabled(false);
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopWhistleDetector();
        setWhistleEnabled(false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    whistleEnabled,
    mainView,
    showSyncModal,
    showImportModal,
    showTrashModal,
    showStorageFolderModal,
  ]);

  useEffect(() => {
    return () => {
      stopWhistleDetector();
    };
  }, []);

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

  // Batch Import .txt / .md / ebook / pasted text (defaults to .txt storage format, silently deduplicates)
  const handleImportDocs = async (
    items: Array<{
      title: string;
      content: string;
      folderId: string | null;
      format?: 'txt' | 'md';
      images?: ExtractedEbookImage[];
    }>
  ) => {
    const now = Date.now();
    const maxOrder = docsRef.current.reduce((m, d) => Math.max(m, d.order), -1);
    const created: ArticleDoc[] = [];
    let totalSavedImages = 0;
    let totalFailedImages = 0;
    let imageTarget: 'local-fs' | 'browser-cache' = 'local-fs';

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.folderId === INBOX_FOLDER_ID) continue;

      if (item.images && item.images.length > 0) {
        const res = await saveLocalImageFiles(item.images, storageDirRef.current);
        totalSavedImages += res.savedCount;
        totalFailedImages += res.failedCount;
        imageTarget = res.target;
      }

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
      markAutoCatalogDirty();
    }

    if (totalSavedImages > 0) {
      const destLabel =
        imageTarget === 'local-fs' ? '本地 images/ 文件夹' : '浏览器本地缓存';
      showToast(
        totalFailedImages > 0
          ? `已提取 ${totalSavedImages} 张插图至${destLabel}（${totalFailedImages} 张写入失败）`
          : `已提取 ${totalSavedImages} 张插图至${destLabel}（不占坚果云流量）`
      );
    } else if (totalFailedImages > 0) {
      showToast(`文档已导入，但 ${totalFailedImages} 张插图写入本地失败`);
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

    webDavConfigRef.current = nextConfig;
    setWebDavConfig(nextConfig);
    setFoldersDirty(true);
    autoSyncFailCountRef.current = 0;
    autoSyncBackoffUntilRef.current = 0;
    lastAuthErrorKeyRef.current = '';

    if (encChanged) {
      const now = Date.now();
      const nextDocs = docsRef.current.map((d) =>
        d.encrypted && !d.deleted && !isDocBodyMissing(d)
          ? { ...d, updatedAt: now, syncStatus: 'dirty' as const, cloudBodySynced: false }
          : d
      );
      docsRef.current = nextDocs;
      setDocs(nextDocs);
    }

    if (nextConfig.username.trim() && nextConfig.password.trim()) {
      autoCatalogDirtyRef.current = true;
      autoMutationSeqRef.current++;
      void runSilentAutoSyncRef
        .current({ forcePullCheck: true, bypassThrottle: true })
        .then((res) => {
          if (!appMountedRef.current) return;
          if (res.status === 'auth-error') {
            showToast('坚果云账号或应用密码错误，请检查设置');
          } else if (res.status === 'ok' && res.oversizedInboxCount > 0) {
            lastOversizedInboxNoticeAtRef.current = Date.now();
            showToast(
              `inbox 有 ${res.oversizedInboxCount} 个文件超过 200 KB，请改用 Wi-Fi 或电脑直连`
            );
          }
        });
    }
  };

  const handleToggleLanDirect = async (next: boolean) => {
    setLanLoading(true);
    try {
      if (next) {
        const res = await startLanDirectServer(
          activeFolders,
          docs,
          webDavConfigRef.current.encryptionPassword || ''
        );
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

  const runSilentAutoSync = async (options?: {
    forcePullCheck?: boolean;
    bypassThrottle?: boolean;
    isManual?: boolean;
  }): Promise<SilentAutoSyncResult> => {
    const cfg = webDavConfigRef.current;
    if (!cfg.username.trim() || !cfg.password.trim()) return { status: 'skipped' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { status: 'offline' };
    }
    if (activeAutoSyncPromiseRef.current) return { status: 'skipped' };
    // Pause background WebDAV sync while user is resolving Wi-Fi progress conflicts in Directory Mode
    if (
      mainViewRef.current === 'tree' &&
      docsRef.current.some((d) => !d.deleted && d.pendingRemoteProgress?.source === 'wifi')
    ) {
      return { status: 'skipped' };
    }

    const now = Date.now();
    if (now < autoSyncBackoffUntilRef.current) return { status: 'skipped' };

    const hasLocalChanges = autoProgressDirtyRef.current || autoCatalogDirtyRef.current;
    if (!hasLocalChanges && !options?.forcePullCheck) return { status: 'skipped' };

    if (
      !hasLocalChanges &&
      !options?.bypassThrottle &&
      now - lastAutoPullAtRef.current < AUTO_PULL_COOLDOWN_MS
    ) {
      return { status: 'skipped' };
    }

    const seqBefore = autoMutationSeqRef.current;
    const prevLiveDocIds = new Set(
      docsRef.current.filter((d) => !d.deleted).map((d) => d.id)
    );
    const currentTreeScroll =
      mainViewRef.current === 'tree'
        ? treeViewRef.current?.getScrollTop() ?? treeScrollTopRef.current
        : treeScrollTopRef.current;
    const localTreeState: SyncedTreeState = {
      collapsedIds: collapsedFolderIdsRef.current,
      activeTarget: activeTargetRef.current,
      scrollTop: currentTreeScroll,
      updatedAt: treeStateUpdatedAtRef.current,
    };

    const task = (async (): Promise<SilentAutoSyncResult> => {
      try {
        const outcome = await runAutoMetadataProgressSync(
          cfg,
          foldersRef.current,
          docsRef.current,
          localTreeState,
          hasLocalChanges,
          purgedRecordsRef.current
        );
        applyQuotaDelta(outcome.quotaDelta);

        if (outcome.authFailed) {
          const stepIdx = Math.min(
            autoSyncFailCountRef.current,
            AUTO_SYNC_BACKOFF_STEPS_MS.length - 1
          );
          autoSyncFailCountRef.current++;
          autoSyncBackoffUntilRef.current = Date.now() + AUTO_SYNC_BACKOFF_STEPS_MS[stepIdx];
          const credKey = `${cfg.baseUrl}|${cfg.username.trim()}|${cfg.password.trim()}`;
          if (!options?.isManual && lastAuthErrorKeyRef.current !== credKey) {
            lastAuthErrorKeyRef.current = credKey;
            showToast('坚果云账号或应用密码错误，请检查设置');
          }
          return { status: 'auth-error' };
        }

        if (outcome.wasRateLimited) {
          const stepIdx = Math.min(
            autoSyncFailCountRef.current,
            AUTO_SYNC_BACKOFF_STEPS_MS.length - 1
          );
          autoSyncFailCountRef.current++;
          autoSyncBackoffUntilRef.current = Date.now() + AUTO_SYNC_BACKOFF_STEPS_MS[stepIdx];
          return { status: 'rate-limited' };
        }

        autoSyncFailCountRef.current = 0;
        autoSyncBackoffUntilRef.current = 0;
        lastAuthErrorKeyRef.current = '';
        lastAutoPullAtRef.current = Date.now();

        setWebDavConfig((prev) => ({
          ...prev,
          syncShortDocsViaCloud: outcome.config.syncShortDocsViaCloud,
          settingsUpdatedAt: outcome.config.settingsUpdatedAt,
          lastAutoManifestEtag: outcome.config.lastAutoManifestEtag,
          lastSyncedAt: outcome.config.lastSyncedAt ?? prev.lastSyncedAt,
        }));

        const noConcurrentMutation = autoMutationSeqRef.current === seqBefore;

        if (outcome.didPull) {
          if (noConcurrentMutation) {
            setFolders(outcome.folders.map((f) => ({ ...f, parentId: null })));
          } else {
            const outcomeFolderMap = new Map(
              outcome.folders.map((f) => [f.id, { ...f, parentId: null }])
            );
            setFolders((prev) => {
              const merged = new Map<string, FolderNode>();
              for (const f of prev) merged.set(f.id, f);
              for (const [id, rf] of outcomeFolderMap) {
                const lf = merged.get(id);
                if (!lf || rf.updatedAt > lf.updatedAt) {
                  merged.set(id, rf);
                }
              }
              return Array.from(merged.values());
            });
          }

          if (outcome.treeState.updatedAt > treeStateUpdatedAtRef.current) {
            setCollapsedFolderIds(outcome.treeState.collapsedIds);
            setActiveTarget(outcome.treeState.activeTarget);
            setTreeScrollTop(outcome.treeState.scrollTop);
            setTreeStateUpdatedAt(outcome.treeState.updatedAt);
          }
        }

        if (outcome.didPull || outcome.didPush) {
          const outcomeDocMap = new Map(outcome.docs.map((d) => [d.id, d]));
          if (noConcurrentMutation) {
            setDocs((prev) => {
              const prevMap = new Map(prev.map((d) => [d.id, d]));
              const nextList = outcome.docs.map((next) => {
                const curr = prevMap.get(next.id);
                if (curr?.pendingRemoteProgress?.source === 'wifi') {
                  return {
                    ...next,
                    readProgress: curr.readProgress,
                    lastCharOffset: curr.lastCharOffset,
                    lastScrollTop: curr.lastScrollTop,
                    lastMode: curr.lastMode,
                    lastReadAt: curr.lastReadAt,
                    readAnchorText: curr.readAnchorText,
                    progressOverrideAt: curr.progressOverrideAt,
                    pendingRemoteProgress: curr.pendingRemoteProgress,
                  };
                }
                return next;
              });
              docsRef.current = nextList;
              return nextList;
            });
          } else {
            setDocs((prev) => {
              const seenIds = new Set<string>();
              const updatedExisting = prev.map((curr) => {
                seenIds.add(curr.id);
                const next = outcomeDocMap.get(curr.id);
                if (!next) return curr;
                const currOverrideTs = curr.progressOverrideAt ?? 0;
                const nextOverrideTs = next.progressOverrideAt ?? 0;
                const keepWifiConflict =
                  curr.pendingRemoteProgress?.source === 'wifi' ||
                  currOverrideTs > nextOverrideTs;
                const currProgressTs = curr.lastReadAt ?? 0;
                const nextProgressTs = next.lastReadAt ?? 0;
                const useNextProgress =
                  !keepWifiConflict &&
                  (nextOverrideTs > currOverrideTs || nextProgressTs > currProgressTs);
                const useNextCatalog = next.updatedAt > curr.updatedAt;
                const downloadedBody =
                  curr.syncStatus === 'remote-only' && !curr.content && Boolean(next.content);
                const cloudFlagChanged = Boolean(next.cloudBodySynced) !== Boolean(curr.cloudBodySynced);
                const pendingChanged =
                  !keepWifiConflict &&
                  ((next.pendingRemoteProgress?.lastCharOffset ?? -1) !==
                    (curr.pendingRemoteProgress?.lastCharOffset ?? -1) ||
                    (next.pendingRemoteProgress?.lastReadAt ?? -1) !==
                      (curr.pendingRemoteProgress?.lastReadAt ?? -1) ||
                    (next.pendingRemoteProgress?.source ?? '') !==
                      (curr.pendingRemoteProgress?.source ?? ''));
                const baselineChanged =
                  !keepWifiConflict &&
                  (next.lastSyncedCharOffset !== curr.lastSyncedCharOffset ||
                    next.lastSyncedProgress !== curr.lastSyncedProgress);
                if (
                  !useNextProgress &&
                  !useNextCatalog &&
                  !downloadedBody &&
                  !cloudFlagChanged &&
                  !pendingChanged &&
                  !baselineChanged
                ) {
                  return curr;
                }
                return {
                  ...curr,
                  cloudBodySynced: Boolean(next.cloudBodySynced),
                  ...(pendingChanged
                    ? { pendingRemoteProgress: next.pendingRemoteProgress ?? null }
                    : {}),
                  ...(baselineChanged
                    ? {
                        lastSyncedCharOffset: next.lastSyncedCharOffset,
                        lastSyncedProgress: next.lastSyncedProgress,
                        lastSyncedReadAt: next.lastSyncedReadAt,
                      }
                    : {}),
                  ...(downloadedBody
                    ? {
                        content: next.content,
                        contentHash: next.contentHash,
                        byteSize: next.byteSize,
                        excerpt: next.excerpt,
                        syncStatus: next.syncStatus,
                      }
                    : {}),
                  ...(useNextCatalog
                    ? {
                        title: next.title,
                        folderId: next.folderId,
                        order: next.order,
                        starred: next.starred,
                        tags: next.tags,
                        deleted: next.deleted,
                        deletedAt: next.deletedAt,
                        deletedByFolderId: next.deletedByFolderId,
                        updatedAt: next.updatedAt,
                        syncStatus: next.syncStatus,
                      }
                    : {}),
                  ...(useNextProgress
                    ? {
                        readProgress: next.readProgress,
                        lastCharOffset: next.lastCharOffset,
                        lastScrollTop: next.lastScrollTop,
                        lastMode: next.lastMode,
                        lastReadAt: next.lastReadAt,
                        readAnchorText: next.readAnchorText ?? curr.readAnchorText,
                        progressOverrideAt: next.progressOverrideAt ?? curr.progressOverrideAt,
                      }
                    : {}),
                };
              });
              // Option A: append newly discovered remote catalog docs not yet present locally
              const addedRemote = outcome.docs.filter((d) => !seenIds.has(d.id));
              const nextList =
                addedRemote.length > 0 ? [...updatedExisting, ...addedRemote] : updatedExisting;
              docsRef.current = nextList;
              return nextList;
            });
          }

          const openDocId = selectedDocIdRef.current;
          if (
            mainViewRef.current === 'doc' &&
            openDocId &&
            Object.prototype.hasOwnProperty.call(outcome.pulledProgressDocIds, openDocId) &&
            noConcurrentMutation
          ) {
            const pulledOffset = outcome.pulledProgressDocIds[openDocId];
            const pulledDoc = outcomeDocMap.get(openDocId);
            if (pulledDoc) {
              setLiveReadProgress(pulledDoc.readProgress);
            }
            docViewRef.current?.jumpToCharOffset(pulledOffset);
          }
        }

        if (noConcurrentMutation) {
          autoProgressDirtyRef.current = false;
          autoCatalogDirtyRef.current = false;
          setFoldersDirty(false);
          if (outcome.purgedSynced) {
            setPurgedRecords({ docs: {}, docFormats: {}, folders: {} });
          }
        }
        const addedDocsCount = outcome.didPull
          ? outcome.docs.filter((d) => !d.deleted && !prevLiveDocIds.has(d.id)).length
          : 0;
        const oversizedInboxCount = outcome.oversizedInboxCount ?? 0;
        if (
          !options?.isManual &&
          oversizedInboxCount > 0 &&
          mainViewRef.current === 'tree' &&
          Date.now() - lastOversizedInboxNoticeAtRef.current > 10 * 60 * 1000
        ) {
          lastOversizedInboxNoticeAtRef.current = Date.now();
          showToast(`inbox 有 ${oversizedInboxCount} 个文件超过 200 KB，请改用 Wi-Fi 或电脑直连`);
        }
        return {
          status: 'ok',
          didPull: outcome.didPull,
          didPush: outcome.didPush,
          addedDocsCount,
          oversizedInboxCount,
        };
      } catch {
        // Silent exponential backoff on network/transient errors — never interrupt reading
        const stepIdx = Math.min(
          autoSyncFailCountRef.current,
          AUTO_SYNC_BACKOFF_STEPS_MS.length - 1
        );
        autoSyncFailCountRef.current++;
        autoSyncBackoffUntilRef.current = Date.now() + AUTO_SYNC_BACKOFF_STEPS_MS[stepIdx];
        return { status: 'error' };
      } finally {
        activeAutoSyncPromiseRef.current = null;
      }
    })();

    activeAutoSyncPromiseRef.current = task;
    return await task;
  };

  const runSilentAutoSyncRef = useRef(runSilentAutoSync);
  runSilentAutoSyncRef.current = runSilentAutoSync;

  const markAutoCatalogDirty = (triggerDebounce = true) => {
    autoCatalogDirtyRef.current = true;
    autoMutationSeqRef.current++;
    if (!triggerDebounce) return;
    const cfg = webDavConfigRef.current;
    if (!cfg.username.trim() || !cfg.password.trim()) return;
    if (autoCatalogDebounceTimerRef.current !== null) {
      window.clearTimeout(autoCatalogDebounceTimerRef.current);
    }
    autoCatalogDebounceTimerRef.current = window.setTimeout(() => {
      autoCatalogDebounceTimerRef.current = null;
      if (autoCatalogDirtyRef.current || autoProgressDirtyRef.current) {
        void runSilentAutoSyncRef.current({ bypassThrottle: true });
      }
    }, AUTO_CATALOG_DEBOUNCE_MS);
  };

  // Auto-sync Trigger 1: Every 60 seconds while reading (0 requests if no page turn/change occurred)
  const webDavConfigured = Boolean(webDavConfig.username.trim() && webDavConfig.password.trim());
  useEffect(() => {
    if (!webDavConfigured || mainView !== 'doc') return;
    const timer = window.setInterval(() => {
      const openDocId = selectedDocIdRef.current;
      if (openDocId && docViewRef.current) {
        const captured = docViewRef.current.flushAndCaptureViewState();
        handleUpdateDocViewState(openDocId, captured);
      }
      if (autoProgressDirtyRef.current || autoCatalogDirtyRef.current) {
        void runSilentAutoSyncRef.current({ bypassThrottle: true });
      }
    }, AUTO_PROGRESS_SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [webDavConfigured, mainView]);

  // Auto-sync Trigger 1b (Plan A): While staying in Directory Mode in foreground,
  // poll Jianguoyun cloud & inbox every 45s (stops immediately in Reading Mode, background, or offline).
  useEffect(() => {
    if (!webDavConfigured || mainView !== 'tree') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void runSilentAutoSyncRef.current({ forcePullCheck: true });
    }, AUTO_TREE_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [webDavConfigured, mainView]);

  // Plan B: Pull-to-refresh in Directory Mode for instant on-demand cloud & inbox sync
  const handleTreePullRefresh = async () => {
    const cfg = webDavConfigRef.current;
    if (!cfg.username.trim() || !cfg.password.trim()) {
      showToast('请先在设置中配置坚果云');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showToast('当前无网络连接');
      return;
    }
    if (treePullRefreshingRef.current) return;
    treePullRefreshingRef.current = true;
    setTreePullRefreshing(true);
    try {
      let res: SilentAutoSyncResult;
      const inFlight = activeAutoSyncPromiseRef.current
        ? await activeAutoSyncPromiseRef.current.catch(() => null)
        : null;
      if (
        inFlight &&
        inFlight.status === 'ok' &&
        (inFlight.addedDocsCount > 0 || inFlight.didPull || inFlight.oversizedInboxCount > 0)
      ) {
        res = inFlight;
      } else {
        autoSyncBackoffUntilRef.current = 0;
        res = await runSilentAutoSyncRef.current({
          forcePullCheck: true,
          bypassThrottle: true,
          isManual: true,
        });
      }
      if (!appMountedRef.current) return;
      if (res.status === 'ok') {
        if (res.oversizedInboxCount > 0) {
          lastOversizedInboxNoticeAtRef.current = Date.now();
          showToast(
            res.addedDocsCount > 0
              ? `新增 ${res.addedDocsCount} 篇，另有 ${res.oversizedInboxCount} 个 inbox 文件超 200 KB`
              : `inbox 有 ${res.oversizedInboxCount} 个文件超过 200 KB，请改用 Wi-Fi 或电脑直连`
          );
        } else if (res.addedDocsCount > 0) {
          showToast(`已同步，新增 ${res.addedDocsCount} 篇文档`);
        } else if (res.didPull || res.didPush) {
          showToast('已同步云端');
        } else {
          showToast('已是最新');
        }
      } else if (res.status === 'offline') {
        showToast('当前无网络连接');
      } else if (res.status === 'auth-error') {
        showToast('坚果云账号或应用密码错误，请检查设置');
      } else if (res.status === 'rate-limited') {
        showToast('云端请求频繁，请稍后再试');
      } else if (res.status === 'error') {
        showToast('同步失败，请检查网络');
      }
    } finally {
      treePullRefreshingRef.current = false;
      if (appMountedRef.current) {
        setTreePullRefreshing(false);
      }
    }
  };

  // Auto-sync Trigger 2: Startup light pull + foreground/background lifecycle sync
  useEffect(() => {
    if (!webDavConfigured) return;
    void runSilentAutoSyncRef.current({ forcePullCheck: true });

    const flushAndPushIfDirty = () => {
      if (mainViewRef.current === 'doc' && selectedDocIdRef.current && docViewRef.current) {
        const captured = docViewRef.current.flushAndCaptureViewState();
        handleUpdateDocViewState(selectedDocIdRef.current, captured);
      }
      if (autoProgressDirtyRef.current || autoCatalogDirtyRef.current) {
        void runSilentAutoSyncRef.current({ bypassThrottle: true });
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushAndPushIfDirty();
      } else if (document.visibilityState === 'visible') {
        void runSilentAutoSyncRef.current({ forcePullCheck: true });
      }
    };

    const onOnline = () => {
      if (mainViewRef.current === 'doc' && selectedDocIdRef.current && docViewRef.current) {
        const captured = docViewRef.current.flushAndCaptureViewState();
        handleUpdateDocViewState(selectedDocIdRef.current, captured);
      }
      autoSyncBackoffUntilRef.current = 0;
      void runSilentAutoSyncRef.current({ forcePullCheck: true, bypassThrottle: true });
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flushAndPushIfDirty);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flushAndPushIfDirty);
      window.removeEventListener('online', onOnline);
    };
  }, [webDavConfigured]);

  useEffect(() => {
    return () => {
      if (autoCatalogDebounceTimerRef.current !== null) {
        window.clearTimeout(autoCatalogDebounceTimerRef.current);
        autoCatalogDebounceTimerRef.current = null;
      }
    };
  }, []);

  const getWifiLocalState = () => {
    const currentTreeScroll =
      mainViewRef.current === 'tree'
        ? treeViewRef.current?.getScrollTop() ?? treeScrollTopRef.current
        : treeScrollTopRef.current;
    const cfg = webDavConfigRef.current;
    return {
      folders: foldersRef.current,
      docs: docsRef.current,
      treeState: {
        collapsedIds: collapsedFolderIdsRef.current,
        activeTarget: activeTargetRef.current,
        scrollTop: currentTreeScroll,
        updatedAt: treeStateUpdatedAtRef.current,
      },
      purgedRecords: purgedRecordsRef.current,
      cloudConfigured: Boolean(cfg.username.trim() && cfg.password.trim()),
    };
  };

  const applyWifiMergedCatalog = (
    nextFolders: FolderNode[],
    nextDocs: ArticleDoc[],
    nextTreeState: SyncedTreeState,
    nextPurgedRecords?: PurgedSyncRecords
  ) => {
    const normalizedFolders = nextFolders.map((f) => ({ ...f, parentId: null }));
    foldersRef.current = normalizedFolders;
    docsRef.current = nextDocs;
    setFolders(normalizedFolders);
    setDocs(nextDocs);
    if (nextTreeState.updatedAt > treeStateUpdatedAtRef.current) {
      setCollapsedFolderIds(nextTreeState.collapsedIds);
      setActiveTarget(nextTreeState.activeTarget);
      setTreeScrollTop(nextTreeState.scrollTop);
      setTreeStateUpdatedAt(nextTreeState.updatedAt);
    }
    if (nextPurgedRecords) {
      const pruned = pruneExpiredPurgedRecords(nextPurgedRecords);
      purgedRecordsRef.current = pruned;
      setPurgedRecords(pruned);
    }
    setFoldersDirty(true);
    const hasUnresolvedWifiConflict = nextDocs.some(
      (d) => !d.deleted && d.pendingRemoteProgress?.source === 'wifi'
    );
    // Record mutation so any in-flight WebDAV sync won't clobber newly merged Wi-Fi state,
    // and let triggerPostWifiCloudSync coordinate a single-side cloud push once Wi-Fi completes.
    autoMutationSeqRef.current++;
    if (autoCatalogDebounceTimerRef.current !== null) {
      window.clearTimeout(autoCatalogDebounceTimerRef.current);
      autoCatalogDebounceTimerRef.current = null;
    }
    if (!hasUnresolvedWifiConflict) {
      wifiCloudSyncNeededRef.current = true;
    }
  };

  const applyWifiReceivedDocBody = async (payload: WifiDocBodyPayload) => {
    wifiCloudSyncNeededRef.current = true;
    setDocs((prev) => {
      const next = applyWifiReceivedDocToDocs(prev, payload);
      docsRef.current = next;
      return next;
    });
  };

  const triggerPostWifiCloudSync = (isInitiator: boolean, peerCloudConfigured: boolean) => {
    const cfg = webDavConfigRef.current;
    if (!cfg.username.trim() || !cfg.password.trim()) return;
    if (docsRef.current.some((d) => !d.deleted && d.pendingRemoteProgress?.source === 'wifi')) {
      return;
    }
    // Single-side coordination: prefer the Wi-Fi initiator to sync to WebDAV cloud so both devices
    // never race against Jianguoyun at the same instant; fall back to host if initiator has no cloud.
    if (!isInitiator && peerCloudConfigured) {
      wifiCloudSyncNeededRef.current = false;
      return;
    }
    const needsSync =
      wifiCloudSyncNeededRef.current ||
      autoProgressDirtyRef.current ||
      autoCatalogDirtyRef.current;
    // Anti-ping-pong guard: if we just pulled from cloud (<4s ago) and Wi-Fi didn't bring new
    // changes or conflict resolutions back to us, skip a redundant immediate cloud round-trip.
    if (!needsSync && Date.now() - lastAutoPullAtRef.current < 4000) {
      return;
    }

    wifiCloudSyncNeededRef.current = false;
    autoCatalogDirtyRef.current = true;
    autoProgressDirtyRef.current = true;
    autoSyncBackoffUntilRef.current = 0;

    const trigger = () => {
      if (!appMountedRef.current) return;
      void runSilentAutoSyncRef.current({ forcePullCheck: true, bypassThrottle: true });
    };
    if (activeAutoSyncPromiseRef.current) {
      void activeAutoSyncPromiseRef.current.finally(trigger);
    } else {
      trigger();
    }
  };
  triggerPostWifiCloudSyncRef.current = triggerPostWifiCloudSync;

  const wifiCallbacksRef = useRef({
    getLocalState: getWifiLocalState,
    applyMergedCatalog: applyWifiMergedCatalog,
    applyReceivedDocBody: applyWifiReceivedDocBody,
  });
  wifiCallbacksRef.current = {
    getLocalState: getWifiLocalState,
    applyMergedCatalog: applyWifiMergedCatalog,
    applyReceivedDocBody: applyWifiReceivedDocBody,
  };

  const scheduleHideWifiBubble = (delayMs = TOOLBAR_TOAST_DURATION_MS) => {
    if (wifiBubbleTimerRef.current !== null) {
      window.clearTimeout(wifiBubbleTimerRef.current);
    }
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
    wifiBubbleTimerRef.current = window.setTimeout(() => {
      wifiBubbleTimerRef.current = null;
      setWifiQuickBubble(null);
    }, delayMs);
  };

  const clearWifiIncomingSafetyTimer = () => {
    if (wifiIncomingSyncTimerRef.current !== null) {
      window.clearTimeout(wifiIncomingSyncTimerRef.current);
      wifiIncomingSyncTimerRef.current = null;
    }
  };

  const armWifiIncomingSafetyTimer = () => {
    clearWifiIncomingSafetyTimer();
    wifiIncomingSyncTimerRef.current = window.setTimeout(() => {
      wifiIncomingSyncTimerRef.current = null;
      if (!wifiAutoSyncingRef.current) {
        setWifiQuickBubble((prev) => (prev?.status === 'syncing' ? null : prev));
      }
    }, 15_000);
  };

  // Plan A: Only keep Wi-Fi P2P host & UDP/NSD discovery active while in Directory Mode
  // and app is in foreground. Automatically shuts down in Reading Mode or background for 0% E-Ink reading drain.
  const wifiHostShouldRun = mainView === 'tree';

  useEffect(() => {
    wifiLastSyncedPairRef.current.clear();
  }, [webDavConfig.encryptionPassword]);

  // Keep local sync fingerprint updated while Wi-Fi standby is active, and push changes to native UDP beacon
  useEffect(() => {
    const password = (webDavConfig.encryptionPassword || '').trim();
    if (!password || !isWifiSyncNativeAvailable() || !wifiHostShouldRun) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void computeWifiSyncFingerprint(
        foldersRef.current,
        docsRef.current,
        storageDirRef.current
      ).then((nextHash) => {
        if (cancelled) return;
        if (nextHash !== wifiLocalStateHashRef.current) {
          wifiLocalStateHashRef.current = nextHash;
          setWifiLocalStateHash(nextHash);
          void updateWifiSyncStateHash(nextHash);
        }
      });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    wifiHostShouldRun,
    webDavConfig.encryptionPassword,
    folders,
    docs,
    storageDir,
    wifiImageVersion,
  ]);

  useEffect(() => {
    const password = (webDavConfig.encryptionPassword || '').trim();
    if (!password || !isWifiSyncNativeAvailable() || !wifiHostShouldRun) {
      setWifiServerInfo(null);
      wifiPeersRef.current = [];
      setWifiPeers([]);
      clearWifiIncomingSafetyTimer();
      if (!wifiHostShouldRun) {
        setWifiQuickBubble(null);
      }
      return;
    }

    let disposed = false;
    let lifecycleId = 0;
    let activeStop: (() => Promise<void>) | null = null;

    const stopHost = async () => {
      lifecycleId++;
      const stopFn = activeStop;
      activeStop = null;
      setWifiServerInfo(null);
      wifiPeersRef.current = [];
      setWifiPeers([]);
      clearWifiIncomingSafetyTimer();
      if (stopFn) {
        await stopFn().catch(() => {});
      }
    };

    const isPageHidden = () => document.visibilityState === 'hidden';

    const startHost = async () => {
      if (disposed || isPageHidden()) return;
      if (activeStop) return;
      const runId = ++lifecycleId;
      try {
        let initialHash = wifiLocalStateHashRef.current;
        if (!initialHash) {
          initialHash = await computeWifiSyncFingerprint(
            foldersRef.current,
            docsRef.current,
            storageDirRef.current
          );
          if (disposed || runId !== lifecycleId || isPageHidden()) return;
          wifiLocalStateHashRef.current = initialHash;
          setWifiLocalStateHash(initialHash);
        }

        const res = await startWifiSyncHost(
          password,
          {
            getLocalState: () => wifiCallbacksRef.current.getLocalState(),
            applyMergedCatalog: (...args) => wifiCallbacksRef.current.applyMergedCatalog(...args),
            applyReceivedDocBody: (payload) =>
              wifiCallbacksRef.current.applyReceivedDocBody(payload),
            onPeersChange: (nextPeers) => {
              if (disposed || runId !== lifecycleId) return;
              const prev = wifiPeersRef.current;
              const same =
                prev.length === nextPeers.length &&
                prev.every(
                  (p, i) =>
                    p.id === nextPeers[i].id &&
                    p.name === nextPeers[i].name &&
                    p.ip === nextPeers[i].ip &&
                    p.port === nextPeers[i].port &&
                    (p.stateHash || '') === (nextPeers[i].stateHash || '')
                );
              if (!same) {
                wifiPeersRef.current = nextPeers;
                setWifiPeers(nextPeers);
              }
            },
            onImageReceived: () => {
              if (!disposed) {
                setWifiImageVersion((v) => v + 1);
              }
            },
            onIncomingActivity: () => {
              if (!disposed && mainViewRef.current === 'tree') {
                armWifiIncomingSafetyTimer();
              }
            },
            onPeerCloudStatus: (peerCloudConfigured) => {
              if (!disposed && runId === lifecycleId) {
                lastWifiPeerCloudConfiguredRef.current = peerCloudConfigured;
              }
            },
            onIncomingSync: (status) => {
              if (disposed || runId !== lifecycleId) return;
              if (status === 'start') {
                lastWifiPeerCloudConfiguredRef.current = false;
                if (mainViewRef.current === 'tree' && !wifiAutoSyncingRef.current) {
                  if (wifiBubbleTimerRef.current !== null) {
                    window.clearTimeout(wifiBubbleTimerRef.current);
                    wifiBubbleTimerRef.current = null;
                  }
                  setWifiQuickBubble({ status: 'syncing' });
                  armWifiIncomingSafetyTimer();
                }
              } else if (status === 'end') {
                clearWifiIncomingSafetyTimer();
                setWifiImageVersion((v) => v + 1);
                if (!wifiAutoSyncingRef.current) {
                  const hasWifiConflict = docsRef.current.some(
                    (d) => !d.deleted && d.pendingRemoteProgress?.source === 'wifi'
                  );
                  if (mainViewRef.current === 'tree') {
                    if (hasWifiConflict) {
                      setWifiQuickBubble(null);
                    } else {
                      setWifiQuickBubble({ status: 'done', text: '同步完成' });
                      scheduleHideWifiBubble(TOOLBAR_TOAST_DURATION_MS);
                    }
                  }
                  if (!hasWifiConflict) {
                    triggerPostWifiCloudSyncRef.current(
                      false,
                      lastWifiPeerCloudConfiguredRef.current
                    );
                  }
                }
              }
            },
          },
          initialHash
        );
        if (disposed || runId !== lifecycleId || isPageHidden()) {
          await res.stop().catch(() => {});
          return;
        }
        activeStop = res.stop;
        setWifiServerInfo(res.info);
      } catch {
        // Ignore transient offline / no-Wi-Fi errors while waiting in directory mode
      }
    };

    if (document.visibilityState === 'visible') {
      void startHost();
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void stopHost();
      } else if (document.visibilityState === 'visible') {
        void startHost();
      }
    };

    const handlePageHide = () => {
      void stopHost();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      void stopHost();
    };
  }, [webDavConfig.encryptionPassword, wifiHostShouldRun]);

  const appMountedRef = useRef(true);
  useEffect(() => {
    appMountedRef.current = true;
    return () => {
      appMountedRef.current = false;
    };
  }, []);

  // Plan A Auto-Sync: When both devices are in Directory Mode on the same Wi-Fi and their data
  // fingerprints differ, the deterministic leader (smaller instanceId) automatically initiates bidirectional sync.
  useEffect(() => {
    const password = (webDavConfig.encryptionPassword || '').trim();
    if (
      mainView !== 'tree' ||
      hasPendingWifiConflicts ||
      !password ||
      !wifiServerInfo?.running ||
      !wifiLocalStateHash ||
      wifiAutoSyncingRef.current
    ) {
      return;
    }

    const myId = wifiServerInfo.instanceId;
    const now = Date.now();
    const candidate = wifiPeers.find((peer) => {
      const peerHash = (peer.stateHash || '').trim();
      if (!peerHash || peerHash === wifiLocalStateHash) return false;
      // Deterministic leader election prevents both peers from initiating simultaneously
      if (myId >= peer.id) return false;

      const prev = wifiLastSyncedPairRef.current.get(peer.id);
      if (prev) {
        if (now - prev.at < 2500) return false;
        if (prev.localHash === wifiLocalStateHash && prev.peerHash === peerHash) {
          if (!prev.isError || prev.isAuthError) return false;
          if (now - prev.at < 30_000) return false;
        }
      }
      return true;
    });

    if (!candidate) return;

    const peerHashSnapshot = (candidate.stateHash || '').trim();
    const localHashSnapshot = wifiLocalStateHash;

    const runAutoSync = async () => {
      wifiAutoSyncingRef.current = true;
      if (wifiBubbleTimerRef.current !== null) {
        window.clearTimeout(wifiBubbleTimerRef.current);
        wifiBubbleTimerRef.current = null;
      }
      setWifiQuickBubble({ status: 'syncing' });

      try {
        const summary = await runWifiBidirectionalSync({
          host: candidate.ip,
          port: candidate.port,
          password,
          storageDir: storageDirRef.current,
          getLocalState: () => wifiCallbacksRef.current.getLocalState(),
          applyMergedCatalog: (...args) => wifiCallbacksRef.current.applyMergedCatalog(...args),
          applyReceivedDocBody: (payload) =>
            wifiCallbacksRef.current.applyReceivedDocBody(payload),
        });

        wifiLastSyncedPairRef.current.set(candidate.id, {
          localHash: localHashSnapshot,
          peerHash: peerHashSnapshot,
          at: Date.now(),
        });
        setWifiImageVersion((v) => v + 1);

        const hasWifiConflict = docsRef.current.some(
          (d) => !d.deleted && d.pendingRemoteProgress?.source === 'wifi'
        );
        if (appMountedRef.current && mainViewRef.current === 'tree') {
          if (hasWifiConflict) {
            setWifiQuickBubble(null);
          } else {
            setWifiQuickBubble({ status: 'done', text: '同步完成' });
            scheduleHideWifiBubble(TOOLBAR_TOAST_DURATION_MS);
          }
        }
        if (!hasWifiConflict) {
          triggerPostWifiCloudSyncRef.current(true, summary.peerCloudConfigured);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err || '');
        const lower = raw.toLowerCase();
        const isAuthError =
          lower.includes('401') ||
          lower.includes('auth') ||
          lower.includes('密码') ||
          lower.includes('invalid');
        wifiLastSyncedPairRef.current.set(candidate.id, {
          localHash: localHashSnapshot,
          peerHash: peerHashSnapshot,
          at: Date.now(),
          isError: true,
          isAuthError,
        });

        if (appMountedRef.current && mainViewRef.current === 'tree') {
          if (isAuthError) {
            setWifiQuickBubble({
              status: 'error',
              text: 'Wi-Fi 同步密码不一致',
              action: 'settings',
            });
            scheduleHideWifiBubble(TOOLBAR_TOAST_DURATION_MS);
          } else {
            // Peer may have just entered Reading Mode or locked screen; dismiss quietly
            setWifiQuickBubble(null);
          }
        }
      } finally {
        wifiAutoSyncingRef.current = false;
      }
    };

    void runAutoSync();
  }, [
    mainView,
    hasPendingWifiConflicts,
    wifiServerInfo,
    wifiPeers,
    wifiLocalStateHash,
    webDavConfig.encryptionPassword,
  ]);

  // Animate expanding/contracting 3-dot ellipsis (1 -> 2 -> 3 -> 2 -> 1) while Wi-Fi sync is running
  useEffect(() => {
    if (wifiQuickBubble?.status !== 'syncing') {
      setWifiBubbleDots(1);
      return;
    }
    const sequence = [1, 2, 3, 2];
    let step = 0;
    setWifiBubbleDots(sequence[0]);
    const timer = window.setInterval(() => {
      step = (step + 1) % sequence.length;
      setWifiBubbleDots(sequence[step]);
    }, 380);
    return () => {
      window.clearInterval(timer);
    };
  }, [wifiQuickBubble?.status]);

  useEffect(() => {
    return () => {
      if (wifiBubbleTimerRef.current !== null) {
        window.clearTimeout(wifiBubbleTimerRef.current);
        wifiBubbleTimerRef.current = null;
      }
      if (wifiResolutionPushTimerRef.current !== null) {
        window.clearTimeout(wifiResolutionPushTimerRef.current);
        wifiResolutionPushTimerRef.current = null;
      }
      clearWifiIncomingSafetyTimer();
    };
  }, []);

  // Drag-to-reorder handler (plus optional non-conflicting long-press) for movable bottom toolbar icons
  const handleToolbarIconPointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    iconId: TreeToolbarIconId | DocToolbarIconId,
    mode: MainView,
    onLongPress?: () => void
  ) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let longPressTriggered = false;
    let longPressTimer: number | null = null;

    const clearLongPressTimer = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    if (onLongPress) {
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        if (dragging) return;
        longPressTriggered = true;
        suppressToolbarClickRef.current = true;
        onLongPress();
        window.setTimeout(() => {
          suppressToolbarClickRef.current = false;
        }, 260);
      }, 450);
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (longPressTriggered) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (!dragging) {
        if (Math.abs(dx) >= 10 || Math.hypot(dx, dy) >= 14) {
          clearLongPressTimer();
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
      clearLongPressTimer();
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
    const files = Array.from(e.dataTransfer.files).filter(isSupportedImportFile);
    if (files.length === 0) return;
    const parsed: Array<{
      title: string;
      content: string;
      folderId: string | null;
      format: 'txt';
      images?: ExtractedEbookImage[];
    }> = [];
    const failedMsgs: string[] = [];
    for (const file of files) {
      if (isEbookFile(file)) {
        try {
          const ebookDoc = await parseEbookFile(file);
          parsed.push({
            title: ebookDoc.title,
            content: ebookDoc.content,
            folderId: defaultImportFolderId,
            format: 'txt',
            images: ebookDoc.images,
          });
        } catch (err) {
          failedMsgs.push(err instanceof Error ? err.message : `解析「${file.name}」失败`);
        }
      } else {
        const content = await readTextFileSmart(file);
        const title = file.name.replace(/\.(txt|md|markdown|text)$/i, '').trim() || '导入文档';
        parsed.push({ title, content, folderId: defaultImportFolderId, format: 'txt' });
      }
    }
    if (parsed.length > 0) {
      await handleImportDocs(parsed);
    }
    if (failedMsgs.length > 0) {
      showToast(failedMsgs[0]);
    }
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
            storageDir={storageDir}
            docFolderName={
              selectedDoc.folderId
                ? folders.find((f) => f.id === selectedDoc.folderId)?.name ?? null
                : null
            }
            fontSize={fontSize}
            autoHyphenate={autoHyphenate}
            hasActiveMdict={mdictDicts.length > 0}
            isMdictPopupOpen={mdictLookup !== null}
            isMdictLookupPending={mdictLookupPending}
            onEnglishWordSelected={({ word, placement }) => {
              setShowFontSizeBar(false);
              setNotePopoverState(null);
              pendingMdictAutoExpandRef.current = false;
              void runMdictLookup(word, placement);
            }}
            onClearMdictLookup={() => {
              mdictLookupReqRef.current++;
              pendingMdictAutoExpandRef.current = false;
              setMdictLookupPending(false);
              setMdictLookup(null);
            }}
            onMdictPopupReleased={() => {
              if (mdictPopupRef.current) {
                mdictPopupRef.current.autoExpandIfOverflowing();
              } else {
                pendingMdictAutoExpandRef.current = true;
              }
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
              setLiveProgressDecimals((prev) =>
                prev === metrics.progressDecimals ? prev : metrics.progressDecimals
              );
            }}
            onVisibleNotesChange={setVisibleNoteIds}
            onOpenNoteFromMargin={handleOpenNoteFromMargin}
            onFetchRemoteBody={() => handleFetchRemoteBody(selectedDoc.id)}
            onReturnToTree={handleExitDocToTree}
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
            onPullRefresh={handleTreePullRefresh}
            isPullRefreshing={treePullRefreshing}
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
        className="relative shrink-0 bg-[var(--fei-bg-bar)] border-t border-[var(--fei-border)] pb-[env(safe-area-inset-bottom,0px)] select-none"
      >
        {mainView === 'tree' && wifiQuickBubble && (
          <div
            role="status"
            aria-live="polite"
            onClick={
              wifiQuickBubble.action
                ? () => {
                    const action = wifiQuickBubble.action;
                    if (wifiBubbleTimerRef.current !== null) {
                      window.clearTimeout(wifiBubbleTimerRef.current);
                      wifiBubbleTimerRef.current = null;
                    }
                    setWifiQuickBubble(null);
                    if (action === 'settings') {
                      setShowSyncModal(true);
                    }
                  }
                : undefined
            }
            className={`absolute bottom-[calc(100%+10px)] left-1/2 -translate-x-1/2 z-40 px-3.5 py-1.5 rounded-lg bg-[var(--fei-bg-surface)] border border-[var(--fei-modal-border)] eink:border-[var(--fei-border-strong)] text-[12.5px] font-medium text-[var(--fei-text-primary)] whitespace-nowrap shadow-md eink:shadow-none select-none ${
              wifiQuickBubble.action ? 'cursor-pointer hover:bg-[var(--fei-bg-hover)]' : 'pointer-events-none'
            }`}
          >
            {wifiQuickBubble.status === 'syncing' ? (
              <span className="inline-flex items-baseline">
                <span>同步中</span>
                <span className="inline-block w-[1.15em] text-left">
                  {'.'.repeat(wifiBubbleDots)}
                </span>
              </span>
            ) : (
              <span>{wifiQuickBubble.text}</span>
            )}
          </div>
        )}
        <div className="h-[54px] max-w-[760px] mx-auto px-3 sm:px-6 flex items-center justify-start gap-0.5 sm:gap-1">
          {mainView === 'tree' ? (
            <>
              {treeToolbarOrder.map((iconId) => {
                const key = `tree:${iconId}`;
                const isDraggingThis = draggingToolbarIconId === key;
                const dragCls = isDraggingThis
                  ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)] text-[var(--fei-text-primary)] scale-105 opacity-90'
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
                      title="导入 .txt / .md / .epub / .mobi 等文档或粘贴文本（可拖动调整图标位置）"
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
                            ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)] text-[var(--fei-text-primary)]'
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
                    ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)] text-[var(--fei-text-primary)] scale-105'
                    : 'text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)]'
                }`}
              >
                <Trash2 className="w-[22px] h-[22px]" strokeWidth={1.8} />
              </button>
            </>
          ) : (
            /* 文档浏览模式：默认依次为 返回、字体设置（均可拖动排序），最右侧固定显示阅读进度 */
            <>
              {docToolbarOrder.map((iconId) => {
                const key = `doc:${iconId}`;
                const isDraggingThis = draggingToolbarIconId === key;
                const dragCls = isDraggingThis
                  ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)] text-[var(--fei-text-primary)] scale-105 opacity-90'
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

                if (iconId === 'whistle') {
                  return (
                    <button
                      key={iconId}
                      ref={bindRef}
                      type="button"
                      disabled={whistleStarting}
                      onPointerDown={(e) => handleToolbarIconPointerDown(e, 'whistle', 'doc')}
                      onClick={() => {
                        if (suppressToolbarClickRef.current) return;
                        void handleToggleWhistlePageTurn();
                      }}
                      aria-label={whistleEnabled ? '关闭口哨翻页' : '开启口哨翻页'}
                      aria-pressed={whistleEnabled}
                      title={
                        whistleEnabled
                          ? '口哨翻页已开启（点击关闭，可拖动调整图标位置）'
                          : '开启口哨翻页（吹一声口哨翻下一页，可拖动调整图标位置）'
                      }
                      className={`w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg transition-all shrink-0 touch-none select-none disabled:opacity-50 ${
                        isDraggingThis
                          ? dragCls
                          : whistleEnabled
                            ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)] text-[var(--fei-text-primary)]'
                            : 'text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)]'
                      }`}
                    >
                      <Music2 className="w-[20px] h-[20px]" strokeWidth={1.8} />
                    </button>
                  );
                }

                if (iconId === 'note') {
                  const hasVisibleNotes = visibleNoteIds.length > 0;
                  const noteActive = hasVisibleNotes || Boolean(notePopoverState);
                  return (
                    <button
                      key={iconId}
                      ref={bindRef}
                      type="button"
                      onPointerDown={(e) =>
                        handleToolbarIconPointerDown(e, 'note', 'doc', handleOpenNotesListModal)
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleOpenNotesListModal();
                      }}
                      onClick={() => {
                        if (suppressToolbarClickRef.current) return;
                        handleOpenNotePopover();
                      }}
                      aria-label={
                        hasVisibleNotes
                          ? `当前页有 ${visibleNoteIds.length} 条读书笔记（点击编辑，长按查看全部笔记）`
                          : '添加读书笔记（长按查看全部笔记）'
                      }
                      aria-pressed={noteActive}
                      title={
                        hasVisibleNotes
                          ? `当前页有 ${visibleNoteIds.length} 条笔记（点击查看/编辑，长按或右键打开全部笔记列表）`
                          : '读书笔记（点击记录，长按或右键查看全部笔记，可拖动调整位置）'
                      }
                      className={`relative w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg transition-all shrink-0 touch-none select-none ${
                        isDraggingThis
                          ? dragCls
                          : noteActive
                            ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)] text-[var(--fei-text-primary)]'
                            : 'text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)]'
                      }`}
                    >
                      <StickyNote
                        className="w-[20px] h-[20px]"
                        strokeWidth={hasVisibleNotes ? 2.1 : 1.8}
                      />
                      {hasVisibleNotes &&
                        (visibleNoteIds.length > 1 ? (
                          <span
                            aria-hidden="true"
                            className="absolute top-1.5 right-1.5 min-w-[13px] h-[13px] px-0.5 rounded-full bg-[var(--fei-text-primary)] text-[var(--fei-bg)] text-[9px] font-semibold tabular-nums leading-none inline-flex items-center justify-center"
                          >
                            {visibleNoteIds.length > 9 ? '9+' : visibleNoteIds.length}
                          </span>
                        ) : (
                          <span
                            aria-hidden="true"
                            className="absolute top-2 right-2 w-[6px] h-[6px] rounded-full bg-[var(--fei-text-primary)]"
                          />
                        ))}
                    </button>
                  );
                }

                return (
                  <button
                    key={iconId}
                    ref={bindRef}
                    type="button"
                    onPointerDown={(e) => handleToolbarIconPointerDown(e, 'font', 'doc')}
                    onClick={() => {
                      if (suppressToolbarClickRef.current) return;
                      setShowFontSizeBar((prev) => {
                        if (!prev) setNotePopoverState(null);
                        return !prev;
                      });
                    }}
                    aria-label="字号与断字设置"
                    title="字号与断字设置（可拖动调整图标位置）"
                    className={`w-[44px] sm:w-[46px] h-[46px] inline-flex items-center justify-center rounded-lg transition-all shrink-0 touch-none select-none ${
                      isDraggingThis
                        ? dragCls
                        : showFontSizeBar
                          ? 'bg-[var(--fei-bg-selected)] border border-transparent eink:border-[var(--fei-border-strong)] text-[var(--fei-text-primary)]'
                          : 'text-[var(--fei-text-muted)] hover:bg-[var(--fei-bg-hover)]'
                    }`}
                  >
                    <ALargeSmall className="w-[22px] h-[22px]" strokeWidth={1.8} />
                  </button>
                );
              })}

              {/* 最右侧固定：自适应精度百分比阅读进度（不参与拖动排序，不可点击切换） */}
              <span
                aria-label={`当前阅读进度 ${formatAdaptiveProgressPercent(liveReadProgress, liveProgressDecimals)}`}
                className="ml-auto h-[40px] px-1.5 -mr-0.5 inline-flex items-center justify-end text-[14px] font-medium tabular-nums text-[var(--fei-text-muted)] select-none whitespace-nowrap shrink-0"
              >
                {formatAdaptiveProgressPercent(liveReadProgress, liveProgressDecimals)}
              </span>
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
          themeMode={themeMode}
          onChangeThemeMode={setThemeMode}
          whistleSensitivity={whistleSensitivity}
          onChangeWhistleSensitivity={handleChangeWhistleSensitivity}
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

      {/* Wi-Fi Sync Reading Progress Conflict Modal — resolve all conflicts immediately in Directory Mode */}
      {mainView === 'tree' &&
        wifiConflictDocs.length > 0 &&
        wifiQuickBubble?.status !== 'syncing' &&
        !showSyncModal &&
        !showImportModal &&
        !showTrashModal &&
        !showStorageFolderModal &&
        wifiConflictDocs[0].pendingRemoteProgress && (
          <ProgressConflictModal
            doc={wifiConflictDocs[0]}
            pending={wifiConflictDocs[0].pendingRemoteProgress}
            queuePosition={
              Math.max(wifiConflictBatchTotal, wifiConflictDocs.length) > 1
                ? {
                    current: Math.max(
                      1,
                      Math.max(wifiConflictBatchTotal, wifiConflictDocs.length) -
                        wifiConflictDocs.length +
                        1
                    ),
                    total: Math.max(wifiConflictBatchTotal, wifiConflictDocs.length),
                  }
                : undefined
            }
            onAcceptRemote={() => handleAcceptRemoteProgress(wifiConflictDocs[0].id)}
            onKeepLocal={() => handleKeepLocalProgress(wifiConflictDocs[0].id)}
            onDismiss={() => handleDismissProgressConflict(wifiConflictDocs[0])}
          />
        )}

      {/* Plan-B Reading Progress Confirmation Modal (on book open or immediately if already open) */}
      {mainView === 'doc' &&
        selectedDoc &&
        selectedDoc.pendingRemoteProgress &&
        Boolean(selectedDoc.content) &&
        dismissedConflictKeys[selectedDoc.id] !== getConflictSnapshotKey(selectedDoc) && (
          <ProgressConflictModal
            doc={selectedDoc}
            pending={selectedDoc.pendingRemoteProgress}
            onAcceptRemote={() => handleAcceptRemoteProgress(selectedDoc.id)}
            onKeepLocal={() => handleKeepLocalProgress(selectedDoc.id)}
            onDismiss={() => handleDismissProgressConflict(selectedDoc)}
          />
        )}

      {/* Font Size & Hyphenation Adjuster Popover in Browse Mode */}
      {mainView === 'doc' && showFontSizeBar && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setShowFontSizeBar(false)}
          />
          <div
            role="dialog"
            aria-label="字号与断字设置"
            onClick={(e) => e.stopPropagation()}
            className="fixed bottom-[64px] left-1/2 -translate-x-1/2 z-40 w-[min(340px,calc(100vw-24px))] px-3.5 py-2.5 rounded-2xl bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] shadow-lg eink:shadow-none flex flex-col gap-2.5 select-none"
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
                    ? 'bg-[var(--fei-switch-track-on)] border-[var(--fei-switch-track-on)]'
                    : 'bg-[var(--fei-switch-track-off)] border-[var(--fei-border-strong)]'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-block h-4 w-4 rounded-full transition-transform ${
                    autoHyphenate
                      ? 'translate-x-[23px] bg-[var(--fei-switch-thumb-on)]'
                      : 'translate-x-[3px] bg-[var(--fei-switch-thumb-off)]'
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

      {/* Reading Note Input Popover in Browse Mode */}
      {mainView === 'doc' && selectedDoc && notePopoverState && (
        <ReadingNotePopover
          screenNotes={getActiveNotes(selectedDoc.notes).filter((n) =>
            notePopoverState.screenNoteIds.includes(n.id)
          )}
          initialNoteId={notePopoverState.initialNoteId}
          defaultAnchor={notePopoverState.defaultAnchor}
          canCreateAtDefaultAnchor={notePopoverState.canCreateAtDefaultAnchor}
          fontSize={fontSize}
          onSaveNote={handleSaveReadingNote}
          onDeleteNote={handleDeleteReadingNote}
          onClose={() => setNotePopoverState(null)}
        />
      )}

      {/* Reading Notes List Modal (Long-press Note Toolbar Icon) */}
      {mainView === 'doc' && selectedDoc && showNotesListModal && (
        <ReadingNotesListModal
          docTitle={selectedDoc.title}
          docContentLength={selectedDoc.content.length}
          notes={selectedDoc.notes}
          onJumpToNote={handleJumpToNoteFromList}
          onDeleteNote={handleDeleteReadingNote}
          onCopySuccess={showToast}
          onClose={() => setShowNotesListModal(false)}
        />
      )}

      {/* Drag Overlay */}
      {windowDragging && (
        <div className="fixed inset-0 z-50 bg-black/10 dark:bg-black/25 eink:bg-transparent flex items-center justify-center pointer-events-none">
          <div className="px-5 py-3 rounded-xl bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] shadow-lg eink:shadow-none text-[14px] text-[var(--fei-text-primary)]">
            松开导入 .txt / .md / .epub / .mobi 等文档
          </div>
        </div>
      )}

      {/* Global Input Long-Press Paste Popover */}
      <InputPastePopover onFeedback={showToast} />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-32px)] px-4 py-2 rounded-lg bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] text-[12.5px] leading-snug text-center shadow-md eink:shadow-none">
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

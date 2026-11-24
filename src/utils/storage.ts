import {
  ArticleDoc,
  FolderNode,
  PurgedSyncRecords,
  QuotaStats,
  ReaderSettings,
  SyncLogEntry,
  WebDavConfig,
} from '../types';
import { createInitialQuotaStats, getCurrentMonthKey } from './webdavSync';
import { pruneExpiredPurgedRecords } from './trash';

const KEYS = {
  FOLDERS: 'feiartical_folders_v1',
  DOCS: 'feiartical_docs_v1',
  READER: 'feiartical_reader_v1',
  WEBDAV: 'feiartical_webdav_v1',
  QUOTA: 'feiartical_quota_v1',
  LOGS: 'feiartical_sync_logs_v1',
  THEME: 'feiartical_theme_v1',
  FOLDERS_DIRTY: 'feiartical_folders_dirty_v1',
  TREE_STATE: 'feiartical_tree_state_v1',
  STORAGE_DIR: 'feiartical_storage_dir_v1',
  LAST_DOC_ID: 'feiartical_last_doc_id_v1',
  PURGED_RECORDS: 'feiartical_purged_records_v1',
  ACTIVE_MDICT: 'feiartical_active_mdict_v1',
  TREE_TOOLBAR_ORDER_LEGACY: 'feiartical_tree_toolbar_order_v1',
  TREE_TOOLBAR_ORDER: 'feiartical_tree_toolbar_order_v2',
  DOC_TOOLBAR_ORDER: 'feiartical_doc_toolbar_order_v1',
};

export type LocalStorageBackendMode = 'saf' | 'path' | 'web-fs' | 'browser-only';

export interface StorageDirectoryConfig {
  initialized: boolean;
  folderPath: string;
  selectedAt: number;
  storageMode?: LocalStorageBackendMode;
  treeUri?: string;
}

export interface PersistedTreeState {
  collapsedIds: string[];
  activeTarget: { kind: 'folder' | 'doc'; id: string } | null;
  scrollTop: number;
  updatedAt: number;
}

export const MIN_DOC_FONT_SIZE = 13;
export const MAX_DOC_FONT_SIZE = 24;

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 16,
  lineHeight: 1.62,
  width: 'medium',
  paper: 'white',
  indentFirstLine: false,
  autoHyphenate: true,
  progressDisplayMode: 'percent',
  whistleSensitivity: 'medium',
};

export const DEFAULT_WEBDAV_CONFIG: WebDavConfig = {
  provider: 'jianguoyun',
  enabled: false,
  baseUrl: 'https://dav.jianguoyun.com/dav/FeiArtical/',
  username: '',
  password: '',
  encryptionPassword: '',
  syncShortDocsViaCloud: false,
  settingsUpdatedAt: 0,
  lazyFetch: false,
};

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadFolders(): FolderNode[] {
  const loaded = safeParse<FolderNode[]>(localStorage.getItem(KEYS.FOLDERS), []);
  return loaded.map((f, idx) => ({
    ...f,
    parentId: null,
    order: typeof f.order === 'number' ? f.order : idx,
  }));
}

export function saveFolders(folders: FolderNode[]): void {
  try {
    localStorage.setItem(KEYS.FOLDERS, JSON.stringify(folders));
  } catch {
    // Ignore localStorage quota errors when real filesystem persistence is active
  }
}

export function loadDocs(): ArticleDoc[] {
  return safeParse<ArticleDoc[]>(localStorage.getItem(KEYS.DOCS), []);
}

export function saveDocs(docs: ArticleDoc[]): void {
  try {
    localStorage.setItem(KEYS.DOCS, JSON.stringify(docs));
  } catch {
    // Ignore localStorage quota errors when large docs exceed browser 5MB cap
  }
}

export function loadReaderSettings(): ReaderSettings {
  return {
    ...DEFAULT_READER_SETTINGS,
    ...safeParse<Partial<ReaderSettings>>(localStorage.getItem(KEYS.READER), {}),
  };
}

export function saveReaderSettings(settings: ReaderSettings): void {
  localStorage.setItem(KEYS.READER, JSON.stringify(settings));
}

export function loadWebDavConfig(): WebDavConfig {
  return {
    ...DEFAULT_WEBDAV_CONFIG,
    ...safeParse<Partial<WebDavConfig>>(localStorage.getItem(KEYS.WEBDAV), {}),
    lazyFetch: false,
  };
}

export function saveWebDavConfig(config: WebDavConfig): void {
  localStorage.setItem(KEYS.WEBDAV, JSON.stringify(config));
}

export function loadQuotaStats(): QuotaStats {
  const stats = safeParse<QuotaStats>(localStorage.getItem(KEYS.QUOTA), createInitialQuotaStats());
  const currentMonth = getCurrentMonthKey();
  if (stats.monthKey !== currentMonth) {
    return createInitialQuotaStats();
  }
  return stats;
}

export function saveQuotaStats(stats: QuotaStats): void {
  localStorage.setItem(KEYS.QUOTA, JSON.stringify(stats));
}

export function loadSyncLogs(): SyncLogEntry[] {
  return safeParse<SyncLogEntry[]>(localStorage.getItem(KEYS.LOGS), []);
}

export function saveSyncLogs(logs: SyncLogEntry[]): void {
  localStorage.setItem(KEYS.LOGS, JSON.stringify(logs.slice(0, 20)));
}

export type AppThemeMode = 'light' | 'dark' | 'eink';

export function loadTheme(): AppThemeMode {
  const saved = localStorage.getItem(KEYS.THEME);
  if (saved === 'dark' || saved === 'light' || saved === 'eink') return saved;
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function saveTheme(theme: AppThemeMode): void {
  localStorage.setItem(KEYS.THEME, theme);
}

export function applyThemeMode(theme: AppThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('eink', theme === 'eink');
}

export function loadFoldersDirty(): boolean {
  return localStorage.getItem(KEYS.FOLDERS_DIRTY) === '1';
}

export function saveFoldersDirty(dirty: boolean): void {
  localStorage.setItem(KEYS.FOLDERS_DIRTY, dirty ? '1' : '0');
}

export function loadTreeViewState(): PersistedTreeState {
  const parsed = safeParse<Partial<PersistedTreeState>>(localStorage.getItem(KEYS.TREE_STATE), {});
  const collapsedIds = Array.isArray(parsed.collapsedIds)
    ? parsed.collapsedIds.filter((id): id is string => typeof id === 'string')
    : [];
  const rawTarget = parsed.activeTarget;
  const activeTarget =
    rawTarget &&
    (rawTarget.kind === 'folder' || rawTarget.kind === 'doc') &&
    typeof rawTarget.id === 'string'
      ? { kind: rawTarget.kind, id: rawTarget.id }
      : null;
  const scrollTop =
    typeof parsed.scrollTop === 'number' && Number.isFinite(parsed.scrollTop) && parsed.scrollTop >= 0
      ? parsed.scrollTop
      : 0;
  const updatedAt =
    typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
  return { collapsedIds, activeTarget, scrollTop, updatedAt };
}

export function saveTreeViewState(state: PersistedTreeState): void {
  localStorage.setItem(KEYS.TREE_STATE, JSON.stringify(state));
}

export function loadStorageDirConfig(): StorageDirectoryConfig {
  const parsed = safeParse<Partial<StorageDirectoryConfig>>(
    localStorage.getItem(KEYS.STORAGE_DIR),
    {}
  );
  const rawMode = parsed.storageMode;
  const storageMode: LocalStorageBackendMode | undefined =
    rawMode === 'saf' ||
    rawMode === 'path' ||
    rawMode === 'web-fs' ||
    rawMode === 'browser-only'
      ? rawMode
      : undefined;
  return {
    initialized: parsed.initialized === true,
    folderPath:
      typeof parsed.folderPath === 'string' && parsed.folderPath.trim()
        ? parsed.folderPath.trim()
        : '/Documents/FeiArtical',
    selectedAt: typeof parsed.selectedAt === 'number' ? parsed.selectedAt : 0,
    storageMode,
    treeUri: typeof parsed.treeUri === 'string' && parsed.treeUri.trim() ? parsed.treeUri.trim() : undefined,
  };
}

export function saveStorageDirConfig(config: StorageDirectoryConfig): void {
  localStorage.setItem(KEYS.STORAGE_DIR, JSON.stringify(config));
}

export function loadLastOpenedDocId(): string | null {
  const val = localStorage.getItem(KEYS.LAST_DOC_ID);
  return val && val.trim() ? val.trim() : null;
}

export function saveLastOpenedDocId(docId: string | null): void {
  if (docId) {
    localStorage.setItem(KEYS.LAST_DOC_ID, docId);
  } else {
    localStorage.removeItem(KEYS.LAST_DOC_ID);
  }
}

export function loadPurgedSyncRecords(): PurgedSyncRecords {
  const parsed = safeParse<Partial<PurgedSyncRecords>>(
    localStorage.getItem(KEYS.PURGED_RECORDS),
    {}
  );
  return pruneExpiredPurgedRecords({
    docs: parsed.docs && typeof parsed.docs === 'object' ? parsed.docs : {},
    docFormats:
      parsed.docFormats && typeof parsed.docFormats === 'object' ? parsed.docFormats : {},
    folders: parsed.folders && typeof parsed.folders === 'object' ? parsed.folders : {},
  });
}

export function savePurgedSyncRecords(records: PurgedSyncRecords): void {
  const pruned = pruneExpiredPurgedRecords(records);
  localStorage.setItem(KEYS.PURGED_RECORDS, JSON.stringify(pruned));
}

export function loadActiveMdictId(): string | null {
  const val = localStorage.getItem(KEYS.ACTIVE_MDICT);
  return val && val.trim() ? val.trim() : null;
}

export function saveActiveMdictId(dictId: string | null): void {
  if (dictId) {
    localStorage.setItem(KEYS.ACTIVE_MDICT, dictId);
  } else {
    localStorage.removeItem(KEYS.ACTIVE_MDICT);
  }
}

export type TreeToolbarIconId = 'read' | 'import' | 'cut' | 'encrypt' | 'settings';
export type DocToolbarIconId = 'back' | 'font' | 'note' | 'whistle';

export const DEFAULT_TREE_TOOLBAR_ORDER: TreeToolbarIconId[] = [
  'read',
  'import',
  'cut',
  'encrypt',
  'settings',
];

export const DEFAULT_DOC_TOOLBAR_ORDER: DocToolbarIconId[] = [
  'back',
  'font',
  'note',
  'whistle',
];

function normalizeToolbarOrder<T extends string>(raw: unknown, defaults: readonly T[]): T[] {
  const allowed = new Set<string>(defaults);
  const seen = new Set<T>();
  const result: T[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && allowed.has(item) && !seen.has(item as T)) {
        seen.add(item as T);
        result.push(item as T);
      }
    }
  }
  for (const item of defaults) {
    if (!seen.has(item)) {
      result.push(item);
    }
  }
  return result;
}

function migrateTreeToolbarRaw(parsed: unknown): TreeToolbarIconId[] {
  if (!Array.isArray(parsed)) return [...DEFAULT_TREE_TOOLBAR_ORDER];
  const filtered = parsed.filter((item): item is string => typeof item === 'string' && item !== 'edit');
  if (!filtered.includes('read')) {
    const importIdx = filtered.indexOf('import');
    if (importIdx !== -1) {
      filtered.splice(importIdx, 0, 'read');
    } else {
      filtered.unshift('read');
    }
  }
  return normalizeToolbarOrder(filtered, DEFAULT_TREE_TOOLBAR_ORDER);
}

export function loadTreeToolbarOrder(): TreeToolbarIconId[] {
  const rawV2 = localStorage.getItem(KEYS.TREE_TOOLBAR_ORDER);
  if (rawV2) {
    const parsed = safeParse<unknown>(rawV2, null);
    const normalized = migrateTreeToolbarRaw(parsed);
    const needsSave =
      !Array.isArray(parsed) ||
      parsed.length !== normalized.length ||
      parsed.some((item, idx) => item !== normalized[idx]);
    if (needsSave) {
      saveTreeToolbarOrder(normalized);
    }
    return normalized;
  }
  const rawLegacy = localStorage.getItem(KEYS.TREE_TOOLBAR_ORDER_LEGACY);
  if (rawLegacy) {
    const parsed = safeParse<unknown>(rawLegacy, null);
    const normalized = migrateTreeToolbarRaw(parsed);
    saveTreeToolbarOrder(normalized);
    return normalized;
  }
  return [...DEFAULT_TREE_TOOLBAR_ORDER];
}

export function saveTreeToolbarOrder(order: TreeToolbarIconId[]): void {
  try {
    localStorage.setItem(KEYS.TREE_TOOLBAR_ORDER, JSON.stringify(order));
  } catch {
    // ignore storage quota errors
  }
}

export function loadDocToolbarOrder(): DocToolbarIconId[] {
  const parsed = safeParse<unknown>(localStorage.getItem(KEYS.DOC_TOOLBAR_ORDER), null);
  return normalizeToolbarOrder(parsed, DEFAULT_DOC_TOOLBAR_ORDER);
}

export function saveDocToolbarOrder(order: DocToolbarIconId[]): void {
  try {
    localStorage.setItem(KEYS.DOC_TOOLBAR_ORDER, JSON.stringify(order));
  } catch {
    // ignore storage quota errors
  }
}




import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { ArticleDoc, FolderNode } from '../types';
import { LocalStorageBackendMode, StorageDirectoryConfig } from './storage';
import { extractExcerpt, getByteSize, sha256Hex } from './textParser';

export interface FsBatchOp {
  op: 'mkdir' | 'write' | 'delete' | 'rmdirIfEmpty';
  path: string;
  content?: string;
}

interface NativeDirectoryStatus {
  configured: boolean;
  writable: boolean;
  mode: string;
  displayPath: string;
  treeUri: string;
}

interface NativePickResult {
  cancelled: boolean;
  ok?: boolean;
  mode?: 'saf';
  treeUri?: string;
  displayPath?: string;
  error?: string;
}

interface NativeConfigureResult {
  ok: boolean;
  mode?: 'saf' | 'path';
  displayPath?: string;
  treeUri?: string;
  absolutePath?: string;
  needsPermission?: boolean;
  error?: string;
}

interface NativeScannedFile {
  relPath: string;
  folderName: string | null;
  fileName: string;
  format: 'md' | 'txt';
  content: string;
  lastModified: number;
  byteSize: number;
}

interface NativeScanResult {
  ok: boolean;
  indexJson?: string;
  folders?: Array<{ name: string }>;
  files?: NativeScannedFile[];
  error?: string;
}

interface LocalStorageNativePlugin {
  getStatus(): Promise<NativeDirectoryStatus>;
  pickDirectory(): Promise<NativePickResult>;
  configureDirectory(options: {
    mode?: 'saf' | 'path';
    folderPath: string;
    treeUri?: string;
    requestPermission?: boolean;
  }): Promise<NativeConfigureResult>;
  applyBatch(options: {
    ops: FsBatchOp[];
  }): Promise<{ ok: boolean; applied?: number; fingerprint?: string; error?: string }>;
  getWorkspaceFingerprint(): Promise<{ ok: boolean; fingerprint?: string }>;
  scanWorkspace(): Promise<NativeScanResult>;
  addListener(
    eventName: 'workspaceResume',
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
}

const LocalStorageNative = registerPlugin<LocalStorageNativePlugin>('LocalStorageNative');

const INDEX_FILE_NAME = '.feiartical-index.json';
const SYNC_MANIFEST_STORAGE_KEY = 'feiartical_local_fs_manifest_v1';
const WEB_FS_DB_NAME = 'feiartical_local_fs_db';
const WEB_FS_STORE_NAME = 'handles';
const WEB_FS_ROOT_KEY = 'root_dir_handle';

interface SyncedManifestState {
  folderPaths: Record<string, string>;
  docFiles: Record<string, { relPath: string; contentHash: string; writtenBytes?: number }>;
  indexSig: string;
}

interface LocalFsIndexDocMeta {
  relPath: string;
  contentHash: string;
  title: string;
  folderId: string | null;
  order: number;
  format: 'md' | 'txt';
  readProgress: number;
  lastCharOffset: number;
  lastScrollTop: number;
  lastReadAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface LocalFsIndexFile {
  version: 1;
  updatedAt: number;
  folderPaths: Record<string, string>;
  folderMeta: Array<{ id: string; name: string; order: number; updatedAt: number }>;
  docFiles: Record<string, LocalFsIndexDocMeta>;
}

// Browser File System Access API minimal typing
interface WebFsPermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface WebFileSystemWritableFileStream {
  write(data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface WebFileSystemFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WebFileSystemWritableFileStream>;
}

interface WebFileSystemDirectoryHandle {
  kind: 'directory';
  name: string;
  queryPermission?: (desc?: WebFsPermissionDescriptor) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (desc?: WebFsPermissionDescriptor) => Promise<'granted' | 'denied' | 'prompt'>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<WebFileSystemDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WebFileSystemFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, WebFileSystemDirectoryHandle | WebFileSystemFileHandle]>;
}

let cachedWebDirHandle: WebFileSystemDirectoryHandle | null = null;
let syncQueue: Promise<void> = Promise.resolve();
let lastObservedDiskFingerprint: string | null = null;

export function isNativeLocalStorageAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LocalStorageNative');
}

export function subscribeLocalStorageResume(onResume: () => void): () => void {
  let disposed = false;
  let nativeHandle: PluginListenerHandle | null = null;
  let lastTriggerAt = 0;

  const trigger = () => {
    if (disposed) return;
    const now = Date.now();
    if (now - lastTriggerAt < 400) return;
    lastTriggerAt = now;
    onResume();
  };

  if (isNativeLocalStorageAvailable()) {
    LocalStorageNative.addListener('workspaceResume', trigger)
      .then((h) => {
        if (disposed) {
          h.remove().catch(() => {});
        } else {
          nativeHandle = h;
        }
      })
      .catch(() => {});
  }

  const handleVis = () => {
    if (document.visibilityState === 'visible') {
      trigger();
    }
  };
  document.addEventListener('visibilitychange', handleVis);
  window.addEventListener('focus', trigger);

  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', handleVis);
    window.removeEventListener('focus', trigger);
    if (nativeHandle) {
      nativeHandle.remove().catch(() => {});
      nativeHandle = null;
    }
  };
}

export function isWebDirectoryPickerSupported(): boolean {
  if (Capacitor.isNativePlatform()) return false;
  const win = window as unknown as { showDirectoryPicker?: unknown };
  return typeof win.showDirectoryPicker === 'function';
}

function openWebFsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(WEB_FS_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WEB_FS_STORE_NAME)) {
        db.createObjectStore(WEB_FS_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open local fs db'));
  });
}

async function saveWebDirHandle(handle: WebFileSystemDirectoryHandle | null): Promise<void> {
  cachedWebDirHandle = handle;
  try {
    const db = await openWebFsDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WEB_FS_STORE_NAME, 'readwrite');
      const store = tx.objectStore(WEB_FS_STORE_NAME);
      if (handle) {
        store.put(handle, WEB_FS_ROOT_KEY);
      } else {
        store.delete(WEB_FS_ROOT_KEY);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to persist directory handle'));
    });
    db.close();
  } catch {
    // Ignore IDB errors in restricted environments
  }
}

async function loadWebDirHandle(): Promise<WebFileSystemDirectoryHandle | null> {
  if (cachedWebDirHandle) return cachedWebDirHandle;
  try {
    const db = await openWebFsDb();
    const handle = await new Promise<WebFileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(WEB_FS_STORE_NAME, 'readonly');
      const store = tx.objectStore(WEB_FS_STORE_NAME);
      const req = store.get(WEB_FS_ROOT_KEY);
      req.onsuccess = () => resolve((req.result as WebFileSystemDirectoryHandle | undefined) ?? null);
      req.onerror = () => reject(req.error || new Error('Failed to load directory handle'));
    });
    db.close();
    cachedWebDirHandle = handle;
    return handle;
  } catch {
    return null;
  }
}

async function ensureWebHandleWritable(
  handle: WebFileSystemDirectoryHandle,
  allowPrompt: boolean
): Promise<boolean> {
  try {
    if (typeof handle.queryPermission === 'function') {
      const state = await handle.queryPermission({ mode: 'readwrite' });
      if (state === 'granted') return true;
      if (allowPrompt && typeof handle.requestPermission === 'function') {
        const reqState = await handle.requestPermission({ mode: 'readwrite' });
        return reqState === 'granted';
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface DirectoryPickOutcome {
  cancelled: boolean;
  ok: boolean;
  folderPath?: string;
  storageMode?: LocalStorageBackendMode;
  treeUri?: string;
  error?: string;
}

export async function pickRealStorageDirectory(): Promise<DirectoryPickOutcome> {
  if (isNativeLocalStorageAvailable()) {
    try {
      const res = await LocalStorageNative.pickDirectory();
      if (res.cancelled) {
        return { cancelled: true, ok: false };
      }
      if (!res.ok) {
        return {
          cancelled: false,
          ok: false,
          error: res.error || '所选文件夹不可写，请重试',
        };
      }
      return {
        cancelled: false,
        ok: true,
        folderPath: res.displayPath || '/FeiArtical',
        storageMode: 'saf',
        treeUri: res.treeUri,
      };
    } catch (err) {
      return {
        cancelled: false,
        ok: false,
        error: err instanceof Error ? err.message : '打开系统文件夹选择器失败',
      };
    }
  }

  const win = window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<WebFileSystemDirectoryHandle>;
  };

  if (typeof win.showDirectoryPicker === 'function') {
    try {
      const handle = await win.showDirectoryPicker({ mode: 'readwrite' });
      const writable = await ensureWebHandleWritable(handle, true);
      if (!writable) {
        return { cancelled: false, ok: false, error: '未获得该文件夹的写入权限' };
      }
      await saveWebDirHandle(handle);
      return {
        cancelled: false,
        ok: true,
        folderPath: `/${handle.name}`,
        storageMode: 'web-fs',
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { cancelled: true, ok: false };
      }
      return {
        cancelled: false,
        ok: false,
        error: '当前浏览器环境限制直接访问本地磁盘，可在桌面端独立浏览器或 Android App 中绑定真实文件夹',
      };
    }
  }

  return {
    cancelled: false,
    ok: false,
    error: '当前浏览器不支持直接绑定本地磁盘文件夹',
  };
}

export interface DirectoryConfigureOutcome {
  ok: boolean;
  folderPath: string;
  storageMode: LocalStorageBackendMode;
  treeUri?: string;
  needsPermission?: boolean;
  error?: string;
}

export async function configureRealStorageDirectory(options: {
  folderPath: string;
  storageMode?: LocalStorageBackendMode;
  treeUri?: string;
  requestPermission?: boolean;
}): Promise<DirectoryConfigureOutcome> {
  const normalized = options.folderPath.trim().startsWith('/')
    ? options.folderPath.trim()
    : `/${options.folderPath.trim() || 'Documents/FeiArtical'}`;

  if (isNativeLocalStorageAvailable()) {
    try {
      const mode: 'saf' | 'path' =
        options.storageMode === 'saf' && options.treeUri ? 'saf' : 'path';
      const res = await LocalStorageNative.configureDirectory({
        mode,
        folderPath: normalized,
        treeUri: options.treeUri,
        requestPermission: options.requestPermission ?? true,
      });
      if (res.ok) {
        return {
          ok: true,
          folderPath: res.displayPath || normalized,
          storageMode: res.mode === 'saf' ? 'saf' : 'path',
          treeUri: res.treeUri || undefined,
        };
      }
      return {
        ok: false,
        folderPath: normalized,
        storageMode: mode,
        needsPermission: res.needsPermission,
        error: res.error || '无法创建或写入所选目录',
      };
    } catch (err) {
      return {
        ok: false,
        folderPath: normalized,
        storageMode: 'path',
        error: err instanceof Error ? err.message : '初始化本地目录失败',
      };
    }
  }

  if (options.storageMode === 'web-fs') {
    const handle = await loadWebDirHandle();
    if (handle && (await ensureWebHandleWritable(handle, options.requestPermission ?? true))) {
      return {
        ok: true,
        folderPath: `/${handle.name}`,
        storageMode: 'web-fs',
      };
    }
  }

  // Fallback for plain web preview (non-Android, non-File-System-Access)
  await saveWebDirHandle(null);
  return {
    ok: true,
    folderPath: normalized,
    storageMode: 'browser-only',
  };
}

export async function verifyLocalStorageReady(config: StorageDirectoryConfig): Promise<{
  ready: boolean;
  isRealDisk: boolean;
  needsRebind: boolean;
  updatedConfig?: StorageDirectoryConfig;
}> {
  if (isNativeLocalStorageAvailable()) {
    try {
      const status = await LocalStorageNative.getStatus();
      if (status.configured && status.writable) {
        const nextMode: LocalStorageBackendMode = status.mode === 'saf' ? 'saf' : 'path';
        const nextPath = status.displayPath || config.folderPath;
        const nextUri = status.treeUri || undefined;
        const changed =
          config.storageMode !== nextMode ||
          config.folderPath !== nextPath ||
          config.treeUri !== nextUri;
        return {
          ready: true,
          isRealDisk: true,
          needsRebind: false,
          updatedConfig: changed
            ? {
                ...config,
                initialized: true,
                folderPath: nextPath,
                storageMode: nextMode,
                treeUri: nextUri,
              }
            : undefined,
        };
      }

      // Try silent re-bind (e.g. upgrading from old version that only saved localStorage path)
      const silent = await configureRealStorageDirectory({
        folderPath: config.folderPath,
        storageMode: config.storageMode,
        treeUri: config.treeUri,
        requestPermission: false,
      });
      if (silent.ok) {
        return {
          ready: true,
          isRealDisk: true,
          needsRebind: false,
          updatedConfig: {
            ...config,
            initialized: true,
            folderPath: silent.folderPath,
            storageMode: silent.storageMode,
            treeUri: silent.treeUri,
          },
        };
      }

      return { ready: false, isRealDisk: false, needsRebind: true };
    } catch {
      return { ready: false, isRealDisk: false, needsRebind: true };
    }
  }

  if (config.storageMode === 'web-fs') {
    const handle = await loadWebDirHandle();
    if (handle && (await ensureWebHandleWritable(handle, false))) {
      return { ready: true, isRealDisk: true, needsRebind: false };
    }
    return { ready: false, isRealDisk: false, needsRebind: false };
  }

  return { ready: true, isRealDisk: false, needsRebind: false };
}

export function sanitizeFsName(raw: string, fallback: string): string {
  const cleaned = (raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();
  const truncated = cleaned.slice(0, 80).trim();
  return truncated || fallback;
}

function loadSyncManifest(): SyncedManifestState {
  try {
    const raw = localStorage.getItem(SYNC_MANIFEST_STORAGE_KEY);
    if (!raw) {
      return { folderPaths: {}, docFiles: {}, indexSig: '' };
    }
    const parsed = JSON.parse(raw) as Partial<SyncedManifestState>;
    return {
      folderPaths:
        parsed.folderPaths && typeof parsed.folderPaths === 'object' ? parsed.folderPaths : {},
      docFiles: parsed.docFiles && typeof parsed.docFiles === 'object' ? parsed.docFiles : {},
      indexSig: typeof parsed.indexSig === 'string' ? parsed.indexSig : '',
    };
  } catch {
    return { folderPaths: {}, docFiles: {}, indexSig: '' };
  }
}

function saveSyncManifest(state: SyncedManifestState): void {
  try {
    localStorage.setItem(SYNC_MANIFEST_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore localStorage quota errors
  }
}

export function resetLocalFsSyncManifest(): void {
  lastObservedDiskFingerprint = null;
  try {
    localStorage.removeItem(SYNC_MANIFEST_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

async function computeWebFsFingerprint(): Promise<string | null> {
  const root = await loadWebDirHandle();
  if (!root) return null;
  const writable = await ensureWebHandleWritable(root, false);
  if (!writable) return null;

  const detectFormat = (fileName: string): 'md' | 'txt' | null => {
    if (!fileName || fileName.startsWith('.')) return null;
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
    if (lower.endsWith('.txt')) return 'txt';
    return null;
  };

  try {
    const lines: string[] = [];
    for await (const [name, handle] of root.entries()) {
      if (!name || name.startsWith('.')) continue;
      if (handle.kind === 'directory') {
        lines.push(`D:${name}`);
        for await (const [subName, subHandle] of handle.entries()) {
          if (subHandle.kind !== 'file') continue;
          if (!detectFormat(subName)) continue;
          const file = await subHandle.getFile();
          lines.push(`F:${name}/${subName}:${file.size}:${file.lastModified}`);
        }
      } else if (handle.kind === 'file') {
        if (!detectFormat(name)) continue;
        const file = await handle.getFile();
        lines.push(`F:${name}:${file.size}:${file.lastModified}`);
      }
    }
    lines.sort();
    return lines.join('\n');
  } catch {
    return null;
  }
}

async function getDiskWorkspaceFingerprint(config: StorageDirectoryConfig): Promise<string | null> {
  if (isNativeLocalStorageAvailable()) {
    try {
      const res = await LocalStorageNative.getWorkspaceFingerprint();
      return res.ok && typeof res.fingerprint === 'string' ? res.fingerprint : null;
    } catch {
      return null;
    }
  }
  if (config.storageMode === 'web-fs') {
    return computeWebFsFingerprint();
  }
  return null;
}

function buildFingerprintFromScan(scan: NativeScanResult): string {
  const lines: string[] = [];
  for (const f of scan.folders ?? []) {
    if (f.name && !f.name.startsWith('.')) {
      lines.push(`D:${f.name}`);
    }
  }
  for (const file of scan.files ?? []) {
    lines.push(`F:${file.relPath}:${file.byteSize}:${file.lastModified}`);
  }
  lines.sort();
  return lines.join('\n');
}

async function applyWebFsBatch(ops: FsBatchOp[]): Promise<{ ok: boolean; error?: string }> {
  const root = await loadWebDirHandle();
  if (!root) return { ok: false, error: '未绑定本地文件夹' };
  const writable = await ensureWebHandleWritable(root, false);
  if (!writable) return { ok: false, error: '缺少本地文件夹写入权限' };

  const getDir = async (
    dirPath: string,
    create: boolean
  ): Promise<WebFileSystemDirectoryHandle | null> => {
    if (!dirPath) return root;
    const segments = dirPath.split('/').filter(Boolean);
    let current = root;
    for (const seg of segments) {
      try {
        current = await current.getDirectoryHandle(seg, { create });
      } catch {
        return null;
      }
    }
    return current;
  };

  try {
    for (const item of ops) {
      const cleanPath = item.path.replace(/^\/+/, '');
      if (!cleanPath) continue;
      const slash = cleanPath.lastIndexOf('/');
      const dirPart = slash >= 0 ? cleanPath.slice(0, slash) : '';
      const baseName = slash >= 0 ? cleanPath.slice(slash + 1) : cleanPath;

      if (item.op === 'mkdir') {
        await getDir(cleanPath, true);
      } else if (item.op === 'write') {
        const parent = await getDir(dirPart, true);
        if (!parent) continue;
        const fileHandle = await parent.getFileHandle(baseName, { create: true });
        const stream = await fileHandle.createWritable();
        await stream.write(item.content ?? '');
        await stream.close();
      } else if (item.op === 'delete') {
        const parent = await getDir(dirPart, false);
        if (!parent) continue;
        try {
          await parent.removeEntry(baseName);
        } catch {
          // Ignore if already removed
        }
      } else if (item.op === 'rmdirIfEmpty') {
        const parent = await getDir(dirPart, false);
        if (!parent) continue;
        try {
          const targetDir = await parent.getDirectoryHandle(baseName, { create: false });
          let hasChild = false;
          for await (const _entry of targetDir.entries()) {
            hasChild = true;
            break;
          }
          if (!hasChild) {
            await parent.removeEntry(baseName);
          }
        } catch {
          // Ignore if missing or non-empty
        }
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '写入本地文件夹失败' };
  }
}

async function scanWebFsWorkspace(): Promise<NativeScanResult> {
  const root = await loadWebDirHandle();
  if (!root) return { ok: false, error: '未绑定本地文件夹' };
  const writable = await ensureWebHandleWritable(root, false);
  if (!writable) return { ok: false, error: '缺少本地文件夹访问权限' };

  const folders: Array<{ name: string }> = [];
  const files: NativeScannedFile[] = [];
  let indexJson = '';

  const detectFormat = (fileName: string): 'md' | 'txt' | null => {
    if (!fileName || fileName.startsWith('.')) return null;
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
    if (lower.endsWith('.txt')) return 'txt';
    return null;
  };

  try {
    for await (const [name, handle] of root.entries()) {
      if (name === INDEX_FILE_NAME && handle.kind === 'file') {
        const f = await handle.getFile();
        indexJson = await f.text();
        continue;
      }
      if (name.startsWith('.')) continue;

      if (handle.kind === 'directory') {
        folders.push({ name });
        for await (const [subName, subHandle] of handle.entries()) {
          if (subHandle.kind !== 'file') continue;
          const fmt = detectFormat(subName);
          if (!fmt) continue;
          const file = await subHandle.getFile();
          if (file.size > 15 * 1024 * 1024) continue;
          const content = (await file.text()).replace(/^\uFEFF/, '');
          files.push({
            relPath: `${name}/${subName}`,
            folderName: name,
            fileName: subName,
            format: fmt,
            content,
            lastModified: file.lastModified || Date.now(),
            byteSize: file.size,
          });
        }
      } else if (handle.kind === 'file') {
        const fmt = detectFormat(name);
        if (!fmt) continue;
        const file = await handle.getFile();
        if (file.size > 15 * 1024 * 1024) continue;
        const content = (await file.text()).replace(/^\uFEFF/, '');
        files.push({
          relPath: name,
          folderName: null,
          fileName: name,
          format: fmt,
          content,
          lastModified: file.lastModified || Date.now(),
          byteSize: file.size,
        });
      }
    }

    return { ok: true, indexJson, folders, files };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '扫描本地文件夹失败' };
  }
}

function buildDesiredWorkspaceLayout(
  folders: FolderNode[],
  docs: ArticleDoc[]
): {
  folderPaths: Record<string, string>;
  docFiles: Record<string, LocalFsIndexDocMeta>;
  folderMeta: Array<{ id: string; name: string; order: number; updatedAt: number }>;
} {
  const activeFolders = folders
    .filter((f) => !f.deleted)
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const folderPaths: Record<string, string> = {};
  const usedDirNames = new Set<string>();
  const folderMeta: Array<{ id: string; name: string; order: number; updatedAt: number }> = [];

  for (const f of activeFolders) {
    const base = sanitizeFsName(f.name, '新建文件夹');
    let candidate = base;
    let suffix = 2;
    while (usedDirNames.has(candidate.toLowerCase())) {
      candidate = `${base} (${suffix++})`;
    }
    usedDirNames.add(candidate.toLowerCase());
    folderPaths[f.id] = candidate;
    folderMeta.push({
      id: f.id,
      name: f.name,
      order: f.order,
      updatedAt: f.updatedAt,
    });
  }

  const activeDocs = docs
    .filter(
      (d) =>
        !d.deleted &&
        d.syncStatus !== 'remote-only' &&
        !(d.content.length === 0 && d.byteSize > 0)
    )
    .slice()
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const docFiles: Record<string, LocalFsIndexDocMeta> = {};
  const usedRelPaths = new Set<string>();

  for (const d of activeDocs) {
    const dirName = d.folderId && folderPaths[d.folderId] ? folderPaths[d.folderId] : '';
    const format: 'md' | 'txt' = d.format === 'txt' ? 'txt' : 'md';
    const ext = format === 'txt' ? '.txt' : '.md';
    const baseTitle = sanitizeFsName(d.title, '无标题文档');

    let fileName = `${baseTitle}${ext}`;
    let relPath = dirName ? `${dirName}/${fileName}` : fileName;
    let suffix = 2;
    while (usedRelPaths.has(relPath.toLowerCase())) {
      fileName = `${baseTitle} (${suffix++})${ext}`;
      relPath = dirName ? `${dirName}/${fileName}` : fileName;
    }
    usedRelPaths.add(relPath.toLowerCase());

    docFiles[d.id] = {
      relPath,
      contentHash: d.contentHash || String(d.content.length),
      title: d.title,
      folderId: d.folderId && folderPaths[d.folderId] ? d.folderId : null,
      order: d.order,
      format,
      readProgress: d.readProgress ?? 0,
      lastCharOffset: d.lastCharOffset ?? 0,
      lastScrollTop: d.lastScrollTop ?? 0,
      lastReadAt: d.lastReadAt ?? null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }

  return { folderPaths, docFiles, folderMeta };
}

export function syncWorkspaceToLocalFs(
  folders: FolderNode[],
  docs: ArticleDoc[],
  config: StorageDirectoryConfig,
  options?: { forceFull?: boolean }
): Promise<{ ok: boolean; applied: number; skipped?: boolean; error?: string }> {
  const run = async (): Promise<{ ok: boolean; applied: number; skipped?: boolean; error?: string }> => {
    const isNative = isNativeLocalStorageAvailable();
    const isWebFs = !isNative && config.storageMode === 'web-fs';
    if (!config.initialized || (!isNative && !isWebFs)) {
      return { ok: true, applied: 0, skipped: true };
    }

    const forceFull = options?.forceFull === true;
    const prev = forceFull ? { folderPaths: {}, docFiles: {}, indexSig: '' } : loadSyncManifest();
    const { folderPaths, docFiles, folderMeta } = buildDesiredWorkspaceLayout(folders, docs);
    const docById = new Map<string, ArticleDoc>(docs.map((d) => [d.id, d]));

    const ops: FsBatchOp[] = [];
    const desiredDirs = new Set<string>(Object.values(folderPaths));

    // 1. Ensure all active folder directories exist on disk
    for (const dirName of desiredDirs) {
      if (forceFull || !Object.values(prev.folderPaths).includes(dirName)) {
        ops.push({ op: 'mkdir', path: dirName });
      }
    }

    // 2. Write new/changed/moved docs and delete stale old paths
    for (const [docId, meta] of Object.entries(docFiles)) {
      const prevEntry = prev.docFiles[docId];
      const docObj = docById.get(docId);
      if (!docObj) continue;

      const actualBytes = getByteSize(docObj.content);
      const needsWrite =
        forceFull ||
        !prevEntry ||
        prevEntry.relPath !== meta.relPath ||
        prevEntry.contentHash !== meta.contentHash ||
        prevEntry.writtenBytes !== actualBytes;

      if (needsWrite) {
        ops.push({
          op: 'write',
          path: meta.relPath,
          content: docObj.content,
        });
      }

      if (prevEntry && prevEntry.relPath && prevEntry.relPath !== meta.relPath) {
        ops.push({ op: 'delete', path: prevEntry.relPath });
      }
    }

    // 3. Remove files for deleted/trashed docs
    for (const [prevDocId, prevEntry] of Object.entries(prev.docFiles)) {
      if (!docFiles[prevDocId] && prevEntry.relPath) {
        ops.push({ op: 'delete', path: prevEntry.relPath });
      }
    }

    // 4. Remove old folders that are now empty and no longer active
    for (const prevDirName of new Set(Object.values(prev.folderPaths))) {
      if (prevDirName && !desiredDirs.has(prevDirName)) {
        ops.push({ op: 'rmdirIfEmpty', path: prevDirName });
      }
    }

    // 5. Write .feiartical-index.json when anything in metadata or files changed
    const indexPayload: LocalFsIndexFile = {
      version: 1,
      updatedAt: Date.now(),
      folderPaths,
      folderMeta,
      docFiles,
    };
    const indexSigPayload = JSON.stringify({ folderPaths, folderMeta, docFiles });
    if (forceFull || ops.length > 0 || indexSigPayload !== prev.indexSig) {
      ops.push({
        op: 'write',
        path: INDEX_FILE_NAME,
        content: JSON.stringify(indexPayload, null, 2),
      });
    }

    if (ops.length === 0) {
      return { ok: true, applied: 0 };
    }

    let result: { ok: boolean; applied?: number; fingerprint?: string; error?: string };
    if (isNative) {
      result = await LocalStorageNative.applyBatch({ ops });
    } else {
      result = await applyWebFsBatch(ops);
      if (result.ok) {
        const fp = await computeWebFsFingerprint();
        if (fp !== null) result.fingerprint = fp;
      }
    }

    if (result.ok) {
      if (typeof result.fingerprint === 'string') {
        lastObservedDiskFingerprint = result.fingerprint;
      }
      const nextManifest: SyncedManifestState = {
        folderPaths,
        docFiles: Object.fromEntries(
          Object.entries(docFiles).map(([id, m]) => {
            const docObj = docById.get(id);
            return [
              id,
              {
                relPath: m.relPath,
                contentHash: m.contentHash,
                writtenBytes: docObj ? getByteSize(docObj.content) : 0,
              },
            ];
          })
        ),
        indexSig: indexSigPayload,
      };
      saveSyncManifest(nextManifest);
      return { ok: true, applied: result.applied ?? ops.length };
    }

    return { ok: false, applied: 0, error: result.error };
  };

  const next = syncQueue.then(run, run);
  syncQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function stripDocExtension(fileName: string): string {
  return fileName.replace(/\.(md|markdown|txt)$/i, '').trim() || '无标题文档';
}

/**
 * Scan the bound phone/local folder for existing folders and .md/.txt files,
 * merging any disk documents that are not yet present in app state.
 */
export async function scanAndMergeFromLocalFs(
  existingFolders: FolderNode[],
  existingDocs: ArticleDoc[],
  config: StorageDirectoryConfig
): Promise<{
  folders: FolderNode[];
  docs: ArticleDoc[];
  importedFolderCount: number;
  importedDocCount: number;
}> {
  const isNative = isNativeLocalStorageAvailable();
  const isWebFs = !isNative && config.storageMode === 'web-fs';
  if (!config.initialized || (!isNative && !isWebFs)) {
    return {
      folders: existingFolders,
      docs: existingDocs,
      importedFolderCount: 0,
      importedDocCount: 0,
    };
  }

  const scan = isNative ? await LocalStorageNative.scanWorkspace() : await scanWebFsWorkspace();
  if (!scan.ok) {
    return {
      folders: existingFolders,
      docs: existingDocs,
      importedFolderCount: 0,
      importedDocCount: 0,
    };
  }

  let diskIndex: LocalFsIndexFile | null = null;
  if (scan.indexJson && scan.indexJson.trim()) {
    try {
      const parsed = JSON.parse(scan.indexJson) as Partial<LocalFsIndexFile>;
      if (parsed && parsed.version === 1) {
        diskIndex = {
          version: 1,
          updatedAt: parsed.updatedAt ?? Date.now(),
          folderPaths: parsed.folderPaths ?? {},
          folderMeta: Array.isArray(parsed.folderMeta) ? parsed.folderMeta : [],
          docFiles: parsed.docFiles ?? {},
        };
      }
    } catch {
      diskIndex = null;
    }
  }

  const nextFolders = existingFolders.slice();
  const nextDocs = existingDocs.slice();
  const folderByName = new Map<string, FolderNode>();
  const folderById = new Map<string, FolderNode>();

  for (const f of nextFolders) {
    folderById.set(f.id, f);
    if (!f.deleted) {
      folderByName.set(sanitizeFsName(f.name, '新建文件夹').toLowerCase(), f);
    }
  }

  // Map index dirName -> folderMeta
  const indexFolderMetaByDir = new Map<string, { id: string; name: string; order: number; updatedAt: number }>();
  if (diskIndex) {
    const metaById = new Map(diskIndex.folderMeta.map((m) => [m.id, m]));
    for (const [fid, dirName] of Object.entries(diskIndex.folderPaths)) {
      const m = metaById.get(fid);
      if (m) {
        indexFolderMetaByDir.set(dirName.toLowerCase(), m);
      }
    }
  }

  let importedFolderCount = 0;
  let maxFolderOrder = nextFolders.reduce((m, f) => Math.max(m, f.order), -1);
  const now = Date.now();

  for (const diskFolder of scan.folders ?? []) {
    const dirName = (diskFolder.name || '').trim();
    if (!dirName) continue;
    const key = dirName.toLowerCase();
    const indexed = indexFolderMetaByDir.get(key);
    if (indexed && folderById.has(indexed.id)) continue;
    if (folderByName.has(key)) continue;

    maxFolderOrder += 1;
    const newFolder: FolderNode = {
      id: indexed?.id || `folder_disk_${now}_${importedFolderCount}`,
      name: indexed?.name || dirName,
      parentId: null,
      order: indexed?.order ?? maxFolderOrder,
      updatedAt: indexed?.updatedAt ?? now,
    };
    nextFolders.push(newFolder);
    folderById.set(newFolder.id, newFolder);
    folderByName.set(key, newFolder);
    importedFolderCount += 1;
  }

  // Map index relPath -> docId & metadata
  const indexDocByRelPath = new Map<string, { id: string; meta: LocalFsIndexDocMeta }>();
  if (diskIndex) {
    for (const [docId, meta] of Object.entries(diskIndex.docFiles)) {
      if (meta?.relPath) {
        indexDocByRelPath.set(meta.relPath.toLowerCase(), { id: docId, meta });
      }
    }
  }

  const existingDocById = new Map<string, ArticleDoc>(nextDocs.map((d) => [d.id, d]));
  const existingDocSignature = new Set<string>(
    nextDocs
      .filter((d) => !d.deleted)
      .map((d) => {
        const f = d.folderId ? folderById.get(d.folderId) : null;
        const dir = f ? sanitizeFsName(f.name, '新建文件夹').toLowerCase() : '';
        const base = sanitizeFsName(d.title, '无标题文档').toLowerCase();
        return `${dir}/${base}.${d.format === 'txt' ? 'txt' : 'md'}`;
      })
  );

  let importedDocCount = 0;
  let maxDocOrder = nextDocs.reduce((m, d) => Math.max(m, d.order), -1);

  for (const file of scan.files ?? []) {
    const relKey = file.relPath.toLowerCase();
    const indexed = indexDocByRelPath.get(relKey);

    if (indexed && existingDocById.has(indexed.id)) {
      continue;
    }

    const folderNode = file.folderName ? folderByName.get(file.folderName.toLowerCase()) ?? null : null;
    const title = indexed?.meta.title || stripDocExtension(file.fileName);
    const sig = `${folderNode ? sanitizeFsName(folderNode.name, '新建文件夹').toLowerCase() : ''}/${sanitizeFsName(title, '无标题文档').toLowerCase()}.${file.format}`;
    if (existingDocSignature.has(sig)) {
      continue;
    }

    const content = file.content ?? '';
    const hash = await sha256Hex(content);
    const byteSize = getByteSize(content);
    const excerpt = extractExcerpt(content);
    maxDocOrder += 1;

    const newDoc: ArticleDoc = {
      id: indexed?.id || `doc_disk_${now}_${importedDocCount}`,
      title,
      folderId: folderNode ? folderNode.id : null,
      order: indexed?.meta.order ?? maxDocOrder,
      content,
      contentHash: hash,
      excerpt,
      tags: [],
      starred: false,
      readProgress: indexed?.meta.readProgress ?? 0,
      lastReadAt: indexed?.meta.lastReadAt ?? null,
      lastMode: 'read',
      lastScrollTop: indexed?.meta.lastScrollTop ?? 0,
      lastCharOffset: indexed?.meta.lastCharOffset ?? 0,
      format: file.format,
      createdAt: indexed?.meta.createdAt ?? (file.lastModified || now),
      updatedAt: indexed?.meta.updatedAt ?? (file.lastModified || now),
      syncStatus: 'dirty',
      highlights: [],
      byteSize,
    };

    nextDocs.push(newDoc);
    existingDocById.set(newDoc.id, newDoc);
    existingDocSignature.add(sig);
    importedDocCount += 1;
  }

  lastObservedDiskFingerprint = buildFingerprintFromScan(scan);

  return {
    folders: nextFolders,
    docs: nextDocs,
    importedFolderCount,
    importedDocCount,
  };
}

export interface ExternalDiskSyncResult {
  changed: boolean;
  folders: FolderNode[];
  docs: ArticleDoc[];
  updatedCount: number;
  addedCount: number;
  renamedCount: number;
  removedCount: number;
}

/**
 * Two-way external change pull: checks a lightweight metadata fingerprint first (< 5ms, no file reads)
 * and only performs a full scan + smart merge when another app modified, added, renamed, or deleted
 * files/folders in the bound local directory.
 */
export function checkAndPullExternalLocalFsChanges(
  existingFolders: FolderNode[],
  existingDocs: ArticleDoc[],
  config: StorageDirectoryConfig,
  options?: {
    protectedDocId?: string | null;
    forceScan?: boolean;
  }
): Promise<ExternalDiskSyncResult> {
  const run = async (): Promise<ExternalDiskSyncResult> => {
    const noop: ExternalDiskSyncResult = {
      changed: false,
      folders: existingFolders,
      docs: existingDocs,
      updatedCount: 0,
      addedCount: 0,
      renamedCount: 0,
      removedCount: 0,
    };

    const isNative = isNativeLocalStorageAvailable();
    const isWebFs = !isNative && config.storageMode === 'web-fs';
    if (!config.initialized || (!isNative && !isWebFs)) {
      return noop;
    }

    const currentFp = await getDiskWorkspaceFingerprint(config);
    if (currentFp === null) {
      return noop;
    }
    if (!options?.forceScan && lastObservedDiskFingerprint !== null && currentFp === lastObservedDiskFingerprint) {
      return noop;
    }

    const scan = isNative ? await LocalStorageNative.scanWorkspace() : await scanWebFsWorkspace();
    if (!scan.ok) {
      return noop;
    }

    lastObservedDiskFingerprint = buildFingerprintFromScan(scan);

    const prevManifest = loadSyncManifest();
    let diskIndex: LocalFsIndexFile | null = null;
    if (scan.indexJson && scan.indexJson.trim()) {
      try {
        const parsed = JSON.parse(scan.indexJson) as Partial<LocalFsIndexFile>;
        if (parsed && parsed.version === 1) {
          diskIndex = {
            version: 1,
            updatedAt: parsed.updatedAt ?? Date.now(),
            folderPaths: parsed.folderPaths ?? {},
            folderMeta: Array.isArray(parsed.folderMeta) ? parsed.folderMeta : [],
            docFiles: parsed.docFiles ?? {},
          };
        }
      } catch {
        diskIndex = null;
      }
    }

    const now = Date.now();
    const protectedDocId = options?.protectedDocId ?? null;
    const nextFolders = existingFolders.map((f) => ({ ...f }));
    const nextDocs = existingDocs.map((d) => ({ ...d }));

    const folderById = new Map<string, FolderNode>(nextFolders.map((f) => [f.id, f]));
    const folderByDirKey = new Map<string, FolderNode>();
    for (const f of nextFolders) {
      if (!f.deleted) {
        folderByDirKey.set(sanitizeFsName(f.name, '新建文件夹').toLowerCase(), f);
      }
    }

    const syncedFolderIdByDirKey = new Map<string, string>();
    for (const [fid, dirName] of Object.entries(prevManifest.folderPaths)) {
      if (dirName) syncedFolderIdByDirKey.set(dirName.toLowerCase(), fid);
    }

    const indexFolderMetaByDirKey = new Map<
      string,
      { id: string; name: string; order: number; updatedAt: number }
    >();
    if (diskIndex) {
      const metaById = new Map(diskIndex.folderMeta.map((m) => [m.id, m]));
      for (const [fid, dirName] of Object.entries(diskIndex.folderPaths)) {
        const m = metaById.get(fid);
        if (m) indexFolderMetaByDirKey.set(dirName.toLowerCase(), m);
      }
    }

    let changed = false;
    let updatedCount = 0;
    let addedCount = 0;
    let renamedCount = 0;
    let removedCount = 0;

    // 1. Reconcile folders present on disk
    const seenFolderIds = new Set<string>();
    let maxFolderOrder = nextFolders.reduce((m, f) => Math.max(m, f.order), -1);

    for (const diskFolder of scan.folders ?? []) {
      const dirName = (diskFolder.name || '').trim();
      if (!dirName) continue;
      const key = dirName.toLowerCase();

      const mappedId = syncedFolderIdByDirKey.get(key) || indexFolderMetaByDirKey.get(key)?.id;
      const existingById = mappedId ? folderById.get(mappedId) : undefined;
      if (existingById && !existingById.deleted) {
        seenFolderIds.add(existingById.id);
        folderByDirKey.set(key, existingById);
        continue;
      }

      const existingByName = folderByDirKey.get(key);
      if (existingByName && !existingByName.deleted) {
        seenFolderIds.add(existingByName.id);
        continue;
      }

      const indexedMeta = indexFolderMetaByDirKey.get(key);
      maxFolderOrder += 1;
      const created: FolderNode = {
        id: indexedMeta && !folderById.has(indexedMeta.id) ? indexedMeta.id : `folder_ext_${now}_${maxFolderOrder}`,
        name: indexedMeta?.name || dirName,
        parentId: null,
        order: indexedMeta?.order ?? maxFolderOrder,
        updatedAt: now,
      };
      nextFolders.push(created);
      folderById.set(created.id, created);
      folderByDirKey.set(key, created);
      seenFolderIds.add(created.id);
      changed = true;
    }

    // Build expected path lookup for active in-app docs
    const currentLayout = buildDesiredWorkspaceLayout(nextFolders, nextDocs);
    const docById = new Map<string, ArticleDoc>(nextDocs.map((d) => [d.id, d]));
    const docIdByRelKey = new Map<string, string>();

    for (const [docId, meta] of Object.entries(currentLayout.docFiles)) {
      docIdByRelKey.set(meta.relPath.toLowerCase(), docId);
    }
    for (const [docId, prevEntry] of Object.entries(prevManifest.docFiles)) {
      if (prevEntry.relPath && !docIdByRelKey.has(prevEntry.relPath.toLowerCase())) {
        const docObj = docById.get(docId);
        if (docObj && !docObj.deleted) {
          docIdByRelKey.set(prevEntry.relPath.toLowerCase(), docId);
        }
      }
    }

    const indexDocByRelKey = new Map<string, { id: string; meta: LocalFsIndexDocMeta }>();
    if (diskIndex) {
      for (const [docId, meta] of Object.entries(diskIndex.docFiles)) {
        if (meta?.relPath) {
          indexDocByRelKey.set(meta.relPath.toLowerCase(), { id: docId, meta });
        }
      }
    }

    const diskFiles = scan.files ?? [];
    const diskHashes = new Map<string, string>();
    for (const file of diskFiles) {
      diskHashes.set(file.relPath.toLowerCase(), await sha256Hex(file.content ?? ''));
    }

    const seenDocIds = new Set<string>();
    const unmatchedFiles: NativeScannedFile[] = [];

    // Pass 1: Match disk files by exact relative path & pull external content edits
    for (const file of diskFiles) {
      const relKey = file.relPath.toLowerCase();
      const matchedId = docIdByRelKey.get(relKey) ?? indexDocByRelKey.get(relKey)?.id;
      const existingDoc = matchedId ? docById.get(matchedId) : undefined;

      if (!existingDoc || existingDoc.deleted) {
        unmatchedFiles.push(file);
        continue;
      }

      seenDocIds.add(existingDoc.id);
      const diskContent = file.content ?? '';
      if (diskContent !== existingDoc.content) {
        if (existingDoc.id === protectedDocId) {
          continue;
        }
        const hash = diskHashes.get(relKey) || (await sha256Hex(diskContent));
        existingDoc.content = diskContent;
        existingDoc.contentHash = hash;
        existingDoc.byteSize = getByteSize(diskContent);
        existingDoc.excerpt = extractExcerpt(diskContent);
        existingDoc.updatedAt = Math.max(file.lastModified || now, existingDoc.updatedAt + 1);
        existingDoc.syncStatus = 'dirty';
        updatedCount += 1;
        changed = true;
      }
    }

    // Identify previously-synced active docs missing from their old disk path
    const missingSyncedDocs: ArticleDoc[] = [];
    for (const docId of Object.keys(prevManifest.docFiles)) {
      if (seenDocIds.has(docId)) continue;
      const docObj = docById.get(docId);
      if (!docObj || docObj.deleted || docObj.syncStatus === 'remote-only') continue;
      missingSyncedDocs.push(docObj);
    }

    // Pass 2: Detect external renames or moves by matching contentHash
    const stillUnmatchedFiles: NativeScannedFile[] = [];
    for (const file of unmatchedFiles) {
      const relKey = file.relPath.toLowerCase();
      const fileHash = diskHashes.get(relKey) || '';
      const renameIdx = missingSyncedDocs.findIndex(
        (d) => !seenDocIds.has(d.id) && d.contentHash && d.contentHash === fileHash
      );

      if (renameIdx !== -1) {
        const docObj = missingSyncedDocs[renameIdx];
        const targetFolder = file.folderName
          ? folderByDirKey.get(file.folderName.toLowerCase()) ?? null
          : null;
        docObj.title = stripDocExtension(file.fileName);
        docObj.folderId = targetFolder ? targetFolder.id : null;
        docObj.format = file.format;
        docObj.updatedAt = Math.max(file.lastModified || now, docObj.updatedAt + 1);
        docObj.syncStatus = 'dirty';
        seenDocIds.add(docObj.id);
        renamedCount += 1;
        changed = true;
      } else {
        stillUnmatchedFiles.push(file);
      }
    }

    // Pass 3: Import genuinely new external files
    let maxDocOrder = nextDocs.reduce((m, d) => Math.max(m, d.order), -1);
    for (const file of stillUnmatchedFiles) {
      const relKey = file.relPath.toLowerCase();
      const indexed = indexDocByRelKey.get(relKey);
      const targetFolder = file.folderName
        ? folderByDirKey.get(file.folderName.toLowerCase()) ?? null
        : null;
      const content = file.content ?? '';
      const hash = diskHashes.get(relKey) || (await sha256Hex(content));
      maxDocOrder += 1;

      const created: ArticleDoc = {
        id:
          indexed && !docById.has(indexed.id)
            ? indexed.id
            : `doc_ext_${now}_${maxDocOrder}`,
        title: indexed?.meta.title || stripDocExtension(file.fileName),
        folderId: targetFolder ? targetFolder.id : null,
        order: indexed?.meta.order ?? maxDocOrder,
        content,
        contentHash: hash,
        excerpt: extractExcerpt(content),
        tags: [],
        starred: false,
        readProgress: indexed?.meta.readProgress ?? 0,
        lastReadAt: indexed?.meta.lastReadAt ?? null,
        lastMode: 'read',
        lastScrollTop: indexed?.meta.lastScrollTop ?? 0,
        lastCharOffset: indexed?.meta.lastCharOffset ?? 0,
        format: file.format,
        createdAt: indexed?.meta.createdAt ?? (file.lastModified || now),
        updatedAt: indexed?.meta.updatedAt ?? (file.lastModified || now),
        syncStatus: 'dirty',
        highlights: [],
        byteSize: getByteSize(content),
      };

      nextDocs.push(created);
      docById.set(created.id, created);
      seenDocIds.add(created.id);
      addedCount += 1;
      changed = true;
    }

    // Pass 4: Soft-delete docs & empty folders that were previously synced and removed externally
    for (const docObj of missingSyncedDocs) {
      if (seenDocIds.has(docObj.id)) continue;
      if (docObj.id === protectedDocId) continue;
      docObj.deleted = true;
      docObj.deletedAt = now;
      docObj.updatedAt = now;
      docObj.syncStatus = 'dirty';
      removedCount += 1;
      changed = true;
    }

    for (const prevFolderId of Object.keys(prevManifest.folderPaths)) {
      if (seenFolderIds.has(prevFolderId)) continue;
      const folderObj = folderById.get(prevFolderId);
      if (!folderObj || folderObj.deleted) continue;
      const hasRemainingActiveDocs = nextDocs.some(
        (d) => !d.deleted && d.folderId === prevFolderId
      );
      if (!hasRemainingActiveDocs) {
        folderObj.deleted = true;
        folderObj.deletedAt = now;
        folderObj.updatedAt = now;
        changed = true;
      }
    }

    if (changed) {
      const updatedLayout = buildDesiredWorkspaceLayout(nextFolders, nextDocs);
      const nextManifest: SyncedManifestState = {
        folderPaths: updatedLayout.folderPaths,
        docFiles: Object.fromEntries(
          Object.entries(updatedLayout.docFiles).map(([id, m]) => {
            const docObj = docById.get(id);
            return [
              id,
              {
                relPath: m.relPath,
                contentHash: m.contentHash,
                writtenBytes: docObj ? getByteSize(docObj.content) : 0,
              },
            ];
          })
        ),
        indexSig: JSON.stringify({
          folderPaths: updatedLayout.folderPaths,
          folderMeta: updatedLayout.folderMeta,
          docFiles: updatedLayout.docFiles,
        }),
      };
      saveSyncManifest(nextManifest);
    }

    return {
      changed,
      folders: changed ? nextFolders : existingFolders,
      docs: changed ? nextDocs : existingDocs,
      updatedCount,
      addedCount,
      renamedCount,
      removedCount,
    };
  };

  const next = syncQueue.then(run, run);
  syncQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

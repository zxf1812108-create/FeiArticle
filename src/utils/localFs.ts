import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { ArticleDoc, FolderNode } from '../types';
import { LocalStorageBackendMode, StorageDirectoryConfig } from './storage';
import { extractExcerpt, getByteSize, sha256Hex } from './textParser';
import { extractReadAnchorText, relocateCharOffsetByAnchor } from './progressSync';

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
  writeBinaryFile(options: {
    path: string;
    base64: string;
  }): Promise<{ ok: boolean; error?: string }>;
  readBinaryFile(options: {
    path: string;
  }): Promise<{ ok: boolean; base64?: string; mimeType?: string; notFound?: boolean; error?: string }>;
  listBinaryFiles(options?: {
    prefix?: string;
  }): Promise<{
    ok: boolean;
    files?: Array<{ relPath: string; size: number; lastModified: number }>;
    error?: string;
  }>;
  addListener(
    eventName: 'workspaceResume',
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
}

const LocalStorageNative = registerPlugin<LocalStorageNativePlugin>('LocalStorageNative');

export const LOCAL_IMAGES_DIR_NAME = 'images';

export function isReservedMediaDirName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.trim().toLowerCase();
  return lower === 'images' || lower === 'assets';
}

const INDEX_FILE_NAME = '.feiartical-index.json';
const SYNC_MANIFEST_STORAGE_KEY = 'feiartical_local_fs_manifest_v1';
const WEB_FS_DB_NAME = 'feiartical_local_fs_db';
const WEB_FS_STORE_NAME = 'handles';
const WEB_FS_ROOT_KEY = 'root_dir_handle';
const LOCAL_IMAGES_IDB_NAME = 'feiartical_local_images_v1';
const LOCAL_IMAGES_IDB_STORE = 'images';

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
  readAnchorText?: string;
  lastSyncedCharOffset?: number;
  lastSyncedProgress?: number;
  lastSyncedReadAt?: number;
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
        if (isReservedMediaDirName(name)) continue;
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
        if (isReservedMediaDirName(name)) continue;
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
  const usedDirNames = new Set<string>(['images', 'assets']);
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
      readAnchorText: d.readAnchorText,
      lastSyncedCharOffset: d.lastSyncedCharOffset,
      lastSyncedProgress: d.lastSyncedProgress,
      lastSyncedReadAt: d.lastSyncedReadAt,
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
    if (!dirName || isReservedMediaDirName(dirName)) continue;
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
      readAnchorText: indexed?.meta.readAnchorText,
      lastSyncedCharOffset: indexed?.meta.lastSyncedCharOffset,
      lastSyncedProgress: indexed?.meta.lastSyncedProgress,
      lastSyncedReadAt: indexed?.meta.lastSyncedReadAt,
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
        const prevContent = existingDoc.content || '';
        const prevOffset = Math.max(0, Math.round(existingDoc.lastCharOffset ?? 0));
        const hasProgress = prevOffset > 0 || (existingDoc.readProgress ?? 0) > 0;
        const anchorBeforeEdit =
          existingDoc.readAnchorText ||
          (prevContent && hasProgress ? extractReadAnchorText(prevContent, prevOffset) : '');

        const hash = diskHashes.get(relKey) || (await sha256Hex(diskContent));
        existingDoc.content = diskContent;
        existingDoc.contentHash = hash;
        existingDoc.byteSize = getByteSize(diskContent);
        existingDoc.excerpt = extractExcerpt(diskContent);
        existingDoc.updatedAt = Math.max(file.lastModified || now, existingDoc.updatedAt + 1);
        existingDoc.syncStatus = 'dirty';

        if (hasProgress && diskContent.length > 0) {
          const relocated = relocateCharOffsetByAnchor(diskContent, prevOffset, anchorBeforeEdit);
          existingDoc.lastCharOffset = relocated.offset;
          existingDoc.readProgress = relocated.progress;
          existingDoc.lastScrollTop = 0;
          existingDoc.readAnchorText =
            extractReadAnchorText(diskContent, relocated.offset) || anchorBeforeEdit || undefined;
        }
        if (existingDoc.pendingRemoteProgress && diskContent.length > 0) {
          const p = existingDoc.pendingRemoteProgress;
          const relocatedPending = relocateCharOffsetByAnchor(
            diskContent,
            p.lastCharOffset,
            p.anchorText
          );
          if (relocatedPending.matched) {
            existingDoc.pendingRemoteProgress = {
              ...p,
              lastCharOffset: relocatedPending.offset,
              readProgress: relocatedPending.progress,
            };
          }
        }

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
        readAnchorText: indexed?.meta.readAnchorText,
        lastSyncedCharOffset: indexed?.meta.lastSyncedCharOffset,
        lastSyncedProgress: indexed?.meta.lastSyncedProgress,
        lastSyncedReadAt: indexed?.meta.lastSyncedReadAt,
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

// ---------------------------------------------------------------------------
// Local-only image storage & resolution (never synced to WebDAV / Jianguoyun)
// ---------------------------------------------------------------------------

export interface LocalBinaryImageFile {
  relPath: string;
  mimeType: string;
  bytes: Uint8Array;
}

function normalizeImageRelPath(raw: string): string {
  let cleaned = (raw || '').trim().replace(/\\/g, '/');
  // Strip wrapping angle brackets if present from Markdown (<images/foo bar.jpg>)
  if (cleaned.startsWith('<') && cleaned.endsWith('>')) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  // Drop query/hash fragments for local file resolution
  cleaned = cleaned.split(/[?#]/)[0];
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Keep original if malformed percent-encoding
  }
  const parts = cleaned.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    const seg = part.trim();
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      // Collapse leading ../ (e.g. "../images/book/001.jpg" from a subfolder doc -> "images/book/001.jpg")
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}

function guessImageMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function openLocalImagesIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(LOCAL_IMAGES_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOCAL_IMAGES_IDB_STORE)) {
        db.createObjectStore(LOCAL_IMAGES_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open local images db'));
  });
}

async function putImageInIdb(relPath: string, mimeType: string, bytes: Uint8Array): Promise<void> {
  try {
    const db = await openLocalImagesIdb();
    const key = normalizeImageRelPath(relPath).toLowerCase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LOCAL_IMAGES_IDB_STORE, 'readwrite');
      tx.objectStore(LOCAL_IMAGES_IDB_STORE).put({ mimeType, bytes }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to store image in IDB'));
    });
    db.close();
  } catch {
    // Ignore IDB storage failures
  }
}

async function getImageFromIdb(
  relPath: string
): Promise<{ mimeType: string; bytes: Uint8Array } | null> {
  try {
    const db = await openLocalImagesIdb();
    const key = normalizeImageRelPath(relPath).toLowerCase();
    const record = await new Promise<
      { mimeType?: string; bytes?: Uint8Array | ArrayBuffer } | undefined
    >((resolve, reject) => {
      const tx = db.transaction(LOCAL_IMAGES_IDB_STORE, 'readonly');
      const req = tx.objectStore(LOCAL_IMAGES_IDB_STORE).get(key);
      req.onsuccess = () =>
        resolve(req.result as { mimeType?: string; bytes?: Uint8Array | ArrayBuffer } | undefined);
      req.onerror = () => reject(req.error || new Error('Failed to read image from IDB'));
    });
    db.close();
    if (!record || !record.bytes) return null;
    const bytes =
      record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes);
    return {
      mimeType: record.mimeType || guessImageMimeType(relPath),
      bytes,
    };
  } catch {
    return null;
  }
}

async function writeWebFsBinaryFile(relPath: string, bytes: Uint8Array): Promise<boolean> {
  const root = await loadWebDirHandle();
  if (!root) return false;
  const writable = await ensureWebHandleWritable(root, false);
  if (!writable) return false;

  const clean = normalizeImageRelPath(relPath);
  if (!clean) return false;
  const parts = clean.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return false;

  try {
    let dir = root;
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    const fh = await dir.getFileHandle(fileName, { create: true });
    const stream = await fh.createWritable();
    await stream.write(bytes);
    await stream.close();
    return true;
  } catch {
    return false;
  }
}

async function readWebFsBinaryFile(relPath: string): Promise<File | null> {
  const root = await loadWebDirHandle();
  if (!root) return null;
  const permitted = await ensureWebHandleWritable(root, false);
  if (!permitted) return null;

  const clean = normalizeImageRelPath(relPath);
  if (!clean) return null;
  const parts = clean.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return null;

  try {
    let dir = root;
    for (const seg of parts) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create: false });
      } catch {
        // Case-insensitive directory lookup fallback
        let matched: WebFileSystemDirectoryHandle | null = null;
        for await (const [entryName, handle] of dir.entries()) {
          if (handle.kind === 'directory' && entryName.toLowerCase() === seg.toLowerCase()) {
            matched = handle;
            break;
          }
        }
        if (!matched) return null;
        dir = matched;
      }
    }
    try {
      const fh = await dir.getFileHandle(fileName, { create: false });
      return await fh.getFile();
    } catch {
      for await (const [entryName, handle] of dir.entries()) {
        if (handle.kind === 'file' && entryName.toLowerCase() === fileName.toLowerCase()) {
          return await handle.getFile();
        }
      }
      return null;
    }
  } catch {
    return null;
  }
}

// Bounded LRU cache for resolved blob: object URLs (prevents memory leaks on E-Ink devices)
const MAX_CACHED_IMAGE_URLS = 100;
const resolvedImageUrlCache = new Map<string, string>();

function getCachedImageUrl(key: string): string | null {
  const existing = resolvedImageUrlCache.get(key);
  if (!existing) return null;
  // Refresh LRU recency
  resolvedImageUrlCache.delete(key);
  resolvedImageUrlCache.set(key, existing);
  return existing;
}

function setCachedImageUrl(key: string, blobUrl: string): void {
  const prev = resolvedImageUrlCache.get(key);
  if (prev && prev !== blobUrl && prev.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(prev);
    } catch {
      // ignore
    }
  }
  resolvedImageUrlCache.delete(key);
  resolvedImageUrlCache.set(key, blobUrl);
  while (resolvedImageUrlCache.size > MAX_CACHED_IMAGE_URLS) {
    const oldestKey = resolvedImageUrlCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestUrl = resolvedImageUrlCache.get(oldestKey);
    resolvedImageUrlCache.delete(oldestKey);
    if (oldestUrl && oldestUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(oldestUrl);
      } catch {
        // ignore
      }
    }
  }
}

export function invalidateLocalImageCache(rawSrc?: string): void {
  if (!rawSrc) {
    for (const url of resolvedImageUrlCache.values()) {
      if (url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
    resolvedImageUrlCache.clear();
    return;
  }
  const norm = normalizeImageRelPath(rawSrc).toLowerCase();
  for (const [k, url] of Array.from(resolvedImageUrlCache.entries())) {
    if (k === norm || k.endsWith(`/${norm}`) || k.includes(norm)) {
      resolvedImageUrlCache.delete(k);
      if (url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
  }
}

/**
 * Save extracted ebook images directly to the local images/ folder (never synced via WebDAV).
 * Falls back to IndexedDB in browser-only preview mode so images still render immediately.
 */
export async function saveLocalImageFiles(
  images: LocalBinaryImageFile[],
  config: StorageDirectoryConfig
): Promise<{ savedCount: number; failedCount: number; target: 'local-fs' | 'browser-cache' }> {
  if (!images || images.length === 0) {
    return { savedCount: 0, failedCount: 0, target: 'local-fs' };
  }

  const isNative = isNativeLocalStorageAvailable();
  const isWebFs = !isNative && config.storageMode === 'web-fs';
  const useRealFs = config.initialized && (isNative || isWebFs);

  let savedCount = 0;
  let failedCount = 0;

  for (const img of images) {
    const cleanRel = normalizeImageRelPath(img.relPath);
    if (!cleanRel || !img.bytes || img.bytes.length === 0) continue;

    invalidateLocalImageCache(cleanRel);

    if (useRealFs && isNative) {
      try {
        const res = await LocalStorageNative.writeBinaryFile({
          path: cleanRel,
          base64: bytesToBase64(img.bytes),
        });
        if (res.ok) {
          savedCount += 1;
        } else {
          failedCount += 1;
        }
      } catch {
        failedCount += 1;
      }
    } else if (useRealFs && isWebFs) {
      const ok = await writeWebFsBinaryFile(cleanRel, img.bytes);
      if (ok) {
        savedCount += 1;
      } else {
        failedCount += 1;
      }
    } else {
      await putImageInIdb(cleanRel, img.mimeType || guessImageMimeType(cleanRel), img.bytes);
      savedCount += 1;
    }
  }

  return {
    savedCount,
    failedCount,
    target: useRealFs ? 'local-fs' : 'browser-cache',
  };
}

/**
 * Resolve a Markdown image src to a displayable URL (external URL, data URL, or local file blob URL).
 */
export async function resolveLocalImageUrl(
  rawSrc: string,
  config: StorageDirectoryConfig,
  options?: { docFolderName?: string | null; bypassCache?: boolean }
): Promise<{ url: string; displayPath: string } | null> {
  const trimmed = (rawSrc || '').trim();
  if (!trimmed) return null;

  // Allow external HTTP(S) images and inline data:image URLs directly
  if (/^(?:https?:\/\/|data:image\/)/i.test(trimmed)) {
    return { url: trimmed, displayPath: trimmed };
  }
  // Reject unsafe schemes (javascript:, file:, etc.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  }

  const normalized = normalizeImageRelPath(trimmed);
  if (!normalized) return null;

  const candidates: string[] = [normalized];
  const lowerNorm = normalized.toLowerCase();
  const startsWithMediaRoot =
    lowerNorm.startsWith(`${LOCAL_IMAGES_DIR_NAME}/`) || lowerNorm.startsWith('assets/');

  if (!startsWithMediaRoot) {
    if (options?.docFolderName) {
      const safeFolder = sanitizeFsName(options.docFolderName, '');
      if (safeFolder) {
        candidates.push(`${safeFolder}/${normalized}`);
      }
    }
    candidates.push(`${LOCAL_IMAGES_DIR_NAME}/${normalized}`);
  }

  if (options?.bypassCache) {
    for (const c of candidates) {
      invalidateLocalImageCache(c);
    }
  } else {
    for (const c of candidates) {
      const cached = getCachedImageUrl(c.toLowerCase());
      if (cached) {
        return { url: cached, displayPath: c };
      }
    }
  }

  const isNative = isNativeLocalStorageAvailable();
  const isWebFs = !isNative && config.storageMode === 'web-fs';

  if (config.initialized && isNative) {
    for (const candidate of candidates) {
      try {
        const res = await LocalStorageNative.readBinaryFile({ path: candidate });
        if (res.ok && res.base64) {
          const bytes = base64ToUint8Array(res.base64);
          const mime = res.mimeType || guessImageMimeType(candidate);
          const blobUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: mime }));
          setCachedImageUrl(candidate.toLowerCase(), blobUrl);
          return { url: blobUrl, displayPath: candidate };
        }
      } catch {
        // Try next candidate
      }
    }
  } else if (config.initialized && isWebFs) {
    for (const candidate of candidates) {
      const file = await readWebFsBinaryFile(candidate);
      if (file) {
        const blobUrl = URL.createObjectURL(file);
        setCachedImageUrl(candidate.toLowerCase(), blobUrl);
        return { url: blobUrl, displayPath: candidate };
      }
    }
  }

  // Fallback to IndexedDB local image cache (used in browser-only mode)
  for (const candidate of candidates) {
    const idbImg = await getImageFromIdb(candidate);
    if (idbImg) {
      const blobUrl = URL.createObjectURL(
        new Blob([idbImg.bytes.buffer as ArrayBuffer], { type: idbImg.mimeType })
      );
      setCachedImageUrl(candidate.toLowerCase(), blobUrl);
      return { url: blobUrl, displayPath: candidate };
    }
  }

  return null;
}

export interface LocalImageFileMeta {
  relPath: string;
  size: number;
  lastModified: number;
}

async function listWebFsImagesRecursive(
  dir: WebFileSystemDirectoryHandle,
  currentRel: string,
  out: LocalImageFileMeta[],
  depth = 0
): Promise<void> {
  if (depth > 8) return;
  for await (const [name, handle] of dir.entries()) {
    if (!name || name.startsWith('.')) continue;
    const nextRel = currentRel ? `${currentRel}/${name}` : name;
    if (handle.kind === 'directory') {
      await listWebFsImagesRecursive(handle, nextRel, out, depth + 1);
    } else if (handle.kind === 'file') {
      try {
        const f = await handle.getFile();
        if (f.size > 0) {
          out.push({ relPath: nextRel, size: f.size, lastModified: f.lastModified || 0 });
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }
}

export async function listLocalImageFiles(
  config: StorageDirectoryConfig
): Promise<LocalImageFileMeta[]> {
  const isNative = isNativeLocalStorageAvailable();
  if (config.initialized && isNative) {
    try {
      const res = await LocalStorageNative.listBinaryFiles({ prefix: LOCAL_IMAGES_DIR_NAME });
      if (res.ok && Array.isArray(res.files)) {
        return res.files.filter((f) => f && typeof f.relPath === 'string' && f.size > 0);
      }
    } catch {
      return [];
    }
    return [];
  }

  const isWebFs = !isNative && config.storageMode === 'web-fs';
  if (config.initialized && isWebFs) {
    try {
      const root = cachedWebDirHandle ?? (await loadWebDirHandle());
      if (!root) return [];
      const perm = await root.queryPermission?.({ mode: 'read' });
      if (perm && perm !== 'granted') return [];
      const imgDir = await root.getDirectoryHandle(LOCAL_IMAGES_DIR_NAME, { create: false });
      const out: LocalImageFileMeta[] = [];
      await listWebFsImagesRecursive(imgDir, LOCAL_IMAGES_DIR_NAME, out, 0);
      return out;
    } catch {
      return [];
    }
  }

  return [];
}



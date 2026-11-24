import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { ArticleDoc, FolderNode, PurgedSyncRecords, SyncedTreeState } from '../types';
import { invalidateLocalImageCache, listLocalImageFiles, LocalImageFileMeta } from './localFs';
import { StorageDirectoryConfig } from './storage';
import { extractExcerpt, getByteSize, sha256Hex } from './textParser';
import { isTrashExpired, purgeExpiredTrash } from './trash';
import { isDocBodyMissing } from './webdavSync';
import {
  extractReadAnchorText,
  reconcileReadingProgress,
  relocateCharOffsetByAnchor,
  resolveComparableProgressPercent,
} from './progressSync';

export const DEFAULT_WIFI_SYNC_PORT = 48765;

export interface WifiPeer {
  id: string;
  name: string;
  ip: string;
  port: number;
  stateHash?: string;
}

export interface WifiServerInfo {
  running: boolean;
  ip: string;
  port: number;
  deviceName: string;
  instanceId: string;
}

export interface WifiDocCatalogMeta {
  id: string;
  title: string;
  folderId: string | null;
  order: number;
  contentHash: string;
  excerpt: string;
  tags: string[];
  starred: boolean;
  readProgress: number;
  lastReadAt: number | null;
  lastMode?: 'read' | 'edit';
  lastScrollTop?: number;
  lastCharOffset?: number;
  readAnchorText?: string;
  progressOverrideAt?: number;
  encrypted?: boolean;
  format?: 'txt' | 'md';
  cloudBodySynced?: boolean;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
  deletedAt?: number;
  deletedByFolderId?: string;
  byteSize: number;
  hasBody: boolean;
}

export interface WifiCatalogSnapshot {
  folders: FolderNode[];
  docs: WifiDocCatalogMeta[];
  treeState: SyncedTreeState;
  purgedRecords?: PurgedSyncRecords;
  cloudConfigured?: boolean;
}

export interface WifiDocBodyPayload {
  id: string;
  content: string;
  contentHash: string;
  updatedAt: number;
  byteSize: number;
  format?: 'txt' | 'md';
}

export interface WifiSyncProgress {
  phase: 'connecting' | 'catalog' | 'docs' | 'images' | 'done';
  label: string;
  completed: number;
  total: number;
}

export interface WifiSyncSummary {
  peerName: string;
  pulledDocs: number;
  pushedDocs: number;
  pulledImages: number;
  pushedImages: number;
  catalogUpdated: boolean;
  peerCloudConfigured: boolean;
}

interface WifiSyncNativePlugin {
  startServer(options: {
    password: string;
    deviceName?: string;
    port?: number;
    stateHash?: string;
  }): Promise<WifiServerInfo>;
  stopServer(): Promise<{ running: boolean }>;
  updateStateHash(options: { stateHash: string }): Promise<{ ok: boolean }>;
  resolveServerRequest(options: {
    reqId: string;
    ok: boolean;
    payloadJson: string;
  }): Promise<{ ok: boolean }>;
  peerConnect(options: {
    host: string;
    port: number;
    password: string;
  }): Promise<{ ok: boolean; sessionId: string; deviceName: string }>;
  peerRpc(options: {
    sessionId: string;
    action: string;
    payloadJson: string;
  }): Promise<{ ok: boolean; payloadJson: string }>;
  peerPullImage(options: {
    sessionId: string;
    relPath: string;
  }): Promise<{ ok: boolean; bytes?: number; error?: string }>;
  peerPushImage(options: {
    sessionId: string;
    relPath: string;
  }): Promise<{ ok: boolean; bytes?: number; error?: string }>;
  peerDisconnect(options: { sessionId: string }): Promise<{ ok: boolean }>;
  addListener(
    eventName: 'wifiPeers',
    listenerFunc: (data: { peers: WifiPeer[] }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'wifiServerRequest',
    listenerFunc: (data: { reqId: string; action: string; payloadJson: string }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'wifiImageReceived',
    listenerFunc: (data: { relPath: string }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'wifiIncomingSync',
    listenerFunc: (data: { status: 'start' | 'end' }) => void
  ): Promise<PluginListenerHandle>;
}

const WifiSyncNative = registerPlugin<WifiSyncNativePlugin>('WifiSyncNative');

export function isWifiSyncNativeAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('WifiSyncNative');
}

export async function updateWifiSyncStateHash(stateHash: string): Promise<void> {
  if (!isWifiSyncNativeAvailable()) return;
  await WifiSyncNative.updateStateHash({ stateHash }).catch(() => {});
}

/**
 * Deterministic compact fingerprint covering folders, docs metadata/progress/body availability,
 * and local images/ sizes. Converges identically on both peers immediately after sync so
 * auto-discovery can detect real divergence with zero network traffic when already in sync.
 */
export async function computeWifiSyncFingerprint(
  folders: FolderNode[],
  docs: ArticleDoc[],
  storageDir: StorageDirectoryConfig
): Promise<string> {
  const now = Date.now();
  const folderParts = folders
    .filter((f) => !isTrashExpired(f, now))
    .map(
      (f) =>
        `${f.id}|${f.name}|${f.order}|${f.updatedAt}|${f.deleted ? 1 : 0}|${
          f.deleted ? f.deletedAt || 0 : 0
        }`
    )
    .sort();

  const docParts = docs
    .filter((d) => !isTrashExpired(d, now))
    .map((d) => {
      const hasBody = !d.deleted && !isDocBodyMissing(d) ? 1 : 0;
      const progressRounded = Math.round((d.readProgress || 0) * 1000);
      const charOffset = Math.max(0, Math.round(d.lastCharOffset || 0));
      const lastRead = d.lastReadAt || 0;
      const overrideAt = d.progressOverrideAt || 0;
      return `${d.id}|${d.title}|${d.folderId || ''}|${d.order}|${d.contentHash || ''}|${hasBody}|${progressRounded}|${charOffset}|${lastRead}|${overrideAt}|${
        d.encrypted ? 1 : 0
      }|${d.format || 'txt'}|${d.updatedAt}|${d.deleted ? 1 : 0}|${
        d.deleted ? d.deletedAt || 0 : 0
      }`;
    })
    .sort();

  const localImages = await listLocalImageFiles(storageDir).catch(() => [] as LocalImageFileMeta[]);
  const imageParts = localImages
    .map((img) => `${img.relPath.toLowerCase()}|${img.size}`)
    .sort();

  const raw = `F:${folderParts.join(';')}\nD:${docParts.join(';')}\nI:${imageParts.join(';')}`;
  const fullHash = await sha256Hex(raw);
  return fullHash.slice(0, 16);
}

export function buildWifiCatalogSnapshot(
  folders: FolderNode[],
  docs: ArticleDoc[],
  treeState: SyncedTreeState,
  purgedRecords?: PurgedSyncRecords,
  cloudConfigured?: boolean
): WifiCatalogSnapshot {
  return {
    folders,
    docs: docs.map((d) => ({
      id: d.id,
      title: d.title,
      folderId: d.folderId,
      order: d.order,
      contentHash: d.contentHash,
      excerpt: d.encrypted ? '' : d.excerpt,
      tags: d.tags || [],
      starred: Boolean(d.starred),
      readProgress: d.readProgress ?? 0,
      lastReadAt: d.lastReadAt ?? null,
      lastMode: d.lastMode ?? 'read',
      lastScrollTop: d.lastScrollTop ?? 0,
      lastCharOffset: d.lastCharOffset ?? 0,
      readAnchorText: d.encrypted
        ? undefined
        : d.readAnchorText ||
          (d.content ? extractReadAnchorText(d.content, d.lastCharOffset ?? 0) : undefined) ||
          undefined,
      progressOverrideAt: d.progressOverrideAt || undefined,
      encrypted: Boolean(d.encrypted),
      format: d.format ?? 'txt',
      cloudBodySynced: Boolean(d.cloudBodySynced),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      deleted: d.deleted,
      deletedAt: d.deletedAt,
      deletedByFolderId: d.deletedByFolderId,
      byteSize: d.byteSize ?? 0,
      hasBody: !d.deleted && !isDocBodyMissing(d),
    })),
    treeState,
    purgedRecords,
    cloudConfigured: Boolean(cloudConfigured),
  };
}

function pendingWifiProgressEqual(
  a?: ArticleDoc['pendingRemoteProgress'],
  b?: ArticleDoc['pendingRemoteProgress']
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    Math.round(a.lastCharOffset) === Math.round(b.lastCharOffset) &&
    Math.round(a.readProgress * 1000) === Math.round(b.readProgress * 1000) &&
    a.lastReadAt === b.lastReadAt &&
    (a.anchorText || '') === (b.anchorText || '') &&
    a.source === b.source
  );
}

/**
 * Pure LWW merge of local state with a peer's catalog snapshot (folders, catalog metadata,
 * reading progress, and tree state). Preserves local document bodies intact.
 */
export function mergeWifiCatalogIntoLocal(
  localFolders: FolderNode[],
  localDocs: ArticleDoc[],
  localTreeState: SyncedTreeState,
  localPurged: PurgedSyncRecords | undefined,
  peerSnapshot: WifiCatalogSnapshot
): {
  folders: FolderNode[];
  docs: ArticleDoc[];
  treeState: SyncedTreeState;
  changed: boolean;
} {
  const now = Date.now();
  let changed = false;

  // Combine purge tombstones from both peers
  const mergedPurgedDocs: Record<string, number> = { ...(localPurged?.docs || {}) };
  if (peerSnapshot.purgedRecords?.docs) {
    for (const [id, ts] of Object.entries(peerSnapshot.purgedRecords.docs)) {
      if (!mergedPurgedDocs[id] || ts > mergedPurgedDocs[id]) {
        mergedPurgedDocs[id] = ts;
      }
    }
  }
  const mergedPurgedFolders: Record<string, number> = { ...(localPurged?.folders || {}) };
  if (peerSnapshot.purgedRecords?.folders) {
    for (const [id, ts] of Object.entries(peerSnapshot.purgedRecords.folders)) {
      if (!mergedPurgedFolders[id] || ts > mergedPurgedFolders[id]) {
        mergedPurgedFolders[id] = ts;
      }
    }
  }

  // Merge folders (LWW)
  const folderMap = new Map<string, FolderNode>();
  for (const lf of localFolders) {
    const purgedAt = mergedPurgedFolders[lf.id];
    if (purgedAt && purgedAt >= lf.updatedAt) {
      changed = true;
      continue;
    }
    folderMap.set(lf.id, { ...lf, parentId: null });
  }
  for (const pf of peerSnapshot.folders || []) {
    const purgedAt = mergedPurgedFolders[pf.id];
    if ((purgedAt && purgedAt >= pf.updatedAt) || isTrashExpired(pf, now)) continue;
    const lf = folderMap.get(pf.id);
    if (!lf || pf.updatedAt > lf.updatedAt) {
      folderMap.set(pf.id, { ...pf, parentId: null });
      changed = true;
    }
  }

  // Merge tree state (LWW)
  let mergedTreeState = localTreeState;
  if (peerSnapshot.treeState && peerSnapshot.treeState.updatedAt > localTreeState.updatedAt) {
    mergedTreeState = {
      collapsedIds: Array.isArray(peerSnapshot.treeState.collapsedIds)
        ? peerSnapshot.treeState.collapsedIds
        : [],
      activeTarget: peerSnapshot.treeState.activeTarget ?? null,
      scrollTop: typeof peerSnapshot.treeState.scrollTop === 'number' ? peerSnapshot.treeState.scrollTop : 0,
      updatedAt: peerSnapshot.treeState.updatedAt,
    };
    changed = true;
  }

  // Merge docs metadata & reading progress (keeping existing local bodies)
  const docMap = new Map<string, ArticleDoc>();
  for (const ld of localDocs) {
    const purgedAt = mergedPurgedDocs[ld.id];
    if (purgedAt && purgedAt >= ld.updatedAt) {
      changed = true;
      continue;
    }
    docMap.set(ld.id, { ...ld });
  }

  for (const pd of peerSnapshot.docs || []) {
    const purgedAt = mergedPurgedDocs[pd.id];
    if ((purgedAt && purgedAt >= pd.updatedAt) || isTrashExpired(pd, now)) continue;
    const ld = docMap.get(pd.id);
    if (!ld) {
      docMap.set(pd.id, {
        id: pd.id,
        title: pd.title,
        folderId: pd.folderId,
        order: pd.order,
        content: '',
        contentHash: pd.contentHash,
        excerpt: pd.encrypted ? '' : pd.excerpt || '',
        tags: pd.tags || [],
        starred: Boolean(pd.starred),
        readProgress: pd.readProgress ?? 0,
        lastReadAt: pd.lastReadAt ?? null,
        lastMode: pd.lastMode ?? 'read',
        lastScrollTop: pd.lastScrollTop ?? 0,
        lastCharOffset: pd.lastCharOffset ?? 0,
        readAnchorText: pd.encrypted ? undefined : pd.readAnchorText,
        lastSyncedCharOffset: Math.max(0, Math.round(pd.lastCharOffset ?? 0)),
        lastSyncedProgress: pd.readProgress ?? 0,
        lastSyncedReadAt: pd.lastReadAt ?? 0,
        progressOverrideAt: pd.progressOverrideAt || undefined,
        pendingRemoteProgress: null,
        encrypted: Boolean(pd.encrypted),
        format: pd.format ?? 'txt',
        cloudBodySynced: Boolean(pd.cloudBodySynced),
        createdAt: pd.createdAt,
        updatedAt: pd.updatedAt,
        deleted: pd.deleted,
        deletedAt: pd.deletedAt,
        deletedByFolderId: pd.deletedByFolderId,
        highlights: [],
        byteSize: pd.byteSize ?? 0,
        syncStatus: pd.deleted ? 'synced' : 'remote-only',
      });
      changed = true;
      continue;
    }

    let updated = { ...ld };
    const localOverrideAt = ld.progressOverrideAt ?? 0;
    const peerOverrideAt = pd.progressOverrideAt ?? 0;
    const localReadTs = Math.max(ld.lastReadAt ?? 0, localOverrideAt);
    const peerAuthoritativeOverride =
      peerOverrideAt > localOverrideAt && peerOverrideAt > localReadTs;

    if (peerAuthoritativeOverride) {
      const rawPeerOffset = Math.max(0, Math.round(pd.lastCharOffset ?? 0));
      const relocated =
        updated.content && pd.readAnchorText
          ? relocateCharOffsetByAnchor(updated.content, rawPeerOffset, pd.readAnchorText)
          : null;
      const finalOffset = relocated?.matched ? relocated.offset : rawPeerOffset;
      const finalProgress = updated.content
        ? resolveComparableProgressPercent(
            updated.content.length,
            finalOffset,
            pd.readProgress ?? 0,
            true
          )
        : (pd.readProgress ?? 0);
      const finalReadAt = pd.lastReadAt ?? peerOverrideAt;
      updated = {
        ...updated,
        readProgress: finalProgress,
        lastCharOffset: finalOffset,
        lastScrollTop: relocated?.matched ? 0 : Math.max(0, Math.round(pd.lastScrollTop ?? 0)),
        lastMode: pd.lastMode ?? updated.lastMode ?? 'read',
        lastReadAt: finalReadAt,
        readAnchorText:
          pd.readAnchorText ||
          (updated.content && !updated.encrypted
            ? extractReadAnchorText(updated.content, finalOffset)
            : updated.readAnchorText),
        lastSyncedCharOffset: finalOffset,
        lastSyncedProgress: finalProgress,
        lastSyncedReadAt: finalReadAt,
        progressOverrideAt: peerOverrideAt,
        pendingRemoteProgress: null,
      };
      changed = true;
    } else {
      const progMerge = reconcileReadingProgress(ld, pd, 'wifi');
      if (progMerge.action === 'pull') {
        updated = {
          ...updated,
          readProgress: progMerge.resolvedRemoteProgress,
          lastCharOffset: progMerge.resolvedRemoteOffset,
          lastScrollTop: Math.max(0, Math.round(pd.lastScrollTop ?? 0)),
          lastMode: pd.lastMode ?? updated.lastMode ?? 'read',
          lastReadAt: pd.lastReadAt ?? progMerge.resolvedRemoteReadAt,
          readAnchorText:
            progMerge.resolvedRemoteAnchor ||
            (updated.content
              ? extractReadAnchorText(updated.content, progMerge.resolvedRemoteOffset)
              : updated.readAnchorText),
          lastSyncedCharOffset: progMerge.nextBaseline?.charOffset ?? progMerge.resolvedRemoteOffset,
          lastSyncedProgress: progMerge.nextBaseline?.progress ?? progMerge.resolvedRemoteProgress,
          lastSyncedReadAt: progMerge.nextBaseline?.readAt ?? progMerge.resolvedRemoteReadAt,
          progressOverrideAt:
            peerOverrideAt > localOverrideAt ? peerOverrideAt : updated.progressOverrideAt,
          pendingRemoteProgress: null,
        };
        changed = true;
      } else if (progMerge.action === 'prompt' && progMerge.pendingRemoteProgress) {
        if (!pendingWifiProgressEqual(ld.pendingRemoteProgress, progMerge.pendingRemoteProgress)) {
          updated = {
            ...updated,
            pendingRemoteProgress: progMerge.pendingRemoteProgress,
          };
          changed = true;
        }
      } else if (progMerge.action === 'noop' && progMerge.nextBaseline) {
        const needsOverrideSync = peerOverrideAt > localOverrideAt;
        if (
          ld.lastSyncedCharOffset !== progMerge.nextBaseline.charOffset ||
          ld.lastSyncedProgress !== progMerge.nextBaseline.progress ||
          Boolean(ld.pendingRemoteProgress) ||
          needsOverrideSync
        ) {
          updated = {
            ...updated,
            lastSyncedCharOffset: progMerge.nextBaseline.charOffset,
            lastSyncedProgress: progMerge.nextBaseline.progress,
            lastSyncedReadAt: progMerge.nextBaseline.readAt,
            progressOverrideAt: needsOverrideSync ? peerOverrideAt : updated.progressOverrideAt,
            pendingRemoteProgress: null,
          };
          changed = true;
        }
      }
    }

    if (pd.updatedAt > ld.updatedAt) {
      updated = {
        ...updated,
        title: pd.title,
        folderId: pd.folderId,
        order: pd.order,
        starred: Boolean(pd.starred),
        tags: pd.tags || [],
        deleted: pd.deleted,
        deletedAt: pd.deletedAt,
        deletedByFolderId: pd.deletedByFolderId,
        encrypted: Boolean(pd.encrypted),
        cloudBodySynced: Boolean(pd.cloudBodySynced || ld.cloudBodySynced),
        updatedAt: pd.updatedAt,
      };
      changed = true;
    }

    docMap.set(pd.id, updated);
  }

  const purged = purgeExpiredTrash(Array.from(folderMap.values()), Array.from(docMap.values()), now);
  return {
    folders: purged.folders,
    docs: purged.docs,
    treeState: mergedTreeState,
    changed: changed || purged.changed,
  };
}

export interface WifiSyncHostCallbacks {
  getLocalState: () => {
    folders: FolderNode[];
    docs: ArticleDoc[];
    treeState: SyncedTreeState;
    purgedRecords: PurgedSyncRecords;
    cloudConfigured?: boolean;
  };
  applyMergedCatalog: (
    folders: FolderNode[],
    docs: ArticleDoc[],
    treeState: SyncedTreeState
  ) => void;
  applyReceivedDocBody: (payload: WifiDocBodyPayload) => Promise<void>;
  onPeersChange: (peers: WifiPeer[]) => void;
  onImageReceived?: (relPath: string) => void;
  onIncomingSync?: (status: 'start' | 'end') => void;
  onIncomingActivity?: () => void;
  onPeerCloudStatus?: (peerCloudConfigured: boolean) => void;
}

export async function startWifiSyncHost(
  password: string,
  callbacks: WifiSyncHostCallbacks,
  initialStateHash?: string
): Promise<{ info: WifiServerInfo; stop: () => Promise<void> }> {
  if (!password) {
    throw new Error('请先在设置中配置加密密码，再开启 Wi-Fi 同步');
  }
  if (!isWifiSyncNativeAvailable()) {
    throw new Error('当前环境不支持原生 Wi-Fi 设备互传，请在 Android 手机或墨水屏安装包中使用');
  }

  const handles: PluginListenerHandle[] = [];
  let disposed = false;

  const peerHandle = await WifiSyncNative.addListener('wifiPeers', (data) => {
    if (!disposed) {
      callbacks.onPeersChange(Array.isArray(data.peers) ? data.peers : []);
    }
  });
  handles.push(peerHandle);

  const imgHandle = await WifiSyncNative.addListener('wifiImageReceived', (data) => {
    if (!disposed && data?.relPath) {
      invalidateLocalImageCache(data.relPath);
      callbacks.onIncomingActivity?.();
      callbacks.onImageReceived?.(data.relPath);
    }
  });
  handles.push(imgHandle);

  const incomingHandle = await WifiSyncNative.addListener('wifiIncomingSync', (data) => {
    if (!disposed && (data?.status === 'start' || data?.status === 'end')) {
      callbacks.onIncomingSync?.(data.status);
    }
  });
  handles.push(incomingHandle);

  const reqHandle = await WifiSyncNative.addListener('wifiServerRequest', async (evt) => {
    if (disposed) return;
    callbacks.onIncomingActivity?.();
    try {
      const payload = JSON.parse(evt.payloadJson || '{}');
      if (evt.action === 'mergeCatalog') {
        const peerSnapshot = payload as WifiCatalogSnapshot;
        callbacks.onPeerCloudStatus?.(Boolean(peerSnapshot.cloudConfigured));
        const local = callbacks.getLocalState();
        const merged = mergeWifiCatalogIntoLocal(
          local.folders,
          local.docs,
          local.treeState,
          local.purgedRecords,
          peerSnapshot
        );
        if (merged.changed) {
          callbacks.applyMergedCatalog(merged.folders, merged.docs, merged.treeState);
        }
        const reply = buildWifiCatalogSnapshot(
          merged.folders,
          merged.docs,
          merged.treeState,
          local.purgedRecords,
          local.cloudConfigured
        );
        await WifiSyncNative.resolveServerRequest({
          reqId: evt.reqId,
          ok: true,
          payloadJson: JSON.stringify(reply),
        });
        return;
      }

      if (evt.action === 'getDoc') {
        const docId = String(payload.docId || '');
        const local = callbacks.getLocalState();
        const target = local.docs.find((d) => d.id === docId && !d.deleted && !isDocBodyMissing(d));
        if (!target) {
          await WifiSyncNative.resolveServerRequest({
            reqId: evt.reqId,
            ok: true,
            payloadJson: JSON.stringify({ found: false }),
          });
          return;
        }
        const bodyReply: WifiDocBodyPayload & { found: boolean } = {
          found: true,
          id: target.id,
          content: target.content,
          contentHash: target.contentHash,
          updatedAt: target.updatedAt,
          byteSize: target.byteSize,
          format: target.format ?? 'txt',
        };
        await WifiSyncNative.resolveServerRequest({
          reqId: evt.reqId,
          ok: true,
          payloadJson: JSON.stringify(bodyReply),
        });
        return;
      }

      if (evt.action === 'putDoc') {
        const docPayload = payload as WifiDocBodyPayload;
        if (docPayload && typeof docPayload.id === 'string' && typeof docPayload.content === 'string') {
          await callbacks.applyReceivedDocBody(docPayload);
        }
        await WifiSyncNative.resolveServerRequest({
          reqId: evt.reqId,
          ok: true,
          payloadJson: JSON.stringify({ ok: true }),
        });
        return;
      }

      await WifiSyncNative.resolveServerRequest({
        reqId: evt.reqId,
        ok: false,
        payloadJson: JSON.stringify({ error: 'unknown_action' }),
      });
    } catch {
      await WifiSyncNative.resolveServerRequest({
        reqId: evt.reqId,
        ok: false,
        payloadJson: JSON.stringify({ error: 'server_error' }),
      }).catch(() => {});
    }
  });
  handles.push(reqHandle);

  const info = await WifiSyncNative.startServer({
    password,
    port: DEFAULT_WIFI_SYNC_PORT,
    stateHash: initialStateHash || '',
  });

  const stop = async () => {
    disposed = true;
    for (const h of handles) {
      await h.remove().catch(() => {});
    }
    await WifiSyncNative.stopServer().catch(() => {});
  };

  return { info, stop };
}

export async function runWifiBidirectionalSync(options: {
  host: string;
  port: number;
  password: string;
  storageDir: StorageDirectoryConfig;
  getLocalState: () => {
    folders: FolderNode[];
    docs: ArticleDoc[];
    treeState: SyncedTreeState;
    purgedRecords: PurgedSyncRecords;
    cloudConfigured?: boolean;
  };
  applyMergedCatalog: (
    folders: FolderNode[],
    docs: ArticleDoc[],
    treeState: SyncedTreeState
  ) => void;
  applyReceivedDocBody: (payload: WifiDocBodyPayload) => Promise<void>;
  onProgress?: (progress: WifiSyncProgress) => void;
}): Promise<WifiSyncSummary> {
  if (!options.password) {
    throw new Error('请先在设置中配置加密密码');
  }
  if (!isWifiSyncNativeAvailable()) {
    throw new Error('当前环境不支持原生 Wi-Fi 设备同步');
  }

  const report = (
    phase: WifiSyncProgress['phase'],
    label: string,
    completed: number,
    total: number
  ) => {
    options.onProgress?.({ phase, label, completed, total });
  };

  report('connecting', '正在核验加密密码并建立加密通道…', 0, 1);
  const conn = await WifiSyncNative.peerConnect({
    host: options.host.trim(),
    port: options.port || DEFAULT_WIFI_SYNC_PORT,
    password: options.password,
  });
  const sessionId = conn.sessionId;
  const peerName = conn.deviceName || options.host;

  let pulledDocs = 0;
  let pushedDocs = 0;
  let pulledImages = 0;
  let pushedImages = 0;
  let catalogUpdated = false;
  let peerCloudConfigured = false;

  try {
    // Step 1: Exchange & merge catalog / folders / reading progress
    report('catalog', `正在与 ${peerName} 合并书架目录与进度…`, 0, 1);
    const localBefore = options.getLocalState();
    const localSnapshot = buildWifiCatalogSnapshot(
      localBefore.folders,
      localBefore.docs,
      localBefore.treeState,
      localBefore.purgedRecords,
      localBefore.cloudConfigured
    );

    const catRes = await WifiSyncNative.peerRpc({
      sessionId,
      action: 'mergeCatalog',
      payloadJson: JSON.stringify(localSnapshot),
    });
    const peerCatalog = JSON.parse(catRes.payloadJson || '{}') as WifiCatalogSnapshot;
    peerCloudConfigured = Boolean(peerCatalog.cloudConfigured);

    const merged = mergeWifiCatalogIntoLocal(
      localBefore.folders,
      localBefore.docs,
      localBefore.treeState,
      localBefore.purgedRecords,
      peerCatalog
    );
    if (merged.changed) {
      catalogUpdated = true;
      options.applyMergedCatalog(merged.folders, merged.docs, merged.treeState);
    }

    // Step 2: Diff document bodies (bidirectional)
    const peerDocMap = new Map<string, WifiDocCatalogMeta>();
    for (const pd of peerCatalog.docs || []) {
      peerDocMap.set(pd.id, pd);
    }

    const docsToPull: string[] = [];
    const docsToPush: ArticleDoc[] = [];

    for (const doc of merged.docs) {
      if (doc.deleted) continue;
      const peerDoc = peerDocMap.get(doc.id);
      const localHasBody = !isDocBodyMissing(doc);
      const peerHasBody = Boolean(peerDoc && !peerDoc.deleted && peerDoc.hasBody);

      if (!localHasBody && peerHasBody) {
        docsToPull.push(doc.id);
      } else if (localHasBody && (!peerDoc || !peerHasBody)) {
        docsToPush.push(doc);
      } else if (localHasBody && peerHasBody && peerDoc && peerDoc.contentHash !== doc.contentHash) {
        if (peerDoc.updatedAt > doc.updatedAt) {
          docsToPull.push(doc.id);
        } else if (doc.updatedAt > peerDoc.updatedAt) {
          docsToPush.push(doc);
        }
      }
    }

    const totalDocOps = docsToPull.length + docsToPush.length;
    let docDone = 0;

    for (const docId of docsToPull) {
      report('docs', `正在接收正文 (${docDone + 1}/${totalDocOps})…`, docDone, totalDocOps);
      const getRes = await WifiSyncNative.peerRpc({
        sessionId,
        action: 'getDoc',
        payloadJson: JSON.stringify({ docId }),
      });
      const parsed = JSON.parse(getRes.payloadJson || '{}') as WifiDocBodyPayload & { found?: boolean };
      if (parsed.found && typeof parsed.content === 'string') {
        await options.applyReceivedDocBody({
          id: parsed.id || docId,
          content: parsed.content,
          contentHash: parsed.contentHash || (await sha256Hex(parsed.content)),
          updatedAt: parsed.updatedAt || Date.now(),
          byteSize: parsed.byteSize || getByteSize(parsed.content),
          format: parsed.format ?? 'txt',
        });
        pulledDocs++;
      }
      docDone++;
    }

    for (const doc of docsToPush) {
      report('docs', `正在发送正文 (${docDone + 1}/${totalDocOps})…`, docDone, totalDocOps);
      const payload: WifiDocBodyPayload = {
        id: doc.id,
        content: doc.content,
        contentHash: doc.contentHash || (await sha256Hex(doc.content)),
        updatedAt: doc.updatedAt,
        byteSize: doc.byteSize || getByteSize(doc.content),
        format: doc.format ?? 'txt',
      };
      await WifiSyncNative.peerRpc({
        sessionId,
        action: 'putDoc',
        payloadJson: JSON.stringify(payload),
      });
      pushedDocs++;
      docDone++;
    }

    // Step 3: Diff & sync local images/ directory natively (zero base64 overhead in WebView)
    report('images', '正在比对本地插图清单…', 0, 1);
    const [localImages, peerImgRpc] = await Promise.all([
      listLocalImageFiles(options.storageDir),
      WifiSyncNative.peerRpc({
        sessionId,
        action: 'listImages',
        payloadJson: '{}',
      }),
    ]);

    const peerImagesRaw = JSON.parse(peerImgRpc.payloadJson || '{}') as {
      files?: LocalImageFileMeta[];
    };
    const peerImages: LocalImageFileMeta[] = Array.isArray(peerImagesRaw.files)
      ? peerImagesRaw.files
      : [];

    const localImgMap = new Map<string, LocalImageFileMeta>();
    for (const img of localImages) {
      localImgMap.set(img.relPath.toLowerCase(), img);
    }
    const peerImgMap = new Map<string, LocalImageFileMeta>();
    for (const img of peerImages) {
      peerImgMap.set(img.relPath.toLowerCase(), img);
    }

    const imagesToPull: string[] = [];
    const imagesToPush: string[] = [];

    for (const pImg of peerImages) {
      const lImg = localImgMap.get(pImg.relPath.toLowerCase());
      if (!lImg || (lImg.size !== pImg.size && pImg.lastModified >= lImg.lastModified)) {
        imagesToPull.push(pImg.relPath);
      }
    }
    for (const lImg of localImages) {
      const pImg = peerImgMap.get(lImg.relPath.toLowerCase());
      if (!pImg || (pImg.size !== lImg.size && lImg.lastModified > pImg.lastModified)) {
        imagesToPush.push(lImg.relPath);
      }
    }

    const totalImgOps = imagesToPull.length + imagesToPush.length;
    let imgDone = 0;

    for (const relPath of imagesToPull) {
      report('images', `正在接收插图 (${imgDone + 1}/${totalImgOps})…`, imgDone, totalImgOps);
      const res = await WifiSyncNative.peerPullImage({ sessionId, relPath });
      if (res.ok) {
        pulledImages++;
        invalidateLocalImageCache(relPath);
      }
      imgDone++;
    }

    for (const relPath of imagesToPush) {
      report('images', `正在发送插图 (${imgDone + 1}/${totalImgOps})…`, imgDone, totalImgOps);
      const res = await WifiSyncNative.peerPushImage({ sessionId, relPath });
      if (res.ok) {
        pushedImages++;
      }
      imgDone++;
    }

    report('done', '同步完成', 1, 1);
    return {
      peerName,
      pulledDocs,
      pushedDocs,
      pulledImages,
      pushedImages,
      catalogUpdated,
      peerCloudConfigured,
    };
  } finally {
    await WifiSyncNative.peerDisconnect({ sessionId }).catch(() => {});
  }
}

export function applyWifiReceivedDocToDocs(
  prevDocs: ArticleDoc[],
  payload: WifiDocBodyPayload
): ArticleDoc[] {
  const existing = prevDocs.find((d) => d.id === payload.id);
  if (!existing) {
    return prevDocs;
  }
  const excerpt = existing.encrypted ? '' : extractExcerpt(payload.content);
  return prevDocs.map((d) => {
    if (d.id !== payload.id) return d;
    const prevOffset = Math.max(0, Math.round(d.lastCharOffset ?? 0));
    const anchor =
      d.readAnchorText ||
      (d.content && prevOffset > 0 ? extractReadAnchorText(d.content, prevOffset) : undefined);
    const relocated =
      anchor && prevOffset > 0 && payload.content
        ? relocateCharOffsetByAnchor(payload.content, prevOffset, anchor)
        : null;
    const nextPending =
      d.pendingRemoteProgress && payload.content
        ? (() => {
            const p = d.pendingRemoteProgress;
            const rp = relocateCharOffsetByAnchor(payload.content, p.lastCharOffset, p.anchorText);
            return rp.matched
              ? { ...p, lastCharOffset: rp.offset, readProgress: rp.progress }
              : p;
          })()
        : d.pendingRemoteProgress;

    return {
      ...d,
      content: payload.content,
      contentHash: payload.contentHash,
      byteSize: payload.byteSize,
      excerpt,
      format: payload.format ?? d.format ?? 'txt',
      updatedAt: Math.max(d.updatedAt, payload.updatedAt),
      syncStatus: 'synced',
      pendingRemoteProgress: nextPending,
      ...(relocated?.matched
        ? {
            lastCharOffset: relocated.offset,
            readProgress: relocated.progress,
            lastScrollTop: 0,
            readAnchorText: extractReadAnchorText(payload.content, relocated.offset) || anchor,
          }
        : {}),
    };
  });
}

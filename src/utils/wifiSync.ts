import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { ArticleDoc, FolderNode, PurgedSyncRecords, SyncedTreeState } from '../types';
import { invalidateLocalImageCache, listLocalImageFiles, LocalImageFileMeta } from './localFs';
import { StorageDirectoryConfig } from './storage';
import { extractExcerpt, getByteSize, sha256Hex } from './textParser';
import { isTrashExpired, purgeExpiredTrash } from './trash';
import { isDocBodyMissing } from './webdavSync';

export const DEFAULT_WIFI_SYNC_PORT = 48765;

export interface WifiPeer {
  id: string;
  name: string;
  ip: string;
  port: number;
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
}

interface WifiSyncNativePlugin {
  startServer(options: {
    password: string;
    deviceName?: string;
    port?: number;
  }): Promise<WifiServerInfo>;
  stopServer(): Promise<{ running: boolean }>;
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
}

const WifiSyncNative = registerPlugin<WifiSyncNativePlugin>('WifiSyncNative');

export function isWifiSyncNativeAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('WifiSyncNative');
}

export function buildWifiCatalogSnapshot(
  folders: FolderNode[],
  docs: ArticleDoc[],
  treeState: SyncedTreeState,
  purgedRecords?: PurgedSyncRecords
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
  };
}

function getEffectiveProgressTs(
  lastReadAt: number | null | undefined,
  readProgress: number | undefined,
  lastCharOffset: number | undefined,
  fallbackUpdatedAt: number
): number {
  if (typeof lastReadAt === 'number' && Number.isFinite(lastReadAt) && lastReadAt > 0) {
    return lastReadAt;
  }
  if ((lastCharOffset ?? 0) > 0 || (readProgress ?? 0) > 0) {
    return fallbackUpdatedAt;
  }
  return 0;
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
    const localProgressTs = getEffectiveProgressTs(
      ld.lastReadAt,
      ld.readProgress,
      ld.lastCharOffset,
      ld.updatedAt
    );
    const peerProgressTs = getEffectiveProgressTs(
      pd.lastReadAt,
      pd.readProgress,
      pd.lastCharOffset,
      pd.updatedAt
    );
    if (peerProgressTs > localProgressTs) {
      updated = {
        ...updated,
        readProgress: pd.readProgress,
        lastCharOffset: Math.max(0, Math.round(pd.lastCharOffset ?? 0)),
        lastScrollTop: Math.max(0, Math.round(pd.lastScrollTop ?? 0)),
        lastMode: pd.lastMode ?? updated.lastMode ?? 'read',
        lastReadAt: pd.lastReadAt ?? peerProgressTs,
      };
      changed = true;
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
  };
  applyMergedCatalog: (
    folders: FolderNode[],
    docs: ArticleDoc[],
    treeState: SyncedTreeState
  ) => void;
  applyReceivedDocBody: (payload: WifiDocBodyPayload) => Promise<void>;
  onPeersChange: (peers: WifiPeer[]) => void;
  onImageReceived?: (relPath: string) => void;
}

export async function startWifiSyncHost(
  password: string,
  callbacks: WifiSyncHostCallbacks
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
      callbacks.onImageReceived?.(data.relPath);
    }
  });
  handles.push(imgHandle);

  const reqHandle = await WifiSyncNative.addListener('wifiServerRequest', async (evt) => {
    if (disposed) return;
    try {
      const payload = JSON.parse(evt.payloadJson || '{}');
      if (evt.action === 'mergeCatalog') {
        const peerSnapshot = payload as WifiCatalogSnapshot;
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
          local.purgedRecords
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

  try {
    // Step 1: Exchange & merge catalog / folders / reading progress
    report('catalog', `正在与 ${peerName} 合并书架目录与进度…`, 0, 1);
    const localBefore = options.getLocalState();
    const localSnapshot = buildWifiCatalogSnapshot(
      localBefore.folders,
      localBefore.docs,
      localBefore.treeState,
      localBefore.purgedRecords
    );

    const catRes = await WifiSyncNative.peerRpc({
      sessionId,
      action: 'mergeCatalog',
      payloadJson: JSON.stringify(localSnapshot),
    });
    const peerCatalog = JSON.parse(catRes.payloadJson || '{}') as WifiCatalogSnapshot;

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
  return prevDocs.map((d) =>
    d.id === payload.id
      ? {
          ...d,
          content: payload.content,
          contentHash: payload.contentHash,
          byteSize: payload.byteSize,
          excerpt,
          format: payload.format ?? d.format ?? 'txt',
          updatedAt: Math.max(d.updatedAt, payload.updatedAt),
          syncStatus: 'synced',
        }
      : d
  );
}

import {
  ArticleDoc,
  FolderNode,
  ManifestDocEntry,
  QuotaStats,
  RemoteManifest,
  SyncedTreeState,
  SyncLogEntry,
  WebDavConfig,
} from '../types';
import { decryptText, encryptText, isEncryptedPayload } from './crypto';
import { extractExcerpt, formatBytes, getByteSize, sha256Hex } from './textParser';

interface ProxyResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  etag?: string;
  lastModified?: string;
  body?: string;
  bytesTransferred?: number;
  error?: string;
}

const MANIFEST_PATH = '_manifest.json';
const DOCS_DIR = 'docs/';

async function callWebDav(
  config: WebDavConfig,
  method: 'GET' | 'PUT' | 'MKCOL' | 'DELETE' | 'PROPFIND' | 'HEAD',
  relativePath: string,
  options?: { body?: string; ifNoneMatch?: string; depth?: '0' | '1' }
): Promise<ProxyResponse> {
  const res = await fetch('/api/webdav/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: config.baseUrl,
      username: config.username,
      password: config.password,
      method,
      relativePath,
      body: options?.body,
      ifNoneMatch: options?.ifNoneMatch,
      depth: options?.depth,
    }),
  });
  return (await res.json()) as ProxyResponse;
}

export async function testWebDavConnection(config: WebDavConfig): Promise<{ ok: boolean; message: string }> {
  const result = await callWebDav(config, 'PROPFIND', '', { depth: '0' });
  if (result.status === 401 || result.status === 403) {
    return { ok: false, message: '鉴权失败（401）：请确认填写的是坚果云「应用密码」，而非登录密码。' };
  }
  if (result.status === 404) {
    const mk = await callWebDav(config, 'MKCOL', '');
    if (mk.ok || mk.status === 201 || mk.status === 405) {
      return { ok: true, message: '连接成功，已在坚果云自动创建同步目录。' };
    }
    return { ok: false, message: '目录不存在且无法创建（404），请先在坚果云新建同步文件夹。' };
  }
  if (result.ok) {
    return { ok: true, message: `连接成功（HTTP ${result.status}），支持增量同步协议。` };
  }
  return { ok: false, message: result.error || `连接异常（HTTP ${result.status}）` };
}

export function buildLocalManifest(
  folders: FolderNode[],
  docs: ArticleDoc[],
  treeState?: SyncedTreeState,
  config?: WebDavConfig
): RemoteManifest {
  const docMap: Record<string, ManifestDocEntry> = {};
  for (const doc of docs) {
    docMap[doc.id] = {
      id: doc.id,
      title: doc.title,
      folderId: doc.folderId,
      order: doc.order,
      contentHash: doc.contentHash,
      excerpt: doc.encrypted ? '' : doc.excerpt,
      tags: doc.tags,
      starred: doc.starred,
      readProgress: doc.readProgress,
      lastReadAt: doc.lastReadAt,
      lastMode: doc.lastMode ?? 'read',
      lastScrollTop: doc.lastScrollTop ?? 0,
      encrypted: Boolean(doc.encrypted),
      format: doc.format ?? 'txt',
      updatedAt: doc.updatedAt,
      createdAt: doc.createdAt,
      deleted: doc.deleted,
      byteSize: doc.byteSize,
    };
  }
  return {
    version: 2,
    updatedAt: Date.now(),
    folders,
    docs: docMap,
    treeState,
    syncSettings: config
      ? {
          provider: 'jianguoyun',
          baseUrl: config.baseUrl,
          username: config.username,
          password: config.password,
          encryptionPassword: config.encryptionPassword || '',
          updatedAt: config.settingsUpdatedAt || 0,
        }
      : undefined,
  };
}

export interface SyncOutcome {
  folders: FolderNode[];
  docs: ArticleDoc[];
  treeState: SyncedTreeState;
  config: WebDavConfig;
  quotaDelta: {
    uploadBytes: number;
    downloadBytes: number;
    requestCount: number;
    skippedByEtag304: number;
    skippedByHashMatch: number;
  };
  log: SyncLogEntry;
}

/**
 * Quota-saving incremental sync with Jianguoyun WebDAV:
 * - Syncs all document contents (AES-256-GCM encrypted when doc.encrypted is true)
 * - Syncs all document states (encrypted, lastMode, lastScrollTop, order, folderId)
 * - Syncs directory tree state (folders, collapsedIds, activeTarget, scrollTop)
 * - Syncs settings parameters (Jianguoyun WebDAV params + encryption password)
 */
export async function runIncrementalWebDavSync(
  config: WebDavConfig,
  localFolders: FolderNode[],
  localDocs: ArticleDoc[],
  localTreeState: SyncedTreeState,
  metaDirty = false
): Promise<SyncOutcome> {
  let uploadBytes = 0;
  let downloadBytes = 0;
  let requestCount = 0;
  let skippedByEtag304 = 0;
  let skippedByHashMatch = 0;

  const dirtyDocs = localDocs.filter((d) => d.syncStatus === 'dirty');

  // Step 1: Conditional fetch _manifest.json
  requestCount++;
  const manifestRes = await callWebDav(config, 'GET', MANIFEST_PATH, {
    ifNoneMatch: config.lastManifestEtag,
  });

  if (manifestRes.status === 401 || manifestRes.status === 403) {
    throw new Error('坚果云认证失败，请长按同步图标检查账号和应用密码。');
  }

  let remoteManifest: RemoteManifest | null = null;
  let newEtag = config.lastManifestEtag;

  if (manifestRes.status === 304) {
    skippedByEtag304++;
    if (dirtyDocs.length === 0 && !metaDirty) {
      return {
        folders: localFolders,
        docs: localDocs,
        treeState: localTreeState,
        config: { ...config, lastSyncedAt: Date.now() },
        quotaDelta: {
          uploadBytes: 0,
          downloadBytes: 0,
          requestCount,
          skippedByEtag304,
          skippedByHashMatch: localDocs.length,
        },
        log: {
          id: `log_${Date.now()}`,
          timestamp: Date.now(),
          mode: 'live',
          summary: '已是最新（304 零流量）',
          requests: requestCount,
          uploadBytes: 0,
          downloadBytes: 0,
          status: 'noop',
        },
      };
    }
  } else if (manifestRes.status === 404) {
    requestCount++;
    await callWebDav(config, 'MKCOL', '');
    requestCount++;
    await callWebDav(config, 'MKCOL', DOCS_DIR);
  } else if (manifestRes.ok && manifestRes.body) {
    downloadBytes += manifestRes.bytesTransferred || getByteSize(manifestRes.body);
    newEtag = manifestRes.etag || newEtag;
    try {
      remoteManifest = JSON.parse(manifestRes.body) as RemoteManifest;
    } catch {
      remoteManifest = null;
    }
  } else if (!manifestRes.ok) {
    throw new Error(manifestRes.error || `拉取索引失败（HTTP ${manifestRes.status}）`);
  }

  // Step 2: Merge sync settings (Last-Write-Wins by updatedAt)
  let mergedConfig: WebDavConfig = { ...config };
  let needManifestPush = false;
  const remoteSettings = remoteManifest?.syncSettings;
  const localSettingsTs = config.settingsUpdatedAt || 0;
  if (remoteSettings && remoteSettings.updatedAt > localSettingsTs) {
    mergedConfig = {
      ...mergedConfig,
      provider: 'jianguoyun',
      baseUrl: remoteSettings.baseUrl || mergedConfig.baseUrl,
      username: remoteSettings.username || mergedConfig.username,
      password: remoteSettings.password || mergedConfig.password,
      encryptionPassword: remoteSettings.encryptionPassword ?? mergedConfig.encryptionPassword ?? '',
      settingsUpdatedAt: remoteSettings.updatedAt,
      enabled: Boolean(
        (remoteSettings.username || mergedConfig.username) &&
          (remoteSettings.password || mergedConfig.password)
      ),
    };
  } else if (localSettingsTs > (remoteSettings?.updatedAt || 0)) {
    needManifestPush = true;
  }

  const effectiveEncPassword = mergedConfig.encryptionPassword || '';

  // Step 3: Merge folders (Last-Write-Wins by updatedAt per folder)
  const folderMap = new Map<string, FolderNode>();
  for (const f of localFolders) folderMap.set(f.id, f);
  if (remoteManifest?.folders) {
    for (const rf of remoteManifest.folders) {
      const lf = folderMap.get(rf.id);
      if (!lf || rf.updatedAt > lf.updatedAt) {
        folderMap.set(rf.id, { ...rf, parentId: null });
      }
    }
  }
  const mergedFolders = Array.from(folderMap.values());

  // Step 4: Merge directory tree state (expanded/collapsed folders, selection, scrollTop)
  let mergedTreeState: SyncedTreeState = localTreeState;
  const remoteTree = remoteManifest?.treeState;
  if (remoteTree && remoteTree.updatedAt > localTreeState.updatedAt) {
    mergedTreeState = {
      collapsedIds: Array.isArray(remoteTree.collapsedIds) ? remoteTree.collapsedIds : [],
      activeTarget: remoteTree.activeTarget ?? null,
      scrollTop: typeof remoteTree.scrollTop === 'number' ? remoteTree.scrollTop : 0,
      updatedAt: remoteTree.updatedAt,
    };
  } else if (localTreeState.updatedAt > (remoteTree?.updatedAt || 0)) {
    needManifestPush = true;
  }

  // Step 5: Diff documents by plaintext SHA-256 hash, encryption flag & updatedAt
  const mergedDocsMap = new Map<string, ArticleDoc>();
  for (const d of localDocs) mergedDocsMap.set(d.id, { ...d });

  let pushedCount = 0;
  let pulledCount = 0;
  let lazyQueuedCount = 0;

  // 5a. Push locally dirty or unindexed documents
  for (const doc of localDocs) {
    const remoteEntry = remoteManifest?.docs?.[doc.id];
    const hashDiffers = !remoteEntry || remoteEntry.contentHash !== doc.contentHash;
    const encryptionDiffers = Boolean(remoteEntry?.encrypted) !== Boolean(doc.encrypted);
    const isLocallyNewer = !remoteEntry || doc.updatedAt >= remoteEntry.updatedAt;

    if ((doc.syncStatus === 'dirty' || !remoteEntry || encryptionDiffers) && isLocallyNewer) {
      if ((hashDiffers || encryptionDiffers || doc.syncStatus === 'dirty') && !doc.deleted) {
        let uploadBody = doc.content;
        if (doc.encrypted) {
          if (!effectiveEncPassword) {
            throw new Error(`文档《${doc.title}》已启用加密，请长按同步图标设置加密密码`);
          }
          uploadBody = await encryptText(doc.content, effectiveEncPassword);
        }

        const docExt = doc.format === 'md' ? 'md' : 'txt';
        requestCount++;
        const putRes = await callWebDav(config, 'PUT', `${DOCS_DIR}${doc.id}.${docExt}`, {
          body: uploadBody,
        });
        if (!putRes.ok) {
          throw new Error(`上传《${doc.title}》失败（HTTP ${putRes.status}）`);
        }
        uploadBytes += getByteSize(uploadBody);
        pushedCount++;
      } else {
        skippedByHashMatch++;
      }
      mergedDocsMap.set(doc.id, { ...doc, syncStatus: 'synced' });
      needManifestPush = true;
    } else if (!hashDiffers && !encryptionDiffers) {
      skippedByHashMatch++;
      mergedDocsMap.set(doc.id, { ...doc, syncStatus: 'synced' });
    }
  }

  // 5b. Pull newer remote documents (or sync metadata + decrypt encrypted payloads)
  if (remoteManifest?.docs) {
    for (const [id, rEntry] of Object.entries(remoteManifest.docs)) {
      const localDoc = mergedDocsMap.get(id);
      if (!localDoc || rEntry.updatedAt > localDoc.updatedAt) {
        const hashMatchesLocal = localDoc && localDoc.contentHash === rEntry.contentHash;
        if (hashMatchesLocal || rEntry.deleted) {
          skippedByHashMatch++;
          mergedDocsMap.set(id, {
            ...(localDoc || {
              id: rEntry.id,
              content: '',
              lastReadAt: null,
              highlights: [],
            }),
            title: rEntry.title,
            folderId: rEntry.folderId,
            order: rEntry.order,
            contentHash: rEntry.contentHash,
            excerpt: rEntry.encrypted ? '' : rEntry.excerpt,
            tags: rEntry.tags,
            starred: rEntry.starred,
            readProgress: rEntry.readProgress,
            lastReadAt: rEntry.lastReadAt ?? localDoc?.lastReadAt ?? null,
            lastMode: rEntry.lastMode ?? localDoc?.lastMode ?? 'read',
            lastScrollTop: rEntry.lastScrollTop ?? localDoc?.lastScrollTop ?? 0,
            encrypted: Boolean(rEntry.encrypted),
            format: rEntry.format ?? localDoc?.format ?? 'txt',
            createdAt: rEntry.createdAt,
            updatedAt: rEntry.updatedAt,
            deleted: rEntry.deleted,
            byteSize: rEntry.byteSize,
            syncStatus: 'synced',
          });
        } else if (mergedConfig.lazyFetch) {
          lazyQueuedCount++;
          mergedDocsMap.set(id, {
            id: rEntry.id,
            title: rEntry.title,
            folderId: rEntry.folderId,
            order: rEntry.order,
            content: localDoc?.content || '',
            contentHash: rEntry.contentHash,
            excerpt: rEntry.encrypted ? '' : rEntry.excerpt,
            tags: rEntry.tags,
            starred: rEntry.starred,
            readProgress: rEntry.readProgress,
            lastReadAt: rEntry.lastReadAt ?? localDoc?.lastReadAt ?? null,
            lastMode: rEntry.lastMode ?? localDoc?.lastMode ?? 'read',
            lastScrollTop: rEntry.lastScrollTop ?? localDoc?.lastScrollTop ?? 0,
            encrypted: Boolean(rEntry.encrypted),
            format: rEntry.format ?? localDoc?.format ?? 'txt',
            createdAt: rEntry.createdAt,
            updatedAt: rEntry.updatedAt,
            deleted: rEntry.deleted,
            highlights: localDoc?.highlights || [],
            byteSize: rEntry.byteSize,
            syncStatus: 'remote-only',
          });
        } else {
          const primaryExt = rEntry.format === 'md' ? 'md' : 'txt';
          const fallbackExt = primaryExt === 'txt' ? 'md' : 'txt';
          requestCount++;
          let getDoc = await callWebDav(config, 'GET', `${DOCS_DIR}${id}.${primaryExt}`);
          if (!getDoc.ok && getDoc.status === 404) {
            requestCount++;
            getDoc = await callWebDav(config, 'GET', `${DOCS_DIR}${id}.${fallbackExt}`);
          }
          if (getDoc.ok && typeof getDoc.body === 'string') {
            downloadBytes += getDoc.bytesTransferred || getByteSize(getDoc.body);
            const rawBody = getDoc.body;
            const plainContent =
              rEntry.encrypted || isEncryptedPayload(rawBody)
                ? await decryptText(rawBody, effectiveEncPassword)
                : rawBody;
            pulledCount++;
            mergedDocsMap.set(id, {
              id: rEntry.id,
              title: rEntry.title,
              folderId: rEntry.folderId,
              order: rEntry.order,
              content: plainContent,
              contentHash: await sha256Hex(plainContent),
              excerpt: rEntry.encrypted ? '' : extractExcerpt(plainContent),
              tags: rEntry.tags,
              starred: rEntry.starred,
              readProgress: rEntry.readProgress,
              lastReadAt: rEntry.lastReadAt ?? localDoc?.lastReadAt ?? null,
              lastMode: rEntry.lastMode ?? localDoc?.lastMode ?? 'read',
              lastScrollTop: rEntry.lastScrollTop ?? localDoc?.lastScrollTop ?? 0,
              encrypted: Boolean(rEntry.encrypted),
              format: rEntry.format ?? 'txt',
              createdAt: rEntry.createdAt,
              updatedAt: rEntry.updatedAt,
              deleted: rEntry.deleted,
              highlights: localDoc?.highlights || [],
              byteSize: getByteSize(plainContent),
              syncStatus: 'synced',
            });
          }
        }
      }
    }
  }

  const finalDocs = Array.from(mergedDocsMap.values());

  // Step 6: Upload single updated _manifest.json containing all doc states, tree state & sync settings
  if (needManifestPush || metaDirty || !remoteManifest) {
    const nextManifest = buildLocalManifest(mergedFolders, finalDocs, mergedTreeState, mergedConfig);
    const manifestJson = JSON.stringify(nextManifest);
    requestCount++;
    const putManifest = await callWebDav(config, 'PUT', MANIFEST_PATH, { body: manifestJson });
    if (!putManifest.ok) {
      throw new Error(`更新云端索引失败（HTTP ${putManifest.status}）`);
    }
    uploadBytes += getByteSize(manifestJson);
    newEtag = putManifest.etag || newEtag;
  }

  const summaryParts: string[] = [];
  if (pushedCount > 0) summaryParts.push(`上传 ${pushedCount} 篇`);
  if (pulledCount > 0) summaryParts.push(`拉取 ${pulledCount} 篇`);
  if (lazyQueuedCount > 0) summaryParts.push(`索引 ${lazyQueuedCount} 篇`);
  const summary =
    summaryParts.length > 0
      ? `同步完成（${summaryParts.join(' · ')}）`
      : '同步完成';

  return {
    folders: mergedFolders,
    docs: finalDocs,
    treeState: mergedTreeState,
    config: {
      ...mergedConfig,
      lastManifestEtag: newEtag,
      lastSyncedAt: Date.now(),
    },
    quotaDelta: {
      uploadBytes,
      downloadBytes,
      requestCount,
      skippedByEtag304,
      skippedByHashMatch,
    },
    log: {
      id: `log_${Date.now()}`,
      timestamp: Date.now(),
      mode: 'live',
      summary,
      requests: requestCount,
      uploadBytes,
      downloadBytes,
      status: 'success',
    },
  };
}

/**
 * Fetch a single remote-only document body on-demand (automatically decrypts if encrypted)
 */
export async function fetchRemoteDocBody(
  config: WebDavConfig,
  docId: string,
  encrypted = false,
  format: 'txt' | 'md' = 'txt'
): Promise<{ content: string; bytes: number }> {
  const primaryExt = format === 'md' ? 'md' : 'txt';
  const fallbackExt = primaryExt === 'txt' ? 'md' : 'txt';
  let res = await callWebDav(config, 'GET', `${DOCS_DIR}${docId}.${primaryExt}`);
  if (!res.ok && res.status === 404) {
    res = await callWebDav(config, 'GET', `${DOCS_DIR}${docId}.${fallbackExt}`);
  }
  if (!res.ok || typeof res.body !== 'string') {
    throw new Error(res.error || `拉取正文失败（HTTP ${res.status}）`);
  }
  const bytes = res.bytesTransferred || getByteSize(res.body);
  const content =
    encrypted || isEncryptedPayload(res.body)
      ? await decryptText(res.body, config.encryptionPassword || '')
      : res.body;
  return { content, bytes };
}

export function simulateIncrementalSync(
  folders: FolderNode[],
  docs: ArticleDoc[],
  metaDirty = false,
  treeState?: SyncedTreeState,
  config?: WebDavConfig
): {
  docs: ArticleDoc[];
  quotaDelta: {
    uploadBytes: number;
    downloadBytes: number;
    requestCount: number;
    skippedByEtag304: number;
    skippedByHashMatch: number;
  };
  log: SyncLogEntry;
} {
  const dirtyDocs = docs.filter((d) => d.syncStatus === 'dirty');
  const unchangedCount = docs.length - dirtyDocs.length;

  if (dirtyDocs.length === 0 && !metaDirty) {
    return {
      docs,
      quotaDelta: {
        uploadBytes: 0,
        downloadBytes: 0,
        requestCount: 1,
        skippedByEtag304: 1,
        skippedByHashMatch: unchangedCount,
      },
      log: {
        id: `sim_${Date.now()}`,
        timestamp: Date.now(),
        mode: 'simulate',
        summary: `演练：ETag 命中 304，仅 1 次请求、0 B 流量`,
        requests: 1,
        uploadBytes: 0,
        downloadBytes: 0,
        status: 'noop',
      },
    };
  }

  const manifestSize = getByteSize(
    JSON.stringify(buildLocalManifest(folders, docs, treeState, config))
  );
  const docBytes = dirtyDocs.reduce((acc, d) => acc + (d.deleted ? 0 : d.byteSize), 0);
  const uploadBytes = docBytes + manifestSize;
  const requests = 1 + dirtyDocs.filter((d) => !d.deleted).length + 1;

  const syncedDocs = docs.map((d) =>
    d.syncStatus === 'dirty' ? { ...d, syncStatus: 'synced' as const } : d
  );

  return {
    docs: syncedDocs,
    quotaDelta: {
      uploadBytes,
      downloadBytes: 0,
      requestCount: requests,
      skippedByEtag304: 0,
      skippedByHashMatch: unchangedCount,
    },
    log: {
      id: `sim_${Date.now()}`,
      timestamp: Date.now(),
      mode: 'simulate',
      summary: `演练：上传 ${dirtyDocs.length} 篇 + 索引（${formatBytes(uploadBytes)}）`,
      requests,
      uploadBytes,
      downloadBytes: 0,
      status: 'success',
    },
  };
}

export function getCurrentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function createInitialQuotaStats(): QuotaStats {
  return {
    monthKey: getCurrentMonthKey(),
    uploadBytes: 0,
    downloadBytes: 0,
    requestCount: 0,
    skippedByEtag304: 0,
    skippedByHashMatch: 0,
  };
}

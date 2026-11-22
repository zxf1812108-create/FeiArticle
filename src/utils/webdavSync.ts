import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import {
  ArticleDoc,
  FolderNode,
  ManifestDocEntry,
  PurgedSyncRecords,
  QuotaStats,
  RemoteManifest,
  SyncedTreeState,
  SyncLogEntry,
  WebDavConfig,
} from '../types';
import { decryptText, encryptText, isEncryptedPayload } from './crypto';
import {
  INBOX_FOLDER_ID,
  INBOX_FOLDER_NAME,
  parseWebDavInboxXml,
  RemoteInboxFile,
  resolveDuplicateDocImport,
} from './inbox';
import { extractExcerpt, formatBytes, getByteSize, sha256Hex } from './textParser';
import { isTrashExpired, purgeExpiredTrash } from './trash';

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

interface WebDavNativePlugin {
  request(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    contentType?: string;
  }): Promise<{
    status: number;
    body?: string;
    etag?: string;
    lastModified?: string;
    error?: string;
  }>;
}

const WebDavNative = registerPlugin<WebDavNativePlugin>('WebDavNative');

export const DEFAULT_JIANGUOYUN_URL = 'https://dav.jianguoyun.com/dav/FeiArtical/';

const MANIFEST_PATH = '_manifest.json';
const DOCS_DIR = 'docs/';
const INBOX_DIR = `${INBOX_FOLDER_NAME}/`;

/**
 * Normalize user-entered WebDAV URL:
 * - Trims whitespace & auto-prepends https:// if protocol is omitted
 * - Percent-encodes non-ASCII folder names cleanly via URL()
 * - For Jianguoyun bare root (https://dav.jianguoyun.com/dav/), automatically appends FeiArtical/
 *   because Jianguoyun forbids uploading files directly into /dav/ root.
 */
export function normalizeWebDavBaseUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return DEFAULT_JIANGUOYUN_URL;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    const host = parsed.hostname.toLowerCase();
    let pathname = parsed.pathname || '/';

    if (host === 'dav.jianguoyun.com') {
      const cleanedPath = pathname.replace(/\/+$/, '');
      if (cleanedPath === '' || cleanedPath === '/dav') {
        pathname = '/dav/FeiArtical/';
      }
    }

    if (!pathname.endsWith('/')) {
      pathname = `${pathname}/`;
    }
    parsed.pathname = pathname;
    return parsed.toString();
  } catch {
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  }
}

function encodeBasicAuthUtf8(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `Basic ${btoa(binary)}`;
}

function getHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string
): string {
  if (!headers) return '';
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return '';
}

function isSuccessHttpStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

async function callWebDavUrlNative(
  url: string,
  username: string,
  password: string,
  method: 'GET' | 'PUT' | 'MKCOL' | 'DELETE' | 'PROPFIND' | 'HEAD',
  options?: { body?: string; ifNoneMatch?: string; depth?: '0' | '1' }
): Promise<ProxyResponse> {
  const headers: Record<string, string> = {
    Authorization: encodeBasicAuthUtf8(username, password),
    'User-Agent': 'FeiArtical-Android/1.0',
  };
  if (options?.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;
  if (options?.depth) headers['Depth'] = options.depth;

  const contentType =
    method === 'PUT'
      ? url.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8'
      : method === 'PROPFIND'
        ? 'application/xml; charset=utf-8'
        : 'text/plain; charset=utf-8';

  if (method === 'PUT' || method === 'PROPFIND') {
    headers['Content-Type'] = contentType;
  }

  // Prefer OkHttp-based native WebDavPlugin (supports MKCOL/PROPFIND and raw UTF-8 bodies cleanly)
  if (Capacitor.isPluginAvailable('WebDavNative')) {
    try {
      const res = await WebDavNative.request({
        url,
        method,
        headers,
        body:
          method === 'PUT'
            ? (options?.body ?? '')
            : method === 'PROPFIND'
              ? '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getetag/><D:getlastmodified/><D:getcontentlength/></D:prop></D:propfind>'
              : undefined,
        contentType,
      });

      const status = res.status || 0;
      if (status === 0 && res.error) {
        return { ok: false, status: 0, error: res.error };
      }

      const rawBody = typeof res.body === 'string' ? res.body : '';
      return {
        ok: isSuccessHttpStatus(status),
        status,
        etag: res.etag,
        lastModified: res.lastModified,
        body: status === 304 ? '' : rawBody,
        bytesTransferred: status === 304 ? 0 : getByteSize(rawBody),
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : '坚果云网络请求失败',
      };
    }
  }

  // Fallback to CapacitorHttp (note: HttpURLConnection only allows standard HTTP methods)
  try {
    const res = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: method === 'PUT' ? (options?.body ?? '') : undefined,
      responseType: 'text',
    });

    const status = res.status || 0;
    const rawBody =
      typeof res.data === 'string'
        ? res.data
        : res.data != null
          ? JSON.stringify(res.data)
          : '';
    const etag = getHeaderCaseInsensitive(res.headers, 'etag');
    const lastModified = getHeaderCaseInsensitive(res.headers, 'last-modified');

    return {
      ok: isSuccessHttpStatus(status),
      status,
      etag,
      lastModified,
      body: status === 304 ? '' : rawBody,
      bytesTransferred: status === 304 ? 0 : getByteSize(rawBody),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : '坚果云网络请求失败',
    };
  }
}

async function callWebDavUrl(
  baseUrl: string,
  username: string,
  password: string,
  method: 'GET' | 'PUT' | 'MKCOL' | 'DELETE' | 'PROPFIND' | 'HEAD',
  relativePath: string,
  options?: { body?: string; ifNoneMatch?: string; depth?: '0' | '1' }
): Promise<ProxyResponse> {
  const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const cleanRel = relativePath.replace(/^\/+/, '');
  const fullUrl = `${cleanBase}${cleanRel}`;

  if (Capacitor.isNativePlatform()) {
    return callWebDavUrlNative(fullUrl, username, password, method, options);
  }

  try {
    const res = await fetch('/api/webdav/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: cleanBase,
        username,
        password,
        method,
        relativePath: cleanRel,
        body: options?.body,
        ifNoneMatch: options?.ifNoneMatch,
        depth: options?.depth,
      }),
    });

    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as ProxyResponse;
      return {
        ok: Boolean(parsed.ok),
        status: typeof parsed.status === 'number' ? parsed.status : res.status,
        statusText: parsed.statusText,
        etag: parsed.etag,
        lastModified: parsed.lastModified,
        body: parsed.body,
        bytesTransferred: parsed.bytesTransferred,
        error: parsed.error,
      };
    } catch {
      return {
        ok: false,
        status: res.status || 0,
        error: `同步代理返回异常（HTTP ${res.status}）`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : '网络请求失败，请检查网络连接',
    };
  }
}

async function callWebDav(
  config: WebDavConfig,
  method: 'GET' | 'PUT' | 'MKCOL' | 'DELETE' | 'PROPFIND' | 'HEAD',
  relativePath: string,
  options?: { body?: string; ifNoneMatch?: string; depth?: '0' | '1' }
): Promise<ProxyResponse> {
  const normalizedBase = normalizeWebDavBaseUrl(config.baseUrl);
  return callWebDavUrl(
    normalizedBase,
    config.username.trim(),
    config.password.trim(),
    method,
    relativePath,
    options
  );
}

/**
 * Recursively create missing collection folders on WebDAV (e.g. /dav/FeiArtical/ and /dav/FeiArtical/docs/).
 * On Jianguoyun, MKCOL returns 201 (created) or 405 (already exists) — both are treated as success.
 */
async function ensureRemoteDirectories(
  config: WebDavConfig
): Promise<{ requests: number; authFailedStatus?: number; docsReady: boolean }> {
  const normalizedBase = normalizeWebDavBaseUrl(config.baseUrl);
  const username = config.username.trim();
  const password = config.password.trim();
  let requests = 0;

  try {
    const parsed = new URL(normalizedBase);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const isJianguoyun = parsed.hostname.toLowerCase() === 'dav.jianguoyun.com';

    // Never MKCOL /dav/ itself on Jianguoyun; start from the subfolder after /dav/
    const startIdx = isJianguoyun && segments[0]?.toLowerCase() === 'dav' ? 1 : 0;

    let currentPath = startIdx > 0 ? `/${segments.slice(0, startIdx).join('/')}/` : '/';
    for (let i = startIdx; i < segments.length; i++) {
      currentPath = `${currentPath}${segments[i]}/`;
      const targetDir = `${parsed.origin}${currentPath}`;
      requests++;
      const res = await callWebDavUrl(targetDir, username, password, 'MKCOL', '');
      if (res.status === 401 || res.status === 403) {
        return { requests, authFailedStatus: res.status, docsReady: false };
      }
    }
  } catch {
    requests++;
    const baseRes = await callWebDav(config, 'MKCOL', '');
    if (baseRes.status === 401 || baseRes.status === 403) {
      return { requests, authFailedStatus: baseRes.status, docsReady: false };
    }
  }

  requests++;
  const docsRes = await callWebDav(config, 'MKCOL', DOCS_DIR);
  if (docsRes.status === 401 || docsRes.status === 403) {
    return { requests, authFailedStatus: docsRes.status, docsReady: false };
  }
  const docsReady =
    docsRes.ok || docsRes.status === 201 || docsRes.status === 405 || docsRes.status === 301;

  // Also ensure the dropbox inbox/ directory exists alongside docs/
  requests++;
  const inboxRes = await callWebDav(config, 'MKCOL', INBOX_DIR);
  if (inboxRes.status === 401 || inboxRes.status === 403) {
    return { requests, authFailedStatus: inboxRes.status, docsReady: false };
  }

  return { requests, docsReady };
}

function formatSyncHttpError(prefix: string, res: ProxyResponse): string {
  if (res.status === 401 || res.status === 403) {
    return `坚果云认证失败（HTTP ${res.status}），请确认填写的是坚果云「应用密码」而非登录密码`;
  }
  if (res.status === 503 || res.status === 429) {
    return `坚果云请求过于频繁（HTTP ${res.status}），请稍后再试`;
  }
  if (res.status === 409) {
    return `${prefix}（HTTP 409）：远端目录不存在，请先在坚果云中创建对应文件夹或检查同步地址`;
  }
  if (res.status === 0) {
    return res.error || `${prefix}：无法连接服务器，请检查网络或同步地址`;
  }
  return res.error || `${prefix}（HTTP ${res.status}）`;
}

export async function testWebDavConnection(
  config: WebDavConfig
): Promise<{ ok: boolean; message: string }> {
  const result = await callWebDav(config, 'PROPFIND', '', { depth: '0' });
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      message: '鉴权失败（401）：请确认填写的是坚果云「应用密码」，而非登录密码。',
    };
  }
  if (result.status === 404 || result.status === 409) {
    const ensured = await ensureRemoteDirectories(config);
    if (ensured.authFailedStatus) {
      return {
        ok: false,
        message: '鉴权失败：请确认填写的是坚果云「应用密码」，而非登录密码。',
      };
    }
    if (ensured.docsReady) {
      return { ok: true, message: '连接成功，已在坚果云自动创建同步目录。' };
    }
    return {
      ok: false,
      message: '目录不存在且无法创建，请先在坚果云新建 FeiArtical 同步文件夹。',
    };
  }
  if (result.ok) {
    return { ok: true, message: `连接成功（HTTP ${result.status}），支持增量同步协议。` };
  }
  return { ok: false, message: formatSyncHttpError('连接异常', result) };
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
      lastCharOffset: doc.lastCharOffset ?? 0,
      encrypted: Boolean(doc.encrypted),
      format: doc.format ?? 'txt',
      updatedAt: doc.updatedAt,
      createdAt: doc.createdAt,
      deleted: doc.deleted,
      deletedAt: doc.deletedAt,
      deletedByFolderId: doc.deletedByFolderId,
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
          baseUrl: normalizeWebDavBaseUrl(config.baseUrl),
          username: config.username.trim(),
          password: config.password.trim(),
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
 * - Automatically normalizes Jianguoyun URLs & creates remote folders on 404/409
 * - Syncs all document contents (AES-256-GCM encrypted when doc.encrypted is true)
 * - Syncs all document states (encrypted, lastMode, lastScrollTop, order, folderId)
 * - Syncs directory tree state (folders, collapsedIds, activeTarget, scrollTop)
 * - Syncs settings parameters (Jianguoyun WebDAV params + encryption password)
 */
export async function runIncrementalWebDavSync(
  rawConfig: WebDavConfig,
  localFolders: FolderNode[],
  localDocs: ArticleDoc[],
  localTreeState: SyncedTreeState,
  metaDirty = false,
  purgedRecords?: PurgedSyncRecords
): Promise<SyncOutcome> {
  const syncNow = Date.now();
  const config: WebDavConfig = {
    ...rawConfig,
    baseUrl: normalizeWebDavBaseUrl(rawConfig.baseUrl),
    username: rawConfig.username.trim(),
    password: rawConfig.password.trim(),
  };

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
    throw new Error(formatSyncHttpError('拉取索引失败', manifestRes));
  }

  let remoteManifest: RemoteManifest | null = null;
  let newEtag = config.lastManifestEtag;
  let dirsEnsured = false;
  const wasEtag304 = manifestRes.status === 304;

  if (wasEtag304) {
    skippedByEtag304++;
  } else if (manifestRes.status === 404 || manifestRes.status === 409) {
    // First sync or missing remote folder: Jianguoyun returns 404 (no file) or 409 (no parent folder)
    const ensured = await ensureRemoteDirectories(config);
    requestCount += ensured.requests;
    dirsEnsured = true;
    if (ensured.authFailedStatus) {
      throw new Error(
        formatSyncHttpError('创建远端目录失败', { ok: false, status: ensured.authFailedStatus })
      );
    }
  } else if (manifestRes.ok && manifestRes.body) {
    downloadBytes += manifestRes.bytesTransferred || getByteSize(manifestRes.body);
    newEtag = manifestRes.etag || newEtag;
    try {
      remoteManifest = JSON.parse(manifestRes.body) as RemoteManifest;
    } catch {
      remoteManifest = null;
    }
  } else if (!manifestRes.ok) {
    throw new Error(formatSyncHttpError('拉取索引失败', manifestRes));
  }

  // Step 1b: Check Jianguoyun inbox/ dropbox folder for external files
  let inboxFiles: RemoteInboxFile[] = [];
  requestCount++;
  const inboxPropRes = await callWebDav(config, 'PROPFIND', INBOX_DIR, { depth: '1' });
  if (inboxPropRes.status === 401 || inboxPropRes.status === 403) {
    throw new Error(formatSyncHttpError('检查投递箱失败', inboxPropRes));
  } else if (inboxPropRes.status === 404 || inboxPropRes.status === 409) {
    if (!dirsEnsured) {
      const ensured = await ensureRemoteDirectories(config);
      requestCount += ensured.requests;
      dirsEnsured = true;
      if (ensured.authFailedStatus) {
        throw new Error(
          formatSyncHttpError('创建投递箱目录失败', { ok: false, status: ensured.authFailedStatus })
        );
      }
    }
  } else if (inboxPropRes.ok && typeof inboxPropRes.body === 'string') {
    downloadBytes += inboxPropRes.bytesTransferred || getByteSize(inboxPropRes.body);
    inboxFiles = parseWebDavInboxXml(inboxPropRes.body, `${config.baseUrl}${INBOX_DIR}`);
  }

  const hasExpiredLocalTrash =
    localFolders.some((f) => isTrashExpired(f, syncNow)) ||
    localDocs.some((d) => isTrashExpired(d, syncNow));
  const hasPendingPurges = Boolean(
    purgedRecords &&
      (Object.keys(purgedRecords.docs).length > 0 ||
        Object.keys(purgedRecords.folders).length > 0)
  );

  if (
    wasEtag304 &&
    dirtyDocs.length === 0 &&
    !metaDirty &&
    inboxFiles.length === 0 &&
    !hasExpiredLocalTrash &&
    !hasPendingPurges
  ) {
    return {
      folders: localFolders,
      docs: localDocs,
      treeState: localTreeState,
      config: { ...config, lastSyncedAt: Date.now() },
      quotaDelta: {
        uploadBytes: 0,
        downloadBytes,
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
        downloadBytes,
        status: 'noop',
      },
    };
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
      baseUrl: normalizeWebDavBaseUrl(remoteSettings.baseUrl || mergedConfig.baseUrl),
      username: (remoteSettings.username || mergedConfig.username).trim(),
      password: (remoteSettings.password || mergedConfig.password).trim(),
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
      const purgedAt = purgedRecords?.folders?.[rf.id];
      if ((purgedAt && purgedAt >= rf.updatedAt) || isTrashExpired(rf, syncNow)) {
        needManifestPush = true;
        continue;
      }
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
    const shouldPush = wasEtag304
      ? doc.syncStatus === 'dirty'
      : (doc.syncStatus === 'dirty' || !remoteEntry || encryptionDiffers) && isLocallyNewer;

    if (shouldPush) {
      if ((wasEtag304 || hashDiffers || encryptionDiffers || doc.syncStatus === 'dirty') && !doc.deleted) {
        let uploadBody = doc.content;
        if (doc.encrypted) {
          if (!effectiveEncPassword) {
            throw new Error(`文档《${doc.title}》已启用加密，请点击设置图标设置加密密码`);
          }
          uploadBody = await encryptText(doc.content, effectiveEncPassword);
        }

        const docExt = doc.format === 'md' ? 'md' : 'txt';
        requestCount++;
        let putRes = await callWebDav(config, 'PUT', `${DOCS_DIR}${doc.id}.${docExt}`, {
          body: uploadBody,
        });

        if (!putRes.ok && (putRes.status === 404 || putRes.status === 409)) {
          if (!dirsEnsured) {
            const ensured = await ensureRemoteDirectories(config);
            requestCount += ensured.requests;
            dirsEnsured = true;
            requestCount++;
            putRes = await callWebDav(config, 'PUT', `${DOCS_DIR}${doc.id}.${docExt}`, {
              body: uploadBody,
            });
          }
          if (!putRes.ok && (putRes.status === 404 || putRes.status === 409)) {
            // Fallback to root sync folder if docs/ subfolder cannot be created
            requestCount++;
            putRes = await callWebDav(config, 'PUT', `${doc.id}.${docExt}`, {
              body: uploadBody,
            });
          }
        }

        if (!putRes.ok) {
          throw new Error(formatSyncHttpError(`上传《${doc.title}》失败`, putRes));
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
  const remotePurgedDocsToDelete: Array<{ id: string; format: 'txt' | 'md' }> = [];
  if (remoteManifest?.docs) {
    for (const [id, rEntry] of Object.entries(remoteManifest.docs)) {
      const purgedAt = purgedRecords?.docs?.[id];
      if ((purgedAt && purgedAt >= rEntry.updatedAt) || isTrashExpired(rEntry, syncNow)) {
        remotePurgedDocsToDelete.push({ id, format: rEntry.format === 'md' ? 'md' : 'txt' });
        needManifestPush = true;
        continue;
      }
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
            lastCharOffset: rEntry.lastCharOffset ?? localDoc?.lastCharOffset ?? 0,
            encrypted: Boolean(rEntry.encrypted),
            format: rEntry.format ?? localDoc?.format ?? 'txt',
            createdAt: rEntry.createdAt,
            updatedAt: rEntry.updatedAt,
            deleted: rEntry.deleted,
            deletedAt: rEntry.deletedAt,
            deletedByFolderId: rEntry.deletedByFolderId,
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
            lastCharOffset: rEntry.lastCharOffset ?? localDoc?.lastCharOffset ?? 0,
            encrypted: Boolean(rEntry.encrypted),
            format: rEntry.format ?? localDoc?.format ?? 'txt',
            createdAt: rEntry.createdAt,
            updatedAt: rEntry.updatedAt,
            deleted: rEntry.deleted,
            deletedAt: rEntry.deletedAt,
            deletedByFolderId: rEntry.deletedByFolderId,
            highlights: localDoc?.highlights || [],
            byteSize: rEntry.byteSize,
            syncStatus: 'remote-only',
          });
        } else {
          const primaryExt = rEntry.format === 'md' ? 'md' : 'txt';
          const fallbackExt = primaryExt === 'txt' ? 'md' : 'txt';
          requestCount++;
          let getDoc = await callWebDav(config, 'GET', `${DOCS_DIR}${id}.${primaryExt}`);
          if (!getDoc.ok && (getDoc.status === 404 || getDoc.status === 409)) {
            requestCount++;
            getDoc = await callWebDav(config, 'GET', `${DOCS_DIR}${id}.${fallbackExt}`);
          }
          if (!getDoc.ok && (getDoc.status === 404 || getDoc.status === 409)) {
            requestCount++;
            getDoc = await callWebDav(config, 'GET', `${id}.${primaryExt}`);
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
              lastCharOffset: rEntry.lastCharOffset ?? localDoc?.lastCharOffset ?? 0,
              encrypted: Boolean(rEntry.encrypted),
              format: rEntry.format ?? 'txt',
              createdAt: rEntry.createdAt,
              updatedAt: rEntry.updatedAt,
              deleted: rEntry.deleted,
              deletedAt: rEntry.deletedAt,
              deletedByFolderId: rEntry.deletedByFolderId,
              highlights: localDoc?.highlights || [],
              byteSize: getByteSize(plainContent),
              syncStatus: 'synced',
            });
          }
        }
      }
    }
  }

  // 5c. Ingest files placed inside Jianguoyun inbox/ into app's dynamic inbox folder
  let inboxImportedCount = 0;
  const inboxFilesToDelete: string[] = [];

  if (inboxFiles.length > 0) {
    let nextInboxOrder = Array.from(mergedDocsMap.values())
      .filter((d) => !d.deleted && d.folderId === INBOX_FOLDER_ID)
      .reduce((max, d) => Math.max(max, d.order), -1) + 1;

    for (let i = 0; i < inboxFiles.length; i++) {
      const inboxFile = inboxFiles[i];
      requestCount++;
      const getInboxRes = await callWebDav(config, 'GET', inboxFile.relPath);
      if (getInboxRes.status === 401 || getInboxRes.status === 403) {
        throw new Error(formatSyncHttpError('读取投递箱文件失败', getInboxRes));
      }
      if (!getInboxRes.ok || typeof getInboxRes.body !== 'string') {
        continue;
      }

      const plainContent = getInboxRes.body.replace(/^\uFEFF/, '');
      downloadBytes += getInboxRes.bytesTransferred || getByteSize(plainContent);

      const isMd = /\.(md|markdown)$/i.test(inboxFile.name);
      const format: 'txt' | 'md' = isMd ? 'md' : 'txt';
      const rawTitle =
        inboxFile.name.replace(/\.(txt|md|markdown|text)$/i, '').trim() || '导入文档';

      const dupRes = await resolveDuplicateDocImport(
        rawTitle,
        plainContent,
        Array.from(mergedDocsMap.values())
      );

      if (dupRes.action === 'skip') {
        inboxFilesToDelete.push(inboxFile.relPath);
        continue;
      }

      const now = Date.now() + i;
      const newDoc: ArticleDoc = {
        id: `doc_${now}_${Math.random().toString(36).slice(2, 6)}`,
        title: dupRes.title,
        folderId: INBOX_FOLDER_ID,
        order: nextInboxOrder++,
        content: plainContent,
        contentHash: dupRes.contentHash,
        excerpt: extractExcerpt(plainContent),
        tags: [],
        starred: false,
        readProgress: 0,
        lastReadAt: null,
        lastMode: 'read',
        lastScrollTop: 0,
        lastCharOffset: 0,
        format,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'synced',
        highlights: [],
        byteSize: getByteSize(plainContent),
      };

      requestCount++;
      let putDocRes = await callWebDav(config, 'PUT', `${DOCS_DIR}${newDoc.id}.${format}`, {
        body: plainContent,
      });
      if (!putDocRes.ok && (putDocRes.status === 404 || putDocRes.status === 409)) {
        if (!dirsEnsured) {
          const ensured = await ensureRemoteDirectories(config);
          requestCount += ensured.requests;
          dirsEnsured = true;
          requestCount++;
          putDocRes = await callWebDav(config, 'PUT', `${DOCS_DIR}${newDoc.id}.${format}`, {
            body: plainContent,
          });
        }
        if (!putDocRes.ok && (putDocRes.status === 404 || putDocRes.status === 409)) {
          requestCount++;
          putDocRes = await callWebDav(config, 'PUT', `${newDoc.id}.${format}`, {
            body: plainContent,
          });
        }
      }

      if (!putDocRes.ok) {
        throw new Error(formatSyncHttpError(`归档投递箱《${newDoc.title}》失败`, putDocRes));
      }

      uploadBytes += getByteSize(plainContent);
      inboxImportedCount++;
      mergedDocsMap.set(newDoc.id, newDoc);
      needManifestPush = true;
      inboxFilesToDelete.push(inboxFile.relPath);
    }
  }

  const purgedMerge = purgeExpiredTrash(
    mergedFolders,
    Array.from(mergedDocsMap.values()),
    syncNow
  );
  const finalFolders = purgedMerge.folders;
  const finalDocs = purgedMerge.docs;
  if (purgedMerge.changed || hasPendingPurges) {
    needManifestPush = true;
    for (const d of purgedMerge.expiredDocs) {
      remotePurgedDocsToDelete.push({ id: d.id, format: d.format === 'md' ? 'md' : 'txt' });
    }
    if (purgedRecords?.docs) {
      for (const purgedId of Object.keys(purgedRecords.docs)) {
        const fmt = purgedRecords.docFormats?.[purgedId] ?? 'txt';
        remotePurgedDocsToDelete.push({ id: purgedId, format: fmt });
      }
    }
  }

  // Step 6: Upload single updated _manifest.json containing all doc states, tree state & sync settings
  if (needManifestPush || metaDirty || (!remoteManifest && !wasEtag304)) {
    const nextManifest = buildLocalManifest(finalFolders, finalDocs, mergedTreeState, mergedConfig);
    const manifestJson = JSON.stringify(nextManifest);
    requestCount++;
    let putManifest = await callWebDav(config, 'PUT', MANIFEST_PATH, { body: manifestJson });
    if (!putManifest.ok && (putManifest.status === 404 || putManifest.status === 409)) {
      const ensured = await ensureRemoteDirectories(config);
      requestCount += ensured.requests;
      requestCount++;
      putManifest = await callWebDav(config, 'PUT', MANIFEST_PATH, { body: manifestJson });
    }
    if (!putManifest.ok) {
      throw new Error(formatSyncHttpError('更新云端索引失败', putManifest));
    }
    uploadBytes += getByteSize(manifestJson);
    newEtag = putManifest.etag || newEtag;
  }

  // Step 7: Delete processed inbox/ files & permanently purged remote doc files ONLY AFTER _manifest.json succeeds
  for (const relPath of inboxFilesToDelete) {
    requestCount++;
    await callWebDav(config, 'DELETE', relPath);
  }
  const seenPurgeIds = new Set<string>();
  for (const item of remotePurgedDocsToDelete) {
    if (seenPurgeIds.has(item.id)) continue;
    seenPurgeIds.add(item.id);
    requestCount++;
    const delRes = await callWebDav(config, 'DELETE', `${DOCS_DIR}${item.id}.${item.format}`);
    if (delRes.status === 404) {
      const altFormat = item.format === 'txt' ? 'md' : 'txt';
      requestCount++;
      const altRes = await callWebDav(config, 'DELETE', `${DOCS_DIR}${item.id}.${altFormat}`);
      if (altRes.status === 404) {
        requestCount++;
        await callWebDav(config, 'DELETE', `${item.id}.${item.format}`);
      }
    }
  }

  const summaryParts: string[] = [];
  if (inboxImportedCount > 0) summaryParts.push(`投递箱导入 ${inboxImportedCount} 篇`);
  if (pushedCount > 0) summaryParts.push(`上传 ${pushedCount} 篇`);
  if (pulledCount > 0) summaryParts.push(`拉取 ${pulledCount} 篇`);
  if (lazyQueuedCount > 0) summaryParts.push(`索引 ${lazyQueuedCount} 篇`);
  const summary =
    summaryParts.length > 0
      ? `同步完成（${summaryParts.join(' · ')}）`
      : '同步完成';

  return {
    folders: finalFolders,
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
  if (!res.ok && (res.status === 404 || res.status === 409)) {
    res = await callWebDav(config, 'GET', `${DOCS_DIR}${docId}.${fallbackExt}`);
  }
  if (!res.ok && (res.status === 404 || res.status === 409)) {
    res = await callWebDav(config, 'GET', `${docId}.${primaryExt}`);
  }
  if (!res.ok || typeof res.body !== 'string') {
    throw new Error(formatSyncHttpError('拉取正文失败', res));
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

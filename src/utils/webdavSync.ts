import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import {
  ArticleDoc,
  FolderNode,
  ManifestDocEntry,
  PurgedSyncRecords,
  QuotaStats,
  RemoteManifest,
  SyncedTreeState,
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
import { extractExcerpt, getByteSize, sha256Hex } from './textParser';
import { isTrashExpired, purgeExpiredTrash } from './trash';
import { mergeReadingNotes, notesEqual, sanitizeNotesList } from './notes';
import {
  extractReadAnchorText,
  isProgressMeaningfullyDifferent,
  reconcileReadingProgress,
  relocateCharOffsetByAnchor,
} from './progressSync';

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
export const CLOUD_SHORT_DOC_MAX_BYTES = 200 * 1024; // 200 KB optional cloud fallback limit

const MANIFEST_PATH = '_manifest.json';
const DOCS_DIR = 'docs/';
const INBOX_DIR = `${INBOX_FOLDER_NAME}/`;
const ensuredInboxBaseUrls = new Set<string>();
const EMPTY_CONTENT_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function isDocBodyMissing(doc: ArticleDoc): boolean {
  if (doc.deleted) return false;
  if (doc.syncStatus === 'remote-only') return true;
  if (doc.content.length > 0) return false;
  return (
    doc.byteSize > 0 ||
    (Boolean(doc.contentHash) && doc.contentHash !== EMPTY_CONTENT_SHA256)
  );
}

function trimManifestExcerpt(excerpt: string): string {
  const clean = (excerpt || '').trim();
  if (clean.length <= 48) return clean;
  return `${clean.slice(0, 48).trim()}…`;
}

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
  options?: { body?: string; ifNoneMatch?: string; ifMatch?: string; depth?: '0' | '1' }
): Promise<ProxyResponse> {
  const headers: Record<string, string> = {
    Authorization: encodeBasicAuthUtf8(username, password),
    'User-Agent': 'FeiArtical-Android/1.0',
  };
  if (options?.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;
  if (options?.ifMatch) headers['If-Match'] = options.ifMatch;
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
  options?: { body?: string; ifNoneMatch?: string; ifMatch?: string; depth?: '0' | '1' }
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
        ifMatch: options?.ifMatch,
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
  options?: { body?: string; ifNoneMatch?: string; ifMatch?: string; depth?: '0' | '1' }
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
 * Recursively create missing collection folders on WebDAV (e.g. /dav/FeiArtical/ and optionally docs/).
 */
async function ensureRemoteDirectories(
  config: WebDavConfig,
  includeDocsDir = false
): Promise<{ requests: number; authFailedStatus?: number; docsReady: boolean }> {
  const normalizedBase = normalizeWebDavBaseUrl(config.baseUrl);
  const username = config.username.trim();
  const password = config.password.trim();
  let requests = 0;

  try {
    const parsed = new URL(normalizedBase);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const isJianguoyun = parsed.hostname.toLowerCase() === 'dav.jianguoyun.com';
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

  let docsReady = true;
  if (includeDocsDir) {
    requests++;
    const docsRes = await callWebDav(config, 'MKCOL', DOCS_DIR);
    if (docsRes.status === 401 || docsRes.status === 403) {
      return { requests, authFailedStatus: docsRes.status, docsReady: false };
    }
    docsReady =
      docsRes.ok || docsRes.status === 201 || docsRes.status === 405 || docsRes.status === 301;

    if (!ensuredInboxBaseUrls.has(normalizedBase)) {
      requests++;
      const inboxRes = await callWebDav(config, 'MKCOL', INBOX_DIR);
      if (inboxRes.status === 401 || inboxRes.status === 403) {
        return { requests, authFailedStatus: inboxRes.status, docsReady: false };
      }
      if (inboxRes.ok || inboxRes.status === 201 || inboxRes.status === 405 || inboxRes.status === 301) {
        ensuredInboxBaseUrls.add(normalizedBase);
      }
    }
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
    const ensured = await ensureRemoteDirectories(config, true);
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

function toManifestDocEntry(doc: ArticleDoc, cloudBodySynced?: boolean): ManifestDocEntry {
  return {
    id: doc.id,
    title: doc.title,
    folderId: doc.folderId,
    order: doc.order,
    contentHash: doc.contentHash,
    excerpt: doc.encrypted ? '' : trimManifestExcerpt(doc.excerpt),
    tags: doc.tags,
    starred: doc.starred,
    readProgress: doc.readProgress,
    lastReadAt: doc.lastReadAt,
    lastMode: doc.lastMode ?? 'read',
    lastScrollTop: doc.lastScrollTop ?? 0,
    lastCharOffset: doc.lastCharOffset ?? 0,
    readAnchorText: doc.encrypted
      ? undefined
      : doc.readAnchorText ||
        (doc.content ? extractReadAnchorText(doc.content, doc.lastCharOffset ?? 0) : undefined) ||
        undefined,
    progressOverrideAt: doc.progressOverrideAt || undefined,
    encrypted: Boolean(doc.encrypted),
    format: doc.format ?? 'txt',
    cloudBodySynced: Boolean(cloudBodySynced ?? doc.cloudBodySynced),
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    deleted: doc.deleted,
    deletedAt: doc.deletedAt,
    deletedByFolderId: doc.deletedByFolderId,
    notes: (() => {
      const clean = sanitizeNotesList(doc.notes);
      if (clean.length === 0) return undefined;
      return doc.encrypted ? clean.map((n) => ({ ...n, anchorText: '' })) : clean;
    })(),
    byteSize: doc.byteSize,
  };
}

export interface AutoSyncOutcome {
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
  pulledProgressDocIds: Record<string, number>;
  didPush: boolean;
  didPull: boolean;
  purgedSynced?: boolean;
  wasRateLimited?: boolean;
  authFailed?: boolean;
  oversizedInboxCount?: number;
}

function pendingRemoteProgressEqual(
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

function tagsEqual(a?: string[], b?: string[]): boolean {
  const arrA = a || [];
  const arrB = b || [];
  if (arrA.length !== arrB.length) return false;
  for (let i = 0; i < arrA.length; i++) {
    if (arrA[i] !== arrB[i]) return false;
  }
  return true;
}

function catalogFieldsDiffer(localDoc: ArticleDoc, remoteEntry: ManifestDocEntry): boolean {
  return (
    localDoc.title !== remoteEntry.title ||
    (localDoc.folderId ?? null) !== (remoteEntry.folderId ?? null) ||
    localDoc.order !== remoteEntry.order ||
    Boolean(localDoc.starred) !== Boolean(remoteEntry.starred) ||
    Boolean(localDoc.deleted) !== Boolean(remoteEntry.deleted) ||
    (localDoc.deletedAt ?? undefined) !== (remoteEntry.deletedAt ?? undefined) ||
    (localDoc.deletedByFolderId ?? undefined) !== (remoteEntry.deletedByFolderId ?? undefined) ||
    Boolean(localDoc.encrypted) !== Boolean(remoteEntry.encrypted) ||
    !tagsEqual(localDoc.tags, remoteEntry.tags) ||
    !notesEqual(localDoc.notes, remoteEntry.notes)
  );
}

function folderFieldsDiffer(a: FolderNode, b: FolderNode): boolean {
  return (
    a.name !== b.name ||
    a.order !== b.order ||
    Boolean(a.deleted) !== Boolean(b.deleted) ||
    (a.deletedAt ?? undefined) !== (b.deletedAt ?? undefined)
  );
}

/**
 * Dual-track Jianguoyun cloud sync (catalog + reading progress + optional <= 200 KB short-doc & inbox fallback):
 * - Always syncs directory structure, catalog metadata (Option A: remote new books appear as stubs pending Wi-Fi sync),
 *   and per-book reading progress via lightweight `_manifest.json`.
 * - Never uploads/downloads large docs (> 200 KB) or images to Jianguoyun.
 * - Optional lightweight fallback: when `syncShortDocsViaCloud` is enabled, non-deleted docs <= 200 KB sync
 *   their bodies through Jianguoyun `docs/{id}.{ext}` (`cloudBodySynced: true`), AND short text/markdown files
 *   (<= 200 KB) dropped into Jianguoyun `inbox/` are ingested into the `inbox` folder and synced automatically.
 */
export async function runAutoMetadataProgressSync(
  rawConfig: WebDavConfig,
  localFolders: FolderNode[],
  localDocs: ArticleDoc[],
  localTreeState: SyncedTreeState,
  hasLocalChanges: boolean,
  purgedRecords?: PurgedSyncRecords,
  retryOnPreconditionFailed = true
): Promise<AutoSyncOutcome> {
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
  let dirsEnsured = false;
  let docsDirEnsured = false;
  let oversizedInboxCount = 0;

  const listEligibleShortInboxFiles = async (
    targetConfig: WebDavConfig
  ): Promise<{ rateLimited: boolean; files: RemoteInboxFile[]; oversizedCount: number }> => {
    requestCount++;
    const inboxRes = await callWebDav(targetConfig, 'PROPFIND', INBOX_DIR, { depth: '1' });
    if (inboxRes.status === 429 || inboxRes.status === 503) {
      return { rateLimited: true, files: [], oversizedCount: 0 };
    }
    if (inboxRes.status === 404 || inboxRes.status === 409) {
      if (!ensuredInboxBaseUrls.has(targetConfig.baseUrl)) {
        requestCount++;
        const mkRes = await callWebDav(targetConfig, 'MKCOL', INBOX_DIR);
        if (mkRes.status === 429 || mkRes.status === 503) {
          return { rateLimited: true, files: [], oversizedCount: 0 };
        }
        if (mkRes.ok || mkRes.status === 201 || mkRes.status === 405 || mkRes.status === 301) {
          ensuredInboxBaseUrls.add(targetConfig.baseUrl);
        }
      }
      return { rateLimited: false, files: [], oversizedCount: 0 };
    }
    if (!inboxRes.ok || !inboxRes.body) {
      return { rateLimited: false, files: [], oversizedCount: 0 };
    }
    ensuredInboxBaseUrls.add(targetConfig.baseUrl);
    downloadBytes += inboxRes.bytesTransferred || getByteSize(inboxRes.body);
    const parsed = parseWebDavInboxXml(inboxRes.body, `${targetConfig.baseUrl}${INBOX_DIR}`);
    const eligible = parsed.filter(
      (f) => f.size === undefined || f.size <= CLOUD_SHORT_DOC_MAX_BYTES
    );
    const oversizedCount = parsed.length - eligible.length;
    return { rateLimited: false, files: eligible, oversizedCount };
  };

  const hasPendingPurges = Boolean(
    purgedRecords &&
      (Object.keys(purgedRecords.docs).length > 0 ||
        Object.keys(purgedRecords.folders).length > 0)
  );
  const hasEligibleUnbackedShortDoc = Boolean(
    config.syncShortDocsViaCloud &&
      localDocs.some(
        (d) =>
          !d.deleted &&
          !isDocBodyMissing(d) &&
          d.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES &&
          !d.cloudBodySynced
      )
  );
  const hasRemoteShortDocToAutoPull = Boolean(
    config.syncShortDocsViaCloud &&
      localDocs.some(
        (d) =>
          !d.deleted &&
          isDocBodyMissing(d) &&
          Boolean(d.cloudBodySynced) &&
          d.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES
      )
  );

  const hasUnpushedLocalProgress = localDocs.some(
    (d) =>
      !d.deleted &&
      !d.pendingRemoteProgress &&
      typeof d.lastSyncedCharOffset === 'number' &&
      isProgressMeaningfullyDifferent(
        d.lastCharOffset ?? 0,
        d.readProgress ?? 0,
        d.lastSyncedCharOffset,
        d.lastSyncedProgress ?? 0
      )
  );
  const hasUnpushedProgressOverride = localDocs.some(
    (d) =>
      !d.deleted &&
      !d.pendingRemoteProgress &&
      typeof d.progressOverrideAt === 'number' &&
      d.progressOverrideAt > (d.lastSyncedReadAt ?? 0)
  );

  const shouldBypass304 =
    hasLocalChanges ||
    hasPendingPurges ||
    hasEligibleUnbackedShortDoc ||
    hasRemoteShortDocToAutoPull ||
    hasUnpushedLocalProgress ||
    hasUnpushedProgressOverride;

  // Step 1: Conditional fetch _manifest.json (304 = 0 bytes when unchanged)
  requestCount++;
  let manifestRes = await callWebDav(config, 'GET', MANIFEST_PATH, {
    ifNoneMatch: shouldBypass304 ? undefined : config.lastAutoManifestEtag,
  });

  if (manifestRes.status === 401 || manifestRes.status === 403) {
    return {
      folders: localFolders,
      docs: localDocs,
      treeState: localTreeState,
      config,
      quotaDelta: {
        uploadBytes: 0,
        downloadBytes: 0,
        requestCount,
        skippedByEtag304: 0,
        skippedByHashMatch: 0,
      },
      pulledProgressDocIds: {},
      didPush: false,
      didPull: false,
      authFailed: true,
    };
  }

  if (manifestRes.status === 429 || manifestRes.status === 503) {
    return {
      folders: localFolders,
      docs: localDocs,
      treeState: localTreeState,
      config,
      quotaDelta: {
        uploadBytes: 0,
        downloadBytes: 0,
        requestCount,
        skippedByEtag304: 0,
        skippedByHashMatch: 0,
      },
      pulledProgressDocIds: {},
      didPush: false,
      didPull: false,
      wasRateLimited: true,
    };
  }

  let precheckedInboxFiles: RemoteInboxFile[] | null = null;
  if (manifestRes.status === 304 && !shouldBypass304) {
    if (config.syncShortDocsViaCloud) {
      const inboxCheck = await listEligibleShortInboxFiles(config);
      if (inboxCheck.rateLimited) {
        return {
          folders: localFolders,
          docs: localDocs,
          treeState: localTreeState,
          config,
          quotaDelta: {
            uploadBytes: 0,
            downloadBytes,
            requestCount,
            skippedByEtag304: 0,
            skippedByHashMatch: 0,
          },
          pulledProgressDocIds: {},
          didPush: false,
          didPull: false,
          wasRateLimited: true,
        };
      }
      precheckedInboxFiles = inboxCheck.files;
      oversizedInboxCount += inboxCheck.oversizedCount;
    }

    if (!precheckedInboxFiles || precheckedInboxFiles.length === 0) {
      skippedByEtag304++;
      return {
        folders: localFolders,
        docs: localDocs,
        treeState: localTreeState,
        config: {
          ...config,
          lastSyncedAt: Date.now(),
        },
        quotaDelta: {
          uploadBytes: 0,
          downloadBytes,
          requestCount,
          skippedByEtag304,
          skippedByHashMatch: localDocs.length,
        },
        pulledProgressDocIds: {},
        didPush: false,
        didPull: false,
        oversizedInboxCount: oversizedInboxCount > 0 ? oversizedInboxCount : undefined,
      };
    }

    // Eligible short files were dropped into inbox/ while manifest was 304 -> fetch full manifest to merge cleanly
    requestCount++;
    manifestRes = await callWebDav(config, 'GET', MANIFEST_PATH);
    if (manifestRes.status === 401 || manifestRes.status === 403) {
      return {
        folders: localFolders,
        docs: localDocs,
        treeState: localTreeState,
        config,
        quotaDelta: {
          uploadBytes: 0,
          downloadBytes,
          requestCount,
          skippedByEtag304: 0,
          skippedByHashMatch: 0,
        },
        pulledProgressDocIds: {},
        didPush: false,
        didPull: false,
        authFailed: true,
      };
    }
    if (manifestRes.status === 429 || manifestRes.status === 503) {
      return {
        folders: localFolders,
        docs: localDocs,
        treeState: localTreeState,
        config,
        quotaDelta: {
          uploadBytes: 0,
          downloadBytes,
          requestCount,
          skippedByEtag304: 0,
          skippedByHashMatch: 0,
        },
        pulledProgressDocIds: {},
        didPush: false,
        didPull: false,
        wasRateLimited: true,
      };
    }
  }

  let remoteManifest: RemoteManifest | null = null;
  let nextAutoEtag = config.lastAutoManifestEtag;
  let fetchedManifestEtag: string | undefined;

  if (manifestRes.status === 404 || manifestRes.status === 409) {
    const hasAnythingLocal =
      localFolders.length > 0 || localDocs.length > 0 || localTreeState.updatedAt > 0;
    if (!shouldBypass304 && !hasAnythingLocal) {
      return {
        folders: localFolders,
        docs: localDocs,
        treeState: localTreeState,
        config,
        quotaDelta: {
          uploadBytes: 0,
          downloadBytes: 0,
          requestCount,
          skippedByEtag304: 0,
          skippedByHashMatch: 0,
        },
        pulledProgressDocIds: {},
        didPush: false,
        didPull: false,
      };
    }
    const ensured = await ensureRemoteDirectories(config, Boolean(config.syncShortDocsViaCloud));
    requestCount += ensured.requests;
    dirsEnsured = true;
    docsDirEnsured = Boolean(config.syncShortDocsViaCloud && ensured.docsReady);
    if (ensured.authFailedStatus === 401 || ensured.authFailedStatus === 403) {
      return {
        folders: localFolders,
        docs: localDocs,
        treeState: localTreeState,
        config,
        quotaDelta: {
          uploadBytes: 0,
          downloadBytes,
          requestCount,
          skippedByEtag304: 0,
          skippedByHashMatch: 0,
        },
        pulledProgressDocIds: {},
        didPush: false,
        didPull: false,
        authFailed: true,
      };
    }
    if (ensured.authFailedStatus) {
      throw new Error(
        formatSyncHttpError('创建远端目录失败', {
          ok: false,
          status: ensured.authFailedStatus,
        })
      );
    }
  } else if (manifestRes.ok && manifestRes.body) {
    downloadBytes += manifestRes.bytesTransferred || getByteSize(manifestRes.body);
    nextAutoEtag = manifestRes.etag || nextAutoEtag;
    fetchedManifestEtag = manifestRes.etag || undefined;
    try {
      remoteManifest = JSON.parse(manifestRes.body) as RemoteManifest;
    } catch {
      remoteManifest = null;
    }
  } else if (!manifestRes.ok) {
    throw new Error(formatSyncHttpError('拉取目录索引失败', manifestRes));
  }

  let mergedConfig: WebDavConfig = { ...config };
  let needManifestPush = remoteManifest === null;
  let didPull = false;
  let didPush = false;
  const pulledProgressDocIds: Record<string, number> = {};

  // Step 2: Merge non-sensitive sync settings only (credentials & encryptionPassword stay strictly local)
  const remoteSettings = remoteManifest?.syncSettings as
    | (Record<string, unknown> & { syncShortDocsViaCloud?: boolean; updatedAt?: number })
    | undefined;
  const hasLegacySensitiveFields = Boolean(
    remoteSettings &&
      ('encryptionPassword' in remoteSettings ||
        'password' in remoteSettings ||
        'username' in remoteSettings ||
        'baseUrl' in remoteSettings)
  );
  if (hasLegacySensitiveFields) {
    // Automatically scrub legacy plaintext credentials from remote _manifest.json on push
    needManifestPush = true;
  }

  const localSettingsTs = config.settingsUpdatedAt || 0;
  const remoteSettingsTs =
    typeof remoteSettings?.updatedAt === 'number' ? remoteSettings.updatedAt : 0;
  if (remoteSettings && remoteSettingsTs > localSettingsTs) {
    const nextShortDocFlag =
      typeof remoteSettings.syncShortDocsViaCloud === 'boolean'
        ? remoteSettings.syncShortDocsViaCloud
        : Boolean(mergedConfig.syncShortDocsViaCloud);
    mergedConfig = {
      ...mergedConfig,
      syncShortDocsViaCloud: nextShortDocFlag,
      settingsUpdatedAt: remoteSettingsTs,
    };
    didPull = true;
  } else if (localSettingsTs > remoteSettingsTs) {
    needManifestPush = true;
  }

  const effectiveEncPassword = mergedConfig.encryptionPassword || '';
  const shortDocFallback = Boolean(mergedConfig.syncShortDocsViaCloud);

  const uploadShortDocBody = async (doc: ArticleDoc): Promise<boolean> => {
    if (doc.deleted || isDocBodyMissing(doc) || doc.byteSize > CLOUD_SHORT_DOC_MAX_BYTES) {
      return false;
    }
    let uploadBody = doc.content;
    if (doc.encrypted) {
      if (!effectiveEncPassword) {
        return false;
      }
      uploadBody = await encryptText(doc.content, effectiveEncPassword);
    }

    const docExt = doc.format === 'md' ? 'md' : 'txt';
    if (!docsDirEnsured) {
      const ensured = await ensureRemoteDirectories(mergedConfig, true);
      requestCount += ensured.requests;
      dirsEnsured = true;
      docsDirEnsured = ensured.docsReady;
      if (ensured.authFailedStatus) {
        return false;
      }
    }

    requestCount++;
    let putRes = await callWebDav(mergedConfig, 'PUT', `${DOCS_DIR}${doc.id}.${docExt}`, {
      body: uploadBody,
    });
    if (!putRes.ok && (putRes.status === 404 || putRes.status === 409)) {
      const ensured = await ensureRemoteDirectories(mergedConfig, true);
      requestCount += ensured.requests;
      dirsEnsured = true;
      docsDirEnsured = ensured.docsReady;
      requestCount++;
      putRes = await callWebDav(mergedConfig, 'PUT', `${DOCS_DIR}${doc.id}.${docExt}`, {
        body: uploadBody,
      });
    }
    if (!putRes.ok) {
      return false;
    }
    uploadBytes += getByteSize(uploadBody);
    return true;
  };

  const downloadShortDocBody = async (
    rEntry: ManifestDocEntry
  ): Promise<{ content: string; contentHash: string; byteSize: number } | null> => {
    if (rEntry.deleted || rEntry.byteSize > CLOUD_SHORT_DOC_MAX_BYTES) {
      return null;
    }
    const primaryExt = rEntry.format === 'md' ? 'md' : 'txt';
    const fallbackExt = primaryExt === 'txt' ? 'md' : 'txt';
    requestCount++;
    let getDoc = await callWebDav(mergedConfig, 'GET', `${DOCS_DIR}${rEntry.id}.${primaryExt}`);
    if (!getDoc.ok && (getDoc.status === 404 || getDoc.status === 409)) {
      requestCount++;
      getDoc = await callWebDav(mergedConfig, 'GET', `${DOCS_DIR}${rEntry.id}.${fallbackExt}`);
    }
    if (!getDoc.ok && (getDoc.status === 404 || getDoc.status === 409)) {
      requestCount++;
      getDoc = await callWebDav(mergedConfig, 'GET', `${rEntry.id}.${primaryExt}`);
    }
    if (!getDoc.ok || typeof getDoc.body !== 'string') {
      return null;
    }
    downloadBytes += getDoc.bytesTransferred || getByteSize(getDoc.body);
    const rawBody = getDoc.body;
    let plainContent = rawBody;
    if (rEntry.encrypted || isEncryptedPayload(rawBody)) {
      if (!effectiveEncPassword) return null;
      try {
        plainContent = await decryptText(rawBody, effectiveEncPassword);
      } catch {
        return null;
      }
    }
    return {
      content: plainContent,
      contentHash: await sha256Hex(plainContent),
      byteSize: getByteSize(plainContent),
    };
  };

  // Step 3: Merge folders (LWW by updatedAt)
  const remoteFolderMap = new Map<string, FolderNode>();
  if (remoteManifest?.folders) {
    for (const rf of remoteManifest.folders) {
      remoteFolderMap.set(rf.id, rf);
    }
  }
  const folderMap = new Map<string, FolderNode>();
  for (const lf of localFolders) {
    folderMap.set(lf.id, lf);
    const rf = remoteFolderMap.get(lf.id);
    if (!rf) {
      needManifestPush = true;
    } else if (lf.updatedAt > rf.updatedAt && folderFieldsDiffer(lf, rf)) {
      needManifestPush = true;
    }
  }
  if (remoteManifest?.folders) {
    for (const rf of remoteManifest.folders) {
      const purgedAt = purgedRecords?.folders?.[rf.id];
      if ((purgedAt && purgedAt >= rf.updatedAt) || isTrashExpired(rf, syncNow)) {
        needManifestPush = true;
        continue;
      }
      const lf = folderMap.get(rf.id);
      if (!lf) {
        folderMap.set(rf.id, { ...rf, parentId: null });
        didPull = true;
      } else if (rf.updatedAt > lf.updatedAt) {
        if (folderFieldsDiffer(lf, rf)) {
          didPull = true;
        }
        folderMap.set(rf.id, { ...rf, parentId: null });
      }
    }
  }
  const mergedFoldersRaw = Array.from(folderMap.values());

  // Step 4: Merge directory tree state (LWW by updatedAt)
  let mergedTreeState: SyncedTreeState = localTreeState;
  const remoteTree = remoteManifest?.treeState;
  if (remoteTree && remoteTree.updatedAt > localTreeState.updatedAt) {
    mergedTreeState = {
      collapsedIds: Array.isArray(remoteTree.collapsedIds) ? remoteTree.collapsedIds : [],
      activeTarget: remoteTree.activeTarget ?? null,
      scrollTop: typeof remoteTree.scrollTop === 'number' ? remoteTree.scrollTop : 0,
      updatedAt: remoteTree.updatedAt,
    };
    didPull = true;
  } else if (localTreeState.updatedAt > (remoteTree?.updatedAt || 0)) {
    needManifestPush = true;
  }

  // Step 5: Merge ALL documents (Option A: remote books appear in catalog immediately as pending-Wi-Fi or cloud-short-doc)
  const mergedDocsMap = new Map<string, ArticleDoc>();
  const nextRemoteDocs: Record<string, ManifestDocEntry> = {};
  const remotePurgedDocsToDelete: Array<{ id: string; format: 'txt' | 'md' }> = [];

  for (const localDoc of localDocs) {
    const remoteEntry = remoteManifest?.docs?.[localDoc.id];
    const localMissingBody = isDocBodyMissing(localDoc);

    // 5a. Brand new local doc not yet in cloud manifest -> publish catalog immediately (Option A)
    if (!remoteEntry) {
      let cloudSynced = Boolean(localDoc.cloudBodySynced);
      if (shortDocFallback && !localDoc.deleted && !localMissingBody && localDoc.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES) {
        const uploaded = await uploadShortDocBody(localDoc);
        if (uploaded) {
          cloudSynced = true;
        }
      }
      const localOffset = Math.max(0, Math.round(localDoc.lastCharOffset ?? 0));
      const hasActiveWifiConflict = localDoc.pendingRemoteProgress?.source === 'wifi';
      const nextLocal: ArticleDoc = {
        ...localDoc,
        cloudBodySynced: cloudSynced,
        syncStatus: localMissingBody ? 'remote-only' : 'synced',
        lastSyncedContentHash: localMissingBody ? localDoc.lastSyncedContentHash : localDoc.contentHash,
        lastSyncedCharOffset: localOffset,
        lastSyncedProgress: localDoc.readProgress ?? 0,
        lastSyncedReadAt: localDoc.lastReadAt ?? 0,
        pendingRemoteProgress: hasActiveWifiConflict ? localDoc.pendingRemoteProgress : null,
      };
      mergedDocsMap.set(localDoc.id, nextLocal);
      nextRemoteDocs[localDoc.id] = toManifestDocEntry(nextLocal, cloudSynced);
      needManifestPush = true;
      continue;
    }

    // 5b. Existing doc present in both local and remote manifest
    skippedByHashMatch++;
    const sameBody =
      !localMissingBody &&
      remoteEntry.contentHash === localDoc.contentHash &&
      Boolean(remoteEntry.encrypted) === Boolean(localDoc.encrypted);

    let nextLocal: ArticleDoc = { ...localDoc };
    const nextRemoteEntry: ManifestDocEntry = { ...remoteEntry };
    let cloudSynced = Boolean(remoteEntry.cloudBodySynced);

    // Reading progress merge (Plan B open-book confirmation + last-synced baseline + text anchor guard)
    // Never overwrite or clear an active Wi-Fi progress conflict waiting for user resolution in Directory Mode
    if (localDoc.pendingRemoteProgress?.source !== 'wifi') {
      const localOverrideAt = localDoc.progressOverrideAt ?? 0;
      const remoteOverrideAt = remoteEntry.progressOverrideAt ?? 0;
      const remoteReadTs = Math.max(remoteEntry.lastReadAt ?? 0, remoteOverrideAt);
      const localReadTs = Math.max(localDoc.lastReadAt ?? 0, localOverrideAt);
      const localAuthoritativeOverride =
        localOverrideAt > remoteOverrideAt && localOverrideAt > remoteReadTs;
      const remoteAuthoritativeOverride =
        remoteOverrideAt > localOverrideAt && remoteOverrideAt > localReadTs;

      if (localAuthoritativeOverride) {
        // Explicit user conflict resolution (e.g. from Wi-Fi sync) directly overrides older cloud progress
        const localOffset = Math.max(0, Math.round(localDoc.lastCharOffset ?? 0));
        const localAnchor = localDoc.encrypted
          ? undefined
          : localDoc.readAnchorText ||
            (localDoc.content ? extractReadAnchorText(localDoc.content, localOffset) : undefined) ||
            undefined;
        const syncedTs = Math.max(localDoc.lastReadAt ?? 0, localOverrideAt);
        nextRemoteEntry.readProgress = localDoc.readProgress;
        nextRemoteEntry.lastCharOffset = localOffset;
        nextRemoteEntry.lastScrollTop = Math.max(0, Math.round(localDoc.lastScrollTop ?? 0));
        nextRemoteEntry.lastMode = localDoc.lastMode ?? 'read';
        nextRemoteEntry.lastReadAt = localDoc.lastReadAt ?? localOverrideAt;
        nextRemoteEntry.readAnchorText = localAnchor;
        nextRemoteEntry.progressOverrideAt = localOverrideAt;
        nextLocal = {
          ...nextLocal,
          readAnchorText: localDoc.readAnchorText || localAnchor,
          lastSyncedCharOffset: localOffset,
          lastSyncedProgress: localDoc.readProgress,
          lastSyncedReadAt: syncedTs,
          pendingRemoteProgress: null,
        };
        needManifestPush = true;
      } else if (remoteAuthoritativeOverride) {
        // Another device explicitly resolved a conflict and pushed to cloud; adopt cleanly without re-prompting
        const rawRemoteOffset = Math.max(0, Math.round(remoteEntry.lastCharOffset ?? 0));
        const relocated =
          nextLocal.content && remoteEntry.readAnchorText
            ? relocateCharOffsetByAnchor(nextLocal.content, rawRemoteOffset, remoteEntry.readAnchorText)
            : null;
        const pulledOffset = relocated?.matched ? relocated.offset : rawRemoteOffset;
        const pulledProgress =
          relocated?.matched && Math.abs(relocated.offset - rawRemoteOffset) >= 60
            ? relocated.progress
            : (remoteEntry.readProgress ?? 0);
        const syncedTs = Math.max(remoteEntry.lastReadAt ?? 0, remoteOverrideAt);
        nextLocal = {
          ...nextLocal,
          readProgress: pulledProgress,
          lastCharOffset: pulledOffset,
          lastScrollTop: relocated?.matched ? 0 : Math.max(0, Math.round(remoteEntry.lastScrollTop ?? 0)),
          lastMode: remoteEntry.lastMode ?? nextLocal.lastMode ?? 'read',
          lastReadAt: remoteEntry.lastReadAt ?? remoteOverrideAt,
          readAnchorText:
            remoteEntry.readAnchorText ||
            (nextLocal.content && !nextLocal.encrypted
              ? extractReadAnchorText(nextLocal.content, pulledOffset)
              : nextLocal.readAnchorText),
          lastSyncedCharOffset: pulledOffset,
          lastSyncedProgress: pulledProgress,
          lastSyncedReadAt: syncedTs,
          progressOverrideAt: remoteOverrideAt,
          pendingRemoteProgress: null,
        };
        pulledProgressDocIds[localDoc.id] = pulledOffset;
        didPull = true;
      } else {
        const progMerge = reconcileReadingProgress(localDoc, remoteEntry, 'cloud');
        if (progMerge.action === 'pull') {
          const pulledOffset = progMerge.resolvedRemoteOffset;
          nextLocal = {
            ...nextLocal,
            readProgress: progMerge.resolvedRemoteProgress,
            lastCharOffset: pulledOffset,
            lastScrollTop: Math.max(0, Math.round(remoteEntry.lastScrollTop ?? 0)),
            lastMode: remoteEntry.lastMode ?? nextLocal.lastMode ?? 'read',
            lastReadAt: remoteEntry.lastReadAt ?? progMerge.resolvedRemoteReadAt,
            readAnchorText:
              progMerge.resolvedRemoteAnchor ||
              (nextLocal.content ? extractReadAnchorText(nextLocal.content, pulledOffset) : nextLocal.readAnchorText),
            lastSyncedCharOffset: progMerge.nextBaseline?.charOffset ?? pulledOffset,
            lastSyncedProgress: progMerge.nextBaseline?.progress ?? progMerge.resolvedRemoteProgress,
            lastSyncedReadAt: progMerge.nextBaseline?.readAt ?? progMerge.resolvedRemoteReadAt,
            progressOverrideAt:
              remoteOverrideAt > localOverrideAt ? remoteOverrideAt : nextLocal.progressOverrideAt,
            pendingRemoteProgress: null,
          };
          pulledProgressDocIds[localDoc.id] = pulledOffset;
          didPull = true;
        } else if (progMerge.action === 'push') {
          const localOffset = Math.max(0, Math.round(localDoc.lastCharOffset ?? 0));
          const localAnchor = localDoc.encrypted
            ? undefined
            : localDoc.readAnchorText ||
              (localDoc.content ? extractReadAnchorText(localDoc.content, localOffset) : undefined) ||
              undefined;
          nextRemoteEntry.readProgress = localDoc.readProgress;
          nextRemoteEntry.lastCharOffset = localOffset;
          nextRemoteEntry.lastScrollTop = Math.max(0, Math.round(localDoc.lastScrollTop ?? 0));
          nextRemoteEntry.lastMode = localDoc.lastMode ?? 'read';
          nextRemoteEntry.lastReadAt = localDoc.lastReadAt ?? Date.now();
          nextRemoteEntry.readAnchorText = localAnchor;
          if (localOverrideAt > remoteOverrideAt) {
            nextRemoteEntry.progressOverrideAt = localOverrideAt;
          }
          nextLocal = {
            ...nextLocal,
            readAnchorText: localDoc.readAnchorText || localAnchor,
            lastSyncedCharOffset: progMerge.nextBaseline?.charOffset ?? localOffset,
            lastSyncedProgress: progMerge.nextBaseline?.progress ?? localDoc.readProgress,
            lastSyncedReadAt: Math.max(
              progMerge.nextBaseline?.readAt ?? (localDoc.lastReadAt ?? 0),
              localOverrideAt
            ),
            pendingRemoteProgress: null,
          };
          needManifestPush = true;
        } else if (progMerge.action === 'prompt' && progMerge.pendingRemoteProgress) {
          // Protect both local and cloud — stash remote progress for explicit user choice on book open
          if (!pendingRemoteProgressEqual(localDoc.pendingRemoteProgress, progMerge.pendingRemoteProgress)) {
            nextLocal = {
              ...nextLocal,
              pendingRemoteProgress: progMerge.pendingRemoteProgress,
            };
            didPull = true;
          }
        } else {
          // action === 'noop': progress within tolerance; align baseline & clear stale pending prompt
          const baselineChanged =
            progMerge.nextBaseline &&
            (localDoc.lastSyncedCharOffset !== progMerge.nextBaseline.charOffset ||
              localDoc.lastSyncedProgress !== progMerge.nextBaseline.progress ||
              Boolean(localDoc.pendingRemoteProgress) ||
              remoteOverrideAt > localOverrideAt);
          if (baselineChanged && progMerge.nextBaseline) {
            nextLocal = {
              ...nextLocal,
              lastSyncedCharOffset: progMerge.nextBaseline.charOffset,
              lastSyncedProgress: progMerge.nextBaseline.progress,
              lastSyncedReadAt: Math.max(
                progMerge.nextBaseline.readAt,
                localOverrideAt,
                remoteOverrideAt
              ),
              progressOverrideAt:
                remoteOverrideAt > localOverrideAt ? remoteOverrideAt : nextLocal.progressOverrideAt,
              pendingRemoteProgress: null,
            };
            didPull = true;
          }
          if (localOverrideAt > remoteOverrideAt) {
            nextRemoteEntry.progressOverrideAt = localOverrideAt;
            needManifestPush = true;
          }
          if (progMerge.silentMinorAlign === 'local-to-remote') {
            const localOffset = Math.max(0, Math.round(localDoc.lastCharOffset ?? 0));
            nextRemoteEntry.readProgress = localDoc.readProgress;
            nextRemoteEntry.lastCharOffset = localOffset;
            nextRemoteEntry.lastScrollTop = Math.max(0, Math.round(localDoc.lastScrollTop ?? 0));
            nextRemoteEntry.lastMode = localDoc.lastMode ?? 'read';
            nextRemoteEntry.lastReadAt = localDoc.lastReadAt ?? nextRemoteEntry.lastReadAt;
            if (!localDoc.encrypted) {
              nextRemoteEntry.readAnchorText =
                localDoc.readAnchorText ||
                (localDoc.content ? extractReadAnchorText(localDoc.content, localOffset) : nextRemoteEntry.readAnchorText);
            }
            needManifestPush = true;
          }
        }
      }
    }

    // Catalog metadata merge (title, folderId, order, starred, tags, soft-delete, encrypted)
    if (catalogFieldsDiffer(localDoc, remoteEntry)) {
      if (remoteEntry.updatedAt > localDoc.updatedAt) {
        nextLocal = {
          ...nextLocal,
          title: remoteEntry.title,
          folderId: remoteEntry.folderId,
          order: remoteEntry.order,
          starred: remoteEntry.starred,
          tags: remoteEntry.tags,
          deleted: remoteEntry.deleted,
          deletedAt: remoteEntry.deletedAt,
          deletedByFolderId: remoteEntry.deletedByFolderId,
          encrypted: Boolean(remoteEntry.encrypted),
          updatedAt: remoteEntry.updatedAt,
        };
        didPull = true;
      } else if (localDoc.updatedAt > remoteEntry.updatedAt) {
        nextRemoteEntry.title = localDoc.title;
        nextRemoteEntry.folderId = localDoc.folderId;
        nextRemoteEntry.order = localDoc.order;
        nextRemoteEntry.starred = localDoc.starred;
        nextRemoteEntry.tags = localDoc.tags;
        nextRemoteEntry.deleted = localDoc.deleted;
        nextRemoteEntry.deletedAt = localDoc.deletedAt;
        nextRemoteEntry.deletedByFolderId = localDoc.deletedByFolderId;
        nextRemoteEntry.encrypted = Boolean(localDoc.encrypted);
        nextRemoteEntry.updatedAt = localDoc.updatedAt;
        needManifestPush = true;
      }
    }

    // Short-doc <= 200 KB optional cloud fallback body sync
    if (!localMissingBody) {
      const localBodyNewer = localDoc.updatedAt >= remoteEntry.updatedAt;
      const forceReuploadBody = Boolean(
        shortDocFallback &&
          !nextLocal.deleted &&
          localDoc.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES &&
          !localDoc.cloudBodySynced &&
          localDoc.syncStatus === 'dirty'
      );
      const bothSidesEditedBody = Boolean(
        !sameBody &&
          localDoc.lastSyncedContentHash &&
          localDoc.contentHash !== localDoc.lastSyncedContentHash &&
          remoteEntry.contentHash !== localDoc.lastSyncedContentHash
      );

      if (
        bothSidesEditedBody &&
        shortDocFallback &&
        remoteEntry.cloudBodySynced &&
        !remoteEntry.deleted &&
        remoteEntry.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES
      ) {
        // Two-way offline body edit detected: keep newer version on original doc & save older as conflict copy
        const downloaded = await downloadShortDocBody(remoteEntry);
        if (downloaded && downloaded.contentHash !== nextLocal.contentHash) {
          const copyTs = Date.now();
          const conflictContent = localBodyNewer ? downloaded.content : nextLocal.content;
          const conflictHash = localBodyNewer ? downloaded.contentHash : nextLocal.contentHash;
          const conflictBytes = localBodyNewer ? downloaded.byteSize : nextLocal.byteSize;
          const baseTitle = (nextLocal.title || '无标题文档').replace(/\s*\(冲突副本\)$/, '');
          const conflictDoc: ArticleDoc = {
            id: `doc_${copyTs}_${Math.random().toString(36).slice(2, 6)}`,
            title: `${baseTitle} (冲突副本)`,
            folderId: nextLocal.folderId,
            order: nextLocal.order + 0.5,
            content: conflictContent,
            contentHash: conflictHash,
            excerpt: nextLocal.encrypted ? '' : extractExcerpt(conflictContent),
            tags: nextLocal.tags || [],
            starred: false,
            readProgress: 0,
            lastReadAt: null,
            lastMode: 'read',
            lastScrollTop: 0,
            lastCharOffset: 0,
            encrypted: Boolean(nextLocal.encrypted),
            format: nextLocal.format ?? 'txt',
            cloudBodySynced: false,
            createdAt: copyTs,
            updatedAt: copyTs,
            syncStatus: 'synced',
            lastSyncedContentHash: conflictHash,
            highlights: [],
            byteSize: conflictBytes,
          };
          if (conflictBytes <= CLOUD_SHORT_DOC_MAX_BYTES) {
            const conflictUploaded = await uploadShortDocBody(conflictDoc);
            if (conflictUploaded) {
              conflictDoc.cloudBodySynced = true;
            }
          }
          mergedDocsMap.set(conflictDoc.id, conflictDoc);
          nextRemoteDocs[conflictDoc.id] = toManifestDocEntry(conflictDoc, Boolean(conflictDoc.cloudBodySynced));
          needManifestPush = true;
          didPull = true;

          if (localBodyNewer) {
            if (!nextLocal.deleted && nextLocal.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES) {
              const uploaded = await uploadShortDocBody(nextLocal);
              if (uploaded) {
                cloudSynced = true;
                nextRemoteEntry.contentHash = nextLocal.contentHash;
                nextRemoteEntry.byteSize = nextLocal.byteSize;
                nextRemoteEntry.excerpt = nextLocal.encrypted ? '' : trimManifestExcerpt(nextLocal.excerpt);
                nextRemoteEntry.encrypted = Boolean(nextLocal.encrypted);
                nextRemoteEntry.cloudBodySynced = true;
                nextRemoteEntry.updatedAt = Math.max(nextRemoteEntry.updatedAt, nextLocal.updatedAt);
              }
            }
            nextLocal = { ...nextLocal, lastSyncedContentHash: nextLocal.contentHash };
          } else {
            const anchor = nextLocal.readAnchorText || remoteEntry.readAnchorText;
            const relocated =
              anchor && (nextLocal.lastCharOffset ?? 0) > 0
                ? relocateCharOffsetByAnchor(downloaded.content, nextLocal.lastCharOffset ?? 0, anchor)
                : null;
            nextLocal = {
              ...nextLocal,
              content: downloaded.content,
              contentHash: downloaded.contentHash,
              lastSyncedContentHash: downloaded.contentHash,
              byteSize: downloaded.byteSize,
              excerpt: remoteEntry.encrypted ? '' : extractExcerpt(downloaded.content),
              updatedAt: remoteEntry.updatedAt,
              syncStatus: 'synced',
              cloudBodySynced: true,
              ...(relocated?.matched
                ? {
                    lastCharOffset: relocated.offset,
                    readProgress: relocated.progress,
                    lastScrollTop: 0,
                    readAnchorText: extractReadAnchorText(downloaded.content, relocated.offset) || anchor,
                  }
                : {}),
            };
            cloudSynced = true;
          }
        }
      } else if (forceReuploadBody || (localBodyNewer && (!sameBody || !cloudSynced))) {
        if (shortDocFallback && !nextLocal.deleted && localDoc.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES) {
          const uploaded = await uploadShortDocBody(nextLocal);
          if (uploaded) {
            cloudSynced = true;
            nextRemoteEntry.contentHash = nextLocal.contentHash;
            nextRemoteEntry.byteSize = nextLocal.byteSize;
            nextRemoteEntry.excerpt = nextLocal.encrypted ? '' : trimManifestExcerpt(nextLocal.excerpt);
            nextRemoteEntry.encrypted = Boolean(nextLocal.encrypted);
            nextRemoteEntry.cloudBodySynced = true;
            nextRemoteEntry.updatedAt = Math.max(nextRemoteEntry.updatedAt, nextLocal.updatedAt);
            nextLocal = { ...nextLocal, lastSyncedContentHash: nextLocal.contentHash };
            needManifestPush = true;
          }
        } else if (!sameBody) {
          // Body updated locally (e.g. > 200 KB or fallback off): update catalog hash/size without cloud body
          cloudSynced = false;
          nextRemoteEntry.contentHash = nextLocal.contentHash;
          nextRemoteEntry.byteSize = nextLocal.byteSize;
          nextRemoteEntry.excerpt = nextLocal.encrypted ? '' : trimManifestExcerpt(nextLocal.excerpt);
          nextRemoteEntry.cloudBodySynced = false;
          nextRemoteEntry.updatedAt = Math.max(nextRemoteEntry.updatedAt, nextLocal.updatedAt);
          nextLocal = { ...nextLocal, lastSyncedContentHash: nextLocal.contentHash };
          needManifestPush = true;
        }
      } else if (
        !localBodyNewer &&
        !sameBody &&
        shortDocFallback &&
        remoteEntry.cloudBodySynced &&
        !remoteEntry.deleted &&
        remoteEntry.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES
      ) {
        const downloaded = await downloadShortDocBody(remoteEntry);
        if (downloaded) {
          const anchor = nextLocal.readAnchorText || remoteEntry.readAnchorText;
          const relocated =
            anchor && (nextLocal.lastCharOffset ?? 0) > 0
              ? relocateCharOffsetByAnchor(downloaded.content, nextLocal.lastCharOffset ?? 0, anchor)
              : null;
          nextLocal = {
            ...nextLocal,
            content: downloaded.content,
            contentHash: downloaded.contentHash,
            lastSyncedContentHash: downloaded.contentHash,
            byteSize: downloaded.byteSize,
            excerpt: remoteEntry.encrypted ? '' : extractExcerpt(downloaded.content),
            updatedAt: remoteEntry.updatedAt,
            syncStatus: 'synced',
            cloudBodySynced: true,
            ...(relocated?.matched
              ? {
                  lastCharOffset: relocated.offset,
                  readProgress: relocated.progress,
                  lastScrollTop: 0,
                  readAnchorText: extractReadAnchorText(downloaded.content, relocated.offset) || anchor,
                }
              : {}),
          };
          cloudSynced = true;
          didPull = true;
        }
      } else if (sameBody && nextLocal.lastSyncedContentHash !== nextLocal.contentHash) {
        nextLocal = { ...nextLocal, lastSyncedContentHash: nextLocal.contentHash };
      }
      nextLocal = {
        ...nextLocal,
        cloudBodySynced: cloudSynced,
        syncStatus: 'synced',
      };
    } else {
      // Local doc is currently a remote-only stub (no body yet)
      if (
        shortDocFallback &&
        remoteEntry.cloudBodySynced &&
        !remoteEntry.deleted &&
        remoteEntry.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES
      ) {
        const downloaded = await downloadShortDocBody(remoteEntry);
        if (downloaded) {
          const anchor = nextLocal.readAnchorText || remoteEntry.readAnchorText;
          const relocated =
            anchor && (nextLocal.lastCharOffset ?? 0) > 0
              ? relocateCharOffsetByAnchor(downloaded.content, nextLocal.lastCharOffset ?? 0, anchor)
              : null;
          nextLocal = {
            ...nextLocal,
            content: downloaded.content,
            contentHash: downloaded.contentHash,
            lastSyncedContentHash: downloaded.contentHash,
            byteSize: downloaded.byteSize,
            excerpt: remoteEntry.encrypted ? '' : extractExcerpt(downloaded.content),
            updatedAt: Math.max(nextLocal.updatedAt, remoteEntry.updatedAt),
            syncStatus: 'synced',
            cloudBodySynced: true,
            ...(relocated?.matched
              ? {
                  lastCharOffset: relocated.offset,
                  readProgress: relocated.progress,
                  lastScrollTop: 0,
                  readAnchorText: extractReadAnchorText(downloaded.content, relocated.offset) || anchor,
                }
              : {}),
          };
          cloudSynced = true;
          didPull = true;
        } else {
          nextLocal = {
            ...nextLocal,
            contentHash: remoteEntry.contentHash,
            byteSize: remoteEntry.byteSize,
            cloudBodySynced: Boolean(remoteEntry.cloudBodySynced),
            syncStatus: 'remote-only',
          };
        }
      } else {
        if (
          nextLocal.cloudBodySynced !== Boolean(remoteEntry.cloudBodySynced) ||
          nextLocal.byteSize !== remoteEntry.byteSize ||
          nextLocal.contentHash !== remoteEntry.contentHash
        ) {
          didPull = true;
        }
        nextLocal = {
          ...nextLocal,
          contentHash: remoteEntry.contentHash,
          byteSize: remoteEntry.byteSize,
          cloudBodySynced: Boolean(remoteEntry.cloudBodySynced),
          syncStatus: 'remote-only',
        };
      }
    }

    nextRemoteEntry.cloudBodySynced = cloudSynced;
    nextRemoteEntry.excerpt = nextRemoteEntry.encrypted
      ? ''
      : trimManifestExcerpt(nextRemoteEntry.excerpt);

    const mergedNotes = mergeReadingNotes(nextLocal.notes, remoteEntry.notes, syncNow);
    if (!notesEqual(nextLocal.notes, mergedNotes)) {
      nextLocal = {
        ...nextLocal,
        notes: mergedNotes.length > 0 ? mergedNotes : undefined,
      };
      didPull = true;
    }
    const nextRemoteNotes =
      mergedNotes.length > 0
        ? nextRemoteEntry.encrypted
          ? mergedNotes.map((n) => ({ ...n, anchorText: '' }))
          : mergedNotes
        : undefined;
    if (!notesEqual(remoteEntry.notes, nextRemoteNotes)) {
      nextRemoteEntry.notes = nextRemoteNotes;
      needManifestPush = true;
    }

    mergedDocsMap.set(localDoc.id, nextLocal);
    nextRemoteDocs[localDoc.id] = nextRemoteEntry;
  }

  // 5c. Remote docs not yet on this device -> Option A (create local catalog stub or auto-pull <= 200 KB fallback)
  if (remoteManifest?.docs) {
    for (const [id, rEntry] of Object.entries(remoteManifest.docs)) {
      if (mergedDocsMap.has(id)) continue;

      const purgedAt = purgedRecords?.docs?.[id];
      if ((purgedAt && purgedAt >= rEntry.updatedAt) || isTrashExpired(rEntry, syncNow)) {
        if (rEntry.cloudBodySynced) {
          remotePurgedDocsToDelete.push({ id, format: rEntry.format === 'md' ? 'md' : 'txt' });
        }
        needManifestPush = true;
        continue;
      }

      if (
        shortDocFallback &&
        rEntry.cloudBodySynced &&
        !rEntry.deleted &&
        rEntry.byteSize <= CLOUD_SHORT_DOC_MAX_BYTES
      ) {
        const downloaded = await downloadShortDocBody(rEntry);
        if (downloaded) {
          const initialOffset = Math.max(0, Math.round(rEntry.lastCharOffset ?? 0));
          const relocated =
            rEntry.readAnchorText && initialOffset > 0
              ? relocateCharOffsetByAnchor(downloaded.content, initialOffset, rEntry.readAnchorText)
              : null;
          const finalOffset = relocated?.matched ? relocated.offset : initialOffset;
          const finalProgress = relocated?.matched ? relocated.progress : (rEntry.readProgress ?? 0);
          const pulledDoc: ArticleDoc = {
            id: rEntry.id,
            title: rEntry.title,
            folderId: rEntry.folderId,
            order: rEntry.order,
            content: downloaded.content,
            contentHash: downloaded.contentHash,
            excerpt: rEntry.encrypted ? '' : extractExcerpt(downloaded.content),
            tags: rEntry.tags || [],
            starred: Boolean(rEntry.starred),
            readProgress: finalProgress,
            lastReadAt: rEntry.lastReadAt ?? null,
            lastMode: rEntry.lastMode ?? 'read',
            lastScrollTop: relocated?.matched ? 0 : (rEntry.lastScrollTop ?? 0),
            lastCharOffset: finalOffset,
            readAnchorText:
              rEntry.readAnchorText ||
              (rEntry.encrypted ? undefined : extractReadAnchorText(downloaded.content, finalOffset) || undefined),
            lastSyncedCharOffset: finalOffset,
            lastSyncedProgress: finalProgress,
            lastSyncedReadAt: Math.max(rEntry.lastReadAt ?? 0, rEntry.progressOverrideAt ?? 0),
            progressOverrideAt: rEntry.progressOverrideAt || undefined,
            pendingRemoteProgress: null,
            encrypted: Boolean(rEntry.encrypted),
            format: rEntry.format ?? 'txt',
            cloudBodySynced: true,
            createdAt: rEntry.createdAt,
            updatedAt: rEntry.updatedAt,
            deleted: rEntry.deleted,
            deletedAt: rEntry.deletedAt,
            deletedByFolderId: rEntry.deletedByFolderId,
            highlights: [],
            notes: sanitizeNotesList(rEntry.notes, syncNow).length > 0
              ? sanitizeNotesList(rEntry.notes, syncNow)
              : undefined,
            byteSize: downloaded.byteSize,
            syncStatus: 'synced',
            lastSyncedContentHash: downloaded.contentHash,
          };
          mergedDocsMap.set(id, pulledDoc);
          nextRemoteDocs[id] = {
            ...rEntry,
            excerpt: rEntry.encrypted ? '' : trimManifestExcerpt(pulledDoc.excerpt),
          };
          didPull = true;
          continue;
        }
      }

      // Option A: show catalog entry immediately on this device with remote-only status
      const stubNotes = sanitizeNotesList(rEntry.notes, syncNow);
      const stubDoc: ArticleDoc = {
        id: rEntry.id,
        title: rEntry.title,
        folderId: rEntry.folderId,
        order: rEntry.order,
        content: '',
        contentHash: rEntry.contentHash,
        excerpt: rEntry.encrypted ? '' : rEntry.excerpt || '',
        tags: rEntry.tags || [],
        starred: Boolean(rEntry.starred),
        readProgress: rEntry.readProgress ?? 0,
        lastReadAt: rEntry.lastReadAt ?? null,
        lastMode: rEntry.lastMode ?? 'read',
        lastScrollTop: rEntry.lastScrollTop ?? 0,
        lastCharOffset: rEntry.lastCharOffset ?? 0,
        readAnchorText: rEntry.encrypted ? undefined : rEntry.readAnchorText,
        lastSyncedCharOffset: Math.max(0, Math.round(rEntry.lastCharOffset ?? 0)),
        lastSyncedProgress: rEntry.readProgress ?? 0,
        lastSyncedReadAt: Math.max(rEntry.lastReadAt ?? 0, rEntry.progressOverrideAt ?? 0),
        progressOverrideAt: rEntry.progressOverrideAt || undefined,
        pendingRemoteProgress: null,
        encrypted: Boolean(rEntry.encrypted),
        format: rEntry.format ?? 'txt',
        cloudBodySynced: Boolean(rEntry.cloudBodySynced),
        createdAt: rEntry.createdAt,
        updatedAt: rEntry.updatedAt,
        deleted: rEntry.deleted,
        deletedAt: rEntry.deletedAt,
        deletedByFolderId: rEntry.deletedByFolderId,
        highlights: [],
        notes: stubNotes.length > 0 ? stubNotes : undefined,
        byteSize: rEntry.byteSize ?? 0,
        syncStatus: rEntry.deleted ? 'synced' : 'remote-only',
      };
      mergedDocsMap.set(id, stubDoc);
      nextRemoteDocs[id] = rEntry;
      didPull = true;
    }
  }

  // 5d. Jianguoyun inbox/ dropbox ingestion (ONLY when short-doc cloud fallback <= 200 KB is enabled)
  const inboxFilesToDelete: string[] = [];
  if (shortDocFallback) {
    let inboxCandidates: RemoteInboxFile[] = [];
    if (precheckedInboxFiles !== null) {
      inboxCandidates = precheckedInboxFiles;
    } else {
      const inboxCheck = await listEligibleShortInboxFiles(mergedConfig);
      if (inboxCheck.rateLimited) {
        return {
          folders: mergedFoldersRaw,
          docs: Array.from(mergedDocsMap.values()),
          treeState: mergedTreeState,
          config: {
            ...mergedConfig,
            lastAutoManifestEtag: nextAutoEtag,
          },
          quotaDelta: {
            uploadBytes,
            downloadBytes,
            requestCount,
            skippedByEtag304,
            skippedByHashMatch,
          },
          pulledProgressDocIds,
          didPush: false,
          didPull,
          wasRateLimited: true,
        };
      }
      inboxCandidates = inboxCheck.files;
      oversizedInboxCount += inboxCheck.oversizedCount;
    }

    if (inboxCandidates.length > 0) {
      let maxInboxOrder = Array.from(mergedDocsMap.values())
        .filter((d) => !d.deleted && d.folderId === INBOX_FOLDER_ID)
        .reduce((m, d) => Math.max(m, d.order), -1);

      for (let i = 0; i < inboxCandidates.length; i++) {
        const file = inboxCandidates[i];
        requestCount++;
        const getInboxRes = await callWebDav(mergedConfig, 'GET', file.relPath);
        if (getInboxRes.status === 429 || getInboxRes.status === 503) {
          break;
        }
        if (!getInboxRes.ok || typeof getInboxRes.body !== 'string') {
          continue;
        }
        const rawText = getInboxRes.body;
        const byteSize = getByteSize(rawText);
        downloadBytes += getInboxRes.bytesTransferred || byteSize;

        // Enforce <= 200 KB short-doc limit (skip larger files safely without deleting from inbox/)
        if (byteSize > CLOUD_SHORT_DOC_MAX_BYTES) {
          oversizedInboxCount += 1;
          continue;
        }

        const rawTitle = file.name.replace(/\.(txt|md|markdown|text)$/i, '').trim() || '投递短文';
        const format: 'txt' | 'md' = /\.(md|markdown)$/i.test(file.name) ? 'md' : 'txt';
        const dupRes = await resolveDuplicateDocImport(
          rawTitle,
          rawText,
          Array.from(mergedDocsMap.values())
        );

        if (dupRes.action === 'skip') {
          inboxFilesToDelete.push(file.relPath);
          continue;
        }

        const docTs = Date.now() + i;
        maxInboxOrder += 1;
        const inboxDoc: ArticleDoc = {
          id: `doc_${docTs}_${Math.random().toString(36).slice(2, 6)}`,
          title: dupRes.title,
          folderId: INBOX_FOLDER_ID,
          order: maxInboxOrder,
          content: rawText,
          contentHash: dupRes.contentHash,
          excerpt: extractExcerpt(rawText),
          tags: [],
          starred: false,
          readProgress: 0,
          lastReadAt: null,
          lastMode: 'read',
          lastScrollTop: 0,
          lastCharOffset: 0,
          encrypted: false,
          format,
          cloudBodySynced: false,
          createdAt: docTs,
          updatedAt: docTs,
          syncStatus: 'synced',
          highlights: [],
          byteSize,
        };

        const uploaded = await uploadShortDocBody(inboxDoc);
        if (!uploaded) {
          // Keep file in inbox/ so next sync retries safely with zero data loss
          continue;
        }

        inboxDoc.cloudBodySynced = true;
        mergedDocsMap.set(inboxDoc.id, inboxDoc);
        nextRemoteDocs[inboxDoc.id] = toManifestDocEntry(inboxDoc, true);
        inboxFilesToDelete.push(file.relPath);
        needManifestPush = true;
        didPull = true;
      }
    }
  }

  // Purge 30-day expired trash cleanly
  const purgedMerge = purgeExpiredTrash(
    mergedFoldersRaw,
    Array.from(mergedDocsMap.values()),
    syncNow
  );
  const mergedFolders = purgedMerge.folders;
  const mergedDocs = purgedMerge.docs;
  if (purgedMerge.changed || hasPendingPurges) {
    needManifestPush = true;
    for (const d of purgedMerge.expiredDocs) {
      delete nextRemoteDocs[d.id];
      if (d.cloudBodySynced) {
        remotePurgedDocsToDelete.push({ id: d.id, format: d.format === 'md' ? 'md' : 'txt' });
      }
    }
    if (purgedRecords?.docs) {
      for (const purgedId of Object.keys(purgedRecords.docs)) {
        const existingRemote = remoteManifest?.docs?.[purgedId];
        delete nextRemoteDocs[purgedId];
        if (existingRemote?.cloudBodySynced) {
          const fmt = purgedRecords.docFormats?.[purgedId] ?? existingRemote.format ?? 'txt';
          remotePurgedDocsToDelete.push({ id: purgedId, format: fmt === 'md' ? 'md' : 'txt' });
        }
      }
    }
  }

  // Step 6: Push updated _manifest.json ONLY when metadata/folders/progress actually changed
  let purgedSynced = false;
  if (needManifestPush) {
    const nextManifest: RemoteManifest = {
      version: 3,
      updatedAt: Date.now(),
      folders: mergedFolders,
      docs: nextRemoteDocs,
      treeState: mergedTreeState,
      syncSettings: {
        syncShortDocsViaCloud: Boolean(mergedConfig.syncShortDocsViaCloud),
        updatedAt: mergedConfig.settingsUpdatedAt || 0,
      },
    };
    const manifestJson = JSON.stringify(nextManifest);
    const useIfMatch = Boolean(remoteManifest !== null && fetchedManifestEtag);
    requestCount++;
    let putManifest = await callWebDav(mergedConfig, 'PUT', MANIFEST_PATH, {
      body: manifestJson,
      ifMatch: useIfMatch ? fetchedManifestEtag : undefined,
    });
    // Optimistic concurrency: another device updated _manifest.json concurrently -> re-fetch & merge once
    if (putManifest.status === 412 && retryOnPreconditionFailed) {
      return runAutoMetadataProgressSync(
        { ...mergedConfig, lastAutoManifestEtag: undefined },
        localFolders,
        localDocs,
        localTreeState,
        true,
        purgedRecords,
        false
      );
    }
    // Graceful fallback if a custom WebDAV server rejects If-Match with 400/501
    if (useIfMatch && !putManifest.ok && (putManifest.status === 400 || putManifest.status === 501)) {
      requestCount++;
      putManifest = await callWebDav(mergedConfig, 'PUT', MANIFEST_PATH, { body: manifestJson });
    }
    if (putManifest.status === 401 || putManifest.status === 403) {
      return {
        folders: mergedFolders,
        docs: mergedDocs,
        treeState: mergedTreeState,
        config: {
          ...mergedConfig,
          lastAutoManifestEtag: nextAutoEtag,
        },
        quotaDelta: {
          uploadBytes,
          downloadBytes,
          requestCount,
          skippedByEtag304,
          skippedByHashMatch,
        },
        pulledProgressDocIds,
        didPush: false,
        didPull,
        authFailed: true,
      };
    }
    if (putManifest.status === 429 || putManifest.status === 503) {
      return {
        folders: mergedFolders,
        docs: mergedDocs,
        treeState: mergedTreeState,
        config: {
          ...mergedConfig,
          lastAutoManifestEtag: nextAutoEtag,
        },
        quotaDelta: {
          uploadBytes,
          downloadBytes,
          requestCount,
          skippedByEtag304,
          skippedByHashMatch,
        },
        pulledProgressDocIds,
        didPush: false,
        didPull,
        wasRateLimited: true,
      };
    }
    if (!putManifest.ok && (putManifest.status === 404 || putManifest.status === 409)) {
      if (!dirsEnsured) {
        const ensured = await ensureRemoteDirectories(mergedConfig, false);
        requestCount += ensured.requests;
        dirsEnsured = true;
      }
      requestCount++;
      putManifest = await callWebDav(mergedConfig, 'PUT', MANIFEST_PATH, { body: manifestJson });
    }
    if (!putManifest.ok) {
      throw new Error(formatSyncHttpError('更新目录索引失败', putManifest));
    }
    uploadBytes += getByteSize(manifestJson);
    nextAutoEtag = putManifest.etag || nextAutoEtag;
    didPush = true;
    purgedSynced = hasPendingPurges;

    // Clean up cloud bodies of permanently purged short docs ONLY AFTER manifest PUT succeeds
    const seenPurgeIds = new Set<string>();
    for (const item of remotePurgedDocsToDelete) {
      if (seenPurgeIds.has(item.id)) continue;
      seenPurgeIds.add(item.id);
      requestCount++;
      await callWebDav(mergedConfig, 'DELETE', `${DOCS_DIR}${item.id}.${item.format}`);
    }

    // Remove ingested short files from Jianguoyun inbox/ ONLY AFTER manifest PUT succeeds
    for (const relPath of inboxFilesToDelete) {
      requestCount++;
      await callWebDav(mergedConfig, 'DELETE', relPath);
    }
  } else if (inboxFilesToDelete.length > 0) {
    // Only duplicate inbox files were encountered (already present in library): clean up inbox/
    for (const relPath of inboxFilesToDelete) {
      requestCount++;
      await callWebDav(mergedConfig, 'DELETE', relPath);
    }
  }

  return {
    folders: mergedFolders,
    docs: mergedDocs,
    treeState: mergedTreeState,
    config: {
      ...mergedConfig,
      lastAutoManifestEtag: nextAutoEtag,
      lastSyncedAt: Date.now(),
    },
    quotaDelta: {
      uploadBytes,
      downloadBytes,
      requestCount,
      skippedByEtag304,
      skippedByHashMatch,
    },
    pulledProgressDocIds,
    didPush,
    didPull,
    purgedSynced,
    oversizedInboxCount: oversizedInboxCount > 0 ? oversizedInboxCount : undefined,
  };
}

/**
 * Fetch a single cloud-backed document body on-demand (automatically decrypts if encrypted)
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
    throw new Error(formatSyncHttpError('拉取云端正文失败', res));
  }
  const bytes = res.bytesTransferred || getByteSize(res.body);
  const content =
    encrypted || isEncryptedPayload(res.body)
      ? await decryptText(res.body, config.encryptionPassword || '')
      : res.body;
  return { content, bytes };
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

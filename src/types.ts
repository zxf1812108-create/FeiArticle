export type SyncStatus = 'synced' | 'dirty' | 'remote-only' | 'conflict';

export type HighlightColor = 'amber' | 'blue' | 'emerald';

export interface HighlightItem {
  id: string;
  text: string;
  note: string;
  color: HighlightColor;
  createdAt: number;
}

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  updatedAt: number;
  deleted?: boolean;
  deletedAt?: number;
}

export interface ArticleDoc {
  id: string;
  title: string;
  folderId: string | null;
  order: number;
  content: string;
  contentHash: string;
  excerpt: string;
  tags: string[];
  starred: boolean;
  readProgress: number; // 0 to 100
  lastReadAt: number | null;
  lastMode?: 'read' | 'edit';
  lastScrollTop?: number;
  encrypted?: boolean;
  format?: 'txt' | 'md';
  createdAt: number;
  updatedAt: number;
  syncStatus: SyncStatus;
  deleted?: boolean;
  deletedAt?: number;
  deletedByFolderId?: string;
  highlights: HighlightItem[];
  byteSize: number;
}

export interface ManifestDocEntry {
  id: string;
  title: string;
  folderId: string | null;
  order: number;
  contentHash: string;
  excerpt: string;
  tags: string[];
  starred: boolean;
  readProgress: number;
  lastReadAt?: number | null;
  lastMode?: 'read' | 'edit';
  lastScrollTop?: number;
  encrypted?: boolean;
  format?: 'txt' | 'md';
  updatedAt: number;
  createdAt: number;
  deleted?: boolean;
  deletedAt?: number;
  deletedByFolderId?: string;
  byteSize: number;
}

export interface PurgedSyncRecords {
  docs: Record<string, number>;
  docFormats?: Record<string, 'txt' | 'md'>;
  folders: Record<string, number>;
}

export interface SyncedTreeState {
  collapsedIds: string[];
  activeTarget: { kind: 'folder' | 'doc'; id: string } | null;
  scrollTop: number;
  updatedAt: number;
}

export interface SyncedSettings {
  provider: 'jianguoyun';
  baseUrl: string;
  username: string;
  password: string;
  encryptionPassword: string;
  updatedAt: number;
}

export interface RemoteManifest {
  version: number;
  updatedAt: number;
  folders: FolderNode[];
  docs: Record<string, ManifestDocEntry>;
  treeState?: SyncedTreeState;
  syncSettings?: SyncedSettings;
}

export interface WebDavConfig {
  provider?: 'jianguoyun';
  enabled: boolean;
  baseUrl: string; // e.g. https://dav.jianguoyun.com/dav/FeiArtical/
  username: string;
  password: string;
  encryptionPassword?: string;
  settingsUpdatedAt?: number;
  lazyFetch: boolean; // On-demand body fetch to save download quota
  lastManifestEtag?: string;
  lastSyncedAt?: number;
}

export interface QuotaStats {
  monthKey: string; // YYYY-MM
  uploadBytes: number;
  downloadBytes: number;
  requestCount: number;
  skippedByEtag304: number;
  skippedByHashMatch: number;
}

export interface SyncLogEntry {
  id: string;
  timestamp: number;
  mode: 'live' | 'simulate';
  summary: string;
  requests: number;
  uploadBytes: number;
  downloadBytes: number;
  status: 'success' | 'noop' | 'error';
}

export type ReaderFont = 'serif' | 'sans' | 'mono';
export type ReaderPaper = 'white' | 'paper' | 'dark';
export type ReaderWidth = 'narrow' | 'medium' | 'wide';

export interface ReaderSettings {
  fontFamily: ReaderFont;
  fontSize: number; // 14 - 22
  lineHeight: number; // 1.6 - 2.2
  width: ReaderWidth;
  paper: ReaderPaper;
  indentFirstLine: boolean;
}

export type SmartView = 'all' | 'recent' | 'starred' | 'dirty' | 'highlights' | 'trash';
export type SortMode = 'custom' | 'updated' | 'title' | 'length';

export interface MdictKeyBlockMeta {
  numEntries: number;
  firstKey: string;
  lastKey: string;
  compressedOffset: number;
  compressedSize: number;
  decompressedSize: number;
}

export interface MdictRecordBlockMeta {
  compressedOffset: number;
  compressedSize: number;
  decompressedOffset: number;
  decompressedSize: number;
}

export type MdictEncoding = 'utf-8' | 'utf-16le' | 'gb18030' | 'big5';

export interface MdictDictionaryRecord {
  id: string;
  fileName: string;
  title: string;
  description: string;
  encoding: MdictEncoding;
  version: number;
  encrypt: number;
  isStripKey: boolean;
  isCaseSensitive: boolean;
  numEntries: number;
  fileSize: number;
  addedAt: number;
  totalRecordDecompressedSize: number;
  keyBlocks: MdictKeyBlockMeta[];
  recordBlocks: MdictRecordBlockMeta[];
}

export type MdictDictionarySummary = Pick<
  MdictDictionaryRecord,
  'id' | 'fileName' | 'title' | 'description' | 'numEntries' | 'fileSize' | 'addedAt'
>;

export interface MdictLookupResult {
  dictId: string;
  dictTitle: string;
  queryWord: string;
  matchedHeadword: string;
  htmlDefinitions: string[];
}


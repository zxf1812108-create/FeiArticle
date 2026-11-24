import { ArticleDoc, FolderNode, PurgedSyncRecords } from '../types';

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function pruneExpiredPurgedRecords(
  records: PurgedSyncRecords | undefined,
  now = Date.now()
): PurgedSyncRecords {
  const docs: Record<string, number> = {};
  const docFormats: Record<string, 'txt' | 'md'> = {};
  const folders: Record<string, number> = {};

  if (records?.docs) {
    for (const [id, ts] of Object.entries(records.docs)) {
      if (typeof ts === 'number' && Number.isFinite(ts) && now - ts < TRASH_RETENTION_MS) {
        docs[id] = ts;
        const fmt = records.docFormats?.[id];
        if (fmt === 'md' || fmt === 'txt') {
          docFormats[id] = fmt;
        }
      }
    }
  }

  if (records?.folders) {
    for (const [id, ts] of Object.entries(records.folders)) {
      if (typeof ts === 'number' && Number.isFinite(ts) && now - ts < TRASH_RETENTION_MS) {
        folders[id] = ts;
      }
    }
  }

  return { docs, docFormats, folders };
}

export function getItemDeletedAt(item: { deletedAt?: number; updatedAt: number }): number {
  return typeof item.deletedAt === 'number' && Number.isFinite(item.deletedAt)
    ? item.deletedAt
    : item.updatedAt;
}

export function isTrashExpired(
  item: { deleted?: boolean; deletedAt?: number; updatedAt: number },
  now = Date.now()
): boolean {
  if (!item.deleted) return false;
  return now - getItemDeletedAt(item) >= TRASH_RETENTION_MS;
}

export function getTrashRemainingDays(
  item: { deletedAt?: number; updatedAt: number },
  now = Date.now()
): number {
  const remainingMs = TRASH_RETENTION_MS - Math.max(0, now - getItemDeletedAt(item));
  if (remainingMs <= 0) return 0;
  return Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
}

export function purgeExpiredTrash(
  folders: FolderNode[],
  docs: ArticleDoc[],
  now = Date.now()
): {
  folders: FolderNode[];
  docs: ArticleDoc[];
  expiredFolderIds: string[];
  expiredDocs: ArticleDoc[];
  changed: boolean;
} {
  const expiredFolderIds: string[] = [];
  const expiredFolderSet = new Set<string>();
  const keptFolders: FolderNode[] = [];

  for (const folder of folders) {
    if (isTrashExpired(folder, now)) {
      expiredFolderIds.push(folder.id);
      expiredFolderSet.add(folder.id);
    } else {
      keptFolders.push(folder);
    }
  }

  const expiredDocs: ArticleDoc[] = [];
  const keptDocs: ArticleDoc[] = [];

  for (const doc of docs) {
    const folderWasExpired = Boolean(
      doc.deleted && doc.folderId && expiredFolderSet.has(doc.folderId)
    );
    if (isTrashExpired(doc, now) || folderWasExpired) {
      expiredDocs.push(doc);
    } else {
      keptDocs.push(doc);
    }
  }

  return {
    folders: keptFolders,
    docs: keptDocs,
    expiredFolderIds,
    expiredDocs,
    changed: expiredFolderIds.length > 0 || expiredDocs.length > 0,
  };
}

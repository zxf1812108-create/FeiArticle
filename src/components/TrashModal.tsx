import React, { useMemo, useState } from 'react';
import { FileText, Folder, RotateCcw, Trash2, X } from 'lucide-react';
import { ArticleDoc, FolderNode } from '../types';
import { getItemDeletedAt } from '../utils/trash';

interface TrashModalProps {
  folders: FolderNode[];
  docs: ArticleDoc[];
  onRestoreFolder: (folderId: string) => void;
  onRestoreDoc: (docId: string) => void;
  onEmptyTrash: () => void;
  onClose: () => void;
}

export const TrashModal: React.FC<TrashModalProps> = ({
  folders,
  docs,
  onRestoreFolder,
  onRestoreDoc,
  onEmptyTrash,
  onClose,
}) => {
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const deletedFolders = useMemo(
    () =>
      folders
        .filter((f) => f.deleted)
        .sort((a, b) => getItemDeletedAt(b) - getItemDeletedAt(a)),
    [folders]
  );

  const deletedFolderIdSet = useMemo(
    () => new Set(deletedFolders.map((f) => f.id)),
    [deletedFolders]
  );

  const folderNameMap = useMemo(
    () => new Map(folders.map((f) => [f.id, f.name])),
    [folders]
  );

  const deletedDocs = useMemo(
    () =>
      docs
        .filter((d) => d.deleted)
        .sort((a, b) => getItemDeletedAt(b) - getItemDeletedAt(a)),
    [docs]
  );

  // Group docs deleted together with a deleted folder vs individually deleted docs
  const { docsByDeletedFolder, standaloneDeletedDocs } = useMemo(() => {
    const grouped = new Map<string, ArticleDoc[]>();
    const standalone: ArticleDoc[] = [];

    for (const doc of deletedDocs) {
      const parentDeletedFolderId =
        doc.deletedByFolderId && deletedFolderIdSet.has(doc.deletedByFolderId)
          ? doc.deletedByFolderId
          : doc.folderId && deletedFolderIdSet.has(doc.folderId)
            ? doc.folderId
            : null;

      if (parentDeletedFolderId) {
        const list = grouped.get(parentDeletedFolderId) || [];
        list.push(doc);
        grouped.set(parentDeletedFolderId, list);
      } else {
        standalone.push(doc);
      }
    }

    return { docsByDeletedFolder: grouped, standaloneDeletedDocs: standalone };
  }, [deletedDocs, deletedFolderIdSet]);

  const hasTrashItems = deletedFolders.length > 0 || deletedDocs.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-transparent dark:bg-black/45 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] max-h-[84vh] flex flex-col bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] rounded-2xl shadow-none dark:shadow-xl overflow-hidden text-[var(--fei-text-primary)]"
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--fei-border)] flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="text-[12.5px] font-normal text-[var(--fei-text-muted)] leading-tight">
              回收站
            </h2>
            <p className="text-[11.5px] text-[var(--fei-text-muted)] mt-0.5">
              30天后自动删除
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {hasTrashItems && (
              confirmEmpty ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onEmptyTrash();
                      setConfirmEmpty(false);
                    }}
                    className="h-7 px-2.5 rounded-lg bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] text-[12px] font-medium hover:opacity-90 transition-opacity whitespace-nowrap"
                  >
                    确认清空
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmEmpty(false)}
                    className="h-7 px-2 rounded-lg text-[12px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors whitespace-nowrap"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmEmpty(true)}
                  className="h-7 px-2.5 rounded-lg text-[12.5px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors whitespace-nowrap"
                >
                  清空
                </button>
              )
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭回收站"
              className="w-8 h-8 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
          {!hasTrashItems ? (
            <div className="py-14 px-6 flex flex-col items-center justify-center text-center space-y-2.5">
              <Trash2
                className="w-8 h-8 text-[var(--fei-text-muted)] opacity-55"
                strokeWidth={1.5}
              />
              <div className="text-[14px] text-[var(--fei-text-primary)]">
                回收站为空
              </div>
              <p className="text-[12px] leading-relaxed text-[var(--fei-text-muted)] max-w-[260px]">
                在目录界面将文档或目录拖入右下角回收站图标即可删除
              </p>
            </div>
          ) : (
            <>
              {/* Deleted Directories (along with their documents) */}
              {deletedFolders.map((folder) => {
                const childDocs = docsByDeletedFolder.get(folder.id) || [];
                return (
                  <div
                    key={folder.id}
                    className="rounded-xl bg-[var(--fei-bg-subtle)]/65 border border-[var(--fei-border)] overflow-hidden"
                  >
                    <div className="flex items-center gap-2 px-3 py-2.5 min-h-[44px]">
                      <Folder
                        className="w-4 h-4 text-[var(--fei-text-muted)] shrink-0"
                        strokeWidth={1.75}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] font-medium text-[var(--fei-text-primary)] truncate">
                          {folder.name}
                        </div>
                      </div>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => onRestoreFolder(folder.id)}
                          title="恢复目录及其中文档"
                          aria-label={`恢复目录 ${folder.name}`}
                          className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
                        >
                          <RotateCcw className="w-4 h-4" strokeWidth={1.75} />
                        </button>
                      </div>
                    </div>

                    {childDocs.length > 0 && (
                      <div className="border-t border-[var(--fei-border)] divide-y divide-[var(--fei-border)]/70 bg-[var(--fei-bg)]/45">
                        {childDocs.map((doc) => (
                          <div
                            key={doc.id}
                            className="flex items-center gap-2 pl-8 pr-3 py-2 min-h-[38px]"
                          >
                            <FileText
                              className="w-3.5 h-3.5 text-[var(--fei-text-muted)] shrink-0"
                              strokeWidth={1.75}
                            />
                            <span className="flex-1 min-w-0 text-[13px] text-[var(--fei-text-primary)] truncate">
                              {doc.title || '无标题文档'}
                            </span>
                            {doc.encrypted && (
                              <span
                                aria-label="已加密"
                                className="text-[13px] font-code text-[var(--fei-text-muted)] shrink-0"
                              >
                                *
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => onRestoreDoc(doc.id)}
                              title="单独恢复该文档"
                              aria-label={`恢复文档 ${doc.title || '无标题文档'}`}
                              className="w-7 h-7 inline-flex items-center justify-center rounded text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors shrink-0"
                            >
                              <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Individually Deleted Documents */}
              {standaloneDeletedDocs.map((doc) => {
                const originFolder = doc.folderId
                  ? folderNameMap.get(doc.folderId)
                  : undefined;
                return (
                  <div
                    key={doc.id}
                    className="flex items-center gap-2 px-3 py-2.5 min-h-[44px] rounded-xl hover:bg-[var(--fei-bg-hover)] transition-colors"
                  >
                    <FileText
                      className="w-4 h-4 text-[var(--fei-text-muted)] shrink-0"
                      strokeWidth={1.75}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[14px] text-[var(--fei-text-primary)] truncate">
                          {doc.title || '无标题文档'}
                        </span>
                        {doc.encrypted && (
                          <span
                            aria-label="已加密"
                            className="text-[13px] font-code text-[var(--fei-text-muted)] shrink-0"
                          >
                            *
                          </span>
                        )}
                      </div>
                      {originFolder && (
                        <div className="text-[11.5px] text-[var(--fei-text-muted)] mt-0.5 truncate">
                          原目录：{originFolder}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onRestoreDoc(doc.id)}
                        title="恢复文档"
                        aria-label={`恢复文档 ${doc.title || '无标题文档'}`}
                        className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] transition-colors"
                      >
                        <RotateCcw className="w-4 h-4" strokeWidth={1.75} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

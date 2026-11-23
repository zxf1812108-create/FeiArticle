import React, { useMemo, useRef, useState } from 'react';
import { Check, Download, FileText, Folder, Plus, X } from 'lucide-react';
import { FolderNode } from '../types';
import {
  ExtractedEbookImage,
  isEbookFile,
  isSupportedImportFile,
  parseEbookFile,
} from '../utils/ebookParser';
import { INBOX_FOLDER_ID, isReservedInboxName } from '../utils/inbox';
import { readTextFileSmart } from '../utils/textParser';

interface ImportModalProps {
  folders: FolderNode[];
  defaultFolderId: string | null;
  onCreateFolder: (name: string) => FolderNode | null;
  onImportDocs: (
    items: Array<{
      title: string;
      content: string;
      folderId: string | null;
      format?: 'txt' | 'md';
      images?: ExtractedEbookImage[];
    }>
  ) => void | Promise<void>;
  onClose: () => void;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  folders,
  defaultFolderId,
  onCreateFolder,
  onImportDocs,
  onClose,
}) => {
  const sortedFolders = useMemo(
    () =>
      [...folders]
        .filter((f) => f.id !== INBOX_FOLDER_ID)
        .sort((a, b) => a.order - b.order),
    [folders]
  );

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(() => {
    if (defaultFolderId && folders.some((f) => f.id === defaultFolderId)) {
      return defaultFolderId;
    }
    return sortedFolders[0]?.id ?? null;
  });

  const effectiveFolderId = useMemo(() => {
    if (selectedFolderId && sortedFolders.some((f) => f.id === selectedFolderId)) {
      return selectedFolderId;
    }
    return sortedFolders[0]?.id ?? null;
  }, [selectedFolderId, sortedFolders]);

  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = async (fileList: FileList | File[]) => {
    if (importing) return;
    setError(null);
    if (!effectiveFolderId) {
      setError('请先新建一个目标目录后再导入。');
      return;
    }
    const files = Array.from(fileList).filter(isSupportedImportFile);
    if (files.length === 0) {
      setError('请选择 .txt、.md、.epub、.mobi、.azw3、.fb2 或 .html 文档（支持多选）。');
      return;
    }

    setImporting(true);
    try {
      const parsed: Array<{
        title: string;
        content: string;
        folderId: string | null;
        format: 'txt';
        images?: ExtractedEbookImage[];
      }> = [];
      const failedMessages: string[] = [];

      for (const file of files) {
        if (isEbookFile(file)) {
          try {
            const ebookDoc = await parseEbookFile(file);
            parsed.push({
              title: ebookDoc.title,
              content: ebookDoc.content,
              folderId: effectiveFolderId,
              format: 'txt',
              images: ebookDoc.images,
            });
          } catch (err) {
            failedMessages.push(
              err instanceof Error ? err.message : `解析「${file.name}」失败`
            );
          }
        } else {
          const content = await readTextFileSmart(file);
          const title = file.name.replace(/\.(txt|md|markdown|text)$/i, '').trim() || '导入文档';
          parsed.push({ title, content, folderId: effectiveFolderId, format: 'txt' });
        }
      }

      if (parsed.length > 0) {
        await onImportDocs(parsed);
        if (failedMessages.length === 0) {
          onClose();
        } else {
          setError(`已导入 ${parsed.length} 篇文档；部分失败：${failedMessages[0]}`);
        }
      } else {
        setError(failedMessages[0] || '未能导入所选文档，请检查文件是否完整。');
      }
    } finally {
      setImporting(false);
    }
  };

  const handleImportPasted = () => {
    setError(null);
    if (!effectiveFolderId) {
      setError('请先新建一个目标目录后再导入。');
      return;
    }
    const trimmed = pasteContent.trim();
    if (!trimmed) {
      setError('请先在文本框中粘贴要导入的内容。');
      return;
    }
    const firstNonEmpty =
      trimmed
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find(Boolean) || '未命名文档';
    const finalTitle = pasteTitle.trim() || firstNonEmpty.slice(0, 40);

    onImportDocs([
      {
        title: finalTitle,
        content: trimmed,
        folderId: effectiveFolderId,
        format: 'txt',
      },
    ]);
    onClose();
  };

  const handleConfirmNewFolder = () => {
    const trimmed = newFolderName.trim();
    if (trimmed) {
      if (isReservedInboxName(trimmed)) {
        setError('inbox 为云端投递箱保留名称，请使用其他目录名。');
        return;
      }
      const created = onCreateFolder(trimmed);
      if (created) {
        setSelectedFolderId(created.id);
      }
      if (error) setError(null);
    }
    setNewFolderName('');
    setAddingFolder(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 dark:bg-black/45 eink:bg-transparent p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[88vh] flex flex-col bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] rounded-2xl shadow-xl dark:shadow-2xl eink:shadow-none overflow-hidden text-[var(--fei-text-primary)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--fei-border)] flex items-center justify-between shrink-0">
          <h2 className="text-[15px] font-semibold text-[var(--fei-text-primary)]">
            导入文档
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Directory Picker List (existing folders only, no automatic 未分类 option) */}
          <div className="space-y-2">
            <div className="text-[12.5px] text-[var(--fei-text-muted)]">目标目录</div>
            <div className="max-h-40 overflow-y-auto divide-y divide-[var(--fei-border)] border border-[var(--fei-border)] rounded-xl">
              {sortedFolders.length === 0 ? (
                <div className="px-3.5 py-3 text-[13px] text-[var(--fei-text-muted)]">
                  暂无目录，请先点击下方新建目标目录
                </div>
              ) : (
                sortedFolders.map((folder) => {
                  const active = effectiveFolderId === folder.id;
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      onClick={() => setSelectedFolderId(folder.id)}
                      className={`w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left text-[14px] text-[var(--fei-text-primary)] transition-colors ${
                        active
                          ? 'bg-[var(--fei-bg-selected)]'
                          : 'hover:bg-[var(--fei-bg-hover)]'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Folder className="w-4 h-4 text-[var(--fei-text-muted)] shrink-0" />
                        <span className="truncate">{folder.name}</span>
                      </span>
                      {active && (
                        <Check className="w-4 h-4 text-[var(--fei-text-primary)] shrink-0" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {addingFolder ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConfirmNewFolder();
                    if (e.key === 'Escape') setAddingFolder(false);
                  }}
                  placeholder="输入新目录名称…"
                  className="flex-1 h-9 px-3 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border-strong)] text-[13.5px] text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none"
                />
                <button
                  type="button"
                  onClick={handleConfirmNewFolder}
                  disabled={!newFolderName.trim()}
                  className={`h-9 px-3 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[13px] transition-colors whitespace-nowrap ${
                    newFolderName.trim()
                      ? 'text-[var(--fei-text-primary)] font-medium hover:bg-[var(--fei-bg-selected)] active:bg-[var(--fei-bg-selected)] cursor-pointer'
                      : 'text-[var(--fei-text-muted)]/55 cursor-not-allowed'
                  }`}
                >
                  创建
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingFolder(true)}
                className="inline-flex items-center gap-1.5 text-[13px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新建目标目录</span>
              </button>
            )}
          </div>

          {/* Paste Text Box (placed BEFORE file picker, defaults to .txt format) */}
          <div className="space-y-2 pt-1 border-t border-[var(--fei-border)]">
            <div className="flex items-center justify-between text-[12.5px] text-[var(--fei-text-muted)]">
              <span>粘贴文本导入</span>
              <span className="font-code text-[11.5px]">默认 .txt</span>
            </div>
            <input
              type="text"
              value={pasteTitle}
              onChange={(e) => setPasteTitle(e.target.value)}
              placeholder="文档标题（留空自动取正文首行）"
              className="w-full h-9 px-3 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[13.5px] text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none focus:border-[var(--fei-border-strong)]"
            />
            <textarea
              rows={4}
              value={pasteContent}
              onChange={(e) => {
                setPasteContent(e.target.value);
                if (error) setError(null);
              }}
              placeholder="在此粘贴文本内容…"
              className="w-full p-3 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[13.5px] leading-relaxed text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none focus:border-[var(--fei-border-strong)] resize-none"
            />
            <div className="flex justify-end">
              {(() => {
                const canImportPasted = Boolean(pasteContent.trim() && effectiveFolderId);
                return (
                  <button
                    type="button"
                    onClick={handleImportPasted}
                    disabled={!canImportPasted}
                    className={`h-9 px-3.5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[13px] transition-colors whitespace-nowrap ${
                      canImportPasted
                        ? 'text-[var(--fei-text-primary)] font-medium hover:bg-[var(--fei-bg-selected)] active:bg-[var(--fei-bg-selected)] cursor-pointer'
                        : 'text-[var(--fei-text-muted)]/55 cursor-not-allowed'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>导入粘贴文本</span>
                  </button>
                );
              })()}
            </div>
          </div>

          {/* Multi-file Drop / Picker Box */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!importing) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!importing && e.dataTransfer.files.length > 0) {
                void processFiles(e.dataTransfer.files);
              }
            }}
            onClick={() => {
              if (!importing) fileInputRef.current?.click();
            }}
            className={`py-6 px-4 rounded-xl border border-dashed text-center transition-colors space-y-1.5 ${
              importing
                ? 'border-[var(--fei-border)] opacity-60 cursor-wait'
                : dragging
                  ? 'border-[var(--fei-text-primary)] bg-[var(--fei-bg-selected)] cursor-pointer'
                  : 'border-[var(--fei-border-strong)] hover:border-[var(--fei-text-muted)] cursor-pointer'
            }`}
          >
            <Download className="w-5 h-5 mx-auto text-[var(--fei-text-muted)]" />
            <div className="text-[14px] font-medium text-[var(--fei-text-primary)]">
              {importing ? '正在解析并转换文档…' : '选择 .txt / .md / .epub / .mobi 等文档（可多选）'}
            </div>
            <p className="text-[12px] text-[var(--fei-text-muted)]">
              支持 EPUB、MOBI、AZW3、AZW、PRC、FB2、HTML，结构自动转为 Markdown 并以 UTF-8 存为 .txt
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={importing}
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  void processFiles(e.target.files);
                }
                e.target.value = '';
              }}
            />
          </div>

          {error && <p className="text-[12.5px] text-[var(--fei-text-muted)]">{error}</p>}
        </div>
      </div>
    </div>
  );
};

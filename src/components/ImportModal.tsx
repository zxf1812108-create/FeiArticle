import React, { useRef, useState } from 'react';
import { Check, Download, FileText, Folder, Plus, X } from 'lucide-react';
import { FolderNode } from '../types';
import { readTextFileSmart } from '../utils/textParser';

interface ImportModalProps {
  folders: FolderNode[];
  defaultFolderId: string | null;
  onCreateFolder: (name: string) => FolderNode;
  onImportDocs: (
    items: Array<{ title: string; content: string; folderId: string | null; format?: 'txt' | 'md' }>
  ) => void;
  onClose: () => void;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  folders,
  defaultFolderId,
  onCreateFolder,
  onImportDocs,
  onClose,
}) => {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(defaultFolderId);
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sortedFolders = [...folders].sort((a, b) => a.order - b.order);

  const processFiles = async (fileList: FileList | File[]) => {
    setError(null);
    const files = Array.from(fileList).filter(
      (f) => /\.(txt|md|markdown|text)$/i.test(f.name) || f.type.startsWith('text/')
    );
    if (files.length === 0) {
      setError('请选择 .txt 或 .md 文本文档（支持多选）。');
      return;
    }

    const parsed: Array<{
      title: string;
      content: string;
      folderId: string | null;
      format: 'txt';
    }> = [];
    for (const file of files) {
      const content = await readTextFileSmart(file);
      const title = file.name.replace(/\.(txt|md|markdown|text)$/i, '').trim() || '导入文档';
      parsed.push({ title, content, folderId: selectedFolderId, format: 'txt' });
    }
    onImportDocs(parsed);
    onClose();
  };

  const handleImportPasted = () => {
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
        folderId: selectedFolderId,
        format: 'txt',
      },
    ]);
    onClose();
  };

  const handleConfirmNewFolder = () => {
    const trimmed = newFolderName.trim();
    if (trimmed) {
      const created = onCreateFolder(trimmed);
      setSelectedFolderId(created.id);
    }
    setNewFolderName('');
    setAddingFolder(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[88vh] flex flex-col bg-[#FFFFFF] dark:bg-[#1E1E1E] border border-[#EAEAEA] dark:border-[#2E2E2E] rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[#EEEEEE] dark:border-[#2A2A2A] flex items-center justify-between shrink-0">
          <h2 className="text-[15px] font-semibold text-[#222222] dark:text-[#EAEAEA]">
            导入文档
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[#888888] hover:bg-[#F3F3F3] dark:hover:bg-[#2A2A2A]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Directory Picker List */}
          <div className="space-y-2">
            <div className="text-[12.5px] text-[#777777] dark:text-[#8E8E8E]">目标目录</div>
            <div className="max-h-40 overflow-y-auto divide-y divide-[#F2F2F2] dark:divide-[#282828] border border-[#EEEEEE] dark:border-[#2C2C2C] rounded-xl">
              {sortedFolders.map((folder) => {
                const active = selectedFolderId === folder.id;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => setSelectedFolderId(folder.id)}
                    className={`w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left text-[14px] transition-colors ${
                      active
                        ? 'bg-[#F2F2F2] dark:bg-[#282828] text-[#222222] dark:text-[#F0F0F0] font-medium'
                        : 'text-[#444444] dark:text-[#C8C8C8] hover:bg-[#FAFAFA] dark:hover:bg-[#242424]'
                    }`}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Folder className="w-4 h-4 opacity-55 shrink-0" />
                      <span className="truncate">{folder.name}</span>
                    </span>
                    {active && <Check className="w-4 h-4 text-[#222222] dark:text-[#EAEAEA] shrink-0" />}
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => setSelectedFolderId(null)}
                className={`w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left text-[14px] transition-colors ${
                  selectedFolderId === null
                    ? 'bg-[#F2F2F2] dark:bg-[#282828] text-[#222222] dark:text-[#F0F0F0] font-medium'
                    : 'text-[#777777] dark:text-[#8E8E8E] hover:bg-[#FAFAFA] dark:hover:bg-[#242424]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Folder className="w-4 h-4 opacity-45 shrink-0" />
                  <span>未分类</span>
                </span>
                {selectedFolderId === null && (
                  <Check className="w-4 h-4 text-[#222222] dark:text-[#EAEAEA] shrink-0" />
                )}
              </button>
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
                  className="flex-1 h-9 px-3 rounded-lg bg-[#F7F7F7] dark:bg-[#262626] border border-[#DDDDDD] dark:border-[#3A3A3A] text-[13.5px] outline-none"
                />
                <button
                  type="button"
                  onClick={handleConfirmNewFolder}
                  className="h-9 px-3 rounded-lg bg-[#222222] dark:bg-[#E0E0E0] text-white dark:text-[#1A1A1A] text-[13px] font-medium whitespace-nowrap"
                >
                  创建
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingFolder(true)}
                className="inline-flex items-center gap-1.5 text-[13px] text-[#777777] dark:text-[#909090] hover:text-[#222222] dark:hover:text-[#EAEAEA]"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新建目标目录</span>
              </button>
            )}
          </div>

          {/* Paste Text Box (placed BEFORE file picker, defaults to .txt format) */}
          <div className="space-y-2 pt-1 border-t border-[#EEEEEE] dark:border-[#2A2A2A]">
            <div className="flex items-center justify-between text-[12.5px] text-[#777777] dark:text-[#8E8E8E]">
              <span>粘贴文本导入</span>
              <span className="font-code text-[11.5px]">默认 .txt</span>
            </div>
            <input
              type="text"
              value={pasteTitle}
              onChange={(e) => setPasteTitle(e.target.value)}
              placeholder="文档标题（留空自动取正文首行）"
              className="w-full h-9 px-3 rounded-lg bg-[#F7F7F7] dark:bg-[#171717] border border-[#E5E5E5] dark:border-[#333333] text-[13.5px] text-[#222222] dark:text-[#E5E5E5] placeholder:text-[#999999] dark:placeholder:text-[#606060] outline-none focus:border-[#666666]"
            />
            <textarea
              rows={4}
              value={pasteContent}
              onChange={(e) => {
                setPasteContent(e.target.value);
                if (error) setError(null);
              }}
              placeholder="在此粘贴文本内容…"
              className="w-full p-3 rounded-lg bg-[#F7F7F7] dark:bg-[#171717] border border-[#E5E5E5] dark:border-[#333333] text-[13.5px] leading-relaxed text-[#222222] dark:text-[#E5E5E5] placeholder:text-[#999999] dark:placeholder:text-[#606060] outline-none focus:border-[#666666] resize-none"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleImportPasted}
                disabled={!pasteContent.trim()}
                className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-lg bg-[#222222] dark:bg-[#E0E0E0] text-[#FFFFFF] dark:text-[#1A1A1A] text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-35 whitespace-nowrap"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>导入粘贴文本</span>
              </button>
            </div>
          </div>

          {/* Multi-file Drop / Picker Box */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length > 0) {
                processFiles(e.dataTransfer.files);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`py-6 px-4 rounded-xl border border-dashed text-center cursor-pointer transition-colors space-y-1.5 ${
              dragging
                ? 'border-[#222222] dark:border-[#D9D9D9] bg-[#F5F5F5] dark:bg-[#262626]'
                : 'border-[#D8D8D8] dark:border-[#383838] hover:border-[#AAAAAA] dark:hover:border-[#555555]'
            }`}
          >
            <Download className="w-5 h-5 mx-auto text-[#777777] dark:text-[#8E8E8E]" />
            <div className="text-[14px] font-medium text-[#222222] dark:text-[#EAEAEA]">
              选择 .txt / .md 文件（可多选）
            </div>
            <p className="text-[12px] text-[#888888] dark:text-[#787878]">
              导入后默认存放为 .txt 文本文档，自动兼容 UTF-8 / GBK 编码
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  processFiles(e.target.files);
                }
                e.target.value = '';
              }}
            />
          </div>

          {error && <p className="text-[12.5px] text-[#555555] dark:text-[#A8A8A8]">{error}</p>}
        </div>
      </div>
    </div>
  );
};

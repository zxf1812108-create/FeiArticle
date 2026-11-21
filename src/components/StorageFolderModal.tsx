import React, { useRef, useState } from 'react';
import { Check, Folder, FolderOpen } from 'lucide-react';

interface StorageFolderModalProps {
  initialPath: string;
  onConfirm: (folderPath: string) => void;
}

const PRESET_FOLDERS = [
  { path: '/Documents/FeiArtical', label: 'Documents / FeiArtical', desc: '推荐 · 文档目录' },
  { path: '/FeiArtical', label: '内部存储 / FeiArtical', desc: '根目录' },
  { path: '/Download/FeiArtical', label: 'Download / FeiArtical', desc: '下载目录' },
];

export const StorageFolderModal: React.FC<StorageFolderModalProps> = ({
  initialPath,
  onConfirm,
}) => {
  const [selectedPath, setSelectedPath] = useState(
    initialPath || PRESET_FOLDERS[0].path
  );
  const [customInput, setCustomInput] = useState(
    initialPath || PRESET_FOLDERS[0].path
  );
  const [picking, setPicking] = useState(false);
  const dirInputRef = useRef<HTMLInputElement>(null);

  const handleBrowseSystemFolder = async () => {
    const win = window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>;
    };

    if (typeof win.showDirectoryPicker === 'function') {
      setPicking(true);
      try {
        const handle = await win.showDirectoryPicker({ mode: 'readwrite' });
        if (handle?.name) {
          const path = `/${handle.name}`;
          setSelectedPath(path);
          setCustomInput(path);
        }
        setPicking(false);
        return;
      } catch (err) {
        setPicking(false);
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
      }
    }

    dirInputRef.current?.click();
  };

  const handleDirInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const first = files[0] as File & { webkitRelativePath?: string };
      const rel = first.webkitRelativePath || '';
      const folderName = rel.split('/')[0]?.trim();
      if (folderName) {
        const path = `/${folderName}`;
        setSelectedPath(path);
        setCustomInput(path);
      }
    }
    e.target.value = '';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = customInput.trim() || selectedPath || PRESET_FOLDERS[0].path;
    const normalized = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
    onConfirm(normalized);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-transparent dark:bg-black/45 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-[360px] bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] rounded-2xl shadow-none dark:shadow-xl overflow-hidden text-[var(--fei-text-primary)]"
      >
        <div className="p-5 space-y-4">
          {/* Header */}
          <div className="space-y-1">
            <h2 className="text-[15px] font-medium text-[var(--fei-text-primary)]">
              选择文档存放目录
            </h2>
            <p className="text-[12.5px] text-[var(--fei-text-muted)]">
              首次运行，请指定本地文档存放文件夹
            </p>
          </div>

          {/* System Folder Picker Button */}
          <button
            type="button"
            onClick={handleBrowseSystemFolder}
            disabled={picking}
            className="w-full h-10 px-3.5 rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] hover:bg-[var(--fei-bg-selected)] transition-colors flex items-center justify-center gap-2 text-[13px] text-[var(--fei-text-primary)] disabled:opacity-60"
          >
            <FolderOpen className="w-4 h-4 text-[var(--fei-text-muted)]" strokeWidth={1.75} />
            <span>{picking ? '正在打开目录…' : '浏览选择文件夹'}</span>
          </button>

          <input
            ref={dirInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is supported in Chromium/Android WebView
            webkitdirectory=""
            directory=""
            multiple
            className="hidden"
            onChange={handleDirInputChange}
          />

          {/* Quick Directory List */}
          <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] divide-y divide-[var(--fei-border)] overflow-hidden">
            {PRESET_FOLDERS.map((item) => {
              const isSelected = customInput.trim() === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    setSelectedPath(item.path);
                    setCustomInput(item.path);
                  }}
                  className={`w-full px-3.5 py-2.5 flex items-center justify-between gap-2.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-[var(--fei-bg-selected)]'
                      : 'hover:bg-[var(--fei-bg-hover)]'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Folder
                      className="w-4 h-4 text-[var(--fei-text-muted)] shrink-0"
                      strokeWidth={1.75}
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] text-[var(--fei-text-primary)] truncate">
                        {item.label}
                      </div>
                      <div className="text-[11.5px] text-[var(--fei-text-muted)]">
                        {item.desc}
                      </div>
                    </div>
                  </div>
                  {isSelected && (
                    <Check
                      className="w-4 h-4 text-[var(--fei-text-primary)] shrink-0"
                      strokeWidth={2}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Current Selected Path Input */}
          <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] px-3.5 h-10 flex items-center gap-2.5">
            <span className="text-[12px] text-[var(--fei-text-muted)] shrink-0">
              目录路径
            </span>
            <input
              type="text"
              value={customInput}
              onChange={(e) => {
                setCustomInput(e.target.value);
                setSelectedPath(e.target.value);
              }}
              placeholder="/Documents/FeiArtical"
              className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none"
            />
          </div>

          {/* Confirm Button */}
          <button
            type="submit"
            className="w-full h-10 rounded-xl bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] text-[13.5px] font-medium hover:opacity-90 transition-opacity"
          >
            确定
          </button>
        </div>
      </form>
    </div>
  );
};

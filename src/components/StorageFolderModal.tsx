import React, { useState } from 'react';
import { Check, Folder, FolderOpen, X } from 'lucide-react';
import {
  configureRealStorageDirectory,
  isNativeLocalStorageAvailable,
  pickRealStorageDirectory,
} from '../utils/localFs';
import { LocalStorageBackendMode } from '../utils/storage';

export interface StorageFolderConfirmResult {
  folderPath: string;
  storageMode: LocalStorageBackendMode;
  treeUri?: string;
}

interface StorageFolderModalProps {
  initialPath: string;
  allowCancel?: boolean;
  subtitle?: string;
  onConfirm: (result: StorageFolderConfirmResult) => Promise<void> | void;
  onCancel?: () => void;
}

const PRESET_FOLDERS = [
  { path: '/Documents/FeiArtical', label: 'Documents / FeiArtical', desc: '推荐 · 文档目录' },
  { path: '/FeiArtical', label: '内部存储 / FeiArtical', desc: '根目录' },
  { path: '/Download/FeiArtical', label: 'Download / FeiArtical', desc: '下载目录' },
];

export const StorageFolderModal: React.FC<StorageFolderModalProps> = ({
  initialPath,
  allowCancel = false,
  subtitle,
  onConfirm,
  onCancel,
}) => {
  const [selectedPath, setSelectedPath] = useState(
    initialPath || PRESET_FOLDERS[0].path
  );
  const [customInput, setCustomInput] = useState(
    initialPath || PRESET_FOLDERS[0].path
  );
  const [pickedMode, setPickedMode] = useState<LocalStorageBackendMode | undefined>(undefined);
  const [pickedTreeUri, setPickedTreeUri] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isAndroidNative = isNativeLocalStorageAvailable();

  const handleBrowseSystemFolder = async () => {
    setErrorMsg(null);
    setPicking(true);
    try {
      const res = await pickRealStorageDirectory();
      if (res.cancelled) {
        return;
      }
      if (!res.ok || !res.folderPath || !res.storageMode) {
        setErrorMsg(res.error || '未能选择本地文件夹，请重试');
        return;
      }

      setSelectedPath(res.folderPath);
      setCustomInput(res.folderPath);
      setPickedMode(res.storageMode);
      setPickedTreeUri(res.treeUri);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '打开系统文件夹选择器失败');
    } finally {
      setPicking(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || picking) return;

    setErrorMsg(null);
    setSubmitting(true);
    try {
      const cleaned = customInput.trim() || selectedPath || PRESET_FOLDERS[0].path;
      const normalized = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;

      // If user explicitly picked via SAF or Web FS and didn't edit the path away, keep that binding
      const usePickedBinding =
        (pickedMode === 'saf' || pickedMode === 'web-fs') && normalized === selectedPath;

      const outcome = await configureRealStorageDirectory({
        folderPath: normalized,
        storageMode: usePickedBinding ? pickedMode : 'path',
        treeUri: usePickedBinding ? pickedTreeUri : undefined,
        requestPermission: true,
      });

      if (!outcome.ok) {
        setErrorMsg(outcome.error || '无法创建或写入该目录，请检查存储权限或通过上方按钮选择文件夹');
        return;
      }

      await onConfirm({
        folderPath: outcome.folderPath,
        storageMode: outcome.storageMode,
        treeUri: outcome.treeUri,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '创建本地目录失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-transparent dark:bg-black/45 p-4"
      onClick={allowCancel && !submitting ? onCancel : undefined}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[360px] bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] rounded-2xl shadow-none dark:shadow-xl overflow-hidden text-[var(--fei-text-primary)]"
      >
        <div className="p-5 space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <h2 className="text-[15px] font-medium text-[var(--fei-text-primary)]">
                选择文档存放目录
              </h2>
              <p className="text-[12.5px] text-[var(--fei-text-muted)] leading-relaxed">
                {subtitle ||
                  (isAndroidNative
                    ? '文档与文件夹将实时保存为手机该目录中的 .md / .txt 文件'
                    : '指定本地文档存放文件夹，文档将实时同步写入该目录')}
              </p>
            </div>
            {allowCancel && onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                aria-label="关闭"
                className="w-7 h-7 -mr-1 -mt-0.5 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* System Folder Picker Button */}
          <button
            type="button"
            onClick={handleBrowseSystemFolder}
            disabled={picking || submitting}
            className="w-full h-10 px-3.5 rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] hover:bg-[var(--fei-bg-selected)] transition-colors flex items-center justify-center gap-2 text-[13px] text-[var(--fei-text-primary)] disabled:opacity-60"
          >
            <FolderOpen className="w-4 h-4 text-[var(--fei-text-muted)]" strokeWidth={1.75} />
            <span>
              {picking
                ? '正在打开系统目录…'
                : pickedMode === 'saf' || pickedMode === 'web-fs'
                  ? '已授权系统文件夹（点击重选）'
                  : '浏览选择文件夹（推荐）'}
            </span>
          </button>

          {/* Quick Directory List */}
          <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] divide-y divide-[var(--fei-border)] overflow-hidden">
            {PRESET_FOLDERS.map((item) => {
              const isSelected = customInput.trim() === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setSelectedPath(item.path);
                    setCustomInput(item.path);
                    setPickedMode(undefined);
                    setPickedTreeUri(undefined);
                    setErrorMsg(null);
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
              disabled={submitting}
              onChange={(e) => {
                setCustomInput(e.target.value);
                setSelectedPath(e.target.value);
                setPickedMode(undefined);
                setPickedTreeUri(undefined);
                setErrorMsg(null);
              }}
              placeholder="/Documents/FeiArtical"
              className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none"
            />
          </div>

          {errorMsg && (
            <p className="text-[12px] leading-relaxed text-[var(--fei-text-primary)] border border-[var(--fei-border-strong)] rounded-xl px-3 py-2 bg-[var(--fei-bg-subtle)]">
              {errorMsg}
            </p>
          )}

          {/* Confirm Button */}
          <button
            type="submit"
            disabled={submitting || picking}
            className="w-full h-10 rounded-xl bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] text-[13.5px] font-medium hover:opacity-90 transition-opacity disabled:opacity-60"
          >
            {submitting ? '正在创建并绑定目录…' : '确定'}
          </button>
        </div>
      </form>
    </div>
  );
};

import React, { useRef, useState } from 'react';
import { BookA, Check, Trash2, Upload, X } from 'lucide-react';
import { MdictDictionarySummary } from '../types';
import { formatBytes } from '../utils/textParser';

interface MdictDictModalProps {
  dictionaries: MdictDictionarySummary[];
  activeDictId: string | null;
  onImportFiles: (files: FileList) => Promise<void>;
  onSelectDict: (id: string) => void;
  onDeleteDict: (id: string) => Promise<void>;
  onClose: () => void;
}

export const MdictDictModal: React.FC<MdictDictModalProps> = ({
  dictionaries,
  activeDictId,
  onImportFiles,
  onSelectDict,
  onDeleteDict,
  onClose,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setErrorMsg(null);
    setImporting(true);
    try {
      await onImportFiles(files);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '导入词典失败');
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] max-h-[84vh] flex flex-col bg-[var(--fei-bg-surface)] border border-[var(--fei-border)] rounded-2xl shadow-xl overflow-hidden text-[var(--fei-text-primary)]"
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--fei-border)] flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="text-[12.5px] font-normal text-[var(--fei-text-muted)] leading-tight">
              词典
            </h2>
            <p className="text-[11.5px] text-[var(--fei-text-muted)] mt-0.5">
              长按选中英文单词自动查词（仅本地离线保存）
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="h-7 px-2.5 rounded-lg inline-flex items-center gap-1 text-[12px] font-medium bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] hover:opacity-90 disabled:opacity-60 transition-opacity whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>{importing ? '解析中…' : '导入词库'}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭词典设置"
              className="w-8 h-8 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
          {errorMsg && (
            <div className="px-3 py-2 rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[12px] text-[var(--fei-text-primary)] leading-relaxed">
              {errorMsg}
            </div>
          )}

          {dictionaries.length === 0 ? (
            <div className="py-12 px-6 flex flex-col items-center justify-center text-center space-y-2.5">
              <BookA
                className="w-8 h-8 text-[var(--fei-text-muted)] opacity-55"
                strokeWidth={1.5}
              />
              <div className="text-[14px] text-[var(--fei-text-primary)]">
                暂未导入词典
              </div>
              <p className="text-[12px] leading-relaxed text-[var(--fei-text-muted)] max-w-[270px]">
                点击右上角「导入词库」选择本地 .mdx 词典文件，支持导入多本并随时切换。
              </p>
            </div>
          ) : (
            dictionaries.map((dict) => {
              const isActive = dict.id === activeDictId;
              const isDeleting = deletingId === dict.id;
              return (
                <div
                  key={dict.id}
                  onClick={() => onSelectDict(dict.id)}
                  className={`group flex items-center gap-2.5 px-3 py-2.5 min-h-[48px] rounded-xl border cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-[var(--fei-bg-selected)] border-[var(--fei-border-strong)]'
                      : 'bg-transparent border-[var(--fei-border)] hover:bg-[var(--fei-bg-hover)]'
                  }`}
                >
                  <div className="w-5 h-5 flex items-center justify-center shrink-0 text-[var(--fei-text-primary)]">
                    {isActive ? (
                      <Check className="w-4 h-4" strokeWidth={2} />
                    ) : (
                      <BookA className="w-4 h-4 text-[var(--fei-text-muted)]" strokeWidth={1.65} />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium text-[var(--fei-text-primary)] truncate">
                      {dict.title}
                    </div>
                    <div className="text-[11.5px] text-[var(--fei-text-muted)] truncate mt-0.5">
                      {dict.numEntries.toLocaleString()} 词条 · {formatBytes(dict.fileSize)}
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={async (e) => {
                      e.stopPropagation();
                      setDeletingId(dict.id);
                      setErrorMsg(null);
                      try {
                        await onDeleteDict(dict.id);
                      } catch (err) {
                        setErrorMsg(err instanceof Error ? err.message : '删除词典失败');
                      } finally {
                        setDeletingId(null);
                      }
                    }}
                    title="移除词库"
                    aria-label={`移除词库 ${dict.title}`}
                    className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors shrink-0 disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" strokeWidth={1.75} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

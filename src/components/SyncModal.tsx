import React, { useEffect, useRef, useState } from 'react';
import {
  BookA,
  Check,
  Copy,
  Eye,
  EyeOff,
  FileCode2,
  Folder,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { MdictDictionarySummary, WebDavConfig } from '../types';
import { stripDictExt } from '../utils/mdictStorage';
import { DEFAULT_JIANGUOYUN_URL, normalizeWebDavBaseUrl } from '../utils/webdavSync';

interface SyncModalProps {
  config: WebDavConfig;
  storageFolderPath: string;
  onChangeStorageFolder: () => void;
  lanRunning: boolean;
  lanUrl: string;
  lanLoading: boolean;
  onToggleLan: (next: boolean) => void;
  onCopyLanUrl: (url: string) => void;
  dictionaries: MdictDictionarySummary[];
  activeDictId: string | null;
  onImportDictFiles: (files: FileList) => Promise<void>;
  onAttachDictCss: (dictId: string, file: File) => Promise<void>;
  onSelectDict: (id: string) => void;
  onDeleteDict: (id: string) => Promise<void>;
  onSaveConfig: (next: WebDavConfig) => void;
  onClose: () => void;
}

export const SyncModal: React.FC<SyncModalProps> = ({
  config,
  storageFolderPath,
  onChangeStorageFolder,
  lanRunning,
  lanUrl,
  lanLoading,
  onToggleLan,
  onCopyLanUrl,
  dictionaries,
  activeDictId,
  onImportDictFiles,
  onAttachDictCss,
  onSelectDict,
  onDeleteDict,
  onSaveConfig,
  onClose,
}) => {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl || DEFAULT_JIANGUOYUN_URL);
  const [username, setUsername] = useState(config.username || '');
  const [password, setPassword] = useState(config.password || '');

  const [encryptionPassword, setEncryptionPassword] = useState(config.encryptionPassword || '');
  const [confirmPassword, setConfirmPassword] = useState(config.encryptionPassword || '');

  const [showAppPassword, setShowAppPassword] = useState(false);
  const [showEncPassword, setShowEncPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const dictFileInputRef = useRef<HTMLInputElement>(null);
  const dictCssInputRef = useRef<HTMLInputElement>(null);
  const pendingCssDictIdRef = useRef<string | null>(null);
  const [dictImporting, setDictImporting] = useState(false);
  const [busyDictId, setBusyDictId] = useState<string | null>(null);
  const [dictErrorMsg, setDictErrorMsg] = useState<string | null>(null);

  const handleDictFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setDictErrorMsg(null);
    setDictImporting(true);
    try {
      await onImportDictFiles(files);
    } catch (err) {
      setDictErrorMsg(err instanceof Error ? err.message : '导入词典失败');
    } finally {
      setDictImporting(false);
      e.target.value = '';
    }
  };

  const handleDictCssFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetId = pendingCssDictIdRef.current;
    pendingCssDictIdRef.current = null;
    e.target.value = '';
    if (!file || !targetId) return;

    setDictErrorMsg(null);
    setBusyDictId(targetId);
    try {
      await onAttachDictCss(targetId, file);
    } catch (err) {
      setDictErrorMsg(err instanceof Error ? err.message : '导入样式文件失败');
    } finally {
      setBusyDictId(null);
    }
  };

  // Clear any residual long-press text selection when opening from the Sync toolbar button
  useEffect(() => {
    const clearSel = () => {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // ignore
      }
    };
    clearSel();
    const rafId = window.requestAnimationFrame(clearSel);
    const t1 = window.setTimeout(clearSel, 120);
    const t2 = window.setTimeout(clearSel, 260);
    window.addEventListener('pointerup', clearSel, { once: true });
    window.addEventListener('touchend', clearSel, { once: true });
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener('pointerup', clearSel);
      window.removeEventListener('touchend', clearSel);
    };
  }, []);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (encryptionPassword !== confirmPassword) {
      setErrorMsg('两次输入的加密密码不一致');
      return;
    }

    const normalizedUrl = normalizeWebDavBaseUrl(baseUrl || DEFAULT_JIANGUOYUN_URL);
    const trimmedUser = username.trim();
    const trimmedPass = password.trim();
    const endpointChanged =
      normalizeWebDavBaseUrl(config.baseUrl || DEFAULT_JIANGUOYUN_URL) !== normalizedUrl ||
      (config.username || '').trim() !== trimmedUser;

    onSaveConfig({
      ...config,
      provider: 'jianguoyun',
      baseUrl: normalizedUrl,
      username: trimmedUser,
      password: trimmedPass,
      encryptionPassword,
      lastManifestEtag: endpointChanged ? undefined : config.lastManifestEtag,
      settingsUpdatedAt: Date.now(),
      enabled: Boolean(trimmedUser && trimmedPass),
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-transparent dark:bg-black/45 p-4 select-none"
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      <form
        onSubmit={handleSave}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[360px] max-h-[88vh] overflow-y-auto bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] rounded-2xl shadow-none dark:shadow-xl text-[var(--fei-text-primary)] select-none"
      >
        <div className="p-4 sm:p-5 space-y-4">
          {/* 区域一：同步设置 */}
          <section className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <h3 className="text-[13.5px] font-medium text-[var(--fei-text-primary)]">
                同步设置
              </h3>
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭"
                className="w-7 h-7 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] divide-y divide-[var(--fei-border)] overflow-hidden">
              <label className="flex items-center gap-2.5 px-3.5 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[var(--fei-text-muted)]">
                  地址
                </span>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={DEFAULT_JIANGUOYUN_URL}
                  className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none"
                />
              </label>

              <label className="flex items-center gap-2.5 px-3.5 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[var(--fei-text-muted)]">
                  账号
                </span>
                <input
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="输入账号"
                  className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none"
                />
              </label>

              <div className="flex items-center gap-2.5 pl-3.5 pr-2 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[var(--fei-text-muted)]">
                  密码
                </span>
                <input
                  type={showAppPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入应用密码"
                  className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowAppPassword((v) => !v)}
                  aria-label={showAppPassword ? '隐藏密码' : '显示密码'}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] shrink-0 transition-colors"
                >
                  {showAppPassword ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          </section>

          {/* 区域二：加密密码 */}
          <section className="space-y-2">
            <h3 className="px-0.5 text-[13.5px] font-medium text-[var(--fei-text-primary)]">
              加密密码
            </h3>

            <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] divide-y divide-[var(--fei-border)] overflow-hidden">
              <div className="flex items-center gap-2.5 pl-3.5 pr-2 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[var(--fei-text-muted)]">
                  密码
                </span>
                <input
                  type={showEncPassword ? 'text' : 'password'}
                  value={encryptionPassword}
                  onChange={(e) => {
                    setEncryptionPassword(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  placeholder="输入加密密码"
                  className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowEncPassword((v) => !v)}
                  aria-label={showEncPassword ? '隐藏密码' : '显示密码'}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] shrink-0 transition-colors"
                >
                  {showEncPassword ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2.5 pl-3.5 pr-2 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[var(--fei-text-muted)]">
                  验证
                </span>
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  placeholder="再次输入加密密码"
                  className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((v) => !v)}
                  aria-label={showConfirmPassword ? '隐藏验证密码' : '显示验证密码'}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] shrink-0 transition-colors"
                >
                  {showConfirmPassword ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>

            {errorMsg && (
              <p className="px-0.5 text-[12px] text-[var(--fei-text-muted)]">
                {errorMsg}
              </p>
            )}
          </section>

          {/* 区域三：电脑直连（同飞记局域网直连） */}
          <section className="space-y-2">
            <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] divide-y divide-[var(--fei-border)] overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-3.5 h-11">
                <span className="text-[13.5px] font-medium text-[var(--fei-text-primary)]">
                  电脑直连
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={lanRunning}
                  aria-label="切换电脑直连"
                  disabled={lanLoading}
                  onClick={() => onToggleLan(!lanRunning)}
                  className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50 ${
                    lanRunning
                      ? 'bg-[var(--fei-btn-primary-bg)]'
                      : 'bg-[var(--fei-border-strong)]'
                  }`}
                >
                  <span
                    className={`inline-block h-[16px] w-[16px] rounded-full transition-transform duration-150 ${
                      lanRunning
                        ? 'translate-x-[21px] bg-[var(--fei-btn-primary-text)]'
                        : 'translate-x-[3px] bg-[var(--fei-bg-surface)]'
                    }`}
                  />
                </button>
              </div>

              {lanRunning && lanUrl && (
                <div className="px-3.5 py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] font-code text-[var(--fei-text-primary)] truncate select-all">
                      {lanUrl}
                    </span>
                    <button
                      type="button"
                      onClick={() => onCopyLanUrl(lanUrl)}
                      aria-label="复制直连地址"
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] shrink-0 transition-colors"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>复制</span>
                    </button>
                  </div>
                  <p className="text-[11.5px] leading-relaxed text-[var(--fei-text-muted)]">
                    手机与电脑连入同一 Wi-Fi，在电脑浏览器打开上方地址即可管理文档
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* 区域四：本地存储目录 */}
          <section className="space-y-2">
            <h3 className="text-[13.5px] font-medium text-[var(--fei-text-primary)] px-0.5">
              本地文档目录
            </h3>
            <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] px-3.5 py-2.5 flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <Folder className="w-4 h-4 text-[var(--fei-text-muted)] shrink-0" strokeWidth={1.75} />
                <span className="text-[12.5px] font-code text-[var(--fei-text-primary)] truncate">
                  {storageFolderPath || '/Documents/FeiArtical'}
                </span>
              </div>
              <button
                type="button"
                onClick={onChangeStorageFolder}
                className="px-2.5 py-1 rounded-lg border border-[var(--fei-border)] text-[12px] text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] shrink-0 transition-colors"
              >
                更改
              </button>
            </div>
          </section>

          {/* 区域五：离线词典（导入与切换 .mdx 词库及配套 .css 样式） */}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <h3 className="text-[13.5px] font-medium text-[var(--fei-text-primary)]">
                词典
              </h3>
              <input
                ref={dictFileInputRef}
                type="file"
                multiple
                onChange={handleDictFileChange}
                className="hidden"
              />
              <input
                ref={dictCssInputRef}
                type="file"
                onChange={handleDictCssFileChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => dictFileInputRef.current?.click()}
                disabled={dictImporting}
                className="h-7 px-2.5 rounded-lg inline-flex items-center gap-1 text-[12px] font-medium border border-[var(--fei-border)] bg-[var(--fei-bg-subtle)] text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] disabled:opacity-60 transition-colors whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5" strokeWidth={1.75} />
                <span>{dictImporting ? '解析中…' : '导入词库'}</span>
              </button>
            </div>

            {dictErrorMsg && (
              <div className="px-3 py-2 rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[12px] text-[var(--fei-text-primary)] leading-relaxed">
                {dictErrorMsg}
              </div>
            )}

            <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] overflow-hidden">
              {dictionaries.length === 0 ? (
                <div className="px-3.5 py-3 text-[12px] leading-relaxed text-[var(--fei-text-muted)]">
                  暂未导入词典，支持导入 .mdx 词库及配套 .css 样式文件
                </div>
              ) : (
                <div className="max-h-[200px] overflow-y-auto divide-y divide-[var(--fei-border)]">
                  {dictionaries.map((dict) => {
                    const isActive = dict.id === activeDictId;
                    const isBusy = busyDictId === dict.id;
                    const displayName = stripDictExt(dict.fileName) || dict.title;
                    return (
                      <div
                        key={dict.id}
                        onClick={() => onSelectDict(dict.id)}
                        className={`flex items-center gap-2 px-3 py-2 min-h-[42px] cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-[var(--fei-bg-selected)]'
                            : 'hover:bg-[var(--fei-bg-hover)]'
                        }`}
                      >
                        <div className="w-4 h-4 flex items-center justify-center shrink-0 text-[var(--fei-text-primary)]">
                          {isActive ? (
                            <Check className="w-3.5 h-3.5" strokeWidth={2} />
                          ) : (
                            <BookA
                              className="w-3.5 h-3.5 text-[var(--fei-text-muted)]"
                              strokeWidth={1.65}
                            />
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-[var(--fei-text-primary)] truncate">
                            {displayName}
                          </div>
                        </div>

                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={(e) => {
                              e.stopPropagation();
                              pendingCssDictIdRef.current = dict.id;
                              dictCssInputRef.current?.click();
                            }}
                            title={dict.cssFileName ? '替换配套 .css 样式' : '导入配套 .css 样式'}
                            aria-label={`为 ${displayName} 导入样式`}
                            className="h-7 px-1.5 inline-flex items-center gap-1 rounded-lg text-[11.5px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors disabled:opacity-50"
                          >
                            <FileCode2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                            <span>{dict.cssFileName ? '换样式' : '样式'}</span>
                          </button>

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={async (e) => {
                              e.stopPropagation();
                              setBusyDictId(dict.id);
                              setDictErrorMsg(null);
                              try {
                                await onDeleteDict(dict.id);
                              } catch (err) {
                                setDictErrorMsg(
                                  err instanceof Error ? err.message : '删除词典失败'
                                );
                              } finally {
                                setBusyDictId(null);
                              }
                            }}
                            title="移除词库"
                            aria-label={`移除词库 ${displayName}`}
                            className="w-7 h-7 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors shrink-0 disabled:opacity-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* Compact Footer Actions */}
          <div className="pt-1 flex items-center gap-2.5 select-none">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-9 rounded-xl bg-[var(--fei-bg-subtle)] text-[13px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] transition-colors select-none"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 h-9 rounded-xl bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] text-[13px] font-medium hover:opacity-90 transition-opacity select-none"
            >
              保存
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

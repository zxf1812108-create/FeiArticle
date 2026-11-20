import React, { useState } from 'react';
import { Copy, Eye, EyeOff, X } from 'lucide-react';
import { WebDavConfig } from '../types';
import { DEFAULT_JIANGUOYUN_URL, normalizeWebDavBaseUrl } from '../utils/webdavSync';

interface SyncModalProps {
  config: WebDavConfig;
  lanRunning: boolean;
  lanUrl: string;
  lanLoading: boolean;
  onToggleLan: (next: boolean) => void;
  onCopyLanUrl: (url: string) => void;
  onSaveConfig: (next: WebDavConfig) => void;
  onClose: () => void;
}

export const SyncModal: React.FC<SyncModalProps> = ({
  config,
  lanRunning,
  lanUrl,
  lanLoading,
  onToggleLan,
  onCopyLanUrl,
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSave}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[360px] max-h-[88vh] overflow-y-auto bg-[var(--fei-bg-surface)] border border-[var(--fei-border)] rounded-2xl shadow-xl text-[var(--fei-text-primary)]"
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
                  type="email"
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

          {/* 区域二：电脑直连（同飞记局域网直连） */}
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

          {/* 区域三：加密密码 */}
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

          {/* Compact Footer Actions */}
          <div className="pt-1 flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-9 rounded-xl bg-[var(--fei-bg-subtle)] text-[13px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 h-9 rounded-xl bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] text-[13px] font-medium hover:opacity-90 transition-opacity"
            >
              保存
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

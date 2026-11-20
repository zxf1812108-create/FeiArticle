import React, { useState } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import { WebDavConfig } from '../types';

interface SyncModalProps {
  config: WebDavConfig;
  onSaveConfig: (next: WebDavConfig) => void;
  onClose: () => void;
}

const DEFAULT_JIANGUOYUN_URL = 'https://dav.jianguoyun.com/dav/FeiArtical/';

export const SyncModal: React.FC<SyncModalProps> = ({
  config,
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

    const trimmedUrl = baseUrl.trim() || DEFAULT_JIANGUOYUN_URL;
    const trimmedUser = username.trim();
    const trimmedPass = password.trim();

    onSaveConfig({
      ...config,
      provider: 'jianguoyun',
      baseUrl: trimmedUrl,
      username: trimmedUser,
      password: trimmedPass,
      encryptionPassword,
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
        className="w-full max-w-[360px] bg-[#FFFFFF] dark:bg-[#1E1E1E] border border-[#EAEAEA] dark:border-[#2E2E2E] rounded-2xl shadow-xl overflow-hidden text-[#222222] dark:text-[#D9D9D9]"
      >
        <div className="p-4 sm:p-5 space-y-4">
          {/* 区域一：同步设置 */}
          <section className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <h3 className="text-[13px] font-medium text-[#555555] dark:text-[#BDBDBD]">
                同步设置
              </h3>
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭"
                className="w-7 h-7 -mr-1 inline-flex items-center justify-center rounded-lg text-[#888888] hover:text-[#222222] dark:hover:text-[#EEEEEE] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-xl bg-[#F7F7F7] dark:bg-[#242424] border border-[#EEEEEE] dark:border-[#2E2E2E] divide-y divide-[#ECECEC] dark:divide-[#2E2E2E] overflow-hidden">
              <label className="flex items-center gap-2.5 px-3.5 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[#777777] dark:text-[#8E8E8E]">
                  地址
                </span>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={DEFAULT_JIANGUOYUN_URL}
                  className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[#222222] dark:text-[#E5E5E5] placeholder:text-[#AAAAAA] dark:placeholder:text-[#555555] outline-none"
                />
              </label>

              <label className="flex items-center gap-2.5 px-3.5 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[#777777] dark:text-[#8E8E8E]">
                  账号
                </span>
                <input
                  type="email"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="输入账号"
                  className="flex-1 min-w-0 bg-transparent text-[13px] text-[#222222] dark:text-[#E5E5E5] placeholder:text-[#AAAAAA] dark:placeholder:text-[#555555] outline-none"
                />
              </label>

              <div className="flex items-center gap-2.5 pl-3.5 pr-2 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[#777777] dark:text-[#8E8E8E]">
                  密码
                </span>
                <input
                  type={showAppPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入应用密码"
                  className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[#222222] dark:text-[#E5E5E5] placeholder:text-[#AAAAAA] dark:placeholder:text-[#555555] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowAppPassword((v) => !v)}
                  aria-label={showAppPassword ? '隐藏密码' : '显示密码'}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[#888888] hover:text-[#222222] dark:hover:text-[#E5E5E5] shrink-0"
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
            <h3 className="px-0.5 text-[13px] font-medium text-[#555555] dark:text-[#BDBDBD]">
              加密密码
            </h3>

            <div className="rounded-xl bg-[#F7F7F7] dark:bg-[#242424] border border-[#EEEEEE] dark:border-[#2E2E2E] divide-y divide-[#ECECEC] dark:divide-[#2E2E2E] overflow-hidden">
              <div className="flex items-center gap-2.5 pl-3.5 pr-2 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[#777777] dark:text-[#8E8E8E]">
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
                  className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[#222222] dark:text-[#E5E5E5] placeholder:text-[#AAAAAA] dark:placeholder:text-[#555555] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowEncPassword((v) => !v)}
                  aria-label={showEncPassword ? '隐藏密码' : '显示密码'}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[#888888] hover:text-[#222222] dark:hover:text-[#E5E5E5] shrink-0"
                >
                  {showEncPassword ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2.5 pl-3.5 pr-2 h-10">
                <span className="w-11 shrink-0 text-[12.5px] text-[#777777] dark:text-[#8E8E8E]">
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
                  className="flex-1 min-w-0 bg-transparent text-[13px] font-code text-[#222222] dark:text-[#E5E5E5] placeholder:text-[#AAAAAA] dark:placeholder:text-[#555555] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((v) => !v)}
                  aria-label={showConfirmPassword ? '隐藏验证密码' : '显示验证密码'}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[#888888] hover:text-[#222222] dark:hover:text-[#E5E5E5] shrink-0"
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
              <p className="px-0.5 text-[12px] text-[#555555] dark:text-[#BDBDBD]">
                {errorMsg}
              </p>
            )}
          </section>

          {/* Compact Footer Actions */}
          <div className="pt-1 flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-9 rounded-xl bg-[#F2F2F2] dark:bg-[#2A2A2A] text-[13px] text-[#555555] dark:text-[#CCCCCC] hover:bg-[#EAEAEA] dark:hover:bg-[#333333] transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 h-9 rounded-xl bg-[#222222] dark:bg-[#E0E0E0] text-[#FFFFFF] dark:text-[#1A1A1A] text-[13px] font-medium hover:opacity-90 transition-opacity"
            >
              保存
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

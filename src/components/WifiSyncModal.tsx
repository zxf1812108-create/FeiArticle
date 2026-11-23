import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Laptop,
  Lock,
  RefreshCw,
  Smartphone,
  Wifi,
  X,
} from 'lucide-react';
import { ArticleDoc, FolderNode, PurgedSyncRecords, SyncedTreeState } from '../types';
import { StorageDirectoryConfig } from '../utils/storage';
import {
  DEFAULT_WIFI_SYNC_PORT,
  isWifiSyncNativeAvailable,
  runWifiBidirectionalSync,
  startWifiSyncHost,
  WifiDocBodyPayload,
  WifiPeer,
  WifiServerInfo,
  WifiSyncProgress,
  WifiSyncSummary,
} from '../utils/wifiSync';

interface WifiSyncModalProps {
  encryptionPassword: string;
  storageDir: StorageDirectoryConfig;
  getLocalState: () => {
    folders: FolderNode[];
    docs: ArticleDoc[];
    treeState: SyncedTreeState;
    purgedRecords: PurgedSyncRecords;
  };
  applyMergedCatalog: (
    folders: FolderNode[],
    docs: ArticleDoc[],
    treeState: SyncedTreeState
  ) => void;
  applyReceivedDocBody: (payload: WifiDocBodyPayload) => Promise<void>;
  onOpenSettings: () => void;
  onClose: () => void;
}

function formatWifiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || '');
  const lower = raw.toLowerCase();
  if (lower.includes('密码') || lower.includes('auth') || lower.includes('401') || lower.includes('invalid')) {
    return '加密密码核验失败：请确认两台设备设置了完全相同的加密密码';
  }
  if (lower.includes('429') || lower.includes('锁定') || lower.includes('too many')) {
    return '连续密码核验失败过多，对方已临时锁定 60 秒，请稍后重试';
  }
  if (lower.includes('refused') || lower.includes('timeout') || lower.includes('timed out') || lower.includes('unreachable')) {
    return '无法连接对方设备：请确认两台设备在同一 Wi-Fi 且对方已打开「Wi-Fi 同步」界面';
  }
  return raw || 'Wi-Fi 同步失败，请重试';
}

function parseHostAndPort(rawInput: string): { host: string; port: number } | null {
  const trimmed = rawInput.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  const host = parts[0]?.trim() || '';
  if (!host) return null;
  const parsedPort = parts[1] ? Number.parseInt(parts[1], 10) : DEFAULT_WIFI_SYNC_PORT;
  const port =
    Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_WIFI_SYNC_PORT;
  return { host, port };
}

export const WifiSyncModal: React.FC<WifiSyncModalProps> = ({
  encryptionPassword,
  storageDir,
  getLocalState,
  applyMergedCatalog,
  applyReceivedDocBody,
  onOpenSettings,
  onClose,
}) => {
  const hasPassword = Boolean(encryptionPassword && encryptionPassword.trim().length > 0);
  const nativeSupported = isWifiSyncNativeAvailable();

  const [serverInfo, setServerInfo] = useState<WifiServerInfo | null>(null);
  const [hostStarting, setHostStarting] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  const [peers, setPeers] = useState<WifiPeer[]>([]);
  const [manualAddress, setManualAddress] = useState('');

  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<WifiSyncProgress | null>(null);
  const [summary, setSummary] = useState<WifiSyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const callbacksRef = useRef({
    getLocalState,
    applyMergedCatalog,
    applyReceivedDocBody,
  });
  callbacksRef.current = {
    getLocalState,
    applyMergedCatalog,
    applyReceivedDocBody,
  };

  useEffect(() => {
    if (!hasPassword || !nativeSupported) return;

    let cancelled = false;
    let stopHost: (() => Promise<void>) | null = null;

    setHostStarting(true);
    setHostError(null);

    startWifiSyncHost(encryptionPassword, {
      getLocalState: () => callbacksRef.current.getLocalState(),
      applyMergedCatalog: (folders, docs, treeState) =>
        callbacksRef.current.applyMergedCatalog(folders, docs, treeState),
      applyReceivedDocBody: (payload) => callbacksRef.current.applyReceivedDocBody(payload),
      onPeersChange: (nextPeers) => {
        if (!cancelled) {
          setPeers(nextPeers);
        }
      },
    })
      .then((res) => {
        if (cancelled) {
          void res.stop();
          return;
        }
        stopHost = res.stop;
        setServerInfo(res.info);
        setHostStarting(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setHostError(formatWifiError(err));
          setHostStarting(false);
        }
      });

    return () => {
      cancelled = true;
      if (stopHost) {
        void stopHost();
      }
    };
  }, [encryptionPassword, hasPassword, nativeSupported]);

  const handleSyncWithPeer = async (host: string, port: number) => {
    if (syncing || !hasPassword || !nativeSupported) return;
    setSyncing(true);
    setSyncError(null);
    setSummary(null);
    setProgress({
      phase: 'connecting',
      label: '正在核验加密密码并建立加密通道…',
      completed: 0,
      total: 1,
    });

    try {
      const result = await runWifiBidirectionalSync({
        host,
        port,
        password: encryptionPassword,
        storageDir,
        getLocalState: () => callbacksRef.current.getLocalState(),
        applyMergedCatalog: (folders, docs, treeState) =>
          callbacksRef.current.applyMergedCatalog(folders, docs, treeState),
        applyReceivedDocBody: (payload) => callbacksRef.current.applyReceivedDocBody(payload),
        onProgress: (p) => setProgress(p),
      });
      setSummary(result);
    } catch (err) {
      setSyncError(formatWifiError(err));
    } finally {
      setSyncing(false);
    }
  };

  const handleManualConnect = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseHostAndPort(manualAddress);
    if (!parsed) {
      setSyncError('请输入有效的对方设备 IP 地址，例如 192.168.1.25');
      return;
    }
    void handleSyncWithPeer(parsed.host, parsed.port);
  };

  const progressPercent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 dark:bg-black/45 eink:bg-transparent p-4 select-none"
      onClick={() => {
        if (!syncing) onClose();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[360px] max-h-[88vh] overflow-y-auto bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] rounded-2xl shadow-xl eink:shadow-none text-[var(--fei-text-primary)] select-none"
      >
        <div className="p-4 sm:p-5 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between px-0.5">
            <div className="flex items-center gap-2">
              <Wifi className="w-4 h-4 text-[var(--fei-text-primary)]" strokeWidth={1.8} />
              <h3 className="text-[14px] font-medium text-[var(--fei-text-primary)]">
                Wi-Fi 设备同步
              </h3>
            </div>
            <button
              type="button"
              disabled={syncing}
              onClick={onClose}
              aria-label="关闭"
              className="w-7 h-7 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] disabled:opacity-40 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {!hasPassword ? (
            /* Gate 1: Encryption password required */
            <div className="space-y-4">
              <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] p-3.5 space-y-2">
                <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--fei-text-primary)]">
                  <Lock className="w-4 h-4 shrink-0" strokeWidth={1.8} />
                  <span>需先设置加密密码</span>
                </div>
                <p className="text-[12.5px] leading-relaxed text-[var(--fei-text-muted)]">
                  同 Wi-Fi 设备互传使用「加密密码」完成双向身份核验与 AES-256 加密传输，无需输入验证码。两台设备设置相同加密密码后即可直接同步正文与插图。
                </p>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 h-9 rounded-xl bg-[var(--fei-bg-subtle)] text-[13px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="flex-1 h-9 rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border-strong)] text-[13px] font-medium text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] transition-colors"
                >
                  前往设置加密密码
                </button>
              </div>
            </div>
          ) : !nativeSupported ? (
            /* Gate 2: Non-Android browser environment */
            <div className="space-y-4">
              <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] p-3.5 space-y-2">
                <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--fei-text-primary)]">
                  <Laptop className="w-4 h-4 shrink-0" strokeWidth={1.8} />
                  <span>请在手机或墨水屏客户端中使用</span>
                </div>
                <p className="text-[12.5px] leading-relaxed text-[var(--fei-text-muted)]">
                  点对点 Wi-Fi 设备同步依赖原生局域网发现与高速二进制通道，仅在 Android 手机及墨水屏安装包中可用。若需用电脑传书，请在手机端设置里开启「电脑直连」。
                </p>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="flex-1 h-9 rounded-xl bg-[var(--fei-bg-subtle)] text-[13px] text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] transition-colors"
                >
                  打开设置
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 h-9 rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[13px] font-medium text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] transition-colors"
                >
                  知道了
                </button>
              </div>
            </div>
          ) : (
            /* Active native Wi-Fi sync UI */
            <div className="space-y-3.5">
              {/* Local Device Status */}
              <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] px-3.5 py-2.5 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Smartphone className="w-3.5 h-3.5 text-[var(--fei-text-muted)] shrink-0" strokeWidth={1.8} />
                    <span className="text-[12.5px] font-medium text-[var(--fei-text-primary)] truncate">
                      {serverInfo?.deviceName || '本机'}
                    </span>
                  </div>
                  <span className="text-[11.5px] text-[var(--fei-text-muted)] shrink-0">
                    {hostStarting
                      ? '正在启动…'
                      : serverInfo?.running
                        ? '已加密就绪'
                        : '未就绪'}
                  </span>
                </div>
                {serverInfo?.ip && (
                  <div className="text-[12px] font-code text-[var(--fei-text-muted)] select-all">
                    本机地址：{serverInfo.ip}:{serverInfo.port}
                  </div>
                )}
                {hostError && (
                  <div className="text-[12px] text-[var(--fei-text-primary)] leading-relaxed pt-0.5">
                    {hostError}
                  </div>
                )}
              </div>

              {/* Discovered Peers */}
              <section className="space-y-1.5">
                <div className="px-0.5 flex items-center justify-between">
                  <span className="text-[12.5px] font-medium text-[var(--fei-text-primary)]">
                    同一 Wi-Fi 下的设备
                  </span>
                  <span className="text-[11.5px] text-[var(--fei-text-muted)]">
                    {peers.length > 0 ? `发现 ${peers.length} 台` : '搜索中…'}
                  </span>
                </div>

                <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] divide-y divide-[var(--fei-border)] overflow-hidden">
                  {peers.length === 0 ? (
                    <div className="px-3.5 py-3 text-[12px] leading-relaxed text-[var(--fei-text-muted)]">
                      请在另一台设备也打开「Wi-Fi 设备同步」界面（两台设备需连入同一 Wi-Fi 且加密密码一致）。
                    </div>
                  ) : (
                    peers.map((peer) => (
                      <div
                        key={peer.id}
                        className="px-3.5 py-2.5 flex items-center justify-between gap-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-[var(--fei-text-primary)] truncate">
                            {peer.name}
                          </div>
                          <div className="text-[11.5px] font-code text-[var(--fei-text-muted)] truncate">
                            {peer.ip}:{peer.port}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={syncing}
                          onClick={() => void handleSyncWithPeer(peer.ip, peer.port)}
                          className="h-8 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12px] font-medium border border-[var(--fei-border-strong)] bg-[var(--fei-bg-surface)] text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] disabled:opacity-50 shrink-0 transition-colors cursor-pointer"
                        >
                          <RefreshCw
                            className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`}
                            strokeWidth={1.8}
                          />
                          <span>{syncing ? '同步中' : '同步'}</span>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>

              {/* Manual IP fallback */}
              <form onSubmit={handleManualConnect} className="space-y-1.5">
                <div className="px-0.5 text-[12px] text-[var(--fei-text-muted)]">
                  若路由器拦截局域网发现，可手动输入对方 IP
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={manualAddress}
                    onChange={(e) => {
                      setManualAddress(e.target.value);
                      if (syncError) setSyncError(null);
                    }}
                    disabled={syncing}
                    placeholder="例如 192.168.1.25"
                    className="flex-1 min-w-0 h-9 px-3 rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[12.5px] font-code text-[var(--fei-text-primary)] placeholder:text-[var(--fei-text-muted)] outline-none focus:border-[var(--fei-border-strong)] disabled:opacity-60"
                  />
                  <button
                    type="submit"
                    disabled={syncing || !manualAddress.trim()}
                    className="h-9 px-3.5 rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[12.5px] font-medium text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] disabled:opacity-45 shrink-0 transition-colors cursor-pointer"
                  >
                    连接同步
                  </button>
                </div>
              </form>

              {/* Sync Progress */}
              {syncing && progress && (
                <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="text-[var(--fei-text-primary)] truncate">
                      {progress.label}
                    </span>
                    <span className="font-code text-[var(--fei-text-muted)] shrink-0">
                      {progressPercent}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-[var(--fei-border)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--fei-text-primary)] transition-all duration-150"
                      style={{ width: `${Math.max(8, progressPercent)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Sync Summary */}
              {!syncing && summary && (
                <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border-strong)] p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--fei-text-primary)]">
                    <Check className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                    <span>已与 {summary.peerName} 完成双向同步</span>
                  </div>
                  {summary.pulledDocs === 0 &&
                  summary.pushedDocs === 0 &&
                  summary.pulledImages === 0 &&
                  summary.pushedImages === 0 ? (
                    <p className="text-[12px] text-[var(--fei-text-muted)]">
                      {summary.catalogUpdated
                        ? '目录与阅读进度已更新，正文与插图均已一致。'
                        : '两台设备的目录、正文与插图均已一致，无需传输。'}
                    </p>
                  ) : (
                    <div className="text-[12px] text-[var(--fei-text-muted)] space-y-0.5">
                      <div>
                        文档正文：接收 {summary.pulledDocs} 篇 · 发送 {summary.pushedDocs} 篇
                      </div>
                      <div>
                        本地插图：接收 {summary.pulledImages} 张 · 发送 {summary.pushedImages} 张
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Error */}
              {!syncing && syncError && (
                <div className="rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--fei-text-primary)]">
                  {syncError}
                </div>
              )}

              {/* Close button */}
              <div className="pt-0.5">
                <button
                  type="button"
                  disabled={syncing}
                  onClick={onClose}
                  className="w-full h-9 rounded-xl bg-[var(--fei-bg-subtle)] text-[13px] font-medium text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] disabled:opacity-50 transition-colors"
                >
                  {syncing ? '正在同步，请勿关闭…' : '完成并关闭'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

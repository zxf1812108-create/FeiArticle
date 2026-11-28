import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { sanitizeLanWebDavPath } from './storage';

export interface LanWebDavRenameRecord {
  from: string;
  to: string;
}

export interface LanWebDavChangeEvent {
  changedAt: number;
  renames?: LanWebDavRenameRecord[];
  touchedPaths?: string[];
}

export interface LanWebDavActivityEvent {
  writeBusy: boolean;
  activeLocks: number;
  lastWriteAt: number;
}

export interface LanWebDavStatus {
  running: boolean;
  url: string;
  ip?: string;
  port?: number;
  basePath?: string;
  writeBusy?: boolean;
  lastWriteAt?: number;
  activeLocks?: number;
}

interface LanWebDavNativePlugin {
  start(options: {
    port?: number;
    basePath: string;
    hiddenPaths?: string[];
  }): Promise<{
    ok: boolean;
    running: boolean;
    url?: string;
    ip?: string;
    port?: number;
    basePath?: string;
    error?: string;
  }>;
  stop(): Promise<{ ok: boolean }>;
  updateHiddenPaths(options: { hiddenPaths: string[] }): Promise<{ ok: boolean }>;
  getStatus(): Promise<{
    running: boolean;
    url?: string;
    ip?: string;
    port?: number;
    basePath?: string;
    writeBusy?: boolean;
    lastWriteAt?: number;
    activeLocks?: number;
  }>;
  addListener(
    eventName: 'webdavChanged',
    listenerFunc: (event: LanWebDavChangeEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'webdavActivity',
    listenerFunc: (event: LanWebDavActivityEvent) => void
  ): Promise<PluginListenerHandle>;
}

const LanWebDavNative = registerPlugin<LanWebDavNativePlugin>('LanWebDavNative');

export const DEFAULT_LAN_WEBDAV_PORT = 8898;
const WRITE_COOLDOWN_MS = 1600;

let cachedWriteBusy = false;
let cachedLastWriteAt = 0;

export function isLanWebDavNativeAvailable(): boolean {
  try {
    return (
      Capacitor.isNativePlatform() &&
      typeof Capacitor.isPluginAvailable === 'function' &&
      Capacitor.isPluginAvailable('LanWebDavNative')
    );
  } catch {
    return false;
  }
}

export function isLanWebDavWriteBusyNow(): boolean {
  if (cachedWriteBusy) return true;
  if (cachedLastWriteAt > 0 && Date.now() - cachedLastWriteAt < WRITE_COOLDOWN_MS) {
    return true;
  }
  return false;
}

export async function startLanWebDavServer(options: {
  basePath: string;
  hiddenPaths?: string[];
  port?: number;
}): Promise<LanWebDavStatus> {
  if (!isLanWebDavNativeAvailable()) {
    throw new Error('局域网网络磁盘仅支持在 Android 手机端使用');
  }
  const cleanPath = sanitizeLanWebDavPath(options.basePath);
  if (!cleanPath) {
    throw new Error('自定义路径不能为空，请输入字母、数字或短横线');
  }

  const res = await LanWebDavNative.start({
    port: options.port ?? DEFAULT_LAN_WEBDAV_PORT,
    basePath: cleanPath,
    hiddenPaths: options.hiddenPaths ?? [],
  });

  if (!res?.ok || !res.running || !res.url) {
    throw new Error(res?.error || '启动局域网网络磁盘失败，请确认手机已连接 Wi-Fi 且已绑定本地目录');
  }

  cachedWriteBusy = false;
  cachedLastWriteAt = 0;

  return {
    running: true,
    url: res.url,
    ip: res.ip,
    port: res.port,
    basePath: res.basePath || cleanPath,
    writeBusy: false,
    lastWriteAt: 0,
    activeLocks: 0,
  };
}

export async function stopLanWebDavServer(): Promise<void> {
  cachedWriteBusy = false;
  cachedLastWriteAt = 0;
  if (!isLanWebDavNativeAvailable()) return;
  try {
    await LanWebDavNative.stop();
  } catch {
    // ignore stop errors on teardown
  }
}

export async function updateLanWebDavHiddenPaths(hiddenPaths: string[]): Promise<void> {
  if (!isLanWebDavNativeAvailable()) return;
  try {
    await LanWebDavNative.updateHiddenPaths({ hiddenPaths });
  } catch {
    // ignore transient native errors
  }
}

export async function getLanWebDavStatus(): Promise<LanWebDavStatus> {
  if (!isLanWebDavNativeAvailable()) {
    return { running: false, url: '' };
  }
  try {
    const res = await LanWebDavNative.getStatus();
    if (typeof res.writeBusy === 'boolean') {
      cachedWriteBusy = res.writeBusy;
    }
    if (typeof res.lastWriteAt === 'number' && res.lastWriteAt > 0) {
      cachedLastWriteAt = Math.max(cachedLastWriteAt, res.lastWriteAt);
    }
    return {
      running: Boolean(res?.running),
      url: res?.url || '',
      ip: res?.ip,
      port: res?.port,
      basePath: res?.basePath,
      writeBusy: Boolean(res?.writeBusy),
      lastWriteAt: res?.lastWriteAt ?? 0,
      activeLocks: res?.activeLocks ?? 0,
    };
  } catch {
    return { running: false, url: '' };
  }
}

export function subscribeLanWebDavChanges(
  enabled: boolean,
  onChange: (event: LanWebDavChangeEvent) => void
): () => void {
  if (!enabled || !isLanWebDavNativeAvailable()) return () => {};

  let disposed = false;
  let changeHandle: PluginListenerHandle | null = null;
  let activityHandle: PluginListenerHandle | null = null;

  void LanWebDavNative.addListener('webdavActivity', (event) => {
    if (disposed) return;
    cachedWriteBusy = Boolean(event?.writeBusy);
    if (typeof event?.lastWriteAt === 'number' && event.lastWriteAt > 0) {
      cachedLastWriteAt = Math.max(cachedLastWriteAt, event.lastWriteAt);
    }
  }).then((h) => {
    if (disposed) {
      void h.remove();
    } else {
      activityHandle = h;
    }
  });

  void LanWebDavNative.addListener('webdavChanged', (event) => {
    if (disposed) return;
    cachedWriteBusy = false;
    onChange({
      changedAt: event?.changedAt || Date.now(),
      renames: Array.isArray(event?.renames) ? event.renames : [],
      touchedPaths: Array.isArray(event?.touchedPaths) ? event.touchedPaths : [],
    });
  }).then((h) => {
    if (disposed) {
      void h.remove();
    } else {
      changeHandle = h;
    }
  });

  return () => {
    disposed = true;
    if (changeHandle) {
      void changeHandle.remove();
      changeHandle = null;
    }
    if (activityHandle) {
      void activityHandle.remove();
      activityHandle = null;
    }
  };
}

export function buildWindowsMountCommand(url: string, driveLetter = 'W:'): string {
  const normalizedUrl = url.replace(/\/+$/, '');
  return `net use ${driveLetter} ${normalizedUrl} /persistent:yes`;
}

export function buildWindowsUnmountCommand(driveLetter = 'W:'): string {
  return `net use ${driveLetter} /delete`;
}

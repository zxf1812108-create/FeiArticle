import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { ArticleDoc, FolderNode } from '../types';
import { PC_DIRECT_HTML } from './pcDirectHtml';

export type LanDirectAction =
  | { type: 'createFolder'; id: string; name: string }
  | { type: 'createDoc'; id: string; folderId: string | null; title: string; content: string }
  | { type: 'saveDoc'; docId: string; title: string; content: string }
  | { type: 'deleteDoc'; docId: string }
  | {
      type: 'importDocs';
      items: Array<{ title: string; content: string; folderId: string | null; format?: 'txt' | 'md' }>;
    }
  | {
      type: 'importEbook';
      fileName: string;
      base64: string;
      folderId: string | null;
    };

interface LanServerNativePlugin {
  start(options: {
    port?: number;
    html: string;
    stateJson: string;
    password?: string;
  }): Promise<{ running: boolean; url: string; ip: string; port: number }>;
  stop(): Promise<{ running: boolean }>;
  updateState(options: { stateJson: string }): Promise<{ ok: boolean }>;
  getStatus(): Promise<{ running: boolean; url: string; ip: string; port: number }>;
  addListener(
    eventName: 'lanAction',
    listenerFunc: (data: { actionJson: string }) => void
  ): Promise<PluginListenerHandle>;
}

const LanServerNative = registerPlugin<LanServerNativePlugin>('LanServerNative');

export interface LanServerStatus {
  running: boolean;
  url: string;
}

function serializeState(folders: FolderNode[], docs: ArticleDoc[]): string {
  return JSON.stringify({
    folders,
    docs: docs.filter((d) => !d.deleted),
  });
}

export async function startLanDirectServer(
  folders: FolderNode[],
  docs: ArticleDoc[],
  password = ''
): Promise<LanServerStatus> {
  const stateJson = serializeState(folders, docs);

  if (Capacitor.isNativePlatform()) {
    if (!Capacitor.isPluginAvailable('LanServerNative')) {
      throw new Error('当前安装包不支持局域网直连，请更新至最新 APK');
    }
    const res = await LanServerNative.start({
      port: 8899,
      html: PC_DIRECT_HTML,
      stateJson,
      password,
    });
    return { running: Boolean(res.running), url: res.url || '' };
  }

  // Web preview mode: enable Express /pc LAN Direct Connect endpoint
  const res = await fetch('/api/lan/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: PC_DIRECT_HTML, stateJson, password }),
  });
  if (!res.ok) {
    throw new Error('启动电脑直连失败');
  }
  const data = (await res.json()) as { running: boolean; url?: string };
  const resolvedUrl = data.url || `${window.location.origin}/pc`;
  return { running: Boolean(data.running), url: resolvedUrl };
}

export async function stopLanDirectServer(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    if (Capacitor.isPluginAvailable('LanServerNative')) {
      await LanServerNative.stop();
    }
    return;
  }
  try {
    await fetch('/api/lan/stop', { method: 'POST' });
  } catch {
    // ignore network errors when stopping
  }
}

export async function pushLanDirectState(
  folders: FolderNode[],
  docs: ArticleDoc[]
): Promise<void> {
  const stateJson = serializeState(folders, docs);

  if (Capacitor.isNativePlatform()) {
    if (Capacitor.isPluginAvailable('LanServerNative')) {
      await LanServerNative.updateState({ stateJson });
    }
    return;
  }

  try {
    await fetch('/api/lan/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateJson }),
    });
  } catch {
    // ignore transient errors
  }
}

export function subscribeLanDirectActions(
  enabled: boolean,
  onAction: (action: LanDirectAction) => void
): () => void {
  if (!enabled) return () => {};

  if (Capacitor.isNativePlatform()) {
    if (!Capacitor.isPluginAvailable('LanServerNative')) return () => {};
    let handle: PluginListenerHandle | null = null;
    let disposed = false;

    LanServerNative.addListener('lanAction', (payload) => {
      try {
        const parsed = JSON.parse(payload.actionJson) as LanDirectAction;
        onAction(parsed);
      } catch {
        // ignore malformed payloads
      }
    }).then((h) => {
      if (disposed) {
        h.remove();
      } else {
        handle = h;
      }
    });

    return () => {
      disposed = true;
      handle?.remove();
    };
  }

  // Web preview polling for PC actions
  let active = true;
  const poll = async () => {
    if (!active) return;
    try {
      const res = await fetch('/api/lan/poll-actions');
      if (res.ok) {
        const data = (await res.json()) as { actions?: LanDirectAction[] };
        if (Array.isArray(data.actions)) {
          for (const act of data.actions) {
            onAction(act);
          }
        }
      }
    } catch {
      // ignore transient errors
    }
  };

  const timer = window.setInterval(poll, 1200);
  return () => {
    active = false;
    window.clearInterval(timer);
  };
}

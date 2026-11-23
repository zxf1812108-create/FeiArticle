import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';

export type VolumeKeyDirection = 'up' | 'down';

export interface NativeInputLongPressEvent {
  source: 'actionMode' | 'touch';
  x?: number;
  y?: number;
}

export interface NativeTouchPoint {
  x: number;
  y: number;
}

interface ReaderNativePlugin {
  setVolumeKeyIntercept(options: { enabled: boolean }): Promise<void>;
  setTouchStateTracking(options: { enabled: boolean }): Promise<{ pressed: boolean }>;
  setInputPasteTracking(options: { enabled: boolean }): Promise<void>;
  readClipboardText(): Promise<{ text: string }>;
  requestMicrophonePermission(): Promise<{ granted: boolean }>;
  addListener(
    eventName: 'volumeKey',
    listenerFunc: (event: { direction: VolumeKeyDirection }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'touchState',
    listenerFunc: (event: { pressed: boolean; x?: number; y?: number }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'touchMove',
    listenerFunc: (event: { x?: number; y?: number }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'inputLongPress',
    listenerFunc: (event: NativeInputLongPressEvent) => void
  ): Promise<PluginListenerHandle>;
}

const ReaderNative = registerPlugin<ReaderNativePlugin>('ReaderNative');

function hasReaderNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ReaderNative');
}

export function hasNativeTouchTracking(): boolean {
  return hasReaderNative();
}

export async function ensureNativeMicrophonePermission(): Promise<boolean> {
  if (!hasReaderNative()) return true;
  try {
    const res = await ReaderNative.requestMicrophonePermission();
    return Boolean(res?.granted);
  } catch {
    return true;
  }
}

export async function readSystemClipboardText(): Promise<{ ok: boolean; text: string }> {
  if (hasReaderNative()) {
    try {
      const res = await ReaderNative.readClipboardText();
      return { ok: true, text: typeof res?.text === 'string' ? res.text : '' };
    } catch {
      // Fall through to web clipboard API if native call unexpectedly fails
    }
  }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      const text = await navigator.clipboard.readText();
      return { ok: true, text: typeof text === 'string' ? text : '' };
    }
  } catch {
    return { ok: false, text: '' };
  }
  return { ok: false, text: '' };
}

export function subscribeNativeInputLongPress(
  onLongPress: (event: NativeInputLongPressEvent) => void
): () => void {
  if (!hasReaderNative()) return () => {};
  let disposed = false;
  let handle: PluginListenerHandle | null = null;

  ReaderNative.setInputPasteTracking({ enabled: true }).catch(() => {});

  ReaderNative.addListener('inputLongPress', (event) => {
    if (disposed || !event) return;
    if (event.source === 'actionMode' || event.source === 'touch') {
      onLongPress(event);
    }
  })
    .then((h) => {
      if (disposed) {
        h.remove().catch(() => {});
      } else {
        handle = h;
      }
    })
    .catch(() => {});

  return () => {
    disposed = true;
    if (handle) {
      handle.remove().catch(() => {});
      handle = null;
    }
    ReaderNative.setInputPasteTracking({ enabled: false }).catch(() => {});
  };
}

export function setNativeVolumeKeyIntercept(enabled: boolean): void {
  if (!hasReaderNative()) return;
  ReaderNative.setVolumeKeyIntercept({ enabled }).catch(() => {});
}

export function subscribeNativeVolumeKeys(
  onDirection: (direction: VolumeKeyDirection) => void
): () => void {
  if (!hasReaderNative()) return () => {};
  let disposed = false;
  let handle: PluginListenerHandle | null = null;

  ReaderNative.addListener('volumeKey', (event) => {
    if (disposed) return;
    if (event?.direction === 'up' || event?.direction === 'down') {
      onDirection(event.direction);
    }
  })
    .then((h) => {
      if (disposed) {
        h.remove().catch(() => {});
      } else {
        handle = h;
      }
    })
    .catch(() => {});

  return () => {
    disposed = true;
    if (handle) {
      handle.remove().catch(() => {});
      handle = null;
    }
  };
}

export function subscribeNativeTouchState(
  onPressedChange: (pressed: boolean, point?: NativeTouchPoint) => void
): () => void {
  if (!hasReaderNative()) return () => {};
  let disposed = false;
  let handle: PluginListenerHandle | null = null;

  ReaderNative.setTouchStateTracking({ enabled: true })
    .then((res) => {
      if (!disposed && typeof res?.pressed === 'boolean') {
        onPressedChange(res.pressed);
      }
    })
    .catch(() => {});

  ReaderNative.addListener('touchState', (event) => {
    if (disposed) return;
    if (typeof event?.pressed === 'boolean') {
      const point =
        typeof event.x === 'number' &&
        Number.isFinite(event.x) &&
        typeof event.y === 'number' &&
        Number.isFinite(event.y)
          ? { x: event.x, y: event.y }
          : undefined;
      onPressedChange(event.pressed, point);
    }
  })
    .then((h) => {
      if (disposed) {
        h.remove().catch(() => {});
      } else {
        handle = h;
      }
    })
    .catch(() => {});

  return () => {
    disposed = true;
    if (handle) {
      handle.remove().catch(() => {});
      handle = null;
    }
    ReaderNative.setTouchStateTracking({ enabled: false }).catch(() => {});
  };
}

export function subscribeNativeTouchMove(
  onMove: (point: NativeTouchPoint) => void
): () => void {
  if (!hasReaderNative()) return () => {};
  let disposed = false;
  let handle: PluginListenerHandle | null = null;

  ReaderNative.addListener('touchMove', (event) => {
    if (disposed) return;
    if (
      typeof event?.x === 'number' &&
      Number.isFinite(event.x) &&
      typeof event?.y === 'number' &&
      Number.isFinite(event.y)
    ) {
      onMove({ x: event.x, y: event.y });
    }
  })
    .then((h) => {
      if (disposed) {
        h.remove().catch(() => {});
      } else {
        handle = h;
      }
    })
    .catch(() => {});

  return () => {
    disposed = true;
    if (handle) {
      handle.remove().catch(() => {});
      handle = null;
    }
  };
}

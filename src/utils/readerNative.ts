import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';

export type VolumeKeyDirection = 'up' | 'down';

interface ReaderNativePlugin {
  setVolumeKeyIntercept(options: { enabled: boolean }): Promise<void>;
  setTouchStateTracking(options: { enabled: boolean }): Promise<{ pressed: boolean }>;
  addListener(
    eventName: 'volumeKey',
    listenerFunc: (event: { direction: VolumeKeyDirection }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'touchState',
    listenerFunc: (event: { pressed: boolean }) => void
  ): Promise<PluginListenerHandle>;
}

const ReaderNative = registerPlugin<ReaderNativePlugin>('ReaderNative');

function hasReaderNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ReaderNative');
}

export function hasNativeTouchTracking(): boolean {
  return hasReaderNative();
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
  onPressedChange: (pressed: boolean) => void
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
      onPressedChange(event.pressed);
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

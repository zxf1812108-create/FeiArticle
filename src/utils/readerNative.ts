import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';

export type VolumeKeyDirection = 'up' | 'down';

interface ReaderNativePlugin {
  setVolumeKeyIntercept(options: { enabled: boolean }): Promise<void>;
  setSuppressSelectionMenu(options: { suppress: boolean }): Promise<void>;
  addListener(
    eventName: 'volumeKey',
    listenerFunc: (event: { direction: VolumeKeyDirection }) => void
  ): Promise<PluginListenerHandle>;
}

const ReaderNative = registerPlugin<ReaderNativePlugin>('ReaderNative');

function hasReaderNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ReaderNative');
}

export function setNativeVolumeKeyIntercept(enabled: boolean): void {
  if (!hasReaderNative()) return;
  ReaderNative.setVolumeKeyIntercept({ enabled }).catch(() => {});
}

export function setNativeSuppressSelectionMenu(suppress: boolean): void {
  if (!hasReaderNative()) return;
  ReaderNative.setSuppressSelectionMenu({ suppress }).catch(() => {});
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

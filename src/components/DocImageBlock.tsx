import React, { useCallback, useEffect, useState } from 'react';
import { ImageOff, RefreshCw } from 'lucide-react';
import { resolveLocalImageUrl } from '../utils/localFs';
import { StorageDirectoryConfig } from '../utils/storage';

export interface DocImagePreviewPayload {
  url: string;
  alt: string;
  src: string;
}

interface DocImageBlockProps {
  src: string;
  alt: string;
  storageDir: StorageDirectoryConfig;
  docFolderName?: string | null;
  topZero?: boolean;
  offsetAttrs: {
    'data-block-idx': number;
    'data-start-offset': number;
    'data-end-offset': number;
  };
  onImageLoaded?: () => void;
  onPreview?: (payload: DocImagePreviewPayload) => void;
}

const GENERIC_ALT_RE = /^(?:image|img|pic|picture|photo|figure|\d+(?:\.[a-z0-9]+)?)$/i;

export const DocImageBlock: React.FC<DocImageBlockProps> = ({
  src,
  alt,
  storageDir,
  docFolderName,
  topZero = false,
  offsetAttrs,
  onImageLoaded,
  onPreview,
}) => {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'missing'>('loading');
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);

  const loadImage = useCallback(
    async (bypassCache: boolean, isCancelled: () => boolean) => {
      setStatus('loading');
      const res = await resolveLocalImageUrl(src, storageDir, {
        docFolderName,
        bypassCache,
      });
      if (isCancelled()) return;
      if (res && res.url) {
        setResolvedUrl(res.url);
        setStatus('loaded');
      } else {
        setResolvedUrl(null);
        setStatus('missing');
        onImageLoaded?.();
      }
    },
    [src, storageDir, docFolderName, onImageLoaded]
  );

  useEffect(() => {
    let cancelled = false;
    void loadImage(retrySeq > 0, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadImage, retrySeq]);

  const showCaption = Boolean(alt && alt.trim() && !GENERIC_ALT_RE.test(alt.trim()));

  return (
    <figure
      {...offsetAttrs}
      data-image-block="true"
      className={`${topZero ? 'mt-0' : 'mt-4'} mb-4 flex flex-col items-center select-none`}
    >
      {status === 'loaded' && resolvedUrl ? (
        <img
          src={resolvedUrl}
          alt={alt || ''}
          loading="lazy"
          decoding="async"
          onLoad={() => onImageLoaded?.()}
          onError={() => {
            setStatus('missing');
            setResolvedUrl(null);
            onImageLoaded?.();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onPreview?.({ url: resolvedUrl, alt, src });
          }}
          className="block max-w-full max-h-[70vh] w-auto h-auto object-contain rounded-lg border border-transparent eink:rounded-none eink:border-[var(--fei-border)] dark:brightness-[0.9] cursor-zoom-in"
        />
      ) : status === 'loading' ? (
        <div className="w-full max-w-[360px] h-[120px] rounded-lg border border-dashed border-[var(--fei-border)] bg-[var(--fei-bg-subtle)] flex items-center justify-center text-[12px] text-[var(--fei-text-muted)]">
          正在加载图片…
        </div>
      ) : (
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-[420px] px-3.5 py-3 rounded-lg border border-dashed border-[var(--fei-border-strong)] bg-[var(--fei-bg-subtle)] flex items-center justify-between gap-3 text-left"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <ImageOff
              className="w-4 h-4 mt-0.5 text-[var(--fei-text-muted)] shrink-0"
              strokeWidth={1.75}
            />
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-[var(--fei-text-primary)] leading-snug">
                本地未找到图片
              </div>
              <div className="text-[11.5px] font-code text-[var(--fei-text-muted)] break-all leading-snug mt-0.5">
                {src}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setRetrySeq((n) => n + 1);
            }}
            aria-label="重新加载图片"
            className="px-2.5 py-1.5 rounded-md border border-[var(--fei-border)] bg-[var(--fei-bg-surface)] text-[12px] text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] inline-flex items-center gap-1 shrink-0 cursor-pointer transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
            <span>重试</span>
          </button>
        </div>
      )}

      {showCaption && (
        <figcaption className="mt-1.5 text-[0.82em] text-[var(--fei-text-muted)] text-center leading-snug max-w-[90%]">
          {alt}
        </figcaption>
      )}
    </figure>
  );
};

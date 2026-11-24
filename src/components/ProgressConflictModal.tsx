import React from 'react';
import { X } from 'lucide-react';
import { ArticleDoc, PendingRemoteProgress } from '../types';
import {
  extractReadAnchorText,
  formatCompactProgressPercent,
  formatProgressTimestamp,
  isRemoteFurtherThanLocal,
  relocateCharOffsetByAnchor,
  resolveComparableProgressPercent,
} from '../utils/progressSync';

interface ProgressConflictModalProps {
  doc: ArticleDoc;
  pending: PendingRemoteProgress;
  queuePosition?: { current: number; total: number };
  onAcceptRemote: () => void;
  onKeepLocal: () => void;
  onDismiss: () => void;
}

export const ProgressConflictModal: React.FC<ProgressConflictModalProps> = ({
  doc,
  pending,
  queuePosition,
  onAcceptRemote,
  onKeepLocal,
  onDismiss,
}) => {
  const contentLen = doc.content ? doc.content.length : 0;
  const localOffset = Math.max(0, Math.round(doc.lastCharOffset ?? 0));
  const rawLocalProgress = doc.readProgress ?? 0;

  const relocatedRemote = doc.content
    ? relocateCharOffsetByAnchor(doc.content, pending.lastCharOffset, pending.anchorText)
    : null;
  const effectiveRemoteOffset = relocatedRemote?.matched
    ? relocatedRemote.offset
    : Math.max(0, Math.round(pending.lastCharOffset));

  const comparableLocal = resolveComparableProgressPercent(
    contentLen,
    localOffset,
    rawLocalProgress,
    true
  );
  const comparableRemote = resolveComparableProgressPercent(
    contentLen,
    effectiveRemoteOffset,
    pending.readProgress,
    true
  );

  const remoteIsFurther = isRemoteFurtherThanLocal(
    localOffset,
    comparableLocal,
    effectiveRemoteOffset,
    comparableRemote
  );
  const localIsFurther = isRemoteFurtherThanLocal(
    effectiveRemoteOffset,
    comparableRemote,
    localOffset,
    comparableLocal
  );

  // Calibrate display percentages on the exact same character scale so "更靠后" can never show a smaller number
  const localProgress =
    contentLen > 0
      ? resolveComparableProgressPercent(contentLen, localOffset, rawLocalProgress, !remoteIsFurther)
      : comparableLocal;
  const effectiveRemoteProgress =
    contentLen > 0
      ? resolveComparableProgressPercent(
          contentLen,
          effectiveRemoteOffset,
          pending.readProgress,
          !localIsFurther
        )
      : comparableRemote;

  const remoteSourceLabel = pending.source === 'wifi' ? '局域网设备进度' : '云端进度';
  const remoteShortLabel = pending.source === 'wifi' ? '对端进度' : '云端进度';

  const remoteSnippet =
    pending.anchorText?.trim() ||
    (doc.content ? extractReadAnchorText(doc.content, effectiveRemoteOffset, 44) : '');
  const localSnippet =
    (doc.content ? extractReadAnchorText(doc.content, localOffset, 44) : '') ||
    doc.readAnchorText?.trim() ||
    '';

  const primaryBtnCls =
    'w-full h-10 rounded-xl bg-[var(--fei-btn-primary-bg)] text-[var(--fei-btn-primary-text)] text-[13px] font-medium hover:opacity-90 active:opacity-80 transition-opacity cursor-pointer select-none';
  const secondaryBtnCls =
    'w-full h-10 rounded-xl bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[13px] text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-selected)] transition-colors cursor-pointer select-none';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="确认阅读进度"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 dark:bg-black/45 eink:bg-transparent p-4 select-none"
      onClick={onDismiss}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[360px] bg-[var(--fei-bg-surface)] border-[1.5px] border-[var(--fei-modal-border)] rounded-2xl shadow-xl eink:shadow-none text-[var(--fei-text-primary)] overflow-hidden"
      >
        <div className="p-4 sm:p-5 space-y-3.5">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-[14.5px] font-medium text-[var(--fei-text-primary)] leading-snug">
                  确认阅读进度
                </h3>
                {queuePosition && queuePosition.total > 1 && (
                  <span className="text-[11.5px] font-code tabular-nums text-[var(--fei-text-muted)] leading-none">
                    {queuePosition.current}/{queuePosition.total}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-[var(--fei-text-muted)] truncate mt-0.5">
                {doc.title}
              </p>
            </div>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="稍后处理"
              className="w-7 h-7 -mr-1 -mt-0.5 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] transition-colors shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Comparison Cards */}
          <div className="space-y-2">
            {/* Remote Progress Card */}
            <div
              className={`rounded-xl border px-3.5 py-2.5 space-y-1.5 ${
                remoteIsFurther
                  ? 'bg-[var(--fei-bg-selected)]/60 border-[var(--fei-border-strong)]'
                  : 'bg-[var(--fei-bg-subtle)] border-[var(--fei-border)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[12.5px] font-medium text-[var(--fei-text-primary)]">
                    {remoteSourceLabel}
                  </span>
                  {remoteIsFurther && (
                    <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--fei-bg-surface)] border border-[var(--fei-border-strong)] text-[var(--fei-text-primary)] leading-none">
                      更靠后
                    </span>
                  )}
                </div>
                <span className="text-[14px] font-medium font-code tabular-nums text-[var(--fei-text-primary)] shrink-0">
                  {formatCompactProgressPercent(effectiveRemoteProgress)}
                </span>
              </div>
              <div className="text-[11px] text-[var(--fei-text-muted)]">
                {formatProgressTimestamp(pending.lastReadAt)}
              </div>
              {remoteSnippet && (
                <p className="text-[12px] leading-relaxed text-[var(--fei-text-muted)] line-clamp-2 border-l-2 border-[var(--fei-border-strong)] pl-2">
                  “{remoteSnippet}…”
                </p>
              )}
            </div>

            {/* Local Progress Card */}
            <div
              className={`rounded-xl border px-3.5 py-2.5 space-y-1.5 ${
                localIsFurther
                  ? 'bg-[var(--fei-bg-selected)]/60 border-[var(--fei-border-strong)]'
                  : 'bg-[var(--fei-bg-subtle)] border-[var(--fei-border)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[12.5px] font-medium text-[var(--fei-text-primary)]">
                    本机当前进度
                  </span>
                  {localIsFurther && (
                    <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--fei-bg-surface)] border border-[var(--fei-border-strong)] text-[var(--fei-text-primary)] leading-none">
                      更靠后
                    </span>
                  )}
                </div>
                <span className="text-[14px] font-medium font-code tabular-nums text-[var(--fei-text-primary)] shrink-0">
                  {formatCompactProgressPercent(localProgress)}
                </span>
              </div>
              <div className="text-[11px] text-[var(--fei-text-muted)]">
                {formatProgressTimestamp(doc.lastReadAt)}
              </div>
              {localSnippet && (
                <p className="text-[12px] leading-relaxed text-[var(--fei-text-muted)] line-clamp-2 border-l-2 border-[var(--fei-border-strong)] pl-2">
                  “{localSnippet}…”
                </p>
              )}
            </div>
          </div>

          {/* Action Buttons: further progress highlighted as primary */}
          <div className="pt-0.5 flex flex-col gap-2">
            {localIsFurther ? (
              <>
                <button type="button" onClick={onKeepLocal} className={primaryBtnCls}>
                  保留本机进度（{formatCompactProgressPercent(localProgress)}）并覆盖
                  {pending.source === 'wifi' ? '对端' : '云端'}
                </button>
                <button type="button" onClick={onAcceptRemote} className={secondaryBtnCls}>
                  采用{remoteShortLabel}（{formatCompactProgressPercent(effectiveRemoteProgress)}）
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onAcceptRemote} className={primaryBtnCls}>
                  采用{remoteShortLabel}（{formatCompactProgressPercent(effectiveRemoteProgress)}）
                </button>
                <button type="button" onClick={onKeepLocal} className={secondaryBtnCls}>
                  保留本机进度（{formatCompactProgressPercent(localProgress)}）并覆盖
                  {pending.source === 'wifi' ? '对端' : '云端'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

import { ArticleDoc, PendingRemoteProgress } from '../types';

export const PROGRESS_DIFF_MIN_CHARS = 320;
export const PROGRESS_DIFF_MIN_PERCENT = 1.5;
const ANCHOR_DEFAULT_LEN = 36;
const ANCHOR_MIN_MATCH_LEN = 6;
const ANCHOR_HALF_LEN = 16;

export interface RemoteProgressInput {
  readProgress?: number;
  lastCharOffset?: number;
  lastScrollTop?: number;
  lastMode?: 'read' | 'edit';
  lastReadAt?: number | null;
  readAnchorText?: string;
  updatedAt: number;
}

export interface RelocatedOffsetResult {
  offset: number;
  progress: number;
  matched: boolean;
}

export interface ProgressReconcileResult {
  action: 'noop' | 'pull' | 'push' | 'prompt';
  /** Re-anchored remote offset in local document coordinates (when local body exists) */
  resolvedRemoteOffset: number;
  resolvedRemoteProgress: number;
  resolvedRemoteReadAt: number;
  resolvedRemoteAnchor?: string;
  pendingRemoteProgress?: PendingRemoteProgress | null;
  /** Suggested updated local sync baseline */
  nextBaseline?: {
    charOffset: number;
    progress: number;
    readAt: number;
  };
  /** Minor sub-threshold timestamp/value alignment when action === 'noop' */
  silentMinorAlign?: 'local-to-remote' | 'remote-to-local';
}

export function roundProgress3(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 1000) / 1000));
}

export function estimateProgressFromOffset(contentLength: number, charOffset: number): number {
  if (contentLength <= 0 || charOffset <= 0) return 0;
  if (charOffset >= contentLength) return 100;
  return roundProgress3((charOffset / contentLength) * 100);
}

/**
 * Calibrate a reading progress percentage onto a single canonical scale (`charOffset / contentLength`)
 * whenever the document content is available locally. This eliminates cross-device / cross-font-size /
 * virtualized-height drift so percentage ordering always strictly matches real character position.
 */
export function resolveComparableProgressPercent(
  contentLength: number,
  charOffset: number,
  rawProgress: number | undefined | null,
  allowHundredSnap = true
): number {
  const safeRaw = roundProgress3(rawProgress);
  if (contentLength <= 0) return safeRaw;
  const safeOffset = Math.max(0, Math.round(charOffset || 0));
  if (safeOffset <= 0) {
    return safeRaw > 0.05 ? safeRaw : 0;
  }
  if (safeOffset >= contentLength) return 100;
  if (allowHundredSnap && safeRaw >= 99.999) return 100;
  return estimateProgressFromOffset(contentLength, safeOffset);
}

/**
 * Extract a short, clean plaintext reading anchor (~36 chars) starting near `charOffset`.
 * Used both to re-locate the exact reading sentence after external edits and to preview
 * reading locations inside the progress confirmation modal.
 */
export function extractReadAnchorText(
  content: string,
  charOffset: number,
  maxLen: number = ANCHOR_DEFAULT_LEN
): string {
  if (!content) return '';
  const safeOffset = Math.max(0, Math.min(content.length, Math.round(charOffset || 0)));
  // Grab a generous forward window (or slightly backward near EOF)
  const windowStart =
    safeOffset >= content.length - 12 ? Math.max(0, content.length - 140) : safeOffset;
  const rawSlice = content.slice(windowStart, Math.min(content.length, windowStart + 220));
  const cleaned = rawSlice
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*`~\-_=+\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.slice(0, maxLen).trim();
}

function findClosestOccurrence(haystack: string, needle: string, targetIndex: number): number {
  if (!needle) return -1;
  let bestIdx = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, pos);
    if (found === -1) break;
    const dist = Math.abs(found - targetIndex);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = found;
    }
    pos = found + 1;
  }
  return bestIdx;
}

function searchNormalizedWindow(
  content: string,
  windowStart: number,
  windowEnd: number,
  normNeedle: string,
  targetRawOffset: number
): number {
  if (!normNeedle) return -1;
  const normChars: string[] = [];
  const rawIndexMap: number[] = [];
  let prevWasSpace = true;

  for (let i = windowStart; i < windowEnd; i++) {
    const ch = content[i];
    if (/\s/.test(ch)) {
      if (!prevWasSpace) {
        normChars.push(' ');
        rawIndexMap.push(i);
        prevWasSpace = true;
      }
    } else {
      normChars.push(ch);
      rawIndexMap.push(i);
      prevWasSpace = false;
    }
  }

  const normText = normChars.join('');
  if (!normText || normText.length < normNeedle.length) return -1;

  let bestRawIdx = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  let pos = 0;
  while (pos <= normText.length - normNeedle.length) {
    const found = normText.indexOf(normNeedle, pos);
    if (found === -1) break;
    const rawIdx = rawIndexMap[found] ?? windowStart;
    const dist = Math.abs(rawIdx - targetRawOffset);
    if (dist < bestDist) {
      bestDist = dist;
      bestRawIdx = rawIdx;
    }
    pos = found + 1;
  }
  return bestRawIdx;
}

/**
 * Re-locate a saved reading offset inside modified (or cross-device) document content using
 * the stored `anchorText`. Prefers the match closest to `fallbackCharOffset`, falling back
 * to whitespace-normalized search and half-anchor fuzzy matching if a few characters changed.
 */
export function relocateCharOffsetByAnchor(
  content: string,
  fallbackCharOffset: number,
  anchorText?: string
): RelocatedOffsetResult {
  const len = content.length;
  const clampedFallback = Math.max(0, Math.min(len, Math.round(fallbackCharOffset || 0)));
  if (len === 0) {
    return { offset: 0, progress: 0, matched: false };
  }

  const normAnchor = (anchorText || '').replace(/\s+/g, ' ').trim();
  if (normAnchor.length < ANCHOR_MIN_MATCH_LEN) {
    return {
      offset: clampedFallback,
      progress: estimateProgressFromOffset(len, clampedFallback),
      matched: false,
    };
  }

  // 1. Exact substring match across full content (very fast native C++ indexOf)
  const exactIdx = findClosestOccurrence(content, normAnchor, clampedFallback);
  if (exactIdx !== -1) {
    return {
      offset: exactIdx,
      progress: estimateProgressFromOffset(len, exactIdx),
      matched: true,
    };
  }

  // 2. Whitespace-normalized match: try local ±60k window first, then full doc
  const localStart = Math.max(0, clampedFallback - 60_000);
  const localEnd = Math.min(len, clampedFallback + 60_000);
  let normIdx = searchNormalizedWindow(content, localStart, localEnd, normAnchor, clampedFallback);
  if (normIdx === -1 && (localStart > 0 || localEnd < len)) {
    normIdx = searchNormalizedWindow(content, 0, len, normAnchor, clampedFallback);
  }
  if (normIdx !== -1) {
    return {
      offset: normIdx,
      progress: estimateProgressFromOffset(len, normIdx),
      matched: true,
    };
  }

  // 3. Partial-sentence fallback (in case a few words inside the anchored line were edited)
  if (normAnchor.length >= ANCHOR_HALF_LEN + 4) {
    const head = normAnchor.slice(0, ANCHOR_HALF_LEN).trim();
    const tail = normAnchor.slice(-ANCHOR_HALF_LEN).trim();

    if (head.length >= ANCHOR_MIN_MATCH_LEN) {
      const headIdx =
        findClosestOccurrence(content, head, clampedFallback) !== -1
          ? findClosestOccurrence(content, head, clampedFallback)
          : searchNormalizedWindow(content, localStart, localEnd, head, clampedFallback);
      if (headIdx !== -1) {
        return {
          offset: headIdx,
          progress: estimateProgressFromOffset(len, headIdx),
          matched: true,
        };
      }
    }

    if (tail.length >= ANCHOR_MIN_MATCH_LEN) {
      const tailRaw =
        findClosestOccurrence(content, tail, clampedFallback) !== -1
          ? findClosestOccurrence(content, tail, clampedFallback)
          : searchNormalizedWindow(content, localStart, localEnd, tail, clampedFallback);
      if (tailRaw !== -1) {
        const estimatedStart = Math.max(0, tailRaw - (normAnchor.length - tail.length));
        return {
          offset: estimatedStart,
          progress: estimateProgressFromOffset(len, estimatedStart),
          matched: true,
        };
      }
    }
  }

  return {
    offset: clampedFallback,
    progress: estimateProgressFromOffset(len, clampedFallback),
    matched: false,
  };
}

export function getEffectiveProgressTimestamp(
  lastReadAt: number | null | undefined,
  readProgress: number | undefined,
  lastCharOffset: number | undefined,
  fallbackUpdatedAt: number
): number {
  if (typeof lastReadAt === 'number' && Number.isFinite(lastReadAt) && lastReadAt > 0) {
    return lastReadAt;
  }
  if ((lastCharOffset ?? 0) > 0 || (readProgress ?? 0) > 0) {
    return fallbackUpdatedAt;
  }
  return 0;
}

export function isProgressMeaningfullyDifferent(
  aOffset: number,
  aProgress: number,
  bOffset: number,
  bProgress: number
): boolean {
  const charDiff = Math.abs(Math.round(aOffset) - Math.round(bOffset));
  const pctDiff = Math.abs(roundProgress3(aProgress) - roundProgress3(bProgress));
  return charDiff >= PROGRESS_DIFF_MIN_CHARS || pctDiff >= PROGRESS_DIFF_MIN_PERCENT;
}

export function isRemoteFurtherThanLocal(
  localOffset: number,
  localProgress: number,
  remoteOffset: number,
  remoteProgress: number
): boolean {
  const charDelta = Math.round(remoteOffset) - Math.round(localOffset);
  const pctDelta = roundProgress3(remoteProgress) - roundProgress3(localProgress);
  if (Math.abs(charDelta) >= PROGRESS_DIFF_MIN_CHARS) {
    return charDelta > 0;
  }
  return pctDelta > 0;
}

function hasReadableProgress(offset: number, progress: number): boolean {
  return Math.round(offset) > 0 || roundProgress3(progress) > 0.05;
}

/**
 * Unified Plan-B + Last-Synced-Baseline reading progress reconciler shared by both
 * Jianguoyun WebDAV sync and automatic Directory-Mode Wi-Fi sync.
 *
 * Guarantees:
 * - Single-device forward/backward reading (when remote === baseline) silently pushes with zero popups.
 * - Unread local docs (0%) silently adopt remote progress with zero popups.
 * - Offline flip on Device B (local changed AND remote changed from baseline, OR remote is further)
 *   NEVER overwrites the remote's further progress; instead stashes `pendingRemoteProgress` so the
 *   user confirms on book open (or immediately if the book is currently open).
 * - Plan B: Whenever a meaningful remote change would overwrite existing local progress (> 0%),
 *   stash `pendingRemoteProgress` for explicit user choice instead of silently overwriting.
 */
export function reconcileReadingProgress(
  localDoc: ArticleDoc,
  remote: RemoteProgressInput,
  source: 'cloud' | 'wifi'
): ProgressReconcileResult {
  const contentLen = localDoc.content ? localDoc.content.length : 0;
  const localOffset = Math.max(0, Math.round(localDoc.lastCharOffset ?? 0));
  const rawLocalProgress = roundProgress3(localDoc.readProgress);
  const localProgress =
    contentLen > 0
      ? resolveComparableProgressPercent(contentLen, localOffset, rawLocalProgress, true)
      : rawLocalProgress;
  const localTs = getEffectiveProgressTimestamp(
    localDoc.lastReadAt,
    localDoc.readProgress,
    localDoc.lastCharOffset,
    localDoc.updatedAt
  );

  const rawRemoteOffset = Math.max(0, Math.round(remote.lastCharOffset ?? 0));
  const rawRemoteProgress = roundProgress3(remote.readProgress);
  const remoteTs = getEffectiveProgressTimestamp(
    remote.lastReadAt,
    remote.readProgress,
    remote.lastCharOffset,
    remote.updatedAt
  );

  // Re-anchor remote position onto local body if available (handles external edits & cross-device diffs)
  let resolvedRemoteOffset = rawRemoteOffset;
  let resolvedRemoteProgress = rawRemoteProgress;
  if (localDoc.content && remote.readAnchorText) {
    const relocated = relocateCharOffsetByAnchor(
      localDoc.content,
      rawRemoteOffset,
      remote.readAnchorText
    );
    if (relocated.matched) {
      resolvedRemoteOffset = relocated.offset;
    }
  }
  if (contentLen > 0) {
    resolvedRemoteProgress = resolveComparableProgressPercent(
      contentLen,
      resolvedRemoteOffset,
      rawRemoteProgress,
      true
    );
  }

  const resolvedRemoteAnchor =
    remote.readAnchorText ||
    (localDoc.content && !localDoc.encrypted
      ? extractReadAnchorText(localDoc.content, resolvedRemoteOffset)
      : undefined);

  const meaningfulDiff = isProgressMeaningfullyDifferent(
    localOffset,
    localProgress,
    resolvedRemoteOffset,
    resolvedRemoteProgress
  );

  // Case 0: Effectively same reading position (within cross-device rounding tolerance)
  if (!meaningfulDiff) {
    const agreedTs = Math.max(localTs, remoteTs);
    const exactDiff =
      Math.round(localProgress * 1000) !== Math.round(resolvedRemoteProgress * 1000) ||
      localOffset !== rawRemoteOffset;
    return {
      action: 'noop',
      resolvedRemoteOffset,
      resolvedRemoteProgress,
      resolvedRemoteReadAt: remoteTs,
      resolvedRemoteAnchor,
      pendingRemoteProgress: null,
      nextBaseline: {
        charOffset: rawRemoteOffset > 0 || localOffset === 0 ? rawRemoteOffset : localOffset,
        progress:
          resolvedRemoteProgress > 0 || localProgress === 0
            ? resolvedRemoteProgress
            : localProgress,
        readAt: agreedTs,
      },
      silentMinorAlign: exactDiff
        ? localTs > remoteTs
          ? 'local-to-remote'
          : remoteTs > localTs
            ? 'remote-to-local'
            : undefined
        : undefined,
    };
  }

  const localHasProg = hasReadableProgress(localOffset, localProgress);
  const remoteHasProg = hasReadableProgress(resolvedRemoteOffset, resolvedRemoteProgress);

  const hasBaseline =
    typeof localDoc.lastSyncedCharOffset === 'number' ||
    typeof localDoc.lastSyncedProgress === 'number';
  const baselineOffset = Math.max(0, Math.round(localDoc.lastSyncedCharOffset ?? 0));
  const rawBaselineProgress = roundProgress3(localDoc.lastSyncedProgress);
  const baselineProgress =
    contentLen > 0
      ? resolveComparableProgressPercent(contentLen, baselineOffset, rawBaselineProgress, true)
      : rawBaselineProgress;
  const comparableRawRemoteProgress =
    contentLen > 0
      ? resolveComparableProgressPercent(contentLen, rawRemoteOffset, rawRemoteProgress, true)
      : rawRemoteProgress;
  const remoteChangedFromBaseline = hasBaseline
    ? isProgressMeaningfullyDifferent(
        rawRemoteOffset,
        comparableRawRemoteProgress,
        baselineOffset,
        baselineProgress
      )
    : true;

  // Case 1: Local is unread (0%) while remote has progress
  if (!localHasProg && remoteHasProg) {
    // Only push 0% if user intentionally reset a previously synced doc while remote stayed at baseline
    if (hasBaseline && !remoteChangedFromBaseline && localTs > remoteTs) {
      return {
        action: 'push',
        resolvedRemoteOffset,
        resolvedRemoteProgress,
        resolvedRemoteReadAt: remoteTs,
        resolvedRemoteAnchor,
        pendingRemoteProgress: null,
        nextBaseline: {
          charOffset: localOffset,
          progress: localProgress,
          readAt: localTs,
        },
      };
    }
    return {
      action: 'pull',
      resolvedRemoteOffset,
      resolvedRemoteProgress,
      resolvedRemoteReadAt: remoteTs,
      resolvedRemoteAnchor,
      pendingRemoteProgress: null,
      nextBaseline: {
        charOffset: resolvedRemoteOffset,
        progress: resolvedRemoteProgress,
        readAt: remoteTs,
      },
    };
  }

  // Case 2: Remote is 0% while local has progress
  if (localHasProg && !remoteHasProg) {
    // If remote was explicitly reset from a synced non-zero baseline by a newer action, ask under Plan B
    if (hasBaseline && remoteChangedFromBaseline && remoteTs > localTs) {
      return {
        action: 'prompt',
        resolvedRemoteOffset,
        resolvedRemoteProgress,
        resolvedRemoteReadAt: remoteTs,
        resolvedRemoteAnchor,
        pendingRemoteProgress: {
          readProgress: resolvedRemoteProgress,
          lastCharOffset: resolvedRemoteOffset,
          lastScrollTop: Math.max(0, Math.round(remote.lastScrollTop ?? 0)),
          lastMode: remote.lastMode ?? 'read',
          lastReadAt: remoteTs,
          anchorText: resolvedRemoteAnchor,
          source,
          detectedAt: Date.now(),
        },
      };
    }
    return {
      action: 'push',
      resolvedRemoteOffset,
      resolvedRemoteProgress,
      resolvedRemoteReadAt: remoteTs,
      resolvedRemoteAnchor,
      pendingRemoteProgress: null,
      nextBaseline: {
        charOffset: localOffset,
        progress: localProgress,
        readAt: localTs,
      },
    };
  }

  // Case 3: Normal single-device reading — remote is untouched since our last sync, and local is newer/same
  if (hasBaseline && !remoteChangedFromBaseline && localTs >= remoteTs) {
    return {
      action: 'push',
      resolvedRemoteOffset,
      resolvedRemoteProgress,
      resolvedRemoteReadAt: remoteTs,
      resolvedRemoteAnchor,
      pendingRemoteProgress: null,
      nextBaseline: {
        charOffset: localOffset,
        progress: localProgress,
        readAt: localTs,
      },
    };
  }

  // Case 3b: First sync after upgrading (no baseline yet): only silent-push if local is BOTH strictly newer AND further
  if (
    !hasBaseline &&
    localTs > remoteTs &&
    !isRemoteFurtherThanLocal(localOffset, localProgress, resolvedRemoteOffset, resolvedRemoteProgress)
  ) {
    return {
      action: 'push',
      resolvedRemoteOffset,
      resolvedRemoteProgress,
      resolvedRemoteReadAt: remoteTs,
      resolvedRemoteAnchor,
      pendingRemoteProgress: null,
      nextBaseline: {
        charOffset: localOffset,
        progress: localProgress,
        readAt: localTs,
      },
    };
  }

  // Case 4 (Plan B + Offline-Flip Guard):
  // Either remote changed since our baseline, or remote is further, or remote is newer over existing local progress.
  // NEVER silently overwrite either side — stash pendingRemoteProgress for user confirmation.
  return {
    action: 'prompt',
    resolvedRemoteOffset,
    resolvedRemoteProgress,
    resolvedRemoteReadAt: remoteTs,
    resolvedRemoteAnchor,
    pendingRemoteProgress: {
      readProgress: resolvedRemoteProgress,
      lastCharOffset: resolvedRemoteOffset,
      lastScrollTop: Math.max(0, Math.round(remote.lastScrollTop ?? 0)),
      lastMode: remote.lastMode ?? 'read',
      lastReadAt: remoteTs,
      anchorText: resolvedRemoteAnchor,
      source,
      detectedAt: Date.now(),
    },
  };
}

export function formatCompactProgressPercent(progress: number): string {
  const clamped = roundProgress3(progress);
  if (clamped <= 0) return '0%';
  if (clamped >= 100) return '100%';
  // Keep up to 2 decimals without trailing zeros so 25.0 -> 25%, 25.10 -> 25.1%, 25.12 -> 25.12%
  const fixed2 = clamped.toFixed(2).replace(/\.?0+$/, '');
  return `${fixed2}%`;
}

export function formatProgressTimestamp(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '时间未知';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfTarget) / 86_400_000);

  if (diffDays === 0) return `今天 ${hhmm}`;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

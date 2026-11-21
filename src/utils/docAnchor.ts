export interface NormalizedTextMap {
  norm: string;
  rawIndices: number[];
}

export interface DomNormalizedMap {
  norm: string;
  points: Array<{ node: Text; offset: number }>;
}

function isIgnorableWs(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * Build a normalized character string paired with exact source character offsets.
 * When `stripMarkdown` is true, block-level prefixes (#, >, -, 1., code fences,
 * horizontal rules, table pipes/delimiters) and inline markers (` * _ ~) are skipped
 * so raw Markdown aligns 1:1 with rendered DOM text.
 */
export function buildNormalizedTextMap(
  raw: string,
  stripMarkdown: boolean,
  startAtLineStart = true
): NormalizedTextMap {
  const chars: string[] = [];
  const rawIndices: number[] = [];
  const len = raw.length;
  let i = 0;
  let atLineStart = startAtLineStart;
  let inCodeFence = false;

  while (i < len) {
    if (stripMarkdown && atLineStart) {
      while (i < len && (raw[i] === ' ' || raw[i] === '\t')) {
        i++;
      }
      if (i >= len) break;

      const lineEndIdx = raw.indexOf('\n', i);
      const lineEnd = lineEndIdx === -1 ? len : lineEndIdx;
      const lineSlice = raw.slice(i, lineEnd).replace(/\r$/, '');

      // Skip fenced code delimiters (```lang / ```)
      if (/^```/.test(lineSlice)) {
        inCodeFence = !inCodeFence;
        i = lineEndIdx === -1 ? len : lineEndIdx + 1;
        atLineStart = true;
        continue;
      }

      if (!inCodeFence) {
        // Skip horizontal rule / Setext underline lines (---, ***, ___, ===)
        if (/^(?:---+|\*\*\*+|___+|===+)\s*$/.test(lineSlice)) {
          i = lineEndIdx === -1 ? len : lineEndIdx + 1;
          atLineStart = true;
          continue;
        }

        // Skip Markdown table delimiter rows (| --- | :---: |)
        if (lineSlice.includes('|') && /^\|?[\s:|-]+\|?$/.test(lineSlice) && lineSlice.includes('-')) {
          i = lineEndIdx === -1 ? len : lineEndIdx + 1;
          atLineStart = true;
          continue;
        }

        // Skip Markdown heading / blockquote / list prefixes
        const prefixMatch = lineSlice.match(/^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/);
        if (prefixMatch) {
          i += prefixMatch[0].length;
        }
      }

      atLineStart = false;
      continue;
    }

    const ch = raw[i];
    if (ch === '\n') {
      atLineStart = true;
      i++;
      continue;
    }

    atLineStart = false;

    if (isIgnorableWs(ch)) {
      i++;
      continue;
    }

    if (stripMarkdown && !inCodeFence && (ch === '`' || ch === '*' || ch === '_' || ch === '~' || ch === '|')) {
      i++;
      continue;
    }

    chars.push(ch.toLowerCase());
    rawIndices.push(i);
    i++;
  }

  return { norm: chars.join(''), rawIndices };
}

export function normalizeTextForAnchor(text: string, stripMarkdown: boolean): string {
  return buildNormalizedTextMap(text, stripMarkdown).norm;
}

function findClosestOccurrence(
  haystack: string,
  needle: string,
  totalPositions: number,
  getRatio: (matchIdx: number) => number,
  fallbackRatio: number
): number | null {
  if (!needle || !haystack) return null;
  let searchFrom = 0;
  let bestIdx: number | null = null;
  let bestDist = Infinity;

  while (searchFrom <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, searchFrom);
    if (found === -1) break;
    const ratio = totalPositions > 0 ? getRatio(found) : 0;
    const dist = Math.abs(ratio - fallbackRatio);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = found;
    }
    searchFrom = found + 1;
  }

  return bestIdx;
}

function buildProbes(targetNorm: string): string[] {
  const probeLengths = [36, 24, 14, 8];
  const probes: string[] = [];
  for (const len of probeLengths) {
    const slice = targetNorm.slice(0, len);
    if (slice.length >= 4 && !probes.includes(slice)) {
      probes.push(slice);
    }
  }
  if (probes.length === 0 && targetNorm.length > 0) {
    probes.push(targetNorm);
  }
  return probes;
}

export function findCharIndexForNormalizedAnchor(
  rawContent: string,
  targetNorm: string,
  fallbackRatio: number
): number {
  if (!rawContent) return 0;
  if (!targetNorm) {
    return Math.round(fallbackRatio * rawContent.length);
  }

  const map = buildNormalizedTextMap(rawContent, true);
  if (!map.norm) {
    return Math.round(fallbackRatio * rawContent.length);
  }

  for (const probe of buildProbes(targetNorm)) {
    const idx = findClosestOccurrence(
      map.norm,
      probe,
      map.rawIndices.length,
      (m) => map.rawIndices[m] / Math.max(1, rawContent.length),
      fallbackRatio
    );
    if (idx !== null) {
      return map.rawIndices[idx];
    }
  }

  return Math.round(fallbackRatio * rawContent.length);
}

export function collectNormalizedDomMap(rootEl: HTMLElement): DomNormalizedMap {
  const chars: string[] = [];
  const points: Array<{ node: Text; offset: number }> = [];
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);

  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const val = textNode.nodeValue || '';
    for (let i = 0; i < val.length; i++) {
      const ch = val[i];
      if (!isIgnorableWs(ch)) {
        chars.push(ch.toLowerCase());
        points.push({ node: textNode, offset: i });
      }
    }
    current = walker.nextNode();
  }

  return { norm: chars.join(''), points };
}

export function findScrollTopForNormalizedAnchor(
  scrollEl: HTMLElement,
  rootEl: HTMLElement,
  targetNorm: string,
  fallbackRatio: number
): number | null {
  if (!targetNorm) return null;

  const domMap = collectNormalizedDomMap(rootEl);
  if (!domMap.norm || domMap.points.length === 0) return null;

  const containerRect = scrollEl.getBoundingClientRect();
  const baseOffset = scrollEl.scrollTop - containerRect.top;
  const rootRect = rootEl.getBoundingClientRect();
  const rootTopScroll = rootRect.top + baseOffset;
  const rootHeight = Math.max(1, rootEl.scrollHeight || rootRect.height);
  const range = document.createRange();

  const measurePointTop = (pointIdx: number): number | null => {
    const pt = domMap.points[pointIdx];
    if (!pt) return null;
    const maxLen = pt.node.nodeValue?.length ?? 0;
    if (pt.offset >= maxLen) return null;
    range.setStart(pt.node, pt.offset);
    range.setEnd(pt.node, Math.min(maxLen, pt.offset + 1));
    const rects = range.getClientRects();
    const r = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
    if (!r || r.height <= 0) return null;
    return r.top + baseOffset;
  };

  for (const probe of buildProbes(targetNorm)) {
    let searchFrom = 0;
    let bestTop: number | null = null;
    let bestDist = Infinity;

    while (searchFrom <= domMap.norm.length - probe.length) {
      const found = domMap.norm.indexOf(probe, searchFrom);
      if (found === -1) break;
      const top = measurePointTop(found);
      if (top !== null) {
        const relRatio = Math.min(1, Math.max(0, (top - rootTopScroll) / rootHeight));
        const dist = Math.abs(relRatio - fallbackRatio);
        if (dist < bestDist) {
          bestDist = dist;
          bestTop = top;
        }
      }
      searchFrom = found + 1;
    }

    if (bestTop !== null) {
      return bestTop;
    }
  }

  return null;
}

function getCharVerticalCenter(range: Range, node: Text, index: number): number | null {
  const len = node.nodeValue?.length ?? 0;
  if (index < 0 || index >= len) return null;
  range.setStart(node, index);
  range.setEnd(node, index + 1);
  const rects = range.getClientRects();
  const r = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
  if (!r || r.height <= 0) return null;
  return (r.top + r.bottom) / 2;
}

/**
 * Extract the exact characters rendered inside a specific visual line vertical band
 * [bandTopScrollY, bandBottomScrollY] in scroll-content coordinates.
 */
export function extractExactVisualLineText(
  scrollEl: HTMLElement,
  rootEl: HTMLElement,
  bandTopScrollY: number,
  bandBottomScrollY: number
): string {
  const containerRect = scrollEl.getBoundingClientRect();
  const baseOffset = scrollEl.scrollTop - containerRect.top;
  const bandTopClient = bandTopScrollY - baseOffset;
  const bandBottomClient = bandBottomScrollY - baseOffset;

  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const parts: string[] = [];

  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const val = textNode.nodeValue || '';
    if (val.trim().length > 0) {
      range.selectNodeContents(textNode);
      const nodeBox = range.getBoundingClientRect();
      if (
        nodeBox.height > 0 &&
        nodeBox.bottom >= bandTopClient - 2 &&
        nodeBox.top <= bandBottomClient + 2
      ) {
        const rects = range.getClientRects();
        if (rects.length <= 1) {
          const r = rects[0] || nodeBox;
          const mid = (r.top + r.bottom) / 2;
          if (mid >= bandTopClient - 2 && mid <= bandBottomClient + 2) {
            parts.push(val);
          }
        } else {
          const len = val.length;
          let lo = 0;
          let hi = len - 1;
          let startIdx = len;

          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            let y = getCharVerticalCenter(range, textNode, mid);
            if (y === null) {
              let probe = mid + 1;
              while (probe < len && y === null) {
                y = getCharVerticalCenter(range, textNode, probe++);
              }
              if (y === null) {
                probe = mid - 1;
                while (probe >= 0 && y === null) {
                  y = getCharVerticalCenter(range, textNode, probe--);
                }
              }
            }
            if (y === null) break;
            if (y >= bandTopClient - 2) {
              startIdx = mid;
              hi = mid - 1;
            } else {
              lo = mid + 1;
            }
          }

          if (startIdx < len) {
            lo = startIdx;
            hi = len - 1;
            let endIdx = startIdx;

            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              let y = getCharVerticalCenter(range, textNode, mid);
              if (y === null) {
                let probe = mid - 1;
                while (probe >= startIdx && y === null) {
                  y = getCharVerticalCenter(range, textNode, probe--);
                }
                if (y === null) {
                  probe = mid + 1;
                  while (probe < len && y === null) {
                    y = getCharVerticalCenter(range, textNode, probe++);
                  }
                }
              }
              if (y === null) break;
              if (y <= bandBottomClient + 2) {
                endIdx = mid + 1;
                lo = mid + 1;
              } else {
                hi = mid - 1;
              }
            }

            if (endIdx > startIdx) {
              parts.push(val.slice(startIdx, endIdx));
            }
          }
        }
      }
    }
    current = walker.nextNode();
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic Read -> Source mapping: locate the DOM block element at the top of the viewport
 * via [data-start-offset]/[data-end-offset] and refine to the exact character offset inside that block.
 */
export function resolveReadViewportCharOffset(
  scrollEl: HTMLElement,
  articleEl: HTMLElement,
  rawContent: string,
  topBandY: number,
  bottomBandY: number,
  lineExactText: string
): number {
  if (!rawContent) return 0;

  const containerRect = scrollEl.getBoundingClientRect();
  const baseOffset = scrollEl.scrollTop - containerRect.top;
  const bandMidY = (topBandY + bottomBandY) / 2;

  const blockEls = articleEl.querySelectorAll<HTMLElement>('[data-start-offset][data-end-offset]');
  let targetBlock: { el: HTMLElement; start: number; end: number; top: number; bottom: number } | null = null;

  for (let i = 0; i < blockEls.length; i++) {
    const el = blockEls[i];
    const rect = el.getBoundingClientRect();
    const top = rect.top + baseOffset;
    const bottom = rect.bottom + baseOffset;
    const start = Number(el.getAttribute('data-start-offset'));
    const end = Number(el.getAttribute('data-end-offset'));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    if (bottom >= bandMidY - 2 && top <= bandMidY + 4) {
      targetBlock = { el, start, end, top, bottom };
      break;
    }
    if (!targetBlock && bottom >= topBandY - 2) {
      targetBlock = { el, start, end, top, bottom };
      break;
    }
  }

  const targetNorm = normalizeTextForAnchor(lineExactText, false);

  if (targetBlock) {
    const blockRaw = rawContent.slice(targetBlock.start, targetBlock.end);
    const blockHeight = Math.max(1, targetBlock.bottom - targetBlock.top);
    const intraRatio = Math.min(1, Math.max(0, (topBandY - targetBlock.top) / blockHeight));

    if (intraRatio <= 0.04) {
      return targetBlock.start;
    }

    if (targetNorm) {
      const localMap = buildNormalizedTextMap(blockRaw, true, true);
      if (localMap.norm) {
        for (const probe of buildProbes(targetNorm)) {
          const idx = findClosestOccurrence(
            localMap.norm,
            probe,
            localMap.rawIndices.length,
            (m) => localMap.rawIndices[m] / Math.max(1, blockRaw.length),
            intraRatio
          );
          if (idx !== null) {
            return targetBlock.start + localMap.rawIndices[idx];
          }
        }
      }
    }

    return Math.min(
      rawContent.length,
      targetBlock.start + Math.round(intraRatio * Math.max(0, targetBlock.end - targetBlock.start))
    );
  }

  const articleRect = articleEl.getBoundingClientRect();
  const articleTop = articleRect.top + baseOffset;
  const articleHeight = Math.max(1, articleEl.scrollHeight || articleRect.height);
  const docRatio = Math.min(1, Math.max(0, (topBandY - articleTop) / articleHeight));
  return findCharIndexForNormalizedAnchor(rawContent, targetNorm, docRatio);
}

/**
 * Deterministic Source -> Read mapping: given a canonical character offset in `rawContent`,
 * locate the owning [data-start-offset]/[data-end-offset] DOM block and return the exact
 * scroll-content top Y of the rendered character line inside that block.
 */
export function findScrollTopForCharOffset(
  scrollEl: HTMLElement,
  articleEl: HTMLElement,
  rawContent: string,
  charOffset: number
): number | null {
  if (!rawContent || charOffset <= 0) return 0;

  const safeOffset = Math.min(rawContent.length, Math.max(0, charOffset));
  const containerRect = scrollEl.getBoundingClientRect();
  const baseOffset = scrollEl.scrollTop - containerRect.top;

  const blockEls = articleEl.querySelectorAll<HTMLElement>('[data-start-offset][data-end-offset]');
  let matchedBlock: { el: HTMLElement; start: number; end: number } | null = null;

  for (let i = 0; i < blockEls.length; i++) {
    const el = blockEls[i];
    const start = Number(el.getAttribute('data-start-offset'));
    const end = Number(el.getAttribute('data-end-offset'));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    if (safeOffset >= start && safeOffset <= end) {
      matchedBlock = { el, start, end };
      break;
    }
    if (start > safeOffset) {
      matchedBlock = { el, start, end };
      break;
    }
  }

  if (!matchedBlock && blockEls.length > 0) {
    const last = blockEls[blockEls.length - 1];
    const start = Number(last.getAttribute('data-start-offset'));
    const end = Number(last.getAttribute('data-end-offset'));
    if (Number.isFinite(start) && Number.isFinite(end)) {
      matchedBlock = { el: last, start, end };
    }
  }

  if (matchedBlock) {
    const blockRect = matchedBlock.el.getBoundingClientRect();
    const blockTop = blockRect.top + baseOffset;

    // If charOffset is at or before the start of this block, align directly to its first visual line
    if (safeOffset <= matchedBlock.start + 1) {
      const firstTextTop = findFirstTextTopInElement(scrollEl, matchedBlock.el);
      return firstTextTop !== null ? firstTextTop : blockTop;
    }

    const blockRaw = rawContent.slice(matchedBlock.start, matchedBlock.end);
    const localOffset = Math.min(blockRaw.length, Math.max(0, safeOffset - matchedBlock.start));
    const localMap = buildNormalizedTextMap(blockRaw, true, true);

    if (localMap.norm && localMap.rawIndices.length > 0) {
      // Find the first normalized character at or after localOffset
      let normIdx = localMap.rawIndices.findIndex((rawIdx) => rawIdx >= localOffset);
      if (normIdx === -1) {
        normIdx = localMap.rawIndices.length - 1;
      }

      const domMap = collectNormalizedDomMap(matchedBlock.el);
      if (domMap.norm && domMap.points.length > 0) {
        const mappedDomIdx = Math.min(
          domMap.points.length - 1,
          Math.max(
            0,
            localMap.norm.length === domMap.norm.length
              ? normIdx
              : Math.round((normIdx / Math.max(1, localMap.norm.length)) * domMap.norm.length)
          )
        );

        // Try exact substring match inside this single block first
        const targetSlice = localMap.norm.slice(normIdx, normIdx + 36);
        const intraRatio = localOffset / Math.max(1, blockRaw.length);
        const exactInBlock = targetSlice
          ? findScrollTopForNormalizedAnchor(scrollEl, matchedBlock.el, targetSlice, intraRatio)
          : null;
        if (exactInBlock !== null) {
          return exactInBlock;
        }

        // Fall back to direct DOM character point measurement
        const pt = domMap.points[mappedDomIdx];
        if (pt && pt.node.nodeValue && pt.offset < pt.node.nodeValue.length) {
          const range = document.createRange();
          range.setStart(pt.node, pt.offset);
          range.setEnd(pt.node, pt.offset + 1);
          const rects = range.getClientRects();
          const r = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
          if (r && r.height > 0) {
            return r.top + baseOffset;
          }
        }
      }
    }

    const intraRatio = localOffset / Math.max(1, matchedBlock.end - matchedBlock.start);
    return blockTop + intraRatio * blockRect.height;
  }

  // Fallback across whole article
  const atLineStart = safeOffset === 0 || rawContent[safeOffset - 1] === '\n';
  const targetNorm = buildNormalizedTextMap(rawContent.slice(safeOffset), true, atLineStart).norm.slice(
    0,
    48
  );
  const ratio = safeOffset / Math.max(1, rawContent.length);
  return findScrollTopForNormalizedAnchor(scrollEl, articleEl, targetNorm, ratio);
}

function findFirstTextTopInElement(scrollEl: HTMLElement, el: HTMLElement): number | null {
  const containerRect = scrollEl.getBoundingClientRect();
  const baseOffset = scrollEl.scrollTop - containerRect.top;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node = walker.nextNode();
  while (node) {
    const val = node.nodeValue || '';
    const nonWsIdx = val.search(/\S/);
    if (nonWsIdx !== -1) {
      range.setStart(node, nonWsIdx);
      range.setEnd(node, Math.min(val.length, nonWsIdx + 1));
      const rects = range.getClientRects();
      const r = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
      if (r && r.height > 0) {
        return r.top + baseOffset;
      }
    }
    node = walker.nextNode();
  }
  return null;
}

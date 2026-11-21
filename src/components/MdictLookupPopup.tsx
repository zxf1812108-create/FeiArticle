import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookA, X } from 'lucide-react';
import { MdictDictionarySummary, MdictLookupResult } from '../types';
import { sanitizeMdictCss } from '../utils/mdict';
import { stripDictExt } from '../utils/mdictStorage';

interface MdictLookupPopupProps {
  queryWord: string;
  placement: 'top' | 'bottom';
  fontSize?: number;
  loading: boolean;
  result: MdictLookupResult | null;
  matchCount: number;
  error: string | null;
  dictionaries: MdictDictionarySummary[];
  activeDictId: string | null;
  onCycleDict: () => void;
  onLookupWord: (word: string) => void;
  onClose: () => void;
}

const UNSAFE_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'textarea',
  'select',
  'meta',
  'base',
  'link',
];

function sanitizeMdictEntryHtml(rawHtml: string): string {
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  for (const tag of UNSAFE_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  }

  doc.querySelectorAll('style').forEach((styleEl) => {
    styleEl.textContent = sanitizeMdictCss(styleEl.textContent || '');
  });

  doc.querySelectorAll('img').forEach((img) => {
    const src = (img.getAttribute('src') || '').trim();
    if (!src.startsWith('data:image/')) {
      img.remove();
    }
  });

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^(?:javascript|vbscript):/i.test(val)
      ) {
        el.removeAttribute(attr.name);
      }
      if (name === 'style' && /expression\s*\(|javascript:/i.test(val)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  return doc.body.innerHTML;
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const MdictShadowDefinition: React.FC<{
  htmlDefinitions: string[];
  dictCssText?: string;
  fontSize: number;
  onLookupWord: (word: string) => void;
}> = ({ htmlDefinitions, dictCssText, fontSize, onLookupWord }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const onLookupWordRef = useRef(onLookupWord);
  onLookupWordRef.current = onLookupWord;

  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setIsDark(root.classList.contains('dark'));
    syncTheme();
    const obs = new MutationObserver(syncTheme);
    obs.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const sanitizedEntries = useMemo(
    () => htmlDefinitions.map((raw) => sanitizeMdictEntryHtml(raw)).filter(Boolean),
    [htmlDefinitions]
  );

  const safeDictCss = useMemo(
    () => (dictCssText ? sanitizeMdictCss(dictCssText) : ''),
    [dictCssText]
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!shadowRef.current) {
      shadowRef.current = host.attachShadow({ mode: 'open' });
      shadowRef.current.addEventListener('click', (evt) => {
        const target = evt.target as HTMLElement | null;
        const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        evt.preventDefault();
        const href = (anchor.getAttribute('href') || '').trim();
        const entryMatch = href.match(/^(?:entry|bword):\/\/(.+)$/i);
        if (entryMatch && entryMatch[1]) {
          const nextWord = decodeURIComponent(entryMatch[1]).replace(/#.*$/, '').trim();
          if (nextWord) {
            onLookupWordRef.current(nextWord);
          }
        }
      });
    }

    const shadow = shadowRef.current;
    const hasCustomCss = Boolean(safeDictCss.trim());
    const baseStyle = `
      :host {
        display: block;
        color: var(--fei-text-primary, #000000);
        font-family: var(--font-doc-body, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif);
        font-size: ${fontSize}px;
        line-height: 1.58;
        word-break: break-word;
      }
      *, *::before, *::after {
        box-sizing: border-box;
        max-width: 100%;
      }
      .mdx-surface, .mdx-entry {
        font-size: ${fontSize}px;
      }
      .mdx-entry + .mdx-entry {
        margin-top: 9px;
        padding-top: 9px;
        border-top: 1px solid var(--fei-border, #C4C4C4);
      }
      p { margin: 0.25em 0; }
      ul, ol { margin: 0.3em 0; padding-left: 1.3em; }
      li { margin: 0.12em 0; }
      a[href^="entry://"], a[href^="bword://"] {
        color: inherit;
        text-decoration: underline;
        text-underline-offset: 2px;
        cursor: pointer;
      }
      a:not([href^="entry://"]):not([href^="bword://"]) {
        color: inherit;
        text-decoration: none;
        cursor: default;
      }
      img { max-width: 100%; height: auto; }
    `;

    // Enforce consistent document font size over fixed-px dictionary stylesheets & adapt dark contrast
    const fontScaleOverride = `
      .mdx-surface {
        font-size: ${fontSize}px !important;
      }
    `;

    const themeAdaptStyle = hasCustomCss
      ? isDark
        ? `
          .mdx-surface {
            background-color: #ffffff;
            color: #222222;
            padding: 4px 6px;
            border-radius: 6px;
            filter: invert(0.85) hue-rotate(180deg);
          }
          .mdx-surface img {
            filter: invert(1) hue-rotate(180deg);
          }
        `
        : `
          .mdx-surface {
            background-color: #ffffff;
            color: #000000;
          }
        `
      : '';

    const entriesHtml = sanitizedEntries
      .map((html) => `<div class="mdx-entry">${html}</div>`)
      .join('');

    shadow.innerHTML = `<style>${baseStyle}</style>${
      hasCustomCss ? `<style>${escapeHtmlText(safeDictCss)}</style>` : ''
    }<style>${fontScaleOverride}${themeAdaptStyle}</style><div class="mdx-surface">${entriesHtml}</div>`;
  }, [sanitizedEntries, safeDictCss, isDark, fontSize]);

  return <div ref={hostRef} />;
};

export const MdictLookupPopup: React.FC<MdictLookupPopupProps> = ({
  queryWord,
  placement,
  fontSize = 16,
  loading,
  result,
  matchCount,
  error,
  dictionaries,
  activeDictId,
  onCycleDict,
  onLookupWord,
  onClose,
}) => {
  const displayedDict =
    (result && dictionaries.find((d) => d.id === result.dictId)) ||
    dictionaries.find((d) => d.id === activeDictId) ||
    dictionaries[0] ||
    null;
  const displayedDictName = displayedDict
    ? stripDictExt(displayedDict.fileName) || displayedDict.title
    : result?.dictTitle || '';
  const showMappedHeadword =
    result &&
    result.matchedHeadword &&
    result.matchedHeadword.toLowerCase() !== queryWord.toLowerCase();

  return (
    <div
      data-mdict-popup="true"
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className={`fixed left-3 right-3 z-40 flex justify-center pointer-events-none ${
        placement === 'top'
          ? 'top-[max(0.75rem,env(safe-area-inset-top))] animate-mdict-down'
          : 'bottom-[64px] animate-mdict-up'
      }`}
    >
      <div className="pointer-events-auto w-full max-w-[720px] max-h-[min(40vh,340px)] flex flex-col bg-[#FFFFFF] dark:bg-[#242424] border-[1.5px] border-[#262626] dark:border-[#787878] rounded-2xl shadow-none dark:ring-1 dark:ring-white/10 dark:shadow-[0_14px_36px_-4px_rgba(0,0,0,0.75)] overflow-hidden text-[var(--fei-text-primary)]">
        {/* Subtle handle bar when docked at bottom */}
        {placement === 'bottom' && (
          <div className="flex justify-center pt-1.5 pb-0.5 bg-[#FFFFFF] dark:bg-[#2A2A2A] shrink-0">
            <span className="w-7 h-[3px] rounded-full bg-[#B0B0B0] dark:bg-[#5E5E5E]" />
          </div>
        )}

        {/* Header Band */}
        <div className="px-3.5 py-2 bg-[#FFFFFF] dark:bg-[#2A2A2A] border-b border-[#BDBDBD] dark:border-[#4A4A4A] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <BookA
              className="w-4 h-4 text-[var(--fei-text-muted)] shrink-0 self-center"
              strokeWidth={1.75}
            />
            <span className="font-doc-body text-[15px] font-semibold text-[var(--fei-text-primary)] truncate">
              {queryWord}
            </span>
            {showMappedHeadword && (
              <span className="font-doc-body text-[12px] text-[var(--fei-text-muted)] shrink-0">
                → {result.matchedHeadword}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {displayedDictName ? (
              matchCount > 1 ? (
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={onCycleDict}
                  title="点击切换下一个包含该词的词典"
                  aria-label={`当前词典 ${displayedDictName}，点击切换词典`}
                  className="text-[12px] text-[var(--fei-text-primary)] underline decoration-[var(--fei-border-strong)] underline-offset-[3px] truncate max-w-[160px] hover:opacity-75 transition-opacity cursor-pointer"
                >
                  {displayedDictName}
                </button>
              ) : (
                <span className="text-[12px] text-[var(--fei-text-muted)] truncate max-w-[160px]">
                  {displayedDictName}
                </span>
              )
            ) : null}

            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClose}
              aria-label="关闭释义"
              className="w-7 h-7 -mr-1 inline-flex items-center justify-center rounded-lg text-[var(--fei-text-muted)] hover:text-[var(--fei-text-primary)] hover:bg-[var(--fei-bg-hover)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Definition Body */}
        <div className="flex-1 overflow-y-auto px-3.5 py-2.5 bg-[#FFFFFF] dark:bg-[#242424]">
          {loading ? (
            <div style={{ fontSize: `${fontSize}px` }} className="py-3 text-[var(--fei-text-muted)]">
              正在查词…
            </div>
          ) : error ? (
            <div style={{ fontSize: `${fontSize}px` }} className="py-3 text-[var(--fei-text-muted)]">
              {error}
            </div>
          ) : result && result.htmlDefinitions.length > 0 ? (
            <MdictShadowDefinition
              htmlDefinitions={result.htmlDefinitions}
              dictCssText={result.dictCssText}
              fontSize={fontSize}
              onLookupWord={onLookupWord}
            />
          ) : null}
        </div>

        {/* Subtle handle bar when docked at top */}
        {placement === 'top' && (
          <div className="flex justify-center pt-0.5 pb-1.5 bg-[#FFFFFF] dark:bg-[#242424] shrink-0">
            <span className="w-7 h-[3px] rounded-full bg-[#B0B0B0] dark:bg-[#5E5E5E]" />
          </div>
        )}
      </div>
    </div>
  );
};

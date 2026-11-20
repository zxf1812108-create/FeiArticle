import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { MdictDictionarySummary, MdictLookupResult } from '../types';
import { sanitizeMdictCss } from '../utils/mdict';

interface MdictLookupPopupProps {
  queryWord: string;
  placement: 'top' | 'bottom';
  loading: boolean;
  result: MdictLookupResult | null;
  error: string | null;
  dictionaries: MdictDictionarySummary[];
  activeDictId: string | null;
  onSwitchDict: (dictId: string) => void;
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

  // Strip external @import or unsafe expressions in inline <style> tags
  doc.querySelectorAll('style').forEach((styleEl) => {
    styleEl.textContent = sanitizeMdictCss(styleEl.textContent || '');
  });

  // Remove unresolvable local/mdd images so broken image placeholders never appear
  doc.querySelectorAll('img').forEach((img) => {
    const src = (img.getAttribute('src') || '').trim();
    if (!src.startsWith('data:image/')) {
      img.remove();
    }
  });

  // Remove inline event handlers and javascript: URLs
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
  onLookupWord: (word: string) => void;
}> = ({ htmlDefinitions, dictCssText, onLookupWord }) => {
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
        color: var(--fei-text-primary, #333333);
        font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif);
        font-size: 13.5px;
        line-height: 1.65;
        word-break: break-word;
      }
      *, *::before, *::after {
        box-sizing: border-box;
        max-width: 100%;
      }
      .mdx-entry + .mdx-entry {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--fei-border, #ececec);
      }
      p { margin: 0.3em 0; }
      ul, ol { margin: 0.35em 0; padding-left: 1.35em; }
      li { margin: 0.15em 0; }
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

    // Dark-mode contrast inversion for third-party light-mode MDict stylesheets
    const darkAdaptStyle =
      hasCustomCss && isDark
        ? `
          .mdx-surface {
            background-color: #ffffff;
            color: #222222;
            padding: 4px 6px;
            border-radius: 8px;
            filter: invert(0.88) hue-rotate(180deg);
          }
          .mdx-surface img {
            filter: invert(1) hue-rotate(180deg);
          }
        `
        : '';

    const entriesHtml = sanitizedEntries
      .map((html) => `<div class="mdx-entry">${html}</div>`)
      .join('');

    shadow.innerHTML = `<style>${baseStyle}</style>${
      hasCustomCss ? `<style>${escapeHtmlText(safeDictCss)}</style>` : ''
    }${darkAdaptStyle ? `<style>${darkAdaptStyle}</style>` : ''}<div class="mdx-surface">${entriesHtml}</div>`;
  }, [sanitizedEntries, safeDictCss, isDark]);

  return <div ref={hostRef} />;
};

export const MdictLookupPopup: React.FC<MdictLookupPopupProps> = ({
  queryWord,
  placement,
  loading,
  result,
  error,
  dictionaries,
  activeDictId,
  onSwitchDict,
  onLookupWord,
  onClose,
}) => {
  const activeDict = dictionaries.find((d) => d.id === activeDictId) || dictionaries[0] || null;
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
          ? 'top-[max(0.75rem,env(safe-area-inset-top))]'
          : 'bottom-[62px]'
      }`}
    >
      <div className="pointer-events-auto w-full max-w-[720px] max-h-[min(38vh,320px)] flex flex-col bg-[var(--fei-bg-surface)] border border-[var(--fei-border-strong)] rounded-2xl shadow-lg overflow-hidden text-[var(--fei-text-primary)]">
        {/* Compact Header */}
        <div className="px-3.5 py-2 border-b border-[var(--fei-border)] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[14.5px] font-semibold text-[var(--fei-text-primary)] truncate">
              {queryWord}
            </span>
            {showMappedHeadword && (
              <span className="text-[11.5px] text-[var(--fei-text-muted)] shrink-0">
                → {result.matchedHeadword}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {dictionaries.length > 1 ? (
              <select
                aria-label="切换查询词典"
                value={activeDict?.id || ''}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => onSwitchDict(e.target.value)}
                className="h-7 max-w-[140px] px-2 rounded-lg bg-[var(--fei-bg-subtle)] border border-[var(--fei-border)] text-[11.5px] text-[var(--fei-text-muted)] outline-none truncate"
              >
                {dictionaries.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            ) : activeDict ? (
              <span className="text-[11.5px] text-[var(--fei-text-muted)] truncate max-w-[130px]">
                {activeDict.title}
              </span>
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
        <div className="flex-1 overflow-y-auto px-3.5 py-2.5">
          {loading ? (
            <div className="py-4 text-[12.5px] text-[var(--fei-text-muted)]">正在查词…</div>
          ) : error ? (
            <div className="py-3 text-[12.5px] text-[var(--fei-text-muted)]">{error}</div>
          ) : result && result.htmlDefinitions.length > 0 ? (
            <MdictShadowDefinition
              htmlDefinitions={result.htmlDefinitions}
              dictCssText={result.dictCssText}
              onLookupWord={onLookupWord}
            />
          ) : (
            <div className="py-3 text-[12.5px] text-[var(--fei-text-muted)]">
              当前词典中未收录「{queryWord}」
              {dictionaries.length > 1 ? '，可在右上角切换其他词典查看。' : '。'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

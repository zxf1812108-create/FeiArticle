import React, { useMemo } from 'react';
import { X } from 'lucide-react';
import { MdictDictionarySummary, MdictLookupResult } from '../types';

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

const SKIP_TAGS = new Set([
  'script',
  'style',
  'link',
  'iframe',
  'object',
  'embed',
  'svg',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'meta',
  'title',
  'audio',
  'video',
  'source',
  'img',
]);

function renderSafeHtmlNode(
  node: ChildNode,
  key: string,
  onLookupWord: (word: string) => void
): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return null;

  if (tag === 'br') {
    return <br key={key} />;
  }
  if (tag === 'hr') {
    return <hr key={key} className="my-2 border-t border-[var(--fei-border)]" />;
  }

  const children = Array.from(el.childNodes).map((child, idx) =>
    renderSafeHtmlNode(child, `${key}_${idx}`, onLookupWord)
  );

  if (tag === 'a') {
    const href = (el.getAttribute('href') || '').trim();
    const entryMatch = href.match(/^(?:entry|bword):\/\/(.+)$/i);
    if (entryMatch && entryMatch[1]) {
      const targetWord = decodeURIComponent(entryMatch[1]).replace(/#.*$/, '').trim();
      if (targetWord) {
        return (
          <button
            key={key}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onLookupWord(targetWord)}
            className="underline decoration-[var(--fei-border-strong)] underline-offset-2 text-[var(--fei-text-primary)] hover:opacity-75 text-left inline"
          >
            {children}
          </button>
        );
      }
    }
    return <span key={key}>{children}</span>;
  }

  if (tag === 'b' || tag === 'strong' || tag === 'dt') {
    return (
      <strong key={key} className="font-semibold text-[var(--fei-text-primary)]">
        {children}
      </strong>
    );
  }
  if (tag === 'i' || tag === 'em') {
    return (
      <em key={key} className="italic">
        {children}
      </em>
    );
  }
  if (tag === 'u') {
    return (
      <span key={key} className="underline underline-offset-2">
        {children}
      </span>
    );
  }
  if (tag === 'sup') {
    return <sup key={key}>{children}</sup>;
  }
  if (tag === 'sub') {
    return <sub key={key}>{children}</sub>;
  }
  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    return (
      <div key={key} className="font-semibold text-[var(--fei-text-primary)] mt-1.5 mb-1">
        {children}
      </div>
    );
  }
  if (tag === 'ul') {
    return (
      <ul key={key} className="list-disc pl-4 my-1 space-y-0.5">
        {children}
      </ul>
    );
  }
  if (tag === 'ol') {
    return (
      <ol key={key} className="list-decimal pl-4 my-1 space-y-0.5">
        {children}
      </ol>
    );
  }
  if (tag === 'li') {
    return <li key={key}>{children}</li>;
  }
  if (tag === 'blockquote') {
    return (
      <div
        key={key}
        className="my-1.5 pl-2.5 border-l-2 border-[var(--fei-border-strong)] text-[var(--fei-text-muted)]"
      >
        {children}
      </div>
    );
  }
  if (tag === 'p' || tag === 'div' || tag === 'dd' || tag === 'dl') {
    return (
      <div key={key} className="my-1 first:mt-0 last:mb-0">
        {children}
      </div>
    );
  }
  if (tag === 'table') {
    return (
      <table key={key} className="w-full border-collapse my-1.5 text-[12.5px]">
        <tbody>{children}</tbody>
      </table>
    );
  }
  if (tag === 'tr') {
    return (
      <tr key={key} className="border-b border-[var(--fei-border)] last:border-b-0">
        {children}
      </tr>
    );
  }
  if (tag === 'td' || tag === 'th') {
    return (
      <td key={key} className="py-1 pr-2 align-top">
        {children}
      </td>
    );
  }

  return <span key={key}>{children}</span>;
}

function SanitizedMdictHtml({
  html,
  onLookupWord,
}: {
  html: string;
  onLookupWord: (word: string) => void;
}) {
  const nodes = useMemo(() => {
    if (typeof DOMParser === 'undefined') return html;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.body.childNodes).map((node, idx) =>
      renderSafeHtmlNode(node, `mdx_${idx}`, onLookupWord)
    );
  }, [html, onLookupWord]);

  return (
    <div className="text-[13.5px] leading-[1.65] text-[var(--fei-text-primary)] break-words">
      {nodes}
    </div>
  );
}

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
        <div className="flex-1 overflow-y-auto px-3.5 py-2.5 space-y-2.5">
          {loading ? (
            <div className="py-4 text-[12.5px] text-[var(--fei-text-muted)]">正在查词…</div>
          ) : error ? (
            <div className="py-3 text-[12.5px] text-[var(--fei-text-muted)]">{error}</div>
          ) : result && result.htmlDefinitions.length > 0 ? (
            result.htmlDefinitions.map((html, idx) => (
              <div
                key={idx}
                className={
                  idx > 0 ? 'pt-2.5 border-t border-[var(--fei-border)]' : undefined
                }
              >
                <SanitizedMdictHtml html={html} onLookupWord={onLookupWord} />
              </div>
            ))
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

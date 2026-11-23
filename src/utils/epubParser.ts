import { unzip } from 'fflate';

export interface ExtractedEbookImage {
  relPath: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ParsedEpubDocument {
  title: string;
  content: string;
  images?: ExtractedEbookImage[];
}

export type HtmlImageResolver = (el: Element) => { relPath: string; alt: string } | null;

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
}

interface TocEntry {
  title: string;
  level: number;
  filePath: string;
  fragment: string | null;
}

const IMAGE_BINARY_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i;

const SKIP_BINARY_EXT_RE =
  /\.(ico|tiff?|ttf|otf|woff2?|eot|mp3|m4a|aac|ogg|wav|mp4|webm|mov|avi|pdf|css|js|map)$/i;

export function sanitizeBookImageDirName(rawTitle: string): string {
  const cleaned = (rawTitle || '')
    .replace(/[\\/:*?"<>|()\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();
  if (!cleaned) return '未命名书籍';
  return cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned;
}

export function detectImageInfoFromBytes(
  bytes: Uint8Array,
  hintPath?: string
): { ext: string; mimeType: string } | null {
  if (!bytes || bytes.length < 4) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: '.jpg', mimeType: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: '.png', mimeType: 'image/png' };
  }
  // GIF: GIF8
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { ext: '.gif', mimeType: 'image/gif' };
  }
  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ext: '.webp', mimeType: 'image/webp' };
  }
  // BMP: BM
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { ext: '.bmp', mimeType: 'image/bmp' };
  }
  // AVIF: ....ftypavif / ftypavis
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis') {
      return { ext: '.avif', mimeType: 'image/avif' };
    }
  }
  // SVG text check
  const headLen = Math.min(bytes.length, 512);
  let headStr = '';
  for (let i = 0; i < headLen; i++) {
    headStr += String.fromCharCode(bytes[i]);
  }
  if (/<svg\b/i.test(headStr)) {
    return { ext: '.svg', mimeType: 'image/svg+xml' };
  }

  // Fallback to explicit image extension on hintPath
  if (hintPath) {
    const lower = hintPath.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return { ext: '.jpg', mimeType: 'image/jpeg' };
    if (lower.endsWith('.png')) return { ext: '.png', mimeType: 'image/png' };
    if (lower.endsWith('.gif')) return { ext: '.gif', mimeType: 'image/gif' };
    if (lower.endsWith('.webp')) return { ext: '.webp', mimeType: 'image/webp' };
    if (lower.endsWith('.bmp')) return { ext: '.bmp', mimeType: 'image/bmp' };
    if (lower.endsWith('.svg')) return { ext: '.svg', mimeType: 'image/svg+xml' };
    if (lower.endsWith('.avif')) return { ext: '.avif', mimeType: 'image/avif' };
  }

  return null;
}

export function formatMarkdownImage(alt: string, relPath: string): string {
  const cleanAlt = (alt || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const safePath = (relPath || '').trim();
  return `![${cleanAlt}](${safePath})`;
}

function getElementImageSrcAttr(el: Element): string {
  return (
    el.getAttribute('src') ||
    el.getAttribute('href') ||
    el.getAttribute('xlink:href') ||
    el.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') ||
    el.getAttribute('data-src') ||
    ''
  ).trim();
}

const GENERIC_TITLE_CLASS_RE =
  /(?:^|[-_\s])(chapter|chap|part|section|title|heading|subtitle|headline|h[1-6])(?:$|[-_\s\d])/i;

function normalizeZipPath(rawPath: string): string {
  const replaced = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = replaced.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

function safeDecodeUriComponent(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function resolveRelativePath(baseFilePath: string, href: string): {
  filePath: string;
  fragment: string | null;
} {
  const hashIdx = href.indexOf('#');
  const rawRel = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const fragment = hashIdx >= 0 ? safeDecodeUriComponent(href.slice(hashIdx + 1)) || null : null;
  const decodedRel = safeDecodeUriComponent(rawRel.split('?')[0]);

  if (!decodedRel) {
    return { filePath: normalizeZipPath(baseFilePath), fragment };
  }
  if (decodedRel.startsWith('/')) {
    return { filePath: normalizeZipPath(decodedRel), fragment };
  }
  const slashIdx = baseFilePath.lastIndexOf('/');
  const baseDir = slashIdx >= 0 ? baseFilePath.slice(0, slashIdx + 1) : '';
  return { filePath: normalizeZipPath(baseDir + decodedRel), fragment };
}

function buildEntryLookup(entries: Record<string, Uint8Array>): {
  getBytes: (path: string) => Uint8Array | null;
  listPaths: () => string[];
} {
  const exact = new Map<string, Uint8Array>();
  const lower = new Map<string, Uint8Array>();

  for (const [rawKey, bytes] of Object.entries(entries)) {
    const norm = normalizeZipPath(rawKey);
    exact.set(norm, bytes);
    lower.set(norm.toLowerCase(), bytes);
    const decoded = normalizeZipPath(safeDecodeUriComponent(rawKey));
    if (!exact.has(decoded)) exact.set(decoded, bytes);
    if (!lower.has(decoded.toLowerCase())) lower.set(decoded.toLowerCase(), bytes);
  }

  return {
    getBytes(path: string): Uint8Array | null {
      const norm = normalizeZipPath(path);
      return (
        exact.get(norm) ??
        exact.get(normalizeZipPath(safeDecodeUriComponent(norm))) ??
        lower.get(norm.toLowerCase()) ??
        lower.get(normalizeZipPath(safeDecodeUriComponent(norm)).toLowerCase()) ??
        null
      );
    },
    listPaths(): string[] {
      return Array.from(exact.keys());
    },
  };
}

export function decodeBytesSmart(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes).replace(/^\uFEFF/, '');
    } catch {
      return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
    }
  }
}

function parseXmlDocument(xmlText: string): Document {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
  if (!xmlDoc.querySelector('parsererror')) {
    return xmlDoc;
  }
  return parser.parseFromString(xmlText, 'text/html');
}

function parseXhtmlDocument(htmlText: string): Document {
  const parser = new DOMParser();
  // Try HTML parser first for maximum resilience against real-world messy EPUB markup
  // while preserving full DOM structure, entities, and element hierarchy.
  const cleaned = htmlText.replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, '');
  return parser.parseFromString(cleaned, 'text/html');
}

function getElementsByLocalName(root: Document | Element, localName: string): Element[] {
  const target = localName.toLowerCase();
  const all = root.getElementsByTagName('*');
  const matched: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const elLocal = (el.localName || el.tagName || '').toLowerCase();
    if (elLocal === target || elLocal.endsWith(`:${target}`)) {
      matched.push(el);
    }
  }
  return matched;
}

function getFirstElementByLocalName(root: Document | Element, localName: string): Element | null {
  const target = localName.toLowerCase();
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const elLocal = (el.localName || el.tagName || '').toLowerCase();
    if (elLocal === target || elLocal.endsWith(`:${target}`)) {
      return el;
    }
  }
  return null;
}

function checkHasContentDrm(
  getBytes: (path: string) => Uint8Array | null
): boolean {
  const encBytes = getBytes('META-INF/encryption.xml');
  if (!encBytes) return false;
  const encDoc = parseXmlDocument(decodeBytesSmart(encBytes));
  const encryptedDataEls = getElementsByLocalName(encDoc, 'EncryptedData');
  for (const el of encryptedDataEls) {
    const methodEl = getFirstElementByLocalName(el, 'EncryptionMethod');
    const algo = (methodEl?.getAttribute('Algorithm') || '').toLowerCase();
    // Font obfuscation (IDPF / Adobe) is normal and does not encrypt text content
    if (algo.includes('embedding') || algo.includes('font')) continue;
    const cipherRef = getFirstElementByLocalName(el, 'CipherReference');
    const uri = (cipherRef?.getAttribute('URI') || '').toLowerCase();
    if (/\.(ttf|otf|woff2?|eot)$/i.test(uri)) continue;
    return true;
  }
  return false;
}

function parseNcxToc(ncxPath: string, ncxXml: string): TocEntry[] {
  const doc = parseXmlDocument(ncxXml);
  const navMap = getFirstElementByLocalName(doc, 'navMap');
  if (!navMap) return [];

  const entries: TocEntry[] = [];

  const walkNavPoint = (parent: Element, depth: number) => {
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i];
      const name = (child.localName || child.tagName || '').toLowerCase();
      if (name !== 'navpoint' && !name.endsWith(':navpoint')) continue;

      const labelEl = getFirstElementByLocalName(child, 'text');
      const contentEl = getFirstElementByLocalName(child, 'content');
      const title = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
      const src = contentEl?.getAttribute('src')?.trim() || '';
      if (title && src) {
        const resolved = resolveRelativePath(ncxPath, src);
        entries.push({
          title,
          level: Math.min(6, Math.max(1, depth)),
          filePath: resolved.filePath,
          fragment: resolved.fragment,
        });
      }
      walkNavPoint(child, depth + 1);
    }
  };

  walkNavPoint(navMap, 1);
  return entries;
}

function parseNavToc(navPath: string, navHtml: string): TocEntry[] {
  const doc = parseXhtmlDocument(navHtml);
  const navs = Array.from(doc.querySelectorAll('nav'));
  const tocNav =
    navs.find((n) => {
      const epubType = (n.getAttribute('epub:type') || n.getAttribute('type') || '').toLowerCase();
      const role = (n.getAttribute('role') || '').toLowerCase();
      return epubType.split(/\s+/).includes('toc') || role === 'doc-toc';
    }) || navs[0];

  if (!tocNav) return [];

  const entries: TocEntry[] = [];

  const walkList = (listEl: Element, depth: number) => {
    for (let i = 0; i < listEl.children.length; i++) {
      const li = listEl.children[i];
      if (li.tagName.toLowerCase() !== 'li') continue;

      let anchor: Element | null = null;
      for (let j = 0; j < li.children.length; j++) {
        const c = li.children[j];
        const tag = c.tagName.toLowerCase();
        if (tag === 'a') {
          anchor = c;
          break;
        }
        if (tag === 'span' || tag === 'div' || tag === 'p') {
          const nestedA = c.querySelector('a');
          if (nestedA) {
            anchor = nestedA;
            break;
          }
        }
      }

      if (anchor) {
        const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        const href = anchor.getAttribute('href')?.trim() || '';
        if (title && href) {
          const resolved = resolveRelativePath(navPath, href);
          entries.push({
            title,
            level: Math.min(6, Math.max(1, depth)),
            filePath: resolved.filePath,
            fragment: resolved.fragment,
          });
        }
      }

      for (let j = 0; j < li.children.length; j++) {
        const sub = li.children[j];
        const tag = sub.tagName.toLowerCase();
        if (tag === 'ol' || tag === 'ul') {
          walkList(sub, depth + 1);
        }
      }
    }
  };

  const rootList = tocNav.querySelector('ol, ul');
  if (rootList) {
    walkList(rootList, 1);
  }
  return entries;
}

function normalizeTextForCompare(text: string): string {
  return text
    .replace(/[*_`~#>\[\]()]/g, '')
    .replace(/[\s\u00a0\u3000]+/g, '')
    .toLowerCase();
}

function isHiddenElement(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true;
  const style = (el.getAttribute('style') || '').toLowerCase();
  if (/display\s*:\s*none/.test(style) || /visibility\s*:\s*hidden/.test(style)) {
    return true;
  }
  return false;
}

function wrapInlineMarker(text: string, marker: '**' | '*' | '`'): string {
  if (!text) return '';
  if (marker === '`') {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return '';
    return cleaned.includes('`') ? `\`\` ${cleaned} \`\`` : `\`${cleaned}\``;
  }

  const leadMatch = text.match(/^\s*/);
  const trailMatch = text.match(/\s*$/);
  const leading = leadMatch ? leadMatch[0] : '';
  const trailing = trailMatch ? trailMatch[0] : '';
  const core = text.trim();
  if (!core) return leading || trailing ? ' ' : '';

  // Avoid broken nested markers (e.g. **a **b** c** or *a *b* c*)
  if (marker === '**') {
    const stripped = core.replace(/\*\*/g, '');
    if (!stripped.trim()) return '';
    return `${leading}**${stripped}**${trailing}`;
  }
  const stripped = core.replace(/\*/g, '');
  if (!stripped.trim()) return '';
  return `${leading}*${stripped}*${trailing}`;
}

function hasInlineBoldStyle(el: Element): boolean {
  const style = (el.getAttribute('style') || '').toLowerCase();
  return /font-weight\s*:\s*(bold|bolder|[6-9]00)/.test(style);
}

function hasInlineItalicStyle(el: Element): boolean {
  const style = (el.getAttribute('style') || '').toLowerCase();
  return /font-style\s*:\s*(italic|oblique)/.test(style);
}

function serializeInlineChildren(
  parent: Node,
  stripFormatting = false,
  imageResolver?: HtmlImageResolver
): string {
  let out = '';

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = (node.nodeValue || '').replace(/\u00a0/g, ' ');
      // Collapse source-code formatting whitespace inside HTML text nodes
      const collapsed = raw.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
      out += collapsed;
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (isHiddenElement(el)) return;

    const tag = el.tagName.toLowerCase();
    if (
      tag === 'script' ||
      tag === 'style' ||
      tag === 'noscript' ||
      tag === 'rt' ||
      tag === 'rp'
    ) {
      return;
    }

    if (tag === 'img') {
      if (!stripFormatting && imageResolver) {
        const resolved = imageResolver(el);
        if (resolved) {
          out += `\n${formatMarkdownImage(resolved.alt, resolved.relPath)}\n`;
        }
      }
      return;
    }

    if (tag === 'svg') {
      if (!stripFormatting && imageResolver) {
        const svgImages = getElementsByLocalName(el, 'image');
        for (const svgImg of svgImages) {
          const resolved = imageResolver(svgImg);
          if (resolved) {
            out += `\n${formatMarkdownImage(resolved.alt, resolved.relPath)}\n`;
          }
        }
      }
      return;
    }

    if (tag === 'br') {
      out += '\n';
      return;
    }

    if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') {
      const inner = serializeInlineChildren(el, true);
      out += stripFormatting ? inner : wrapInlineMarker(inner, '`');
      return;
    }

    if (tag === 'strong' || tag === 'b') {
      const inner = serializeInlineChildren(el, stripFormatting, imageResolver);
      out += stripFormatting ? inner : wrapInlineMarker(inner, '**');
      return;
    }

    if (tag === 'em' || tag === 'i' || tag === 'cite' || tag === 'var' || tag === 'dfn') {
      const inner = serializeInlineChildren(el, stripFormatting, imageResolver);
      out += stripFormatting ? inner : wrapInlineMarker(inner, '*');
      return;
    }

    if (tag === 'span' || tag === 'font') {
      const inner = serializeInlineChildren(el, stripFormatting, imageResolver);
      if (stripFormatting) {
        out += inner;
      } else if (hasInlineBoldStyle(el)) {
        out += wrapInlineMarker(inner, '**');
      } else if (hasInlineItalicStyle(el)) {
        out += wrapInlineMarker(inner, '*');
      } else {
        out += inner;
      }
      return;
    }

    if (tag === 'sup') {
      const inner = serializeInlineChildren(el, true).trim();
      if (!inner) return;
      // Preserve footnote markers cleanly without clutter
      if (/^\[?\d+\]?$/.test(inner)) {
        out += inner.startsWith('[') ? inner : `[${inner}]`;
      } else {
        out += inner;
      }
      return;
    }

    if (tag === 'ruby') {
      for (let i = 0; i < el.childNodes.length; i++) {
        walk(el.childNodes[i]);
      }
      return;
    }

    for (let i = 0; i < el.childNodes.length; i++) {
      walk(el.childNodes[i]);
    }
  };

  for (let i = 0; i < parent.childNodes.length; i++) {
    walk(parent.childNodes[i]);
  }

  return out
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .trim();
}

function cleanBlockLine(text: string): string {
  return text
    .replace(/^[\u3000\u00a0\s]+/, '')
    .replace(/[\u3000\u00a0\s]+$/, '')
    .replace(/ {2,}/g, ' ');
}

function detectCodeLanguage(preEl: Element): string {
  const codeEl = preEl.querySelector('code');
  const classes = `${preEl.getAttribute('class') || ''} ${codeEl?.getAttribute('class') || ''}`;
  const match = classes.match(/(?:language|lang)-([a-zA-Z0-9_+#.-]+)/i);
  return match ? match[1].toLowerCase() : '';
}

function serializeTable(tableEl: Element): string | null {
  const rows: Array<{ cells: string[]; isHeader: boolean }> = [];
  const trEls = Array.from(tableEl.querySelectorAll('tr')).filter(
    (tr) => tr.closest('table') === tableEl
  );

  for (const tr of trEls) {
    const cellEls = Array.from(tr.children).filter((c) => {
      const t = c.tagName.toLowerCase();
      return t === 'td' || t === 'th';
    });
    if (cellEls.length === 0) continue;

    const isHeader =
      tr.parentElement?.tagName.toLowerCase() === 'thead' ||
      cellEls.every((c) => c.tagName.toLowerCase() === 'th');
    const cells = cellEls.map((cell) =>
      serializeInlineChildren(cell, false)
        .replace(/\n+/g, ' ')
        .replace(/\|/g, '\\|')
        .trim()
    );
    if (cells.some((c) => c.length > 0)) {
      rows.push({ cells, isHeader });
    }
  }

  if (rows.length === 0) return null;

  const maxCols = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  // Single-column tables in EPUBs are almost always layout wrappers, not data tables
  if (maxCols <= 1) {
    return rows.map((r) => r.cells[0]).filter(Boolean).join('\n\n');
  }

  const normalizeRow = (cells: string[]) =>
    Array.from({ length: maxCols }, (_, i) => cells[i] ?? '');

  const headerRow = normalizeRow(rows[0].cells);
  const bodyRows = rows.slice(1).map((r) => normalizeRow(r.cells));

  const lines: string[] = [
    `| ${headerRow.join(' | ')} |`,
    `| ${Array.from({ length: maxCols }, () => '---').join(' | ')} |`,
    ...bodyRows.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

const BLOCK_CONTAINER_TAGS = new Set([
  'html',
  'body',
  'article',
  'section',
  'main',
  'div',
  'header',
  'footer',
  'aside',
  'nav',
  'figure',
  'details',
  'center',
]);

const BLOCK_LEAF_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'dl',
  'table',
  'hr',
  'figcaption',
]);

function hasBlockChild(el: Element): boolean {
  for (let i = 0; i < el.children.length; i++) {
    const tag = el.children[i].tagName.toLowerCase();
    if (BLOCK_CONTAINER_TAGS.has(tag) || BLOCK_LEAF_TAGS.has(tag)) {
      return true;
    }
  }
  return false;
}

function isPureTocNavDocument(doc: Document): boolean {
  const body = doc.body;
  if (!body) return false;
  const navs = Array.from(body.querySelectorAll('nav'));
  if (navs.length === 0) return false;
  const hasTocNav = navs.some((n) => {
    const epubType = (n.getAttribute('epub:type') || n.getAttribute('type') || '').toLowerCase();
    const role = (n.getAttribute('role') || '').toLowerCase();
    return epubType.split(/\s+/).includes('toc') || role === 'doc-toc';
  });
  if (!hasTocNav) return false;

  // Check whether there is substantial non-nav prose outside <nav>
  const clone = body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('nav').forEach((n) => n.remove());
  const remainingText = (clone.textContent || '').replace(/\s+/g, '');
  return remainingText.length < 40;
}

function convertSpineDocumentToMarkdown(
  htmlText: string,
  fileTocEntries: TocEntry[],
  imageResolver?: HtmlImageResolver
): string {
  const doc = parseXhtmlDocument(htmlText);
  const body = doc.body;
  if (!body) return '';

  const fragmentTocMap = new Map<string, TocEntry>();
  let fileRootToc: TocEntry | null = null;
  for (const entry of fileTocEntries) {
    if (entry.fragment) {
      if (!fragmentTocMap.has(entry.fragment)) {
        fragmentTocMap.set(entry.fragment, entry);
      }
    } else if (!fileRootToc) {
      fileRootToc = entry;
    }
  }

  const emittedFragmentIds = new Set<string>();
  const blocks: string[] = [];
  let hasAnyHeading = false;

  const pushHeading = (level: number, rawText: string) => {
    const clean = cleanBlockLine(rawText.replace(/\n+/g, ' '));
    if (!clean) return;
    const clamped = Math.min(6, Math.max(1, level));
    blocks.push(`${'#'.repeat(clamped)} ${clean}`);
    hasAnyHeading = true;
  };

  const pushParagraphLines = (raw: string) => {
    const lines = raw
      .split('\n')
      .map((l) => cleanBlockLine(l))
      .filter(Boolean);
    for (const line of lines) {
      blocks.push(line);
    }
  };

  const serializeList = (listEl: Element, ordered: boolean): string | null => {
    const items: string[] = [];
    let counter = Number.parseInt(listEl.getAttribute('start') || '1', 10);
    if (!Number.isFinite(counter) || counter < 1) counter = 1;

    const collectItems = (container: Element, isOrdered: boolean, depth: number) => {
      let localIdx = isOrdered && depth === 0 ? counter : 1;
      for (let i = 0; i < container.children.length; i++) {
        const li = container.children[i];
        if (li.tagName.toLowerCase() !== 'li') continue;

        // Extract text excluding nested <ul>/<ol>
        const nestedLists: Element[] = [];
        const inlineParts: string[] = [];
        for (let j = 0; j < li.childNodes.length; j++) {
          const child = li.childNodes[j];
          if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = (child as Element).tagName.toLowerCase();
            if (tag === 'ul' || tag === 'ol') {
              nestedLists.push(child as Element);
              continue;
            }
            if (tag === 'p' || tag === 'div') {
              const txt = serializeInlineChildren(child, false);
              if (txt) inlineParts.push(txt.replace(/\n+/g, ' '));
              continue;
            }
          }
          const wrap = doc.createElement('span');
          wrap.appendChild(child.cloneNode(true));
          const txt = serializeInlineChildren(wrap, false);
          if (txt) inlineParts.push(txt.replace(/\n+/g, ' '));
        }

        const itemText = cleanBlockLine(inlineParts.join(' '));
        if (itemText) {
          const prefix = isOrdered ? `${localIdx}. ` : '- ';
          items.push(`${prefix}${itemText}`);
          localIdx++;
        }

        for (const sub of nestedLists) {
          collectItems(sub, sub.tagName.toLowerCase() === 'ol', depth + 1);
        }
      }
    };

    collectItems(listEl, ordered, 0);
    return items.length > 0 ? items.join('\n') : null;
  };

  const walkBlock = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = cleanBlockLine((node.nodeValue || '').replace(/\u00a0/g, ' '));
      if (txt) blocks.push(txt);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (isHiddenElement(el)) return;

    const tag = el.tagName.toLowerCase();
    if (
      tag === 'script' ||
      tag === 'style' ||
      tag === 'head' ||
      tag === 'title' ||
      tag === 'meta' ||
      tag === 'link' ||
      tag === 'noscript'
    ) {
      return;
    }

    if (tag === 'img') {
      if (imageResolver) {
        const resolved = imageResolver(el);
        if (resolved) {
          blocks.push(formatMarkdownImage(resolved.alt, resolved.relPath));
        }
      }
      return;
    }

    if (tag === 'svg') {
      if (imageResolver) {
        const svgImages = getElementsByLocalName(el, 'image');
        for (const svgImg of svgImages) {
          const resolved = imageResolver(svgImg);
          if (resolved) {
            blocks.push(formatMarkdownImage(resolved.alt, resolved.relPath));
          }
        }
      }
      return;
    }

    // Check if this element is a TOC anchor fragment (#id)
    const elId = el.getAttribute('id') || el.getAttribute('name');
    const matchedFragmentToc =
      elId && fragmentTocMap.has(elId) && !emittedFragmentIds.has(elId)
        ? fragmentTocMap.get(elId)!
        : null;

    if (/^h[1-6]$/.test(tag)) {
      if (matchedFragmentToc && elId) emittedFragmentIds.add(elId);
      const level = Number.parseInt(tag.slice(1), 10);
      const text = serializeInlineChildren(el, true);
      if (text) {
        pushHeading(level, text);
      } else if (imageResolver) {
        const imgs = Array.from(el.querySelectorAll('img'));
        for (const imgEl of imgs) {
          const resolved = imageResolver(imgEl);
          if (resolved) {
            blocks.push(formatMarkdownImage(resolved.alt, resolved.relPath));
          }
        }
      }
      return;
    }

    if (tag === 'hr') {
      blocks.push('---');
      return;
    }

    if (tag === 'pre') {
      const lang = detectCodeLanguage(el);
      const rawCode = (el.textContent || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/^\n+|\n+$/g, '');
      if (rawCode.trim()) {
        const safeCode = rawCode.replace(/^(\s*)```/gm, '$1\\`\\`\\`');
        blocks.push(`\`\`\`${lang}\n${safeCode}\n\`\`\``);
      }
      return;
    }

    if (tag === 'blockquote') {
      const innerParts: string[] = [];
      if (hasBlockChild(el)) {
        const savedLen = blocks.length;
        for (let i = 0; i < el.childNodes.length; i++) {
          walkBlock(el.childNodes[i]);
        }
        const extracted = blocks.splice(savedLen);
        innerParts.push(...extracted);
      } else {
        const text = serializeInlineChildren(el, false);
        if (text) innerParts.push(text);
      }
      const quoteLines = innerParts
        .join('\n')
        .split('\n')
        .map((l) => l.replace(/^>\s?/, '').trim())
        .filter(Boolean)
        .map((l) => `> ${l}`);
      if (quoteLines.length > 0) {
        blocks.push(quoteLines.join('\n'));
      }
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      const listMd = serializeList(el, tag === 'ol');
      if (listMd) blocks.push(listMd);
      return;
    }

    if (tag === 'dl') {
      for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i];
        const cTag = child.tagName.toLowerCase();
        if (cTag === 'dt') {
          const term = cleanBlockLine(serializeInlineChildren(child, true));
          if (term) blocks.push(`**${term}**`);
        } else if (cTag === 'dd') {
          const def = serializeInlineChildren(child, false);
          if (def) {
            const lines = def
              .split('\n')
              .map((l) => cleanBlockLine(l))
              .filter(Boolean)
              .map((l) => `> ${l}`);
            if (lines.length > 0) blocks.push(lines.join('\n'));
          }
        }
      }
      return;
    }

    if (tag === 'table') {
      const tableMd = serializeTable(el);
      if (tableMd) blocks.push(tableMd);
      return;
    }

    if (tag === 'figcaption') {
      const cap = cleanBlockLine(serializeInlineChildren(el, true));
      if (cap) blocks.push(`*${cap}*`);
      return;
    }

    if (tag === 'p') {
      const plain = cleanBlockLine(serializeInlineChildren(el, true));
      if (matchedFragmentToc && elId) {
        emittedFragmentIds.add(elId);
        if (
          plain &&
          normalizeTextForCompare(plain) === normalizeTextForCompare(matchedFragmentToc.title)
        ) {
          pushHeading(matchedFragmentToc.level, plain);
          return;
        }
        pushHeading(matchedFragmentToc.level, matchedFragmentToc.title);
      }
      // Upgrade paragraph whose class clearly denotes a heading AND matches the chapter's root TOC title
      if (
        fileRootToc &&
        !hasAnyHeading &&
        plain &&
        plain.length <= 80 &&
        (normalizeTextForCompare(plain) === normalizeTextForCompare(fileRootToc.title) ||
          GENERIC_TITLE_CLASS_RE.test(el.getAttribute('class') || ''))
      ) {
        if (normalizeTextForCompare(plain) === normalizeTextForCompare(fileRootToc.title)) {
          pushHeading(fileRootToc.level, plain);
          return;
        }
      }
      const inline = serializeInlineChildren(el, false, imageResolver);
      if (inline) pushParagraphLines(inline);
      return;
    }

    // Generic containers (div, section, article, etc.)
    if (matchedFragmentToc && elId) {
      emittedFragmentIds.add(elId);
      const firstChildText = cleanBlockLine(serializeInlineChildren(el, true));
      if (
        !hasBlockChild(el) &&
        firstChildText &&
        normalizeTextForCompare(firstChildText) ===
          normalizeTextForCompare(matchedFragmentToc.title)
      ) {
        pushHeading(matchedFragmentToc.level, firstChildText);
        return;
      }
      pushHeading(matchedFragmentToc.level, matchedFragmentToc.title);
    }

    if (hasBlockChild(el)) {
      let inlineBuffer: Node[] = [];
      const flushInlineBuffer = () => {
        if (inlineBuffer.length === 0) return;
        const wrapper = doc.createElement('span');
        for (const n of inlineBuffer) {
          wrapper.appendChild(n.cloneNode(true));
        }
        inlineBuffer = [];
        const txt = serializeInlineChildren(wrapper, false, imageResolver);
        if (txt) pushParagraphLines(txt);
      };

      for (let i = 0; i < el.childNodes.length; i++) {
        const child = el.childNodes[i];
        if (child.nodeType === Node.ELEMENT_NODE) {
          const cTag = (child as Element).tagName.toLowerCase();
          if (BLOCK_CONTAINER_TAGS.has(cTag) || BLOCK_LEAF_TAGS.has(cTag)) {
            flushInlineBuffer();
            walkBlock(child);
            continue;
          }
        }
        inlineBuffer.push(child);
      }
      flushInlineBuffer();
      return;
    }

    const leafInline = serializeInlineChildren(el, false, imageResolver);
    if (leafInline) {
      const leafPlain = cleanBlockLine(serializeInlineChildren(el, true));
      if (
        fileRootToc &&
        !hasAnyHeading &&
        leafPlain &&
        normalizeTextForCompare(leafPlain) === normalizeTextForCompare(fileRootToc.title)
      ) {
        pushHeading(fileRootToc.level, leafPlain);
        return;
      }
      pushParagraphLines(leafInline);
    }
  };

  walkBlock(body);

  if (blocks.length === 0) return '';

  // If the chapter had no explicit <h1>-<h6> heading, promote or prepend the TOC entry title
  if (!hasAnyHeading && fileRootToc) {
    const firstNorm = normalizeTextForCompare(blocks[0]);
    const tocNorm = normalizeTextForCompare(fileRootToc.title);
    const prefix = '#'.repeat(Math.min(6, Math.max(1, fileRootToc.level)));
    if (firstNorm && tocNorm && firstNorm === tocNorm) {
      blocks[0] = `${prefix} ${cleanBlockLine(fileRootToc.title)}`;
    } else {
      blocks.unshift(`${prefix} ${cleanBlockLine(fileRootToc.title)}`);
    }
  }

  return blocks.join('\n\n').trim();
}

export function convertHtmlToMarkdown(
  htmlText: string,
  imageResolver?: HtmlImageResolver
): string {
  return convertSpineDocumentToMarkdown(htmlText, [], imageResolver);
}

export function unzipFiltered(
  bytes: Uint8Array,
  includeImages = false
): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(
      bytes,
      {
        filter(file) {
          if (file.name.endsWith('/')) return false;
          if (SKIP_BINARY_EXT_RE.test(file.name)) return false;
          if (!includeImages && IMAGE_BINARY_EXT_RE.test(file.name)) return false;
          return true;
        },
      },
      (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      }
    );
  });
}

export async function parseEpubFile(file: File): Promise<ParsedEpubDocument> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Verify ZIP signature ("PK") before inflating
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`「${file.name}」不是有效的 EPUB 文件`);
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipFiltered(bytes, true);
  } catch {
    throw new Error(`无法解压「${file.name}」，请确认 EPUB 文件完整未损坏`);
  }

  const { getBytes, listPaths } = buildEntryLookup(entries);

  if (checkHasContentDrm(getBytes)) {
    throw new Error(`「${file.name}」受 DRM 加密保护，暂不支持导入`);
  }

  // 1. Locate OPF package path from META-INF/container.xml
  let opfPath: string | null = null;
  const containerBytes = getBytes('META-INF/container.xml');
  if (containerBytes) {
    const containerDoc = parseXmlDocument(decodeBytesSmart(containerBytes));
    const rootfile = getFirstElementByLocalName(containerDoc, 'rootfile');
    const fullPath = rootfile?.getAttribute('full-path')?.trim();
    if (fullPath) {
      opfPath = normalizeZipPath(fullPath);
    }
  }

  if (!opfPath || !getBytes(opfPath)) {
    opfPath = listPaths().find((p) => /\.opf$/i.test(p)) || null;
  }

  const fallbackTitle = file.name.replace(/\.epub$/i, '').trim() || '导入文档';

  const createImageCollector = (resolvedBookTitle: string) => {
    const dirName = sanitizeBookImageDirName(resolvedBookTitle);
    const extractedImages: ExtractedEbookImage[] = [];
    const zipPathToRelPath = new Map<string, string>();
    let imgSeq = 0;

    const registerZipImage = (zipPath: string, preferredBaseName?: string): string | null => {
      const normKey = normalizeZipPath(zipPath).toLowerCase();
      const existing = zipPathToRelPath.get(normKey);
      if (existing) return existing;
      const imgBytes = getBytes(zipPath);
      if (!imgBytes || imgBytes.length === 0) return null;
      const info = detectImageInfoFromBytes(imgBytes, zipPath);
      if (!info) return null;
      const fileName = preferredBaseName
        ? `${preferredBaseName}${info.ext}`
        : `${String(++imgSeq).padStart(3, '0')}${info.ext}`;
      const relPath = `images/${dirName}/${fileName}`;
      zipPathToRelPath.set(normKey, relPath);
      extractedImages.push({ relPath, mimeType: info.mimeType, bytes: imgBytes });
      return relPath;
    };

    const makeChapterResolver = (chapterPath: string): HtmlImageResolver => (el: Element) => {
      const rawSrc = getElementImageSrcAttr(el);
      if (!rawSrc) return null;
      const alt = (el.getAttribute('alt') || el.getAttribute('title') || '').trim();
      if (/^https?:\/\//i.test(rawSrc)) {
        return { relPath: rawSrc, alt };
      }
      if (/^data:image\//i.test(rawSrc)) {
        return { relPath: rawSrc, alt };
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawSrc)) {
        return null;
      }
      const { filePath } = resolveRelativePath(chapterPath, rawSrc);
      const relPath = registerZipImage(filePath);
      if (!relPath) return null;
      return { relPath, alt };
    };

    return { extractedImages, zipPathToRelPath, registerZipImage, makeChapterResolver };
  };

  // Fallback for non-standard EPUB missing OPF: parse all HTML/XHTML files in path order
  if (!opfPath || !getBytes(opfPath)) {
    const collector = createImageCollector(fallbackTitle);
    const htmlPaths = listPaths()
      .filter((p) => /\.(xhtml|html|htm)$/i.test(p))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const sections: string[] = [];
    for (const p of htmlPaths) {
      const b = getBytes(p);
      if (!b) continue;
      const md = convertSpineDocumentToMarkdown(
        decodeBytesSmart(b),
        [],
        collector.makeChapterResolver(p)
      );
      if (md) sections.push(md);
    }
    const combined = sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!combined) {
      throw new Error(`「${file.name}」中未提取到可读文本内容`);
    }
    return {
      title: fallbackTitle,
      content: combined,
      images: collector.extractedImages.length > 0 ? collector.extractedImages : undefined,
    };
  }

  const opfXml = decodeBytesSmart(getBytes(opfPath)!);
  const opfDoc = parseXmlDocument(opfXml);

  // 2. Extract book metadata title (skip generic placeholder titles like "Unknown")
  const metadataRoot = getFirstElementByLocalName(opfDoc, 'metadata') || opfDoc;
  const titleEl = getFirstElementByLocalName(metadataRoot, 'title');
  const metaTitle = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
  const isGenericMetaTitle = /^(unknown|untitled|book|document|无标题|未命名)$/i.test(metaTitle);
  const bookTitle = metaTitle && !isGenericMetaTitle ? metaTitle : fallbackTitle;

  // 3. Build manifest map
  const manifestById = new Map<string, ManifestItem>();
  const manifestItems = getElementsByLocalName(opfDoc, 'item');
  for (const itemEl of manifestItems) {
    const id = itemEl.getAttribute('id')?.trim();
    const rawHref = itemEl.getAttribute('href')?.trim();
    if (!id || !rawHref) continue;
    const { filePath } = resolveRelativePath(opfPath, rawHref);
    const mediaType = (itemEl.getAttribute('media-type') || '').toLowerCase();
    const properties = (itemEl.getAttribute('properties') || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    manifestById.set(id, { id, href: filePath, mediaType, properties });
  }

  // 4. Parse TOC (prefer EPUB 3 nav document, fall back to EPUB 2 NCX)
  let tocEntries: TocEntry[] = [];
  let navHref: string | null = null;

  for (const item of manifestById.values()) {
    if (item.properties.includes('nav')) {
      navHref = item.href;
      const navBytes = getBytes(item.href);
      if (navBytes) {
        tocEntries = parseNavToc(item.href, decodeBytesSmart(navBytes));
      }
      break;
    }
  }

  if (tocEntries.length === 0) {
    const spineEl = getFirstElementByLocalName(opfDoc, 'spine');
    const tocId = spineEl?.getAttribute('toc')?.trim();
    let ncxItem = tocId ? manifestById.get(tocId) : undefined;
    if (!ncxItem) {
      for (const item of manifestById.values()) {
        if (
          item.mediaType === 'application/x-dtbncx+xml' ||
          /\.ncx$/i.test(item.href)
        ) {
          ncxItem = item;
          break;
        }
      }
    }
    if (ncxItem) {
      const ncxBytes = getBytes(ncxItem.href);
      if (ncxBytes) {
        tocEntries = parseNcxToc(ncxItem.href, decodeBytesSmart(ncxBytes));
      }
    }
  }

  const tocByFile = new Map<string, TocEntry[]>();
  for (const entry of tocEntries) {
    const key = entry.filePath.toLowerCase();
    const list = tocByFile.get(key) || [];
    list.push(entry);
    tocByFile.set(key, list);
  }

  // 5. Follow spine reading order
  const spineRefs = getElementsByLocalName(opfDoc, 'itemref');
  const spineItems: ManifestItem[] = [];
  const seenPaths = new Set<string>();

  for (const refEl of spineRefs) {
    const idref = refEl.getAttribute('idref')?.trim();
    if (!idref) continue;
    const item = manifestById.get(idref);
    if (!item) continue;
    if (seenPaths.has(item.href.toLowerCase())) continue;
    seenPaths.add(item.href.toLowerCase());
    spineItems.push(item);
  }

  // Fallback if spine is empty
  if (spineItems.length === 0) {
    for (const item of manifestById.values()) {
      if (
        item.mediaType.includes('html') ||
        /\.(xhtml|html|htm)$/i.test(item.href)
      ) {
        spineItems.push(item);
      }
    }
  }

  // 6. Convert each spine chapter document into structured Markdown and extract embedded images
  const collector = createImageCollector(bookTitle);
  const sections: string[] = [];
  for (const item of spineItems) {
    if (
      item.mediaType &&
      !item.mediaType.includes('html') &&
      !item.mediaType.includes('xml') &&
      !/\.(xhtml|html|htm)$/i.test(item.href)
    ) {
      continue;
    }

    const chapterBytes = getBytes(item.href);
    if (!chapterBytes) continue;
    const chapterHtml = decodeBytesSmart(chapterBytes);

    // Skip pure EPUB 3 navigation TOC page so it doesn't clutter the book body
    if (
      (navHref && item.href.toLowerCase() === navHref.toLowerCase()) ||
      item.properties.includes('nav')
    ) {
      const testDoc = parseXhtmlDocument(chapterHtml);
      if (isPureTocNavDocument(testDoc)) {
        continue;
      }
    }

    const fileTocs = tocByFile.get(item.href.toLowerCase()) || [];
    const md = convertSpineDocumentToMarkdown(
      chapterHtml,
      fileTocs,
      collector.makeChapterResolver(item.href)
    );
    if (md) {
      sections.push(md);
    }
  }

  // If the OPF declares a cover image that wasn't already referenced in the spine HTML, prepend it
  let coverHref: string | null = null;
  for (const item of manifestById.values()) {
    if (item.properties.includes('cover-image')) {
      coverHref = item.href;
      break;
    }
  }
  if (!coverHref) {
    const metaEls = getElementsByLocalName(metadataRoot, 'meta');
    for (const metaEl of metaEls) {
      if ((metaEl.getAttribute('name') || '').toLowerCase() === 'cover') {
        const coverId = (metaEl.getAttribute('content') || '').trim();
        const coverItem = coverId ? manifestById.get(coverId) : undefined;
        if (coverItem) {
          coverHref = coverItem.href;
          break;
        }
      }
    }
  }
  if (coverHref) {
    const normCoverKey = normalizeZipPath(coverHref).toLowerCase();
    if (!collector.zipPathToRelPath.has(normCoverKey)) {
      const relPath = collector.registerZipImage(coverHref, 'cover');
      if (relPath) {
        sections.unshift(formatMarkdownImage('封面', relPath));
      }
    }
  }

  const content = sections
    .join('\n\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!content) {
    throw new Error(`「${file.name}」中未提取到可读文本内容`);
  }

  return {
    title: bookTitle,
    content,
    images: collector.extractedImages.length > 0 ? collector.extractedImages : undefined,
  };
}

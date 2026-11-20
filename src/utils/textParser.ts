export interface TocItem {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

export type BlockNode =
  | { type: 'heading'; level: 1 | 2 | 3; id: string; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'blockquote'; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'hr' };

export function countWords(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/[#*`>~\-[\]()_]/g, ' ').trim();
  const cjkMatches = cleaned.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = cleaned.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ');
  const latinWords = nonCjk.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length;
  return cjkCount + latinWords;
}

export function estimateReadingMinutes(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / 380));
}

export function extractExcerpt(content: string, maxLen = 96): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxLen) return plain;
  return `${plain.slice(0, maxLen).trim()}…`;
}

export function getByteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }
  // Deterministic fallback hash when subtle crypto is unavailable
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatShortDate(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60 * 1000) return '刚刚';
  if (diffMs < 60 * 60 * 1000) return `${Math.floor(diffMs / 60000)} 分钟前`;
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (d.getFullYear() === now.getFullYear()) {
    return `${month}-${day}`;
  }
  return `${d.getFullYear()}-${month}-${day}`;
}

// Detect Chinese chapter headings in plain .txt documents
const CN_CHAPTER_RE = /^(第[零一二三四五六七八九十百千万0-9]+[章卷部节篇回][\s：:、]?.*|[一二三四五六七八九十]+、.{1,28})$/;

export function parseDocumentBlocks(content: string): { blocks: BlockNode[]; toc: TocItem[] } {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: BlockNode[] = [];
  const toc: TocItem[] = [];
  let headingCounter = 0;
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Markdown heading
    const mdHeading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (mdHeading) {
      headingCounter++;
      const level = mdHeading[1].length as 1 | 2 | 3;
      const text = mdHeading[2].trim();
      const id = `heading-${headingCounter}`;
      blocks.push({ type: 'heading', level, id, text });
      toc.push({ id, text, level });
      i++;
      continue;
    }

    // Plain-text Chinese chapter title detection
    if (CN_CHAPTER_RE.test(trimmed) && trimmed.length <= 36) {
      headingCounter++;
      const level: 1 | 2 = trimmed.startsWith('第') && /[章卷部篇]/.test(trimmed) ? 1 : 2;
      const id = `heading-${headingCounter}`;
      blocks.push({ type: 'heading', level, id, text: trimmed });
      toc.push({ id, text: trimmed, level });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // Paragraph (merge consecutive plain lines until blank or block starter)
    const paraLines: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (
        !next ||
        next.startsWith('```') ||
        next.startsWith('#') ||
        next.startsWith('>') ||
        /^[-*+]\s+/.test(next) ||
        /^\d+\.\s+/.test(next) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(next) ||
        (CN_CHAPTER_RE.test(next) && next.length <= 36)
      ) {
        break;
      }
      paraLines.push(next);
      i++;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
  }

  return { blocks, toc };
}

// Decode uploaded .txt / .md file with UTF-8 first, falling back to GB18030 for legacy Chinese .txt files
export async function readTextFileSmart(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return utf8.replace(/^\uFEFF/, '');
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}

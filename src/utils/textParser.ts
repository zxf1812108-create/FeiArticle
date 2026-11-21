export interface TocItem {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

export type TableAlignment = 'left' | 'center' | 'right';

export type BlockNode =
  | { type: 'heading'; level: 1 | 2 | 3; id: string; text: string; startOffset: number; endOffset: number }
  | { type: 'paragraph'; text: string; startOffset: number; endOffset: number }
  | { type: 'blockquote'; text: string; startOffset: number; endOffset: number }
  | { type: 'code'; language: string; code: string; startOffset: number; endOffset: number }
  | { type: 'list'; ordered: boolean; items: string[]; startOffset: number; endOffset: number }
  | {
      type: 'table';
      headers: string[];
      alignments: TableAlignment[];
      rows: string[][];
      startOffset: number;
      endOffset: number;
    }
  | { type: 'hr'; startOffset: number; endOffset: number };

function splitTableCells(rawLine: string): string[] {
  let line = rawLine.trim();
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|') && !line.endsWith('\\|')) line = line.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length && line[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableDelimiterRow(rawLine: string): TableAlignment[] | null {
  const trimmed = rawLine.trim();
  if (!trimmed.includes('|')) return null;
  const cells = splitTableCells(trimmed);
  if (cells.length === 0) return null;

  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) {
      return null;
    }
    if (cell.startsWith(':') && cell.endsWith(':')) {
      alignments.push('center');
    } else if (cell.endsWith(':')) {
      alignments.push('right');
    } else {
      alignments.push('left');
    }
  }
  return alignments;
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const headerLine = lines[index].trim();
  const sepLine = lines[index + 1].trim();
  if (!headerLine.includes('|') || !sepLine.includes('|')) return false;
  const alignments = parseTableDelimiterRow(sepLine);
  if (!alignments) return false;
  const headers = splitTableCells(headerLine);
  return headers.length > 0 && headers.length === alignments.length;
}

export function countWords(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/[#*`>~\-[\]()_|]/g, ' ').trim();
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
    .replace(/[*_`>~|]/g, ' ')
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

// Explicit structural heading patterns for plain-text documents (never guesses headings on ordinary prose)
const CN_CHAPTER_RE =
  /^第[零一二三四五六七八九十百千万0-9]+[章卷部节篇回](?:[\s：:、].{0,36})?$/;

const CN_ENUM_HEADING_RE = /^[一二三四五六七八九十百]+、\s*\S.{0,30}$/;

const CN_PAREN_HEADING_RE = /^[（(][一二三四五六七八九十0-9]+[)）]\s*\S.{0,30}$/;

const EN_CHAPTER_RE =
  /^(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b(?:[:\s—–-].{0,48})?$/i;

const EN_SECTION_RE =
  /^section\s+(?:\d+(?:\.\d+)*|[ivxlcdm]+)\b(?:[:\s—–-].{0,48})?$/i;

const DECIMAL_SECTION_RE = /^\d+(?:\.\d+)+\.?\s+\S.{1,48}$/;

function isSentenceEnding(line: string): boolean {
  return /[。？！；，,.;?!]$/.test(line);
}

function detectPlainTextHeadingLevel(trimmed: string): 1 | 2 | 3 | null {
  if (!trimmed || trimmed.length > 64) return null;

  if (CN_CHAPTER_RE.test(trimmed)) {
    if (/[章卷部篇]/.test(trimmed.slice(0, 12))) return 1;
    return 2;
  }

  if (CN_ENUM_HEADING_RE.test(trimmed) && !isSentenceEnding(trimmed)) {
    return 2;
  }

  if (CN_PAREN_HEADING_RE.test(trimmed) && !isSentenceEnding(trimmed)) {
    return 3;
  }

  if (EN_CHAPTER_RE.test(trimmed) && !/[.,;?!]$/.test(trimmed)) {
    return 1;
  }

  if (EN_SECTION_RE.test(trimmed) && !/[.,;?!]$/.test(trimmed)) {
    return 2;
  }

  if (DECIMAL_SECTION_RE.test(trimmed) && !isSentenceEnding(trimmed)) {
    const dotCount = (trimmed.match(/^\d+(?:\.\d+)+/)?.[0].match(/\./g) || []).length;
    return dotCount >= 2 ? 3 : 2;
  }

  return null;
}

interface RawLineSpan {
  text: string;
  startOffset: number;
  endOffset: number;
}

function splitLinesWithOffsets(content: string): RawLineSpan[] {
  const spans: RawLineSpan[] = [];
  const len = content.length;
  let lineStart = 0;

  for (let i = 0; i < len; i++) {
    if (content[i] === '\n') {
      const hasCr = i > lineStart && content[i - 1] === '\r';
      const lineEnd = hasCr ? i - 1 : i;
      spans.push({
        text: content.slice(lineStart, lineEnd),
        startOffset: lineStart,
        endOffset: lineEnd,
      });
      lineStart = i + 1;
    }
  }

  spans.push({
    text: content.slice(lineStart, len),
    startOffset: lineStart,
    endOffset: len,
  });

  return spans;
}

export function parseDocumentBlocks(content: string): { blocks: BlockNode[]; toc: TocItem[] } {
  const spans = splitLinesWithOffsets(content);
  const lines = spans.map((s) => s.text);
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

    const blockStart = spans[i].startOffset;

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      const endLineIdx = Math.min(i, spans.length - 1);
      const blockEnd = spans[endLineIdx].endOffset;
      if (i < lines.length) i++;
      blocks.push({
        type: 'code',
        language,
        code: codeLines.join('\n'),
        startOffset: blockStart,
        endOffset: blockEnd,
      });
      continue;
    }

    // Setext underlined heading (Title \n ===== or Title \n -----)
    if (
      i + 1 < lines.length &&
      trimmed.length <= 68 &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('>')
    ) {
      const underline = lines[i + 1].trim();
      if (/^={3,}$/.test(underline) || /^-{3,}$/.test(underline)) {
        headingCounter++;
        const level: 1 | 2 = underline.startsWith('=') ? 1 : 2;
        const id = `heading-${headingCounter}`;
        blocks.push({
          type: 'heading',
          level,
          id,
          text: trimmed,
          startOffset: blockStart,
          endOffset: spans[i + 1].endOffset,
        });
        toc.push({ id, text: trimmed, level });
        i += 2;
        continue;
      }
    }

    // GFM Markdown table
    if (isTableStart(lines, i)) {
      const headers = splitTableCells(lines[i]);
      const alignments = parseTableDelimiterRow(lines[i + 1])!;
      const colCount = headers.length;
      const rows: string[][] = [];
      let lastRowIdx = i + 1;
      i += 2;

      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || !rowLine.includes('|')) break;
        if (
          rowLine.startsWith('```') ||
          rowLine.startsWith('#') ||
          rowLine.startsWith('>') ||
          /^(-{3,}|\*{3,}|_{3,})$/.test(rowLine)
        ) {
          break;
        }
        const cells = splitTableCells(rowLine);
        const normalizedRow = Array.from({ length: colCount }, (_, colIdx) => cells[colIdx] ?? '');
        rows.push(normalizedRow);
        lastRowIdx = i;
        i++;
      }

      blocks.push({
        type: 'table',
        headers,
        alignments,
        rows,
        startOffset: blockStart,
        endOffset: spans[lastRowIdx].endOffset,
      });
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({
        type: 'hr',
        startOffset: blockStart,
        endOffset: spans[i].endOffset,
      });
      i++;
      continue;
    }

    // Markdown heading (# to ######, clamped to levels 1..3)
    const mdHeading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (mdHeading) {
      headingCounter++;
      const rawLevel = mdHeading[1].length;
      const level = (rawLevel <= 1 ? 1 : rawLevel === 2 ? 2 : 3) as 1 | 2 | 3;
      const text = mdHeading[2].trim();
      const id = `heading-${headingCounter}`;
      blocks.push({
        type: 'heading',
        level,
        id,
        text,
        startOffset: blockStart,
        endOffset: spans[i].endOffset,
      });
      toc.push({ id, text, level });
      i++;
      continue;
    }

    // Plain-text (.txt) explicit structural heading detection
    const txtHeadingLevel = detectPlainTextHeadingLevel(trimmed);
    if (txtHeadingLevel) {
      headingCounter++;
      const id = `heading-${headingCounter}`;
      blocks.push({
        type: 'heading',
        level: txtHeadingLevel,
        id,
        text: trimmed,
        startOffset: blockStart,
        endOffset: spans[i].endOffset,
      });
      toc.push({ id, text: trimmed, level: txtHeadingLevel });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      let lastQuoteIdx = i;
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        lastQuoteIdx = i;
        i++;
      }
      blocks.push({
        type: 'blockquote',
        text: quoteLines.join('\n'),
        startOffset: blockStart,
        endOffset: spans[lastQuoteIdx].endOffset,
      });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      let lastItemIdx = i;
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        lastItemIdx = i;
        i++;
      }
      blocks.push({
        type: 'list',
        ordered: false,
        items,
        startOffset: blockStart,
        endOffset: spans[lastItemIdx].endOffset,
      });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      let lastItemIdx = i;
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        lastItemIdx = i;
        i++;
      }
      blocks.push({
        type: 'list',
        ordered: true,
        items,
        startOffset: blockStart,
        endOffset: spans[lastItemIdx].endOffset,
      });
      continue;
    }

    // Paragraph: each non-empty line becomes its own paragraph block for uniform paragraph spacing
    blocks.push({
      type: 'paragraph',
      text: trimmed,
      startOffset: blockStart,
      endOffset: spans[i].endOffset,
    });
    i++;
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

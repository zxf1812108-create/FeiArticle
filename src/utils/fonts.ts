import { DocFontId } from '../types';

export const DOC_FONT_OPTIONS: ReadonlyArray<{ id: DocFontId; label: string }> = [
  { id: 'system', label: '系统字体' },
  { id: 'noto-sans-sc', label: '思源黑体' },
  { id: 'noto-serif-sc', label: '思源宋体' },
  { id: 'inter', label: 'Inter' },
];

const VALID_DOC_FONT_IDS = new Set<string>(DOC_FONT_OPTIONS.map((o) => o.id));

export const DEFAULT_DOC_FONT: DocFontId = 'system';

export function isValidDocFontId(id: unknown): id is DocFontId {
  return typeof id === 'string' && VALID_DOC_FONT_IDS.has(id);
}

/**
 * Resolve effective default font, falling back to 'system' if missing or nonexistent.
 */
export function resolveDefaultDocFont(defaultFont?: unknown): DocFontId {
  return isValidDocFontId(defaultFont) ? defaultFont : DEFAULT_DOC_FONT;
}

/**
 * Resolve the effective font for a document:
 * - If the document has a stored selection and it exists in DOC_FONT_OPTIONS, keep it.
 * - If never selected or the previously selected font no longer exists, fall back to defaultFont.
 */
export function resolveDocFont(storedFont: unknown, defaultFont: DocFontId): DocFontId {
  const safeDefault = resolveDefaultDocFont(defaultFont);
  return isValidDocFontId(storedFont) ? storedFont : safeDefault;
}

function getFontTokens(id: DocFontId): string[] {
  switch (id) {
    case 'noto-sans-sc':
      return ['"Noto Sans SC"', '"Source Han Sans SC"', '"Source Han Sans CN"'];
    case 'noto-serif-sc':
      return ['"Noto Serif SC"', '"Source Han Serif SC"', '"Source Han Serif CN"', 'serif'];
    case 'inter':
      return ['"Inter"'];
    case 'system':
    default:
      return [
        'system-ui',
        '-apple-system',
        'BlinkMacSystemFont',
        '"PingFang SC"',
        '"Hiragino Sans GB"',
        '"Microsoft YaHei"',
        '"Roboto"',
        '"Segoe UI"',
        'sans-serif',
      ];
  }
}

/**
 * Build a CSS font-family stack for the selected document font applying across all text,
 * falling back to the default font and device system font when needed.
 */
export function buildDocFontFamily(
  fontId: DocFontId,
  defaultFont: DocFontId = DEFAULT_DOC_FONT
): string {
  const safeDefault = resolveDefaultDocFont(defaultFont);
  const safeFont = resolveDocFont(fontId, safeDefault);

  const tokens: string[] = [];
  const pushUnique = (list: string[]) => {
    for (const item of list) {
      if (!tokens.includes(item)) {
        tokens.push(item);
      }
    }
  };

  pushUnique(getFontTokens(safeFont));
  if (safeFont !== safeDefault) {
    pushUnique(getFontTokens(safeDefault));
  }
  pushUnique(getFontTokens('system'));

  return tokens.join(', ');
}

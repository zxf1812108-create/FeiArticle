import { DocFontChoice, DocFontId } from '../types';

export const DOC_FONT_OPTIONS: ReadonlyArray<{ id: DocFontId; label: string }> = [
  { id: 'system', label: '系统字体' },
  { id: 'noto-sans-sc', label: '思源黑体' },
  { id: 'noto-serif-sc', label: '思源宋体' },
  { id: 'inter', label: 'Inter' },
  { id: 'brela', label: 'Brela' },
];

const VALID_DOC_FONT_IDS = new Set<string>(DOC_FONT_OPTIONS.map((o) => o.id));

export const DEFAULT_DOC_FONT_CHOICE: DocFontChoice = {
  zhFont: 'system',
  enFont: 'system',
};

export function isValidDocFontId(id: unknown): id is DocFontId {
  return typeof id === 'string' && VALID_DOC_FONT_IDS.has(id);
}

/**
 * Resolve effective default fonts, falling back to 'system' if missing or nonexistent.
 */
export function resolveDefaultDocFonts(
  defaultZhFont?: unknown,
  defaultEnFont?: unknown
): DocFontChoice {
  return {
    zhFont: isValidDocFontId(defaultZhFont) ? defaultZhFont : DEFAULT_DOC_FONT_CHOICE.zhFont,
    enFont: isValidDocFontId(defaultEnFont) ? defaultEnFont : DEFAULT_DOC_FONT_CHOICE.enFont,
  };
}

/**
 * Resolve the effective font pair for a document:
 * - If the document has a stored selection and the font exists, keep it.
 * - If never chosen or the previously chosen font does not exist, fall back to the default font.
 */
export function resolveDocFontChoice(
  docChoice: Partial<{ zhFont: unknown; enFont: unknown }> | null | undefined,
  defaultFonts: DocFontChoice
): DocFontChoice {
  const safeDefaults = resolveDefaultDocFonts(defaultFonts.zhFont, defaultFonts.enFont);
  if (!docChoice) return safeDefaults;
  return {
    zhFont: isValidDocFontId(docChoice.zhFont) ? docChoice.zhFont : safeDefaults.zhFont,
    enFont: isValidDocFontId(docChoice.enFont) ? docChoice.enFont : safeDefaults.enFont,
  };
}

function getEnFontTokens(id: DocFontId): string[] {
  switch (id) {
    case 'inter':
      return ['"Inter"'];
    case 'noto-sans-sc':
      return ['"Noto Sans"'];
    case 'noto-serif-sc':
      return ['"Noto Serif"'];
    case 'brela':
      return ['"FeiEnBrela"', '"Brela"', '"Brela Regular"'];
    case 'system':
    default:
      return ['"FeiEnSystem"'];
  }
}

function getZhFontTokens(id: DocFontId): string[] {
  switch (id) {
    case 'noto-sans-sc':
      return [
        '"Noto Sans SC"',
        '"Source Han Sans SC"',
        '"Source Han Sans CN"',
        '"Noto Sans CJK SC"',
      ];
    case 'noto-serif-sc':
      return [
        '"Noto Serif SC"',
        '"Source Han Serif SC"',
        '"Source Han Serif CN"',
        '"Noto Serif CJK SC"',
        '"Songti SC"',
        '"STSong"',
      ];
    case 'inter':
      return ['"Inter"'];
    case 'brela':
      return ['"Brela"', '"Brela Regular"'];
    case 'system':
    default:
      return [
        '-apple-system',
        'BlinkMacSystemFont',
        '"PingFang SC"',
        '"Hiragino Sans GB"',
        '"Microsoft YaHei"',
        '"Roboto"',
        'sans-serif',
      ];
  }
}

/**
 * Build a CSS font-family stack combining independent English and Chinese font choices,
 * degrading gracefully to the user's configured default fonts and system fonts if unavailable.
 */
export function buildDocFontFamily(
  choice: DocFontChoice,
  defaultFonts: DocFontChoice = DEFAULT_DOC_FONT_CHOICE
): string {
  const safeDefaults = resolveDefaultDocFonts(defaultFonts.zhFont, defaultFonts.enFont);
  const safeChoice = resolveDocFontChoice(choice, safeDefaults);

  const tokens: string[] = [];
  const pushUnique = (list: string[]) => {
    for (const item of list) {
      if (!tokens.includes(item)) {
        tokens.push(item);
      }
    }
  };

  pushUnique(getEnFontTokens(safeChoice.enFont));
  if (safeChoice.enFont !== safeDefaults.enFont) {
    pushUnique(getEnFontTokens(safeDefaults.enFont));
  }

  pushUnique(getZhFontTokens(safeChoice.zhFont));
  if (safeChoice.zhFont !== safeDefaults.zhFont) {
    pushUnique(getZhFontTokens(safeDefaults.zhFont));
  }

  pushUnique([
    '-apple-system',
    'BlinkMacSystemFont',
    '"PingFang SC"',
    '"Hiragino Sans GB"',
    '"Microsoft YaHei"',
    '"Noto Sans SC"',
    'sans-serif',
  ]);

  return tokens.join(', ');
}

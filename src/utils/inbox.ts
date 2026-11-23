import { sha256Hex } from './textParser';

export const INBOX_FOLDER_ID = '__inbox__';
export const INBOX_FOLDER_NAME = 'inbox';

export function isReservedInboxName(name: string): boolean {
  return name.trim().toLowerCase() === INBOX_FOLDER_NAME;
}

export interface DuplicateCheckDoc {
  title: string;
  contentHash: string;
  deleted?: boolean;
}

export type DuplicateResolveResult =
  | { action: 'skip'; contentHash: string }
  | { action: 'create'; title: string; contentHash: string };

function isSameOrNumberedTitle(docTitle: string, baseTitle: string): boolean {
  if (docTitle === baseTitle) return true;
  if (!docTitle.startsWith(`${baseTitle} (`) || !docTitle.endsWith(')')) return false;
  const numPart = docTitle.slice(baseTitle.length + 2, -1);
  return /^\d+$/.test(numPart);
}

/**
 * Minimalist duplicate handling:
 * - Same title (or numbered copy of same base title) + identical SHA-256 content hash => silently skip duplicate
 * - Same title + different content => never overwrite; auto-append " (2)", " (3)", ...
 */
export async function resolveDuplicateDocImport(
  rawTitle: string,
  content: string,
  existingDocs: DuplicateCheckDoc[]
): Promise<DuplicateResolveResult> {
  const baseTitle = rawTitle.trim() || '导入文档';
  const contentHash = await sha256Hex(content);
  const liveDocs = existingDocs.filter((d) => !d.deleted);

  const hasExactDuplicate = liveDocs.some(
    (d) => d.contentHash === contentHash && isSameOrNumberedTitle(d.title, baseTitle)
  );

  if (hasExactDuplicate) {
    return { action: 'skip', contentHash };
  }

  const existingTitles = new Set(liveDocs.map((d) => d.title));
  if (!existingTitles.has(baseTitle)) {
    return { action: 'create', title: baseTitle, contentHash };
  }

  let index = 2;
  while (existingTitles.has(`${baseTitle} (${index})`)) {
    index++;
  }
  return { action: 'create', title: `${baseTitle} (${index})`, contentHash };
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractPathName(rawHref: string): string {
  const decodedXml = decodeXmlEntities(rawHref.trim());
  try {
    if (/^https?:\/\//i.test(decodedXml)) {
      return new URL(decodedXml).pathname;
    }
  } catch {
    // fall through
  }
  return decodedXml;
}

export interface RemoteInboxFile {
  name: string;
  relPath: string;
  size?: number;
}

const SUPPORTED_TEXT_EXT_RE = /\.(txt|md|markdown|text)$/i;

/**
 * Parse WebDAV PROPFIND XML (Depth: 1) for files inside the inbox/ folder.
 */
export function parseWebDavInboxXml(xml: string, inboxDirUrl: string): RemoteInboxFile[] {
  if (!xml) return [];

  let inboxDirPath = '/dav/FeiArtical/inbox';
  try {
    inboxDirPath = new URL(inboxDirUrl).pathname.replace(/\/+$/, '');
  } catch {
    inboxDirPath = inboxDirUrl.replace(/\/+$/, '');
  }

  const files: RemoteInboxFile[] = [];
  const seenNames = new Set<string>();
  const responseRe = /<(?:[a-zA-Z0-9_-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?response>/gi;
  let match: RegExpExecArray | null;

  while ((match = responseRe.exec(xml)) !== null) {
    const block = match[1];
    const hrefMatch = block.match(
      /<(?:[a-zA-Z0-9_-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?href>/i
    );
    if (!hrefMatch) continue;

    const rawPath = extractPathName(hrefMatch[1]);
    const isCollection =
      /<(?:[a-zA-Z0-9_-]+:)?collection\b/i.test(block) || rawPath.endsWith('/');
    if (isCollection) continue;

    const trimmedPath = rawPath.replace(/\/+$/, '');
    if (trimmedPath === inboxDirPath) continue;

    const lastSlash = trimmedPath.lastIndexOf('/');
    const rawSegment = lastSlash >= 0 ? trimmedPath.slice(lastSlash + 1) : trimmedPath;
    if (!rawSegment) continue;

    let decodedName = rawSegment;
    try {
      decodedName = decodeURIComponent(rawSegment);
    } catch {
      decodedName = rawSegment;
    }

    if (decodedName.startsWith('.')) continue;
    if (!SUPPORTED_TEXT_EXT_RE.test(decodedName)) continue;
    if (seenNames.has(decodedName)) continue;
    seenNames.add(decodedName);

    const lenMatch = block.match(
      /<(?:[a-zA-Z0-9_-]+:)?getcontentlength\b[^>]*>\s*(\d+)\s*<\/(?:[a-zA-Z0-9_-]+:)?getcontentlength>/i
    );
    const parsedSize = lenMatch ? Number.parseInt(lenMatch[1], 10) : undefined;

    files.push({
      name: decodedName,
      relPath: `${INBOX_FOLDER_NAME}/${encodeURIComponent(decodedName)}`,
      size: typeof parsedSize === 'number' && Number.isFinite(parsedSize) ? parsedSize : undefined,
    });
  }

  return files;
}

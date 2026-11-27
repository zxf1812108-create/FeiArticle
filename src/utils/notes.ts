import { ReadingNote } from '../types';
import {
  extractBackupAnchorText,
  extractReadAnchorText,
  relocateOffsetAfterContentEdit,
} from './progressSync';
import { TRASH_RETENTION_MS } from './trash';

export function getActiveNotes(notes?: ReadingNote[] | null): ReadingNote[] {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  return notes
    .filter((n) => n && !n.deleted && typeof n.content === 'string' && n.content.trim().length > 0)
    .sort((a, b) => a.charOffset - b.charOffset || a.createdAt - b.createdAt);
}

export function sanitizeNotesList(notes?: ReadingNote[] | null, now = Date.now()): ReadingNote[] {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  const out: ReadingNote[] = [];
  for (const n of notes) {
    if (!n || typeof n.id !== 'string' || !n.id) continue;
    if (n.deleted) {
      const delTs = n.deletedAt ?? n.updatedAt ?? 0;
      if (delTs > 0 && now - delTs > TRASH_RETENTION_MS) {
        continue;
      }
      out.push({
        id: n.id,
        charOffset: Math.max(0, Math.round(n.charOffset || 0)),
        anchorText: typeof n.anchorText === 'string' ? n.anchorText : '',
        content: '',
        createdAt: n.createdAt || now,
        updatedAt: n.updatedAt || now,
        deleted: true,
        deletedAt: delTs || now,
      });
      continue;
    }
    if (typeof n.content !== 'string' || !n.content.trim()) continue;
    const backup =
      typeof n.backupAnchorText === 'string' && n.backupAnchorText.trim()
        ? n.backupAnchorText.trim()
        : undefined;
    out.push({
      id: n.id,
      charOffset: Math.max(0, Math.round(n.charOffset || 0)),
      anchorText: typeof n.anchorText === 'string' ? n.anchorText : '',
      ...(backup ? { backupAnchorText: backup } : {}),
      content: n.content,
      createdAt: n.createdAt || now,
      updatedAt: n.updatedAt || now,
    });
  }
  out.sort((a, b) => a.charOffset - b.charOffset || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out;
}

export function mergeReadingNotes(
  localNotes?: ReadingNote[] | null,
  remoteNotes?: ReadingNote[] | null,
  now = Date.now()
): ReadingNote[] {
  const map = new Map<string, ReadingNote>();

  for (const note of sanitizeNotesList(localNotes, now)) {
    map.set(note.id, note);
  }

  for (const rNote of sanitizeNotesList(remoteNotes, now)) {
    const existing = map.get(rNote.id);
    if (!existing) {
      map.set(rNote.id, rNote);
      continue;
    }
    if (rNote.updatedAt > existing.updatedAt) {
      map.set(rNote.id, rNote);
    } else if (rNote.updatedAt === existing.updatedAt && rNote.deleted && !existing.deleted) {
      map.set(rNote.id, rNote);
    }
  }

  return sanitizeNotesList(Array.from(map.values()), now);
}

export function notesSignature(notes?: ReadingNote[] | null): string {
  const clean = sanitizeNotesList(notes);
  if (clean.length === 0) return '';
  return clean
    .map(
      (n) =>
        `${n.id}:${n.charOffset}:${n.updatedAt}:${n.deleted ? 1 : 0}:${n.deleted ? 0 : n.content.length}:${
          n.deleted ? '' : n.content
        }`
    )
    .join('\u001f');
}

export function notesEqual(a?: ReadingNote[] | null, b?: ReadingNote[] | null): boolean {
  return notesSignature(a) === notesSignature(b);
}

export const NOTE_ANCHOR_MAX_CHARS = 48;

export function extractNoteAnchorExcerpt(
  rawParagraphText: string,
  maxChars = NOTE_ANCHOR_MAX_CHARS
): string {
  const cleaned = rawParagraphText
    .replace(/\r\n?/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~[\]]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trim();
}

/**
 * Extract a clean, ellipsis-free anchor text starting at `charOffset` in raw content.
 * Automatically spans across short lines/headings to gather ~48 chars so bookmark
 * relocation stays accurate even after large edits earlier in the document.
 */
export function extractNoteAnchorText(
  rawContent: string,
  charOffset: number,
  fallbackText = '',
  maxChars = NOTE_ANCHOR_MAX_CHARS
): string {
  if (rawContent) {
    const fromRaw = extractReadAnchorText(rawContent, charOffset, maxChars);
    if (fromRaw.length >= 6) {
      return fromRaw;
    }
  }
  const fromFallback = extractNoteAnchorExcerpt(fallbackText, maxChars);
  if (fromFallback) return fromFallback;
  return rawContent ? extractReadAnchorText(rawContent, charOffset, maxChars) : '';
}

export interface RelocateNotesOptions {
  prevContent?: string;
  bumpUpdatedAt?: boolean;
  now?: number;
}

export function relocateNotesAfterContentEdit(
  notes: ReadingNote[] | undefined,
  newContent: string,
  options?: RelocateNotesOptions
): ReadingNote[] | undefined {
  if (!Array.isArray(notes) || notes.length === 0 || !newContent) return notes;
  const prevContent = options?.prevContent || '';
  const bumpUpdatedAt = Boolean(options?.bumpUpdatedAt);
  const now = options?.now ?? Date.now();

  let anyChanged = false;
  const next = notes.map((note) => {
    if (note.deleted) return note;

    const storedAnchor = (note.anchorText || '').trim();
    const storedBackup = (note.backupAnchorText || '').trim();
    const needsRicherAnchor =
      Boolean(prevContent) &&
      (!storedAnchor || storedAnchor.endsWith('…') || storedAnchor.length < 18);
    const prevExtractedAnchor = needsRicherAnchor
      ? extractReadAnchorText(prevContent, note.charOffset, NOTE_ANCHOR_MAX_CHARS)
      : '';
    const effectiveAnchor =
      prevExtractedAnchor.length >= 6 ? prevExtractedAnchor : storedAnchor;

    if (effectiveAnchor || storedBackup || prevContent) {
      const relocated = relocateOffsetAfterContentEdit(newContent, note.charOffset, {
        prevContent: prevContent || undefined,
        primaryAnchor: effectiveAnchor || undefined,
        backupAnchor: storedBackup || undefined,
        fallbackToBoundaryOnDelete: true,
      });
      if (relocated.matched) {
        const offsetChanged = relocated.offset !== note.charOffset;
        const cleanedStored = storedAnchor.replace(/(?:…|\.{3,})\s*$/u, '').trim();
        const refreshedPrimary = extractReadAnchorText(
          newContent,
          relocated.offset,
          NOTE_ANCHOR_MAX_CHARS
        );
        const nextAnchorText =
          refreshedPrimary.length >= 6
            ? refreshedPrimary
            : storedAnchor
              ? prevExtractedAnchor.length > cleanedStored.length
                ? prevExtractedAnchor
                : cleanedStored
              : storedAnchor;
        const nextBackupAnchorText =
          extractBackupAnchorText(newContent, relocated.offset) || storedBackup || undefined;
        const anchorChanged =
          nextAnchorText !== note.anchorText ||
          (nextBackupAnchorText || '') !== (note.backupAnchorText || '');
        if (offsetChanged || anchorChanged) {
          anyChanged = true;
          return {
            ...note,
            charOffset: relocated.offset,
            anchorText: nextAnchorText,
            ...(nextBackupAnchorText ? { backupAnchorText: nextBackupAnchorText } : {}),
            ...(bumpUpdatedAt && offsetChanged
              ? { updatedAt: Math.max(now, note.updatedAt + 1) }
              : {}),
          };
        }
        return note;
      }
    }

    const clamped = Math.min(newContent.length, Math.max(0, note.charOffset));
    if (clamped !== note.charOffset) {
      anyChanged = true;
      return {
        ...note,
        charOffset: clamped,
        ...(bumpUpdatedAt ? { updatedAt: Math.max(now, note.updatedAt + 1) } : {}),
      };
    }
    return note;
  });
  return anyChanged ? next : notes;
}

/**
 * Format user-written notes as clean Markdown containing ONLY the user's own note content
 * (no original text excerpts).
 */
export function formatNotesAsPureMarkdown(docTitle: string, notes: ReadingNote[]): string {
  const active = getActiveNotes(notes);
  if (active.length === 0) return '';
  const safeTitle = (docTitle || '读书笔记').trim();
  const body = active.map((n) => n.content.trim()).join('\n\n---\n\n');
  return `# ${safeTitle} · 读书笔记\n\n${body}\n`;
}

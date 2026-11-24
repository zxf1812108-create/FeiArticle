import { ReadingNote } from '../types';
import { relocateCharOffsetByAnchor } from './progressSync';
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
    out.push({
      id: n.id,
      charOffset: Math.max(0, Math.round(n.charOffset || 0)),
      anchorText: typeof n.anchorText === 'string' ? n.anchorText : '',
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

export function extractNoteAnchorExcerpt(rawParagraphText: string, maxChars = 36): string {
  const cleaned = rawParagraphText
    .replace(/\r\n?/g, ' ')
    .replace(/[#>*_`~[\]]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars).trim()}…`;
}

export function relocateNotesAfterContentEdit(
  notes: ReadingNote[] | undefined,
  newContent: string
): ReadingNote[] | undefined {
  if (!Array.isArray(notes) || notes.length === 0 || !newContent) return notes;
  let anyChanged = false;
  const next = notes.map((note) => {
    if (note.deleted || !note.anchorText) return note;
    const relocated = relocateCharOffsetByAnchor(newContent, note.charOffset, note.anchorText);
    if (relocated.matched && relocated.offset !== note.charOffset) {
      anyChanged = true;
      return { ...note, charOffset: relocated.offset };
    }
    const clamped = Math.min(newContent.length, Math.max(0, note.charOffset));
    if (clamped !== note.charOffset) {
      anyChanged = true;
      return { ...note, charOffset: clamped };
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

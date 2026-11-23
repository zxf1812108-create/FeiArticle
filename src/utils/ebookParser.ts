import {
  convertHtmlToMarkdown,
  decodeBytesSmart,
  detectImageInfoFromBytes,
  ExtractedEbookImage,
  formatMarkdownImage,
  HtmlImageResolver,
  parseEpubFile,
  sanitizeBookImageDirName,
  unzipFiltered,
} from './epubParser';

export type { ExtractedEbookImage };

export interface ParsedEbookDocument {
  title: string;
  content: string;
  images?: ExtractedEbookImage[];
}

const EPUB_EXT_RE = /\.epub$/i;
const MOBI_EXT_RE = /\.(mobi|azw3|azw|kf8|prc)$/i;
const FB2_EXT_RE = /\.fb2(\.zip)?$/i;
const HTML_EXT_RE = /\.(html|htm|xhtml)$/i;
const PLAIN_TEXT_EXT_RE = /\.(txt|md|markdown|text)$/i;

const EBOOK_MIME_TYPES = new Set([
  'application/epub+zip',
  'application/x-mobipocket-ebook',
  'application/vnd.amazon.ebook',
  'application/vnd.amazon.mobi8-ebook',
  'application/x-fictionbook+xml',
  'application/x-fictionbook',
  'text/html',
  'application/xhtml+xml',
]);

export function isEbookFile(file: File): boolean {
  const name = file.name || '';
  const type = (file.type || '').toLowerCase();
  return (
    EPUB_EXT_RE.test(name) ||
    MOBI_EXT_RE.test(name) ||
    FB2_EXT_RE.test(name) ||
    HTML_EXT_RE.test(name) ||
    EBOOK_MIME_TYPES.has(type)
  );
}

export function isSupportedImportFile(file: File): boolean {
  const name = file.name || '';
  const type = (file.type || '').toLowerCase();
  return (
    isEbookFile(file) ||
    PLAIN_TEXT_EXT_RE.test(name) ||
    type.startsWith('text/')
  );
}

function stripEbookExtension(fileName: string): string {
  return (
    fileName
      .replace(/\.fb2\.zip$/i, '')
      .replace(/\.(epub|mobi|azw3|azw|kf8|prc|fb2|html|htm|xhtml|txt|md|markdown|text)$/i, '')
      .trim() || '导入文档'
  );
}

function isGenericBookTitle(title: string): boolean {
  return /^(unknown|untitled|book|document|无标题|未命名)$/i.test(title.trim());
}

function readAscii(bytes: Uint8Array, start: number, len: number): string {
  let out = '';
  const end = Math.min(bytes.length, start + len);
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out;
}

function decodeMobiBytes(bytes: Uint8Array, encodingCode: number): string {
  if (encodingCode === 65001) {
    return decodeBytesSmart(bytes);
  }
  // Encoding 1252 is Windows-1252, though some legacy Chinese MOBI files mislabel UTF-8/GB18030 as 1252
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    if (encodingCode === 1252) {
      // Heuristic: if high-byte pairs dominate like GBK/GB18030, check GB18030 vs Windows-1252
      let highBytes = 0;
      let sampleLen = Math.min(bytes.length, 4096);
      for (let i = 0; i < sampleLen; i++) {
        if (bytes[i] >= 0x80) highBytes++;
      }
      if (highBytes > sampleLen * 0.15) {
        try {
          const gbText = new TextDecoder('gb18030').decode(bytes).replace(/^\uFEFF/, '');
          const cjkMatches = gbText.slice(0, 2000).match(/[\u4e00-\u9fff]/g);
          if (cjkMatches && cjkMatches.length >= 12) {
            return gbText;
          }
        } catch {
          // fall through to windows-1252
        }
      }
      try {
        return new TextDecoder('windows-1252').decode(bytes).replace(/^\uFEFF/, '');
      } catch {
        // fall through
      }
    }
    return decodeBytesSmart(bytes);
  }
}

/**
 * Strip Mobipocket trailing extra data bytes from a text record before decompression.
 * Follows the PalmDOC/MOBI extraDataFlags specification:
 *  - Bits 1..15 (from high bit down to bit 1): backward-encoded VWI specifying trailing byte count.
 *  - Bit 0 (multibyte overlap): last byte's (b & 0x03) + 1 trailing bytes.
 */
function stripMobiTrailingData(record: Uint8Array, extraDataFlags: number): Uint8Array {
  let end = record.length;
  if (end === 0 || extraDataFlags === 0) return record;

  const readBackwardVwi = (limit: number): number => {
    let val = 0;
    let shift = 0;
    let pos = limit - 1;
    const minPos = Math.max(0, limit - 4);
    while (pos >= minPos) {
      const b = record[pos];
      val |= (b & 0x7f) << shift;
      if ((b & 0x80) !== 0) {
        return val;
      }
      shift += 7;
      pos--;
    }
    return val;
  };

  for (let bit = 15; bit >= 1; bit--) {
    if ((extraDataFlags & (1 << bit)) !== 0) {
      if (end <= 0) break;
      const size = readBackwardVwi(end);
      if (size > 0 && size <= end) {
        end -= size;
      }
    }
  }

  if ((extraDataFlags & 1) !== 0 && end > 0) {
    const overlapSize = (record[end - 1] & 0x03) + 1;
    if (overlapSize <= end) {
      end -= overlapSize;
    }
  }

  return record.subarray(0, Math.max(0, end));
}

/**
 * Standard PalmDOC LZ77 decompression (compression type = 2).
 */
function decompressPalmDocLz77(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const c = input[i++];
    if (c === 0) {
      out.push(0);
    } else if (c >= 1 && c <= 8) {
      for (let j = 0; j < c && i < len; j++) {
        out.push(input[i++]);
      }
    } else if (c >= 0x09 && c <= 0x7f) {
      out.push(c);
    } else if (c >= 0x80 && c <= 0xbf) {
      if (i >= len) break;
      const next = input[i++];
      const combined = ((c << 8) | next) & 0x3fff;
      const distance = combined >>> 3;
      const copyLen = (combined & 0x07) + 3;
      if (distance > 0 && distance <= out.length) {
        for (let j = 0; j < copyLen; j++) {
          out.push(out[out.length - distance]);
        }
      }
    } else {
      // 0xc0..0xff: space followed by (c ^ 0x80)
      out.push(0x20, c ^ 0x80);
    }
  }

  return new Uint8Array(out);
}

/**
 * HUFF/CDIC decompressor (compression type = 17480 / 'DH').
 * Uses BigInt for exact unsigned 32-bit/64-bit bit-window comparisons.
 */
class HuffCdicDecompressor {
  private dict1: Array<{ codelen: number; term: boolean; maxcode: bigint }> = [];
  private mincode: bigint[] = new Array(33).fill(0n);
  private maxcode: bigint[] = new Array(33).fill(0n);
  private dict2: Array<{ data: Uint8Array; unpacked: boolean }> = [];

  constructor(huffRecord: Uint8Array, cdicRecords: Uint8Array[]) {
    if (huffRecord.length < 24 || readAscii(huffRecord, 0, 4) !== 'HUFF') {
      throw new Error('HUFF 压缩表头无效');
    }
    const view = new DataView(huffRecord.buffer, huffRecord.byteOffset, huffRecord.byteLength);
    const off1 = view.getUint32(8, false);
    const off2 = view.getUint32(12, false);

    if (off1 + 256 * 4 > huffRecord.length || off2 + 64 * 4 > huffRecord.length) {
      throw new Error('HUFF 压缩表数据不完整');
    }

    for (let i = 0; i < 256; i++) {
      const v = view.getUint32(off1 + i * 4, false);
      const codelen = v & 0x1f;
      const term = (v & 0x80) !== 0;
      let maxc = BigInt(v >>> 8);
      if (codelen === 0) {
        this.dict1.push({ codelen: 0, term: false, maxcode: 0n });
        continue;
      }
      if (!term) {
        maxc = ((maxc + 1n) << BigInt(32 - codelen)) - 1n;
      }
      this.dict1.push({ codelen, term, maxcode: maxc });
    }

    for (let codelen = 1; codelen <= 32; codelen++) {
      const base = off2 + (codelen - 1) * 8;
      const rawMin = BigInt(view.getUint32(base, false));
      const rawMax = BigInt(view.getUint32(base + 4, false));
      const shift = BigInt(32 - codelen);
      this.mincode[codelen] = rawMin << shift;
      this.maxcode[codelen] = ((rawMax + 1n) << shift) - 1n;
    }

    for (const cdic of cdicRecords) {
      if (cdic.length < 16 || readAscii(cdic, 0, 4) !== 'CDIC') continue;
      const cView = new DataView(cdic.buffer, cdic.byteOffset, cdic.byteLength);
      const totalPhrases = cView.getUint32(8, false);
      const bits = cView.getUint32(12, false);
      const maxInThisRecord = 1 << Math.min(bits, 20);
      const remaining = Math.max(0, totalPhrases - this.dict2.length);
      const count = Math.min(maxInThisRecord, remaining);

      for (let i = 0; i < count; i++) {
        const ptrPos = 16 + i * 2;
        if (ptrPos + 2 > cdic.length) break;
        const entryOff = cView.getUint16(ptrPos, false);
        const absPos = 16 + entryOff;
        if (absPos + 2 > cdic.length) break;
        const header = cView.getUint16(absPos, false);
        const sliceLen = header & 0x7fff;
        const isFinal = (header & 0x8000) !== 0;
        const sliceEnd = Math.min(cdic.length, absPos + 2 + sliceLen);
        this.dict2.push({
          data: cdic.subarray(absPos + 2, sliceEnd),
          unpacked: isFinal,
        });
      }
    }
  }

  public unpack(data: Uint8Array, depth = 0): Uint8Array {
    if (depth > 32) return new Uint8Array(0);
    const out: number[] = [];
    const totalBits = data.length * 8;
    let bitPos = 0;

    // Read a 32-bit unsigned big-endian window starting at bitPos (zero-padded past EOF)
    const peek32 = (pos: number): bigint => {
      const byteIdx = pos >>> 3;
      const bitOff = pos & 7;
      let val = 0n;
      for (let k = 0; k < 5; k++) {
        const idx = byteIdx + k;
        const b = idx < data.length ? BigInt(data[idx]) : 0n;
        val = (val << 8n) | b;
      }
      // Shift right to align bitOff..bitOff+31 into lower 32 bits
      return (val >> BigInt(8 - bitOff)) & 0xffffffffn;
    };

    while (bitPos < totalBits) {
      const window32 = peek32(bitPos);
      const topByte = Number(window32 >> 24n);
      const entry = this.dict1[topByte];
      if (!entry || entry.codelen === 0) break;

      let codelen = entry.codelen;
      if (entry.term) {
        const code = window32 >> BigInt(32 - codelen);
        const r = Number(entry.maxcode - code);
        if (bitPos + codelen > totalBits) break;
        bitPos += codelen;
        if (r < 0 || r >= this.dict2.length) break;
        const phrase = this.dict2[r];
        if (!phrase.unpacked) {
          phrase.data = this.unpack(phrase.data, depth + 1);
          phrase.unpacked = true;
        }
        for (let j = 0; j < phrase.data.length; j++) {
          out.push(phrase.data[j]);
        }
        continue;
      }

      while (codelen < 32 && window32 < this.mincode[codelen]) {
        codelen++;
      }
      const codeVal = this.maxcode[codelen];

      if (bitPos + codelen > totalBits) break;
      bitPos += codelen;

      const r = Number((codeVal - window32) >> BigInt(32 - codelen));
      if (r < 0 || r >= this.dict2.length) break;

      const phrase = this.dict2[r];
      if (!phrase.unpacked) {
        phrase.data = this.unpack(phrase.data, depth + 1);
        phrase.unpacked = true;
      }
      for (let j = 0; j < phrase.data.length; j++) {
        out.push(phrase.data[j]);
      }
    }

    return new Uint8Array(out);
  }
}

interface MobiSectionInfo {
  headerRecordIndex: number;
  compression: number;
  textRecordCount: number;
  encryptionType: number;
  textEncoding: number;
  fileVersion: number;
  title: string;
  extraDataFlags: number;
  firstImageRecordIndex: number;
  coverOffset: number;
  huffRecordOffset: number;
  huffRecordCount: number;
  fdstRecordIndex: number;
  kf8Boundary: number;
}

function parseMobiSectionHeader(
  recordBytes: Uint8Array,
  headerRecordIndex: number
): MobiSectionInfo {
  if (recordBytes.length < 16) {
    throw new Error('电子书头部数据不完整');
  }
  const view = new DataView(recordBytes.buffer, recordBytes.byteOffset, recordBytes.byteLength);
  const compression = view.getUint16(0, false);
  const textRecordCount = view.getUint16(8, false);
  const encryptionType = view.getUint16(12, false);

  let textEncoding = 65001;
  let fileVersion = 0;
  let title = '';
  let extraDataFlags = 0;
  let firstImageRecordIndex = 0xffffffff;
  let coverOffset = 0xffffffff;
  let huffRecordOffset = 0xffffffff;
  let huffRecordCount = 0;
  let fdstRecordIndex = 0xffffffff;
  let kf8Boundary = 0xffffffff;

  if (recordBytes.length >= 32 && readAscii(recordBytes, 16, 4) === 'MOBI') {
    const headerLength = view.getUint32(20, false);
    textEncoding = view.getUint32(28, false);
    if (recordBytes.length >= 40) {
      fileVersion = view.getUint32(36, false);
    }
    if (recordBytes.length >= 92) {
      const fullNameOffset = view.getUint32(84, false);
      const fullNameLength = view.getUint32(88, false);
      if (
        fullNameLength > 0 &&
        fullNameOffset < recordBytes.length &&
        fullNameOffset + fullNameLength <= recordBytes.length
      ) {
        title = decodeMobiBytes(
          recordBytes.subarray(fullNameOffset, fullNameOffset + fullNameLength),
          textEncoding
        )
          .replace(/\0/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
    if (recordBytes.length >= 112) {
      firstImageRecordIndex = view.getUint32(108, false);
    }
    if (recordBytes.length >= 120) {
      huffRecordOffset = view.getUint32(112, false);
      huffRecordCount = view.getUint32(116, false);
    }
    if (fileVersion >= 8 && headerLength >= 196 && recordBytes.length >= 196) {
      fdstRecordIndex = view.getUint32(192, false);
    }
    if (headerLength >= 228 && recordBytes.length >= 244) {
      extraDataFlags = view.getUint32(240, false);
    }

    // Parse EXTH header for updated title (503), combo KF8 boundary (121), and cover image offset (201)
    const exthFlags = recordBytes.length >= 132 ? view.getUint32(128, false) : 0;
    const exthOffset = 16 + headerLength;
    if (
      (exthFlags & 0x40) !== 0 &&
      exthOffset + 12 <= recordBytes.length &&
      readAscii(recordBytes, exthOffset, 4) === 'EXTH'
    ) {
      const exthCount = view.getUint32(exthOffset + 8, false);
      let cursor = exthOffset + 12;
      for (let i = 0; i < exthCount && cursor + 8 <= recordBytes.length; i++) {
        const recType = view.getUint32(cursor, false);
        const recLen = view.getUint32(cursor + 4, false);
        if (recLen < 8 || cursor + recLen > recordBytes.length) break;
        const valBytes = recordBytes.subarray(cursor + 8, cursor + recLen);
        if (recType === 503 && valBytes.length > 0) {
          const updatedTitle = decodeMobiBytes(valBytes, textEncoding)
            .replace(/\0/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (updatedTitle) {
            title = updatedTitle;
          }
        } else if (recType === 121 && valBytes.length >= 4) {
          const bView = new DataView(valBytes.buffer, valBytes.byteOffset, valBytes.byteLength);
          kf8Boundary = bView.getUint32(0, false);
        } else if (recType === 201 && valBytes.length >= 4) {
          const cView = new DataView(valBytes.buffer, valBytes.byteOffset, valBytes.byteLength);
          coverOffset = cView.getUint32(0, false);
        }
        cursor += recLen;
      }
    }
  }

  return {
    headerRecordIndex,
    compression,
    textRecordCount,
    encryptionType,
    textEncoding,
    fileVersion,
    title,
    extraDataFlags,
    firstImageRecordIndex,
    coverOffset,
    huffRecordOffset,
    huffRecordCount,
    fdstRecordIndex,
    kf8Boundary,
  };
}

function preprocessMobiHtml(rawHtml: string): string {
  // Replace Kindle page breaks with clean block separation and strip Kindle-only wrapper tags
  let html = rawHtml
    .replace(/<mbp:pagebreak\b[^>]*\/?>/gi, '\n<p></p>\n')
    .replace(/<\/?mbp:[^>]*>/gi, '')
    .replace(/<guide\b[\s\S]*?<\/guide>/gi, '')
    .replace(/<reference\b[^>]*\/?>/gi, '');

  // If legacy MOBI6 book lacks <h1>-<h6> headings, promote short standalone large-<font> paragraphs
  if (!/<h[1-6]\b/i.test(html)) {
    html = html.replace(
      /<(p|div)(\b[^>]*)>\s*(?:<(?:b|strong|center)\b[^>]*>\s*)*<font\b[^>]*\bsize=["']?(?:\+?[2-9]|[5-7])["']?[^>]*>([\s\S]{1,120}?)<\/font>(?:\s*<\/(?:b|strong|center)>)*\s*<\/\1>/gi,
      (_match, _tag, _attrs, inner) => {
        const plain = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (plain.length >= 1 && plain.length <= 60) {
          return `<h2>${inner}</h2>`;
        }
        return _match;
      }
    );
  }

  return html;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function extractMobiSectionBytes(
  records: Uint8Array[],
  section: MobiSectionInfo,
  fileName: string
): Uint8Array {
  if (section.encryptionType !== 0) {
    throw new Error(`「${fileName}」受 DRM 加密保护，暂不支持导入`);
  }

  let huffDecoder: HuffCdicDecompressor | null = null;
  if (section.compression === 17480) {
    const huffStart = section.headerRecordIndex + section.huffRecordOffset;
    if (
      section.huffRecordOffset === 0xffffffff ||
      section.huffRecordCount < 2 ||
      huffStart >= records.length
    ) {
      throw new Error(`「${fileName}」的 HUFF/CDIC 压缩表缺失`);
    }
    const huffRec = records[huffStart];
    const cdicRecs: Uint8Array[] = [];
    for (let k = 1; k < section.huffRecordCount && huffStart + k < records.length; k++) {
      cdicRecs.push(records[huffStart + k]);
    }
    huffDecoder = new HuffCdicDecompressor(huffRec, cdicRecs);
  } else if (section.compression !== 1 && section.compression !== 2) {
    throw new Error(`「${fileName}」使用了暂不支持的压缩方式（类型 ${section.compression}）`);
  }

  const startRec = section.headerRecordIndex + 1;
  const endRec = Math.min(records.length, startRec + section.textRecordCount);
  const chunks: Uint8Array[] = [];

  for (let i = startRec; i < endRec; i++) {
    const rawRec = stripMobiTrailingData(records[i], section.extraDataFlags);
    if (rawRec.length === 0) continue;
    if (section.compression === 1) {
      chunks.push(rawRec);
    } else if (section.compression === 2) {
      chunks.push(decompressPalmDocLz77(rawRec));
    } else if (huffDecoder) {
      chunks.push(huffDecoder.unpack(rawRec));
    }
  }

  let combined = concatChunks(chunks);

  // In KF8 / AZW3, FDST defines byte ranges of each flow; flow 0 is the HTML document,
  // while subsequent flows contain CSS/SVG/JSON assets that must not leak into prose.
  if (
    section.fileVersion >= 8 &&
    section.fdstRecordIndex !== 0xffffffff &&
    section.headerRecordIndex + section.fdstRecordIndex < records.length
  ) {
    const fdstRec = records[section.headerRecordIndex + section.fdstRecordIndex];
    if (fdstRec.length >= 20 && readAscii(fdstRec, 0, 4) === 'FDST') {
      const fView = new DataView(fdstRec.buffer, fdstRec.byteOffset, fdstRec.byteLength);
      const flowsOffset = fView.getUint32(4, false);
      const flowCount = fView.getUint32(8, false);
      if (flowCount >= 1 && flowsOffset + 8 <= fdstRec.length) {
        const flow0Start = fView.getUint32(flowsOffset, false);
        const flow0End = fView.getUint32(flowsOffset + 4, false);
        if (flow0End > flow0Start && flow0End <= combined.length) {
          combined = combined.subarray(flow0Start, flow0End);
        }
      }
    }
  }

  return combined;
}

async function parseMobiFile(file: File): Promise<ParsedEbookDocument> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (bytes.length < 86) {
    throw new Error(`「${file.name}」不是有效的 MOBI / AZW3 文件`);
  }

  const pdbType = readAscii(bytes, 60, 4);
  const pdbCreator = readAscii(bytes, 64, 4);
  const isMobiBook = pdbType === 'BOOK' && pdbCreator === 'MOBI';
  const isPalmDoc = pdbType === 'TEXt' && pdbCreator === 'REAd';

  if (!isMobiBook && !isPalmDoc) {
    throw new Error(`「${file.name}」不是有效的 MOBI / AZW3 / PRC 电子书文件`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numRecords = view.getUint16(76, false);
  if (numRecords < 2 || 78 + numRecords * 8 > bytes.length) {
    throw new Error(`「${file.name}」的记录索引表损坏`);
  }

  const offsets: number[] = [];
  for (let i = 0; i < numRecords; i++) {
    offsets.push(view.getUint32(78 + i * 8, false));
  }

  const records: Uint8Array[] = [];
  for (let i = 0; i < numRecords; i++) {
    const start = offsets[i];
    const end = i + 1 < numRecords ? offsets[i + 1] : bytes.length;
    if (start >= bytes.length || end < start) {
      records.push(new Uint8Array(0));
    } else {
      records.push(bytes.subarray(start, Math.min(bytes.length, end)));
    }
  }

  const primarySection = parseMobiSectionHeader(records[0], 0);
  const fallbackTitle = stripEbookExtension(file.name);

  // Extract primary section (MOBI6 or standalone KF8/AZW3 or PalmDOC)
  let rawBytes = extractMobiSectionBytes(records, primarySection, file.name);
  let activeSection = primarySection;

  // If primary MOBI6 section is unexpectedly empty in a combo file, fall back to its KF8 section
  if (
    rawBytes.length < 32 &&
    primarySection.kf8Boundary !== 0xffffffff &&
    primarySection.kf8Boundary < records.length
  ) {
    let kf8HeaderIdx = primarySection.kf8Boundary;
    if (
      readAscii(records[kf8HeaderIdx], 0, 8) === 'BOUNDARY' &&
      kf8HeaderIdx + 1 < records.length
    ) {
      kf8HeaderIdx += 1;
    }
    if (kf8HeaderIdx < records.length) {
      const kf8Section = parseMobiSectionHeader(records[kf8HeaderIdx], kf8HeaderIdx);
      rawBytes = extractMobiSectionBytes(records, kf8Section, file.name);
      activeSection = kf8Section;
    }
  }

  const metaTitle = activeSection.title || primarySection.title;
  const bookTitle = metaTitle && !isGenericBookTitle(metaTitle) ? metaTitle : fallbackTitle;
  const bookImageDir = sanitizeBookImageDirName(bookTitle);

  const firstImageRecIdx =
    activeSection.firstImageRecordIndex !== 0xffffffff &&
    activeSection.firstImageRecordIndex < records.length
      ? activeSection.firstImageRecordIndex
      : primarySection.firstImageRecordIndex !== 0xffffffff &&
          primarySection.firstImageRecordIndex < records.length
        ? primarySection.firstImageRecordIndex
        : -1;

  const extractedImages: ExtractedEbookImage[] = [];
  const recIndexToRelPath = new Map<number, string>();
  let mobiImgSeq = 0;

  const registerMobiImageRecord = (
    absRecordIndex: number,
    preferredBaseName?: string
  ): string | null => {
    if (absRecordIndex < 0 || absRecordIndex >= records.length) return null;
    const existing = recIndexToRelPath.get(absRecordIndex);
    if (existing) return existing;
    const imgBytes = records[absRecordIndex];
    if (!imgBytes || imgBytes.length < 4) return null;
    const info = detectImageInfoFromBytes(imgBytes);
    if (!info) return null;
    const fileName = preferredBaseName
      ? `${preferredBaseName}${info.ext}`
      : `${String(++mobiImgSeq).padStart(3, '0')}${info.ext}`;
    const relPath = `images/${bookImageDir}/${fileName}`;
    recIndexToRelPath.set(absRecordIndex, relPath);
    extractedImages.push({
      relPath,
      mimeType: info.mimeType,
      bytes: new Uint8Array(imgBytes),
    });
    return relPath;
  };

  const mobiImageResolver: HtmlImageResolver = (el: Element) => {
    const alt = (el.getAttribute('alt') || el.getAttribute('title') || '').trim();
    const recAttr = (
      el.getAttribute('recindex') ||
      el.getAttribute('mediarecindex') ||
      ''
    ).trim();

    if (firstImageRecIdx >= 0 && recAttr) {
      const oneBased = Number.parseInt(recAttr, 10);
      if (Number.isFinite(oneBased) && oneBased >= 1) {
        const relPath = registerMobiImageRecord(firstImageRecIdx + oneBased - 1);
        if (relPath) return { relPath, alt };
      }
    }

    const rawSrc = (
      el.getAttribute('src') ||
      el.getAttribute('href') ||
      el.getAttribute('xlink:href') ||
      el.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') ||
      ''
    ).trim();

    if (!rawSrc) return null;
    if (/^(?:https?:\/\/|data:image\/)/i.test(rawSrc)) {
      return { relPath: rawSrc, alt };
    }

    // KF8 / AZW3 uses kindle:embed:XXXX (base-32 1-based resource index)
    const embedMatch = rawSrc.match(/^kindle:embed:([0-9a-v]+)/i);
    if (firstImageRecIdx >= 0 && embedMatch) {
      const oneBased = Number.parseInt(embedMatch[1], 32);
      if (Number.isFinite(oneBased) && oneBased >= 1) {
        const relPath = registerMobiImageRecord(firstImageRecIdx + oneBased - 1);
        if (relPath) return { relPath, alt };
      }
    }

    return null;
  };

  const decodedText = decodeMobiBytes(rawBytes, activeSection.textEncoding);
  const looksLikeHtml = /<(?:html|body|p|div|h[1-6]|br|img|mbp:pagebreak)\b/i.test(
    decodedText.slice(0, 8000)
  );

  let content: string;
  if (looksLikeHtml) {
    const cleanedHtml = preprocessMobiHtml(decodedText);
    content = convertHtmlToMarkdown(cleanedHtml, mobiImageResolver);
  } else {
    content = decodedText
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // If EXTH specifies a cover image offset that wasn't already referenced in the HTML body, prepend it
  const coverOffset =
    activeSection.coverOffset !== 0xffffffff
      ? activeSection.coverOffset
      : primarySection.coverOffset;
  if (firstImageRecIdx >= 0 && coverOffset !== 0xffffffff) {
    const coverAbsIdx = firstImageRecIdx + coverOffset;
    if (!recIndexToRelPath.has(coverAbsIdx)) {
      const coverRelPath = registerMobiImageRecord(coverAbsIdx, 'cover');
      if (coverRelPath) {
        content = `${formatMarkdownImage('封面', coverRelPath)}\n\n${content}`;
      }
    }
  }

  content = content
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
    images: extractedImages.length > 0 ? extractedImages : undefined,
  };
}

function serializeFb2Inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue || '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = (el.localName || el.tagName || '').toLowerCase();

  if (tag === 'image' || tag === 'binary') return '';

  let inner = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    inner += serializeFb2Inline(el.childNodes[i]);
  }
  const trimmed = inner.trim();
  if (!trimmed) return '';

  if (tag === 'strong') return `**${trimmed.replace(/\*\*/g, '')}**`;
  if (tag === 'emphasis') return `*${trimmed.replace(/\*/g, '')}*`;
  if (tag === 'code') return `\`${trimmed}\``;
  if (tag === 'sup') return /^\[?\d+\]?$/.test(trimmed) ? `[${trimmed.replace(/[\[\]]/g, '')}]` : trimmed;
  return inner;
}

function decodeBase64ToBytes(rawBase64: string): Uint8Array | null {
  try {
    const cleaned = rawBase64.replace(/\s+/g, '');
    if (!cleaned) return null;
    const binary = atob(cleaned);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function parseFb2Xml(xmlText: string, fileName: string): ParsedEbookDocument {
  const parser = new DOMParser();
  let doc = parser.parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    doc = parser.parseFromString(xmlText, 'text/html');
  }

  const getLocal = (root: Document | Element, name: string): Element[] => {
    const all = root.getElementsByTagName('*');
    const out: Element[] = [];
    for (let i = 0; i < all.length; i++) {
      const local = (all[i].localName || all[i].tagName || '').toLowerCase();
      if (local === name || local.endsWith(`:${name}`)) {
        out.push(all[i]);
      }
    }
    return out;
  };

  const titleEl = getLocal(doc, 'book-title')[0];
  const metaTitle = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
  const fallbackTitle = stripEbookExtension(fileName);
  const bookTitle = metaTitle && !isGenericBookTitle(metaTitle) ? metaTitle : fallbackTitle;
  const bookImageDir = sanitizeBookImageDirName(bookTitle);

  // Index embedded <binary id="..."> images in FB2
  const fb2Binaries = new Map<string, { bytes: Uint8Array; hintName: string }>();
  for (const binEl of getLocal(doc, 'binary')) {
    const id = (binEl.getAttribute('id') || '').trim();
    if (!id) continue;
    const decoded = decodeBase64ToBytes(binEl.textContent || '');
    if (decoded && decoded.length >= 4) {
      fb2Binaries.set(id.toLowerCase(), { bytes: decoded, hintName: id });
    }
  }

  const extractedImages: ExtractedEbookImage[] = [];
  const fb2IdToRelPath = new Map<string, string>();
  let fb2ImgSeq = 0;

  const registerFb2Image = (href: string, alt = ''): string | null => {
    const key = href.replace(/^#/, '').trim().toLowerCase();
    if (!key) return null;
    const existing = fb2IdToRelPath.get(key);
    if (existing) return formatMarkdownImage(alt, existing);
    const bin = fb2Binaries.get(key);
    if (!bin) return null;
    const info = detectImageInfoFromBytes(bin.bytes, bin.hintName);
    if (!info) return null;
    const fileNamePart = `${String(++fb2ImgSeq).padStart(3, '0')}${info.ext}`;
    const relPath = `images/${bookImageDir}/${fileNamePart}`;
    fb2IdToRelPath.set(key, relPath);
    extractedImages.push({ relPath, mimeType: info.mimeType, bytes: bin.bytes });
    return formatMarkdownImage(alt, relPath);
  };

  const getFb2ImageHref = (imgEl: Element): string => {
    for (let i = 0; i < imgEl.attributes.length; i++) {
      const attr = imgEl.attributes[i];
      const attrName = attr.name.toLowerCase();
      if (attrName === 'href' || attrName.endsWith(':href')) {
        return attr.value.trim();
      }
    }
    return '';
  };

  const bodies = getLocal(doc, 'body');
  const blocks: string[] = [];

  const extractTitleText = (titleNode: Element): string => {
    const pEls = Array.from(titleNode.children).filter(
      (c) => (c.localName || c.tagName || '').toLowerCase() === 'p'
    );
    if (pEls.length > 0) {
      return pEls
        .map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' · ');
    }
    return (titleNode.textContent || '').replace(/\s+/g, ' ').trim();
  };

  const walkFb2Element = (el: Element, sectionDepth: number) => {
    const tag = (el.localName || el.tagName || '').toLowerCase();

    if (tag === 'image') {
      const href = getFb2ImageHref(el);
      const alt = (el.getAttribute('alt') || el.getAttribute('title') || '').trim();
      const mdImg = href ? registerFb2Image(href, alt) : null;
      if (mdImg) blocks.push(mdImg);
      return;
    }

    if (tag === 'title') {
      const text = extractTitleText(el);
      if (text) {
        const level = Math.min(6, Math.max(1, sectionDepth));
        blocks.push(`${'#'.repeat(level)} ${text}`);
      }
      return;
    }

    if (tag === 'subtitle') {
      const text = serializeFb2Inline(el).trim();
      if (text) {
        const level = Math.min(6, Math.max(2, sectionDepth + 1));
        blocks.push(`${'#'.repeat(level)} ${text}`);
      }
      return;
    }

    if (tag === 'p') {
      const text = serializeFb2Inline(el).trim();
      if (text) blocks.push(text);
      return;
    }

    if (tag === 'epigraph' || tag === 'cite') {
      const quoteLines: string[] = [];
      for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i];
        const line = serializeFb2Inline(child).trim();
        if (line) quoteLines.push(`> ${line}`);
      }
      if (quoteLines.length > 0) blocks.push(quoteLines.join('\n'));
      return;
    }

    if (tag === 'poem') {
      const poemLines: string[] = [];
      for (const stanza of getLocal(el, 'stanza')) {
        for (let i = 0; i < stanza.children.length; i++) {
          const line = serializeFb2Inline(stanza.children[i]).trim();
          if (line) poemLines.push(`> ${line}`);
        }
        poemLines.push('>');
      }
      while (poemLines.length > 0 && poemLines[poemLines.length - 1] === '>') {
        poemLines.pop();
      }
      if (poemLines.length > 0) blocks.push(poemLines.join('\n'));
      return;
    }

    if (tag === 'section') {
      for (let i = 0; i < el.children.length; i++) {
        walkFb2Element(el.children[i], sectionDepth + 1);
      }
      return;
    }

    if (tag === 'empty-line') {
      return;
    }

    for (let i = 0; i < el.children.length; i++) {
      walkFb2Element(el.children[i], sectionDepth);
    }
  };

  for (const body of bodies) {
    // Skip secondary notes/footnotes bodies if primary body already exists unless they have text
    const bodyName = (body.getAttribute('name') || '').toLowerCase();
    if (bodyName === 'notes' && blocks.length > 0) {
      blocks.push('## 注释');
    }
    walkFb2Element(body, 0);
  }

  // Prepend FB2 coverpage image if declared and not already emitted
  const coverPage = getLocal(doc, 'coverpage')[0];
  if (coverPage) {
    const coverImgEl = getLocal(coverPage, 'image')[0];
    if (coverImgEl) {
      const href = getFb2ImageHref(coverImgEl);
      const key = href.replace(/^#/, '').trim().toLowerCase();
      if (key && !fb2IdToRelPath.has(key)) {
        const mdImg = registerFb2Image(href, '封面');
        if (mdImg) blocks.unshift(mdImg);
      }
    }
  }

  const content = blocks
    .join('\n\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!content) {
    throw new Error(`「${fileName}」中未提取到可读文本内容`);
  }

  return {
    title: bookTitle,
    content,
    images: extractedImages.length > 0 ? extractedImages : undefined,
  };
}

async function parseFb2File(file: File): Promise<ParsedEbookDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Handle .fb2.zip archives cleanly
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = await unzipFiltered(bytes);
    const fb2EntryName = Object.keys(entries).find((k) => /\.fb2$/i.test(k));
    if (!fb2EntryName) {
      throw new Error(`「${file.name}」压缩包内未找到 FB2 电子书文件`);
    }
    return parseFb2Xml(decodeBytesSmart(entries[fb2EntryName]), file.name);
  }

  return parseFb2Xml(decodeBytesSmart(bytes), file.name);
}

async function parseHtmlEbookFile(file: File): Promise<ParsedEbookDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const htmlText = decodeBytesSmart(bytes);

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');
  const titleText = (doc.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
  const fallbackTitle = stripEbookExtension(file.name);
  const bookTitle = titleText && !isGenericBookTitle(titleText) ? titleText : fallbackTitle;

  const htmlImageResolver: HtmlImageResolver = (el: Element) => {
    const rawSrc = (el.getAttribute('src') || el.getAttribute('data-src') || '').trim();
    if (!rawSrc) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawSrc) && !/^(?:https?:\/\/|data:image\/)/i.test(rawSrc)) {
      return null;
    }
    const alt = (el.getAttribute('alt') || el.getAttribute('title') || '').trim();
    return { relPath: rawSrc, alt };
  };

  const content = convertHtmlToMarkdown(htmlText, htmlImageResolver)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!content) {
    throw new Error(`「${file.name}」中未提取到可读文本内容`);
  }

  return { title: bookTitle, content };
}

export async function parseEbookFile(file: File): Promise<ParsedEbookDocument> {
  const name = file.name || '';
  const type = (file.type || '').toLowerCase();

  if (EPUB_EXT_RE.test(name) || type === 'application/epub+zip') {
    return parseEpubFile(file);
  }

  if (
    MOBI_EXT_RE.test(name) ||
    type === 'application/x-mobipocket-ebook' ||
    type === 'application/vnd.amazon.ebook' ||
    type === 'application/vnd.amazon.mobi8-ebook'
  ) {
    return parseMobiFile(file);
  }

  if (
    FB2_EXT_RE.test(name) ||
    type === 'application/x-fictionbook+xml' ||
    type === 'application/x-fictionbook'
  ) {
    return parseFb2File(file);
  }

  if (HTML_EXT_RE.test(name) || type === 'text/html' || type === 'application/xhtml+xml') {
    return parseHtmlEbookFile(file);
  }

  // Magic-byte fallback if extension was stripped on Android content URI
  const head = new Uint8Array(await file.slice(0, 70).arrayBuffer());
  if (head.length >= 68) {
    const pdbType = readAscii(head, 60, 4);
    const pdbCreator = readAscii(head, 64, 4);
    if ((pdbType === 'BOOK' && pdbCreator === 'MOBI') || (pdbType === 'TEXt' && pdbCreator === 'REAd')) {
      return parseMobiFile(file);
    }
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) {
    return parseEpubFile(file);
  }

  throw new Error(`暂不支持解析「${file.name}」的文件格式`);
}

import { unzlibSync } from 'fflate';
import {
  MdictDictionaryRecord,
  MdictEncoding,
  MdictKeyBlockMeta,
  MdictLookupResult,
  MdictRecordBlockMeta,
} from '../types';

// ---------------------------------------------------------------------------
// RIPEMD-128 (for MDict 2.0 Encrypted="2" key-block-info obfuscation)
// ---------------------------------------------------------------------------

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) | 0;
}

const RMD_K_L = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc];
const RMD_K_R = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000];

const RMD_R_L = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
];

const RMD_R_R = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
];

const RMD_S_L = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
];

const RMD_S_R = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
];

function rmdF(j: number, x: number, y: number, z: number): number {
  if (j < 16) return x ^ y ^ z;
  if (j < 32) return (x & y) | (~x & z);
  if (j < 48) return (x | ~y) ^ z;
  return (x & z) | (y & ~z);
}

export function ripemd128(data: Uint8Array): Uint8Array {
  const bitLen = BigInt(data.length) * 8n;
  const padLen = ((56 - ((data.length + 1) % 64)) + 64) % 64;
  const totalLen = data.length + 1 + padLen + 8;
  const msg = new Uint8Array(totalLen);
  msg.set(data, 0);
  msg[data.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setBigUint64(totalLen - 8, bitLen, true);

  let h0 = 0x67452301 | 0;
  let h1 = 0xefcdab89 | 0;
  let h2 = 0x98badcfe | 0;
  let h3 = 0x10325476 | 0;

  const X = new Int32Array(16);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      X[i] = dv.getInt32(offset + i * 4, true);
    }

    let al = h0;
    let bl = h1;
    let cl = h2;
    let dl = h3;
    let ar = h0;
    let br = h1;
    let cr = h2;
    let dr = h3;

    for (let j = 0; j < 64; j++) {
      const round = j >> 4;
      const fl = rmdF(j, bl, cl, dl);
      const tl = rotl32((al + fl + X[RMD_R_L[j]] + RMD_K_L[round]) | 0, RMD_S_L[j]) | 0;
      al = dl;
      dl = cl;
      cl = bl;
      bl = tl;

      const fr = rmdF(63 - j, br, cr, dr);
      const tr = rotl32((ar + fr + X[RMD_R_R[j]] + RMD_K_R[round]) | 0, RMD_S_R[j]) | 0;
      ar = dr;
      dr = cr;
      cr = br;
      br = tr;
    }

    const t = (h1 + cl + dr) | 0;
    h1 = (h2 + dl + ar) | 0;
    h2 = (h3 + al + br) | 0;
    h3 = (h0 + bl + cr) | 0;
    h0 = t;
  }

  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setInt32(0, h0, true);
  outDv.setInt32(4, h1, true);
  outDv.setInt32(8, h2, true);
  outDv.setInt32(12, h3, true);
  return out;
}

function fastDecryptInPlace(buf: Uint8Array, key: Uint8Array): void {
  let previous = 0x36;
  const keyLen = key.length;
  for (let i = 0; i < buf.length; i++) {
    let t = ((buf[i] >> 4) | (buf[i] << 4)) & 0xff;
    t = t ^ previous ^ (i & 0xff) ^ key[i % keyLen];
    previous = buf[i];
    buf[i] = t;
  }
}

// ---------------------------------------------------------------------------
// LZO1X-1 Decompressor (for MDict blocks with compType === 1)
// ---------------------------------------------------------------------------

export function lzo1xDecompress(input: Uint8Array, expectedSize = 0): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  let out = new Uint8Array(Math.max(expectedSize, input.length * 4, 1024));
  let ip = 0;
  let op = 0;

  const ensureCapacity = (needed: number) => {
    if (op + needed <= out.length) return;
    let nextLen = out.length * 2;
    while (nextLen < op + needed) nextLen *= 2;
    const grown = new Uint8Array(nextLen);
    grown.set(out.subarray(0, op));
    out = grown;
  };

  const copyLiterals = (count: number) => {
    const safeCount = Math.min(count, input.length - ip);
    if (safeCount <= 0) return;
    ensureCapacity(safeCount);
    for (let i = 0; i < safeCount; i++) {
      out[op++] = input[ip++];
    }
  };

  const copyMatch = (mPos: number, mLen: number) => {
    if (mPos < 0 || mLen <= 0) {
      throw new Error('词库 LZO1X 解压偏移无效');
    }
    ensureCapacity(mLen);
    let src = mPos;
    for (let i = 0; i < mLen; i++) {
      out[op++] = out[src++];
    }
  };

  type LzoState = 'top' | 'first_literal_run' | 'match' | 'match_done' | 'match_next';
  let state: LzoState = 'top';
  let t = 0;

  if (input[ip] > 17) {
    t = input[ip++] - 17;
    if (t < 4) {
      state = 'match_next';
    } else {
      copyLiterals(t);
      state = 'first_literal_run';
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (state === 'top') {
      if (ip >= input.length) break;
      t = input[ip++];
      if (t >= 16) {
        state = 'match';
        continue;
      }
      if (t === 0) {
        while (ip < input.length && input[ip] === 0) {
          t += 255;
          ip++;
        }
        if (ip >= input.length) break;
        t += 15 + input[ip++];
      }
      copyLiterals(t + 3);
      state = 'first_literal_run';
      continue;
    }

    if (state === 'first_literal_run') {
      if (ip >= input.length) break;
      t = input[ip++];
      if (t >= 16) {
        state = 'match';
        continue;
      }
      const mPos = op - 0x0801 - (t >> 2) - (input[ip++] << 2);
      copyMatch(mPos, 3);
      state = 'match_done';
      continue;
    }

    if (state === 'match') {
      let mPos: number;
      let mLen: number;
      if (t >= 64) {
        mPos = op - 1 - ((t >> 2) & 7) - (input[ip++] << 3);
        mLen = (t >> 5) + 1;
      } else if (t >= 32) {
        t &= 31;
        if (t === 0) {
          while (ip < input.length && input[ip] === 0) {
            t += 255;
            ip++;
          }
          t += 31 + input[ip++];
        }
        mPos = op - 1 - ((input[ip] >> 2) + (input[ip + 1] << 6));
        ip += 2;
        mLen = t + 2;
      } else if (t >= 16) {
        mPos = op - ((t & 8) << 11);
        t &= 7;
        if (t === 0) {
          while (ip < input.length && input[ip] === 0) {
            t += 255;
            ip++;
          }
          t += 7 + input[ip++];
        }
        mPos -= (input[ip] >> 2) + (input[ip + 1] << 6);
        ip += 2;
        if (mPos === op) {
          return out.subarray(0, op);
        }
        mPos -= 0x4000;
        mLen = t + 2;
      } else {
        mPos = op - 1 - (t >> 2) - (input[ip++] << 2);
        mLen = 2;
      }

      copyMatch(mPos, mLen);
      state = 'match_done';
      continue;
    }

    if (state === 'match_done') {
      t = input[ip - 2] & 3;
      if (t === 0) {
        state = 'top';
      } else {
        state = 'match_next';
      }
      continue;
    }

    // state === 'match_next'
    copyLiterals(t);
    if (ip >= input.length) break;
    t = input[ip++];
    state = 'match';
  }

  return out.subarray(0, op);
}

// ---------------------------------------------------------------------------
// Binary & Header Helpers
// ---------------------------------------------------------------------------

function decompressBlock(rawBlock: Uint8Array, expectedSize = 0): Uint8Array {
  if (rawBlock.length < 8) {
    throw new Error('词库数据块已损坏');
  }
  const compType = rawBlock[0] | (rawBlock[1] << 8) | (rawBlock[2] << 16) | (rawBlock[3] << 24);
  const payload = rawBlock.subarray(8);
  if (compType === 0) {
    return payload;
  }
  if (compType === 1) {
    return lzo1xDecompress(payload, expectedSize);
  }
  if (compType === 2) {
    return unzlibSync(payload);
  }
  throw new Error(`不支持的词库压缩类型 (${compType})`);
}

function readUIntBE(dv: DataView, offset: number, width: 4 | 8): { value: number; next: number } {
  if (width === 4) {
    return { value: dv.getUint32(offset, false), next: offset + 4 };
  }
  return { value: Number(dv.getBigUint64(offset, false)), next: offset + 8 };
}

function normalizeEncoding(raw?: string): MdictEncoding {
  const lower = (raw || 'utf-8').trim().toLowerCase();
  if (lower === 'utf-16' || lower === 'utf16' || lower === 'utf-16le') return 'utf-16le';
  if (
    lower === 'gbk' ||
    lower === 'gb2312' ||
    lower === 'gb18030' ||
    lower === 'gb-2312' ||
    lower === 'gb_2312-80' ||
    lower === 'gbk2312' ||
    lower === 'cp936'
  ) {
    return 'gb18030';
  }
  if (lower === 'big5') return 'big5';
  return 'utf-8';
}

function decodeText(bytes: Uint8Array, encoding: MdictEncoding): string {
  const decoder = new TextDecoder(encoding);
  return decoder.decode(bytes).replace(/\0+$/, '');
}

function trimTrailingNullBytes(bytes: Uint8Array, isUtf16: boolean): Uint8Array {
  let end = bytes.length;
  if (isUtf16) {
    while (end >= 2 && bytes[end - 1] === 0 && bytes[end - 2] === 0) {
      end -= 2;
    }
    if ((end & 1) === 1 && bytes[end - 1] === 0) {
      end -= 1;
    }
  } else {
    while (end > 0 && bytes[end - 1] === 0) {
      end -= 1;
    }
  }
  return end === bytes.length ? bytes : bytes.subarray(0, end);
}

function decodeRecordText(bytes: Uint8Array, encoding: MdictEncoding): string {
  if (bytes.length === 0) return '';

  // Respect explicit BOM if present in record payload
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const clean = trimTrailingNullBytes(bytes.subarray(3), false);
    return new TextDecoder('utf-8').decode(clean).replace(/\0+$/, '');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const clean = trimTrailingNullBytes(bytes.subarray(2), true);
    return new TextDecoder('utf-16le').decode(clean).replace(/\0+$/, '');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const clean = trimTrailingNullBytes(bytes.subarray(2), true);
    return new TextDecoder('utf-16be').decode(clean).replace(/\0+$/, '');
  }

  const isUtf16 = encoding === 'utf-16le';
  const clean = trimTrailingNullBytes(bytes, isUtf16);
  if (clean.length === 0) return '';

  if (encoding === 'utf-8') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(clean).replace(/\0+$/, '');
    } catch {
      // Some legacy Chinese .mdx files declare UTF-8 (or omit Encoding) while storing GBK/GB18030 records
      return new TextDecoder('gb18030').decode(clean).replace(/\0+$/, '');
    }
  }

  if (encoding === 'gb18030' || encoding === 'big5') {
    const primary = new TextDecoder(encoding).decode(clean).replace(/\0+$/, '');
    if (primary.includes('\uFFFD')) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(clean).replace(/\0+$/, '');
      } catch {
        return primary;
      }
    }
    return primary;
  }

  const evenSlice = (clean.length & 1) === 1 ? clean.subarray(0, clean.length - 1) : clean;
  return new TextDecoder(encoding).decode(evenSlice).replace(/\0+$/, '');
}

function unescapeXmlEntities(s: string): string {
  return s
    .replace(/&#x0*a;/gi, '\n')
    .replace(/&#x0*d;/gi, '\r')
    .replace(/&#0*10;/g, '\n')
    .replace(/&#0*13;/g, '\r')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseStyleSheetMap(
  raw?: string
): Record<string, { prefix: string; suffix: string }> | undefined {
  if (!raw || !raw.trim()) return undefined;
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const map: Record<string, { prefix: string; suffix: string }> = {};
  let hasAny = false;
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const id = lines[i].trim();
    if (!id) continue;
    map[id] = { prefix: lines[i + 1], suffix: lines[i + 2] };
    hasAny = true;
  }
  return hasAny ? map : undefined;
}

function expandStyleSheetTags(
  rawHtml: string,
  styleSheet?: Record<string, { prefix: string; suffix: string }>
): string {
  if (!styleSheet || !rawHtml.includes('`')) return rawHtml;
  const parts = rawHtml.split(/`([^`\r\n]{1,16})`/);
  if (parts.length <= 1) return rawHtml;
  let out = parts[0];
  let openSuffix = '';
  for (let i = 1; i < parts.length; i += 2) {
    const tagId = parts[i];
    const body = parts[i + 1] ?? '';
    const entry = styleSheet[tagId];
    if (entry) {
      out += openSuffix + entry.prefix + body;
      openSuffix = entry.suffix;
    } else {
      out += '`' + tagId + '`' + body;
    }
  }
  out += openSuffix;
  return out;
}

export function sanitizeMdictCss(rawCss: string): string {
  return rawCss
    .replace(/@import\s+[^;]+;?/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/url\(\s*['"]?\s*(?:https?:|javascript:)[^)]*\)/gi, 'none');
}

function parseHeaderAttributes(xml: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(xml)) !== null) {
    attrs[m[1]] = unescapeXmlEntities(m[2]);
  }
  return attrs;
}

function stripHtmlTagsPlain(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitKeyBlockEntries(
  blockBytes: Uint8Array,
  numberWidth: 4 | 8,
  encoding: MdictEncoding
): Array<{ recordStartOffset: number; key: string }> {
  const dv = new DataView(blockBytes.buffer, blockBytes.byteOffset, blockBytes.byteLength);
  const isUtf16 = encoding === 'utf-16le';
  const charUnit = isUtf16 ? 2 : 1;
  const entries: Array<{ recordStartOffset: number; key: string }> = [];

  let pos = 0;
  while (pos + numberWidth < blockBytes.length) {
    const { value: recordStartOffset, next } = readUIntBE(dv, pos, numberWidth);
    pos = next;
    let end = pos;
    if (isUtf16) {
      while (end + 1 < blockBytes.length && !(blockBytes[end] === 0 && blockBytes[end + 1] === 0)) {
        end += 2;
      }
    } else {
      while (end < blockBytes.length && blockBytes[end] !== 0) {
        end++;
      }
    }
    const key = decodeText(blockBytes.subarray(pos, end), encoding);
    entries.push({ recordStartOffset, key });
    pos = Math.min(blockBytes.length, end + charUnit);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Index Parsing (Reads only headers & block tables via Blob.slice)
// ---------------------------------------------------------------------------

interface ParsedMdictContainer {
  title: string;
  description: string;
  encoding: MdictEncoding;
  version: number;
  encrypt: number;
  isStripKey: boolean;
  isCaseSensitive: boolean;
  styleSheet?: Record<string, { prefix: string; suffix: string }>;
  numEntries: number;
  totalRecordDecompressedSize: number;
  keyBlocks: MdictKeyBlockMeta[];
  recordBlocks: MdictRecordBlockMeta[];
}

async function parseMdictContainerFromBlob(
  blob: Blob,
  fileName: string
): Promise<ParsedMdictContainer> {
  if (blob.size < 32) {
    throw new Error('文件过小，不是有效的 .mdx 词典文件');
  }

  const headPrefix = new DataView(await blob.slice(0, 4).arrayBuffer());
  const headerBytesSize = headPrefix.getUint32(0, false);
  if (headerBytesSize <= 0 || headerBytesSize > 4 * 1024 * 1024 || 8 + headerBytesSize >= blob.size) {
    throw new Error('文件头格式无效，不是标准的 .mdx 词典文件');
  }

  const headerBytes = new Uint8Array(await blob.slice(4, 4 + headerBytesSize).arrayBuffer());
  const headerXml = new TextDecoder('utf-16le').decode(headerBytes).replace(/\0+$/, '');
  const trimmedHeader = headerXml.trimStart();
  if (/^<Library_Data\b/i.test(trimmedHeader)) {
    throw new Error('该文件为 .mdd 资源包，仅支持导入 .mdx 词典文件');
  }

  const attrs = parseHeaderAttributes(headerXml);

  const version = parseFloat(attrs.GeneratedByEngineVersion || '1.2') || 1.2;
  if (version >= 3.0) {
    throw new Error('暂不支持 MDict 3.0 格式词库，请使用标准 v1.2 / v2.0 .mdx 文件');
  }

  const encAttr = (attrs.Encrypted || '0').trim().toLowerCase();
  let encrypt = 0;
  if (encAttr === 'yes' || encAttr === '1') encrypt = 1;
  else if (encAttr === '2') encrypt = 2;
  else if (encAttr === '3') encrypt = 3;

  if ((encrypt & 1) !== 0) {
    throw new Error('该词库启用了个人注册码加密（Encrypted=1），暂不支持解密');
  }

  const encoding = normalizeEncoding(attrs.Encoding);
  const isStripKey = (attrs.StripKey || 'Yes').trim().toLowerCase() !== 'no';
  const isCaseSensitive = (attrs.KeyCaseSensitive || 'No').trim().toLowerCase() === 'yes';
  const styleSheet = parseStyleSheetMap(attrs.StyleSheet);
  const fallbackTitle = fileName.replace(/\.mdx$/i, '') || '未命名词典';
  const title = stripHtmlTagsPlain(attrs.Title || '') || fallbackTitle;
  const description = stripHtmlTagsPlain(attrs.Description || '').slice(0, 240);

  const numberWidth: 4 | 8 = version >= 2.0 ? 8 : 4;
  const keySectionOffset = 4 + headerBytesSize + 4;
  const keyHeaderCount = version >= 2.0 ? 5 : 4;
  const keyHeaderBytesLen = keyHeaderCount * numberWidth + (version >= 2.0 ? 4 : 0);

  const keyHeaderBuf = await blob
    .slice(keySectionOffset, keySectionOffset + keyHeaderBytesLen)
    .arrayBuffer();
  const keyHeaderDv = new DataView(keyHeaderBuf);

  let khPos = 0;
  const r1 = readUIntBE(keyHeaderDv, khPos, numberWidth);
  const numKeyBlocks = r1.value;
  khPos = r1.next;

  const r2 = readUIntBE(keyHeaderDv, khPos, numberWidth);
  const numEntries = r2.value;
  khPos = r2.next;

  let keyBlockInfoDecompSize = 0;
  if (version >= 2.0) {
    const r3 = readUIntBE(keyHeaderDv, khPos, numberWidth);
    keyBlockInfoDecompSize = r3.value;
    khPos = r3.next;
  }

  const r4 = readUIntBE(keyHeaderDv, khPos, numberWidth);
  const keyBlockInfoSize = r4.value;
  khPos = r4.next;

  const r5 = readUIntBE(keyHeaderDv, khPos, numberWidth);
  const keyBlockSize = r5.value;

  const keyBlockInfoStart = keySectionOffset + keyHeaderBytesLen;
  const keyBlockInfoRaw = new Uint8Array(
    await blob.slice(keyBlockInfoStart, keyBlockInfoStart + keyBlockInfoSize).arrayBuffer()
  );

  let keyBlockInfoBytes: Uint8Array;
  if (version >= 2.0) {
    if ((encrypt & 2) !== 0) {
      const seed = new Uint8Array(8);
      seed.set(keyBlockInfoRaw.subarray(4, 8), 0);
      seed.set([0x95, 0x36, 0x00, 0x00], 4);
      const key = ripemd128(seed);
      fastDecryptInPlace(keyBlockInfoRaw.subarray(8), key);
    }
    keyBlockInfoBytes = decompressBlock(keyBlockInfoRaw, keyBlockInfoDecompSize);
  } else {
    keyBlockInfoBytes = keyBlockInfoRaw;
  }

  // Parse key block info table
  const kbiDv = new DataView(
    keyBlockInfoBytes.buffer,
    keyBlockInfoBytes.byteOffset,
    keyBlockInfoBytes.byteLength
  );
  const textTerm = version >= 2.0 ? 1 : 0;
  const charUnit = encoding === 'utf-16le' ? 2 : 1;
  const keyDataStart = keyBlockInfoStart + keyBlockInfoSize;

  const keyBlocks: MdictKeyBlockMeta[] = [];
  let p = 0;
  let currentKeyBlockFileOffset = keyDataStart;

  for (let i = 0; i < numKeyBlocks; i++) {
    const entryCountRes = readUIntBE(kbiDv, p, numberWidth);
    p = entryCountRes.next;

    const firstKeyLen = version >= 2.0 ? kbiDv.getUint16(p, false) : kbiDv.getUint8(p);
    p += version >= 2.0 ? 2 : 1;
    const firstKeyByteLen = (firstKeyLen + textTerm) * charUnit;
    const firstKey = decodeText(
      keyBlockInfoBytes.subarray(p, p + firstKeyByteLen),
      encoding
    );
    p += firstKeyByteLen;

    const lastKeyLen = version >= 2.0 ? kbiDv.getUint16(p, false) : kbiDv.getUint8(p);
    p += version >= 2.0 ? 2 : 1;
    const lastKeyByteLen = (lastKeyLen + textTerm) * charUnit;
    const lastKey = decodeText(
      keyBlockInfoBytes.subarray(p, p + lastKeyByteLen),
      encoding
    );
    p += lastKeyByteLen;

    const compSizeRes = readUIntBE(kbiDv, p, numberWidth);
    p = compSizeRes.next;
    const decompSizeRes = readUIntBE(kbiDv, p, numberWidth);
    p = decompSizeRes.next;

    keyBlocks.push({
      numEntries: entryCountRes.value,
      firstKey,
      lastKey,
      compressedOffset: currentKeyBlockFileOffset,
      compressedSize: compSizeRes.value,
      decompressedSize: decompSizeRes.value,
    });
    currentKeyBlockFileOffset += compSizeRes.value;
  }

  // Parse record section header & block table
  const recordSectionStart = keyDataStart + keyBlockSize;
  const recHeaderLen = 4 * numberWidth;
  const recHeaderDv = new DataView(
    await blob.slice(recordSectionStart, recordSectionStart + recHeaderLen).arrayBuffer()
  );

  let rp = 0;
  const recBlocksCountRes = readUIntBE(recHeaderDv, rp, numberWidth);
  rp = recBlocksCountRes.next;
  const recEntriesRes = readUIntBE(recHeaderDv, rp, numberWidth);
  rp = recEntriesRes.next;
  const recInfoSizeRes = readUIntBE(recHeaderDv, rp, numberWidth);
  rp = recInfoSizeRes.next;
  readUIntBE(recHeaderDv, rp, numberWidth); // recordDataSize

  const recInfoStart = recordSectionStart + recHeaderLen;
  const recInfoBuf = await blob
    .slice(recInfoStart, recInfoStart + recInfoSizeRes.value)
    .arrayBuffer();
  const recInfoDv = new DataView(recInfoBuf);

  const recordBlocks: MdictRecordBlockMeta[] = [];
  let rip = 0;
  let compOffset = recInfoStart + recInfoSizeRes.value;
  let decompOffset = 0;

  for (let i = 0; i < recBlocksCountRes.value; i++) {
    const cRes = readUIntBE(recInfoDv, rip, numberWidth);
    rip = cRes.next;
    const dRes = readUIntBE(recInfoDv, rip, numberWidth);
    rip = dRes.next;

    recordBlocks.push({
      compressedOffset: compOffset,
      compressedSize: cRes.value,
      decompressedOffset: decompOffset,
      decompressedSize: dRes.value,
    });

    compOffset += cRes.value;
    decompOffset += dRes.value;
  }

  return {
    title,
    description,
    encoding,
    version,
    encrypt,
    isStripKey,
    isCaseSensitive,
    styleSheet,
    numEntries: numEntries || recEntriesRes.value,
    totalRecordDecompressedSize: decompOffset,
    keyBlocks,
    recordBlocks,
  };
}

export async function parseMdictIndexFromBlob(
  blob: Blob,
  fileName: string,
  id: string = `mdx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
): Promise<MdictDictionaryRecord> {
  const parsed = await parseMdictContainerFromBlob(blob, fileName);
  return {
    id,
    fileName,
    title: parsed.title,
    description: parsed.description,
    encoding: parsed.encoding,
    version: parsed.version,
    encrypt: parsed.encrypt,
    isStripKey: parsed.isStripKey,
    isCaseSensitive: parsed.isCaseSensitive,
    styleSheet: parsed.styleSheet,
    numEntries: parsed.numEntries,
    fileSize: blob.size,
    addedAt: Date.now(),
    totalRecordDecompressedSize: parsed.totalRecordDecompressedSize,
    keyBlocks: parsed.keyBlocks,
    recordBlocks: parsed.recordBlocks,
  };
}

// ---------------------------------------------------------------------------
// Word Extraction, Morphological Candidates & On-Demand Lookup
// ---------------------------------------------------------------------------

const LEADING_TRIM_RE = /^[\s"'“”‘’.,;:!?()[\]{}<>《》「」『』—–·•/\\，。！？；：、（）【】…～~]+/;
const TRAILING_TRIM_RE = /[\s"'“”‘’.,;:!?()[\]{}<>《》「」『』—–·•/\\，。！？；：、（）【】…～~]+$/;
const PURE_HAN_RE = /^\p{Script=Han}+$/u;
const MAX_HAN_LOOKUP_CHARS = 8;

export function extractLookupWord(rawSelection: string): string | null {
  if (!rawSelection || rawSelection.includes('\n') || rawSelection.includes('\r')) {
    return null;
  }
  const cleaned = rawSelection
    .replace(/\u00AD/g, '')
    .trim()
    .replace(LEADING_TRIM_RE, '')
    .replace(TRAILING_TRIM_RE, '');

  if (!cleaned) return null;

  // Support single Chinese characters (e.g. 新华字典) and Chinese words/idioms (up to 8 Han chars)
  if (PURE_HAN_RE.test(cleaned)) {
    const charCount = Array.from(cleaned).length;
    if (charCount >= 1 && charCount <= MAX_HAN_LOOKUP_CHARS) {
      return cleaned;
    }
    return null;
  }

  if (cleaned.length > 48) return null;
  if (!/[A-Za-z]/.test(cleaned)) return null;

  // Reject sentences or multi-word prose: allow up to 3 English words/hyphenated/apostrophe tokens
  const words = cleaned.split(/\s+/);
  if (words.length > 3) return null;
  for (const w of words) {
    if (!/^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(w)) {
      return null;
    }
  }
  return cleaned;
}

export const extractEnglishLookupWord = extractLookupWord;

export function buildLookupCandidates(word: string): string[] {
  const candidates: string[] = [];
  const push = (w: string) => {
    const trimmed = w.trim();
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  push(word);
  const nfc = word.normalize('NFC');
  if (nfc !== word) {
    push(nfc);
  }

  // Skip English inflection rules for pure CJK / non-Latin queries
  if (!/[A-Za-z]/.test(word)) {
    return candidates;
  }

  const lower = word.toLowerCase();
  push(lower);

  // Possessive 's
  if (lower.endsWith("'s") || lower.endsWith('’s')) {
    push(lower.slice(0, -2));
  }

  // Only perform inflection stripping on single tokens
  if (!lower.includes(' ')) {
    if (lower.endsWith('ies') && lower.length > 4) {
      push(`${lower.slice(0, -3)}y`);
    }
    if (lower.endsWith('ves') && lower.length > 4) {
      push(`${lower.slice(0, -3)}f`);
      push(`${lower.slice(0, -3)}fe`);
    }
    if (lower.endsWith('es') && lower.length > 3) {
      push(lower.slice(0, -2));
      push(lower.slice(0, -1));
    }
    if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) {
      push(lower.slice(0, -1));
    }

    if (lower.endsWith('ied') && lower.length > 4) {
      push(`${lower.slice(0, -3)}y`);
    }
    if (lower.endsWith('ed') && lower.length > 3) {
      const stem = lower.slice(0, -2);
      push(lower.slice(0, -1)); // e.g. loved -> love
      push(stem);
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
        push(stem.slice(0, -1)); // stopped -> stop
      }
    }

    if (lower.endsWith('ing') && lower.length > 4) {
      const stem = lower.slice(0, -3);
      push(stem);
      push(`${stem}e`); // making -> make
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
        push(stem.slice(0, -1)); // running -> run
      }
    }

    if (lower.endsWith('ier') && lower.length > 4) {
      push(`${lower.slice(0, -3)}y`);
    }
    if (lower.endsWith('er') && lower.length > 3) {
      const stem = lower.slice(0, -2);
      push(lower.slice(0, -1));
      push(stem);
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
        push(stem.slice(0, -1));
      }
    }

    if (lower.endsWith('iest') && lower.length > 5) {
      push(`${lower.slice(0, -4)}y`);
    }
    if (lower.endsWith('est') && lower.length > 4) {
      const stem = lower.slice(0, -3);
      push(lower.slice(0, -2));
      push(stem);
      if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
        push(stem.slice(0, -1));
      }
    }
  }

  return candidates;
}

export const buildEnglishLookupCandidates = buildLookupCandidates;

function stripKeyForSort(s: string): string {
  return s.replace(/[()., '/\\@_-]+/g, '').toLowerCase();
}

function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

function compareRawStrings(a: string, b: string, useCodePointOrder: boolean): number {
  if (useCodePointOrder) {
    return compareCodePoints(a, b);
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareMdictKeys(
  a: string,
  b: string,
  isStripKey: boolean,
  isCaseSensitive: boolean,
  useCodePointOrder: boolean
): number {
  const ka = isStripKey ? stripKeyForSort(a) : isCaseSensitive ? a : a.toLowerCase();
  const kb = isStripKey ? stripKeyForSort(b) : isCaseSensitive ? b : b.toLowerCase();
  const primary = compareRawStrings(ka, kb, useCodePointOrder);
  if (primary !== 0) return primary;
  return compareRawStrings(a.toLowerCase(), b.toLowerCase(), useCodePointOrder);
}

function selectCandidateKeyBlockIndices(
  keyBlocks: MdictKeyBlockMeta[],
  target: string,
  isStripKey: boolean,
  isCaseSensitive: boolean,
  useCodePointOrder: boolean
): number[] {
  if (keyBlocks.length === 0) return [];
  if (keyBlocks.length <= 4) {
    return keyBlocks.map((_, idx) => idx);
  }

  const picked = new Set<number>();

  // Check both configured normalization AND plain lowercase in case builder sorted differently
  const modes: Array<[boolean, boolean]> = [
    [isStripKey, isCaseSensitive],
    [false, false],
  ];

  for (const [stripMode, caseMode] of modes) {
    let lo = 0;
    let hi = keyBlocks.length - 1;
    let best = 0;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cmpFirst = compareMdictKeys(
        keyBlocks[mid].firstKey,
        target,
        stripMode,
        caseMode,
        useCodePointOrder
      );
      const cmpLast = compareMdictKeys(
        keyBlocks[mid].lastKey,
        target,
        stripMode,
        caseMode,
        useCodePointOrder
      );
      if (cmpFirst <= 0 && cmpLast >= 0) {
        best = mid;
        picked.add(mid);
        break;
      }
      if (cmpFirst > 0) {
        hi = mid - 1;
      } else {
        best = mid;
        lo = mid + 1;
      }
    }

    picked.add(best);
    if (best - 1 >= 0) picked.add(best - 1);
    if (best + 1 < keyBlocks.length) picked.add(best + 1);
  }

  return Array.from(picked).sort((a, b) => a - b);
}

function isKeyBlocksMonotonicForMode(
  keyBlocks: MdictKeyBlockMeta[],
  isStripKey: boolean,
  isCaseSensitive: boolean,
  useCodePointOrder: boolean
): boolean {
  if (keyBlocks.length <= 1) return true;
  for (let i = 0; i < keyBlocks.length; i++) {
    const kb = keyBlocks[i];
    if (kb.numEntries > 0 && (!kb.firstKey || !kb.lastKey)) {
      return false;
    }
    if (
      kb.firstKey &&
      kb.lastKey &&
      compareMdictKeys(kb.firstKey, kb.lastKey, isStripKey, isCaseSensitive, useCodePointOrder) > 0
    ) {
      return false;
    }
    if (i > 0) {
      const prev = keyBlocks[i - 1];
      if (
        prev.lastKey &&
        kb.firstKey &&
        compareMdictKeys(
          prev.lastKey,
          kb.firstKey,
          isStripKey,
          isCaseSensitive,
          useCodePointOrder
        ) > 0
      ) {
        return false;
      }
    }
  }
  return true;
}

const monotonicOrderCache = new Map<string, boolean>();

function hasMonotonicUnicodeOrder(meta: MdictDictionaryRecord): boolean {
  const cached = monotonicOrderCache.get(meta.id);
  if (cached !== undefined) return cached;
  const useCodePointOrder = meta.encoding === 'utf-8';
  const monotonic =
    isKeyBlocksMonotonicForMode(
      meta.keyBlocks,
      meta.isStripKey,
      meta.isCaseSensitive,
      useCodePointOrder
    ) || isKeyBlocksMonotonicForMode(meta.keyBlocks, false, false, useCodePointOrder);
  monotonicOrderCache.set(meta.id, monotonic);
  return monotonic;
}

interface KeyRangeRef {
  key: string;
  start: number;
  end: number;
}

const MAX_FALLBACK_INDEX_DICTS = 3;
const MAX_FALLBACK_INDEX_ENTRIES = 250_000;
const fallbackKeyIndexCache = new Map<string, Map<string, KeyRangeRef[]>>();
const fallbackKeyIndexPromises = new Map<string, Promise<Map<string, KeyRangeRef[]>>>();

export function clearMdictLookupCache(dictId?: string): void {
  if (dictId) {
    fallbackKeyIndexCache.delete(dictId);
    fallbackKeyIndexPromises.delete(dictId);
    monotonicOrderCache.delete(dictId);
    return;
  }
  fallbackKeyIndexCache.clear();
  fallbackKeyIndexPromises.clear();
  monotonicOrderCache.clear();
}

function normalizeFallbackKey(s: string): string {
  return s.trim().toLowerCase().normalize('NFC');
}

async function getOrBuildFallbackKeyIndex(
  blob: Blob,
  meta: MdictDictionaryRecord
): Promise<Map<string, KeyRangeRef[]>> {
  const existing = fallbackKeyIndexCache.get(meta.id);
  if (existing) {
    // Refresh LRU order
    fallbackKeyIndexCache.delete(meta.id);
    fallbackKeyIndexCache.set(meta.id, existing);
    return existing;
  }

  const inFlight = fallbackKeyIndexPromises.get(meta.id);
  if (inFlight) return inFlight;

  const buildPromise = (async () => {
    const index = new Map<string, KeyRangeRef[]>();
    let pendingTailRef: KeyRangeRef | null = null;

    for (let blockIdx = 0; blockIdx < meta.keyBlocks.length; blockIdx++) {
      const entries = await readKeyBlockEntries(blob, meta, blockIdx);
      if (entries.length === 0) continue;

      if (pendingTailRef) {
        pendingTailRef.end = entries[0].recordStartOffset;
        pendingTailRef = null;
      }

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const end =
          i + 1 < entries.length
            ? entries[i + 1].recordStartOffset
            : meta.totalRecordDecompressedSize;
        const ref: KeyRangeRef = {
          key: entry.key,
          start: entry.recordStartOffset,
          end,
        };
        const normKey = normalizeFallbackKey(entry.key);
        if (normKey) {
          const list = index.get(normKey);
          if (list) {
            list.push(ref);
          } else {
            index.set(normKey, [ref]);
          }
        }
        if (i === entries.length - 1) {
          pendingTailRef = ref;
        }
      }
    }

    if (fallbackKeyIndexCache.size >= MAX_FALLBACK_INDEX_DICTS) {
      const oldestKey = fallbackKeyIndexCache.keys().next().value;
      if (oldestKey !== undefined) {
        fallbackKeyIndexCache.delete(oldestKey);
      }
    }
    fallbackKeyIndexCache.set(meta.id, index);
    return index;
  })();

  fallbackKeyIndexPromises.set(meta.id, buildPromise);
  try {
    return await buildPromise;
  } finally {
    fallbackKeyIndexPromises.delete(meta.id);
  }
}

async function scanRemainingKeyBlocksForWord(
  blob: Blob,
  meta: MdictDictionaryRecord,
  word: string,
  checkedBlocks: Set<number>
): Promise<KeyRangeRef[]> {
  const normTarget = normalizeFallbackKey(word);
  const exactMatches: KeyRangeRef[] = [];
  const trimmedMatches: KeyRangeRef[] = [];
  const normMatches: KeyRangeRef[] = [];

  for (let blockIdx = 0; blockIdx < meta.keyBlocks.length; blockIdx++) {
    if (checkedBlocks.has(blockIdx)) continue;
    const entries = await readKeyBlockEntries(blob, meta, blockIdx);
    const matchedIndices: Array<{ idx: number; tier: 0 | 1 | 2 }> = [];

    for (let i = 0; i < entries.length; i++) {
      const k = entries[i].key;
      if (k === word) {
        matchedIndices.push({ idx: i, tier: 0 });
      } else if (k.trim() === word) {
        matchedIndices.push({ idx: i, tier: 1 });
      } else if (normalizeFallbackKey(k) === normTarget) {
        matchedIndices.push({ idx: i, tier: 2 });
      }
    }

    if (matchedIndices.length === 0) continue;

    let nextBlockFirstOffset: number | null = null;
    for (const { idx, tier } of matchedIndices) {
      const start = entries[idx].recordStartOffset;
      let end: number;
      if (idx + 1 < entries.length) {
        end = entries[idx + 1].recordStartOffset;
      } else if (blockIdx + 1 < meta.keyBlocks.length) {
        if (nextBlockFirstOffset === null) {
          const nextEntries = await readKeyBlockEntries(blob, meta, blockIdx + 1);
          nextBlockFirstOffset =
            nextEntries.length > 0
              ? nextEntries[0].recordStartOffset
              : meta.totalRecordDecompressedSize;
        }
        end = nextBlockFirstOffset;
      } else {
        end = meta.totalRecordDecompressedSize;
      }
      const ref: KeyRangeRef = { key: entries[idx].key, start, end };
      if (tier === 0) exactMatches.push(ref);
      else if (tier === 1) trimmedMatches.push(ref);
      else normMatches.push(ref);
    }
  }

  if (exactMatches.length > 0) return exactMatches;
  if (trimmedMatches.length > 0) return trimmedMatches;
  return normMatches;
}

async function readKeyBlockEntries(
  blob: Blob,
  meta: MdictDictionaryRecord,
  blockIdx: number
): Promise<Array<{ recordStartOffset: number; key: string }>> {
  const kb = meta.keyBlocks[blockIdx];
  const numberWidth: 4 | 8 = meta.version >= 2.0 ? 8 : 4;
  const raw = new Uint8Array(
    await blob.slice(kb.compressedOffset, kb.compressedOffset + kb.compressedSize).arrayBuffer()
  );
  const decompressed = decompressBlock(raw, kb.decompressedSize);
  return splitKeyBlockEntries(decompressed, numberWidth, meta.encoding);
}

async function readRecordRangeText(
  blob: Blob,
  meta: MdictDictionaryRecord,
  startOffset: number,
  endOffset: number
): Promise<string> {
  if (endOffset <= startOffset || meta.recordBlocks.length === 0) return '';

  // Binary search first record block with decompressedOffset + decompressedSize > startOffset
  let lo = 0;
  let hi = meta.recordBlocks.length - 1;
  let firstIdx = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = meta.recordBlocks[mid];
    const bEnd = b.decompressedOffset + b.decompressedSize;
    if (bEnd <= startOffset) {
      lo = mid + 1;
    } else {
      firstIdx = mid;
      hi = mid - 1;
    }
  }

  const chunks: Uint8Array[] = [];
  let totalChunkBytes = 0;

  for (let i = firstIdx; i < meta.recordBlocks.length; i++) {
    const rb = meta.recordBlocks[i];
    if (rb.decompressedOffset >= endOffset) break;

    const raw = new Uint8Array(
      await blob.slice(rb.compressedOffset, rb.compressedOffset + rb.compressedSize).arrayBuffer()
    );
    const decomp = decompressBlock(raw, rb.decompressedSize);

    const sliceStart = Math.max(0, startOffset - rb.decompressedOffset);
    const sliceEnd = Math.min(decomp.length, endOffset - rb.decompressedOffset);
    if (sliceEnd > sliceStart) {
      const part = decomp.subarray(sliceStart, sliceEnd);
      chunks.push(part);
      totalChunkBytes += part.length;
    }
  }

  const combined = new Uint8Array(totalChunkBytes);
  let pos = 0;
  for (const c of chunks) {
    combined.set(c, pos);
    pos += c.length;
  }

  return decodeRecordText(combined, meta.encoding).trim();
}

async function lookupExactWord(
  blob: Blob,
  meta: MdictDictionaryRecord,
  word: string,
  visited = new Set<string>()
): Promise<{ matchedHeadword: string; htmlDefinitions: string[] } | null> {
  const visitKey = normalizeFallbackKey(word);
  if (visited.has(visitKey) || visited.size >= 4) return null;
  visited.add(visitKey);

  const useCodePointOrder = meta.encoding === 'utf-8';
  const candidateBlocks = selectCandidateKeyBlockIndices(
    meta.keyBlocks,
    word,
    meta.isStripKey,
    meta.isCaseSensitive,
    useCodePointOrder
  );

  const matchedRanges: KeyRangeRef[] = [];
  const lowerTarget = word.toLowerCase();
  const strippedTarget = stripKeyForSort(word);

  for (const blockIdx of candidateBlocks) {
    const entries = await readKeyBlockEntries(blob, meta, blockIdx);
    const exactIndices: number[] = [];
    const trimmedExactIndices: number[] = [];
    const ciIndices: number[] = [];
    const strippedIndices: number[] = [];

    for (let i = 0; i < entries.length; i++) {
      const k = entries[i].key;
      const trimmedK = k.trim();
      if (k === word) {
        exactIndices.push(i);
      } else if (trimmedK === word) {
        trimmedExactIndices.push(i);
      } else if (trimmedK.toLowerCase() === lowerTarget) {
        ciIndices.push(i);
      } else if (meta.isStripKey && strippedTarget && stripKeyForSort(trimmedK) === strippedTarget) {
        strippedIndices.push(i);
      }
    }

    const chosen =
      exactIndices.length > 0
        ? exactIndices
        : trimmedExactIndices.length > 0
          ? trimmedExactIndices
          : ciIndices.length > 0
            ? ciIndices
            : strippedIndices;

    if (chosen.length === 0) continue;

    let nextBlockFirstOffset: number | null = null;
    for (const idx of chosen) {
      const start = entries[idx].recordStartOffset;
      let end: number;
      if (idx + 1 < entries.length) {
        end = entries[idx + 1].recordStartOffset;
      } else if (blockIdx + 1 < meta.keyBlocks.length) {
        if (nextBlockFirstOffset === null) {
          const nextEntries = await readKeyBlockEntries(blob, meta, blockIdx + 1);
          nextBlockFirstOffset =
            nextEntries.length > 0
              ? nextEntries[0].recordStartOffset
              : meta.totalRecordDecompressedSize;
        }
        end = nextBlockFirstOffset;
      } else {
        end = meta.totalRecordDecompressedSize;
      }
      matchedRanges.push({ key: entries[idx].key, start, end });
    }

    // Only stop early if all exact matches are strictly before the end of this block
    if (
      exactIndices.length > 0 &&
      exactIndices[exactIndices.length - 1] < entries.length - 1
    ) {
      break;
    }
  }

  // Fallback for Chinese/GBK/Big5/Pinyin/non-Unicode-sorted .mdx dictionaries (and non-BMP chars)
  // where binary search in Unicode order cannot locate the headword's key block.
  if (matchedRanges.length === 0 && candidateBlocks.length < meta.keyBlocks.length) {
    const hasNonBmp = word.length > Array.from(word).length;
    const needsFallback =
      meta.encoding === 'gb18030' ||
      meta.encoding === 'big5' ||
      hasNonBmp ||
      !hasMonotonicUnicodeOrder(meta);

    if (needsFallback) {
      if (meta.numEntries <= MAX_FALLBACK_INDEX_ENTRIES) {
        const index = await getOrBuildFallbackKeyIndex(blob, meta);
        const bucket = index.get(visitKey);
        if (bucket && bucket.length > 0) {
          const exact = bucket.filter((r) => r.key === word);
          const trimmed = exact.length > 0 ? exact : bucket.filter((r) => r.key.trim() === word);
          matchedRanges.push(...(trimmed.length > 0 ? trimmed : bucket));
        }
      } else {
        const scanned = await scanRemainingKeyBlocksForWord(
          blob,
          meta,
          word,
          new Set(candidateBlocks)
        );
        matchedRanges.push(...scanned);
      }
    }
  }

  if (matchedRanges.length === 0) return null;

  const htmlDefinitions: string[] = [];
  let matchedHeadword = matchedRanges[0].key;

  for (const r of matchedRanges) {
    const rawDef = await readRecordRangeText(blob, meta, r.start, r.end);
    if (!rawDef) continue;

    if (rawDef.startsWith('@@@LINK=')) {
      const linkTarget = rawDef.slice('@@@LINK='.length).split(/[\r\n]/)[0].trim();
      if (linkTarget) {
        const redirected = await lookupExactWord(blob, meta, linkTarget, visited);
        if (redirected) {
          if (htmlDefinitions.length === 0) {
            matchedHeadword = redirected.matchedHeadword;
          }
          htmlDefinitions.push(...redirected.htmlDefinitions);
          continue;
        }
      }
    }
    htmlDefinitions.push(expandStyleSheetTags(rawDef, meta.styleSheet));
  }

  if (htmlDefinitions.length === 0) return null;
  return { matchedHeadword, htmlDefinitions };
}

export async function lookupInMdictBlob(
  blob: Blob,
  meta: MdictDictionaryRecord,
  rawQuery: string
): Promise<MdictLookupResult | null> {
  const candidates = buildLookupCandidates(rawQuery);
  for (const candidate of candidates) {
    const res = await lookupExactWord(blob, meta, candidate);
    if (res) {
      return {
        dictId: meta.id,
        dictTitle: meta.title,
        dictCssText: meta.cssText,
        queryWord: rawQuery,
        matchedHeadword: res.matchedHeadword,
        htmlDefinitions: res.htmlDefinitions,
      };
    }
  }
  return null;
}

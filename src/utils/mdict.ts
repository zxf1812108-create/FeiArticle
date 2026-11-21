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
    ensureCapacity(count);
    for (let i = 0; i < count; i++) {
      out[op++] = input[ip++];
    }
  };

  const copyMatch = (mPos: number, mLen: number) => {
    ensureCapacity(mLen);
    for (let i = 0; i < mLen; i++) {
      out[op++] = out[mPos++];
    }
  };

  let t = input[ip++];
  let skipFirstMatchCheck = false;

  if (t > 17) {
    t -= 17;
    if (t < 4) {
      copyLiterals(t);
      t = input[ip++];
    } else {
      copyLiterals(t);
      skipFirstMatchCheck = true;
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!skipFirstMatchCheck) {
      if (t < 16) {
        if (t === 0) {
          while (input[ip] === 0) {
            t += 255;
            ip++;
          }
          t += 15 + input[ip++];
        }
        copyLiterals(t + 3);
        if (ip >= input.length) break;
      }
    }
    skipFirstMatchCheck = false;

    if (ip >= input.length) break;
    if (t < 16) {
      t = input[ip++];
      if (t < 16) {
        const mPos = op - 0x0801 - (t >> 2) - (input[ip++] << 2);
        copyMatch(mPos, 3);
        t = input[ip - 2] & 3;
        if (t !== 0) {
          copyLiterals(t);
          if (ip >= input.length) break;
          t = input[ip++];
          continue;
        }
        if (ip >= input.length) break;
        t = input[ip++];
        continue;
      }
    }

    // Match loop
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let mPos: number;
      let mLen: number;
      if (t >= 64) {
        mPos = op - 1 - ((t >> 2) & 7) - (input[ip++] << 3);
        mLen = (t >> 5) + 1;
      } else if (t >= 32) {
        t &= 31;
        if (t === 0) {
          while (input[ip] === 0) {
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
          while (input[ip] === 0) {
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

      t = input[ip - 2] & 3;
      if (t === 0) break;
      copyLiterals(t);
      if (ip >= input.length) return out.subarray(0, op);
      t = input[ip++];
    }

    if (ip >= input.length) break;
    t = input[ip++];
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
  if (lower === 'gbk' || lower === 'gb2312' || lower === 'gb18030') return 'gb18030';
  if (lower === 'big5') return 'big5';
  return 'utf-8';
}

function decodeText(bytes: Uint8Array, encoding: MdictEncoding): string {
  const decoder = new TextDecoder(encoding);
  return decoder.decode(bytes).replace(/\0+$/, '');
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
  headerTag: 'Dictionary' | 'Library_Data';
  fileExt: 'mdx' | 'mdd';
  title: string;
  description: string;
  encoding: MdictEncoding;
  keyEncoding: MdictEncoding;
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
  const fileExt: 'mdx' | 'mdd' = fileName.toLowerCase().endsWith('.mdd') ? 'mdd' : 'mdx';
  if (blob.size < 32) {
    throw new Error(`文件过小，不是有效的 .${fileExt} 词典文件`);
  }

  const headPrefix = new DataView(await blob.slice(0, 4).arrayBuffer());
  const headerBytesSize = headPrefix.getUint32(0, false);
  if (headerBytesSize <= 0 || headerBytesSize > 4 * 1024 * 1024 || 8 + headerBytesSize >= blob.size) {
    throw new Error(`文件头格式无效，不是标准的 .${fileExt} 词典文件`);
  }

  const headerBytes = new Uint8Array(await blob.slice(4, 4 + headerBytesSize).arrayBuffer());
  const headerXml = new TextDecoder('utf-16le').decode(headerBytes).replace(/\0+$/, '');
  const trimmedHeader = headerXml.trimStart();
  const isLibraryData = /^<Library_Data\b/i.test(trimmedHeader);
  const isDictionary = /^<Dictionary\b/i.test(trimmedHeader);
  if (!isLibraryData && !isDictionary) {
    throw new Error(`文件头结构无法识别，不是标准的 .mdx / .mdd 词典文件`);
  }

  const attrs = parseHeaderAttributes(headerXml);

  const version = parseFloat(attrs.GeneratedByEngineVersion || '1.2') || 1.2;
  if (version >= 3.0) {
    throw new Error('暂不支持 MDict 3.0 格式词库，请使用标准 v1.2 / v2.0 文件');
  }

  const encAttr = (attrs.Encrypted || '0').trim().toLowerCase();
  let encrypt = 0;
  if (encAttr === 'yes' || encAttr === '1') encrypt = 1;
  else if (encAttr === '2') encrypt = 2;
  else if (encAttr === '3') encrypt = 3;

  if ((encrypt & 1) !== 0) {
    throw new Error('该词库启用了个人注册码加密（Encrypted=1），暂不支持解密');
  }

  const encoding: MdictEncoding = normalizeEncoding(attrs.Encoding);
  // Standard <Library_Data> files store keys in UTF-16LE even when record payloads are UTF-8 HTML
  const keyEncoding: MdictEncoding = isLibraryData ? 'utf-16le' : encoding;
  const isStripKey = isLibraryData
    ? (attrs.StripKey || 'No').trim().toLowerCase() === 'yes'
    : (attrs.StripKey || 'Yes').trim().toLowerCase() !== 'no';
  const isCaseSensitive = (attrs.KeyCaseSensitive || 'No').trim().toLowerCase() === 'yes';
  const styleSheet = parseStyleSheetMap(attrs.StyleSheet);
  const fallbackTitle = fileName.replace(/\.(mdx|mdd)$/i, '') || '未命名词典';
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
  const charUnit = keyEncoding === 'utf-16le' ? 2 : 1;
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
      keyEncoding
    );
    p += firstKeyByteLen;

    const lastKeyLen = version >= 2.0 ? kbiDv.getUint16(p, false) : kbiDv.getUint8(p);
    p += version >= 2.0 ? 2 : 1;
    const lastKeyByteLen = (lastKeyLen + textTerm) * charUnit;
    const lastKey = decodeText(
      keyBlockInfoBytes.subarray(p, p + lastKeyByteLen),
      keyEncoding
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
    headerTag: isLibraryData ? 'Library_Data' : 'Dictionary',
    fileExt,
    title,
    description,
    encoding,
    keyEncoding,
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
    fileExt: parsed.fileExt,
    headerTag: parsed.headerTag,
    title: parsed.title,
    description: parsed.description,
    encoding: parsed.encoding,
    keyEncoding: parsed.keyEncoding,
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

export function extractEnglishLookupWord(rawSelection: string): string | null {
  if (!rawSelection || rawSelection.includes('\n') || rawSelection.includes('\r')) {
    return null;
  }
  const cleaned = rawSelection
    .trim()
    .replace(/^[\s"'“”‘’.,;:!?()[\]{}<>《》「」『』—–·•/\\]+/, '')
    .replace(/[\s"'“”‘’.,;:!?()[\]{}<>《》「」『』—–·•/\\]+$/, '');

  if (!cleaned || cleaned.length > 48) return null;
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

export function buildEnglishLookupCandidates(word: string): string[] {
  const candidates: string[] = [];
  const push = (w: string) => {
    const trimmed = w.trim();
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  push(word);
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

function stripKeyForSort(s: string): string {
  return s.replace(/[()., '/\\@_-]+/g, '').toLowerCase();
}

function compareMdictKeys(a: string, b: string, isStripKey: boolean, isCaseSensitive: boolean): number {
  const ka = isStripKey ? stripKeyForSort(a) : isCaseSensitive ? a : a.toLowerCase();
  const kb = isStripKey ? stripKeyForSort(b) : isCaseSensitive ? b : b.toLowerCase();
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return 0;
}

function selectCandidateKeyBlockIndices(
  keyBlocks: MdictKeyBlockMeta[],
  target: string,
  isStripKey: boolean,
  isCaseSensitive: boolean
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
      const cmpFirst = compareMdictKeys(keyBlocks[mid].firstKey, target, stripMode, caseMode);
      const cmpLast = compareMdictKeys(keyBlocks[mid].lastKey, target, stripMode, caseMode);
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

async function readKeyBlockEntries(
  blob: Blob,
  meta: {
    version: number;
    encoding: MdictEncoding;
    keyEncoding?: MdictEncoding;
    keyBlocks: MdictKeyBlockMeta[];
  },
  blockIdx: number
): Promise<Array<{ recordStartOffset: number; key: string }>> {
  const kb = meta.keyBlocks[blockIdx];
  const numberWidth: 4 | 8 = meta.version >= 2.0 ? 8 : 4;
  const raw = new Uint8Array(
    await blob.slice(kb.compressedOffset, kb.compressedOffset + kb.compressedSize).arrayBuffer()
  );
  const decompressed = decompressBlock(raw, kb.decompressedSize);
  return splitKeyBlockEntries(decompressed, numberWidth, meta.keyEncoding || meta.encoding);
}

async function readRecordRangeBytes(
  blob: Blob,
  recordBlocks: MdictRecordBlockMeta[],
  startOffset: number,
  endOffset: number
): Promise<Uint8Array> {
  if (endOffset <= startOffset || recordBlocks.length === 0) {
    return new Uint8Array(0);
  }

  // Binary search first record block with decompressedOffset + decompressedSize > startOffset
  let lo = 0;
  let hi = recordBlocks.length - 1;
  let firstIdx = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = recordBlocks[mid];
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

  for (let i = firstIdx; i < recordBlocks.length; i++) {
    const rb = recordBlocks[i];
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

  return combined;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
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
    return 'image/webp';
  }
  return null;
}

function decodeSmartRecordPayload(bytes: Uint8Array, fallbackEncoding: MdictEncoding): string {
  const imageMime = detectImageMime(bytes);
  if (imageMime) {
    return `<img src="data:${imageMime};base64,${uint8ToBase64(bytes)}" />`;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2)).replace(/\0+$/, '').trim();
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2)).replace(/\0+$/, '').trim();
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3)).replace(/\0+$/, '').trim();
  }

  // Heuristic for BOM-less UTF-16LE HTML/ASCII records inside Library_Data .mdd
  const samplePairs = Math.min(24, Math.floor(bytes.length / 2));
  if (samplePairs >= 4) {
    let oddZeros = 0;
    let evenPrintable = 0;
    for (let i = 0; i < samplePairs; i++) {
      if (bytes[i * 2 + 1] === 0) oddZeros++;
      const ev = bytes[i * 2];
      if ((ev >= 0x20 && ev <= 0x7e) || ev === 0x0a || ev === 0x0d || ev === 0x09) {
        evenPrintable++;
      }
    }
    if (oddZeros >= Math.ceil(samplePairs * 0.7) && evenPrintable >= Math.ceil(samplePairs * 0.7)) {
      return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/, '').trim();
    }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0+$/, '').trim();
  } catch {
    return decodeText(bytes, fallbackEncoding).trim();
  }
}

async function readRecordRangeText(
  blob: Blob,
  meta: MdictDictionaryRecord,
  startOffset: number,
  endOffset: number
): Promise<string> {
  const combined = await readRecordRangeBytes(blob, meta.recordBlocks, startOffset, endOffset);
  if (combined.length === 0) return '';
  if (meta.headerTag === 'Library_Data' || meta.fileExt === 'mdd') {
    return decodeSmartRecordPayload(combined, meta.encoding);
  }
  return decodeText(combined, meta.encoding).trim();
}

export function normalizeMddKey(rawPath: string): string {
  let cleaned = rawPath.trim();
  cleaned = cleaned.replace(/^(?:file|entry|sound|bword):\/\//i, '');
  cleaned = cleaned.split('#')[0].split('?')[0];
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Keep raw if malformed percent encoding
  }
  cleaned = cleaned.replace(/\//g, '\\').replace(/^\\+/, '');
  return `\\${cleaned}`;
}

export function guessMimeFromPath(path: string): string {
  const lower = path.split('?')[0].split('#')[0].toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.css')) return 'text/css';
  return 'application/octet-stream';
}

export async function lookupResourceInMdictBlob(
  blob: Blob,
  meta: MdictDictionaryRecord,
  rawPath: string
): Promise<Uint8Array | null> {
  const normalized = normalizeMddKey(rawPath);
  const candidates = [normalized, normalized.slice(1)];
  const lastSlash = normalized.lastIndexOf('\\');
  if (lastSlash > 0) {
    const baseName = normalized.slice(lastSlash + 1);
    for (const k of [`\\${baseName}`, baseName]) {
      if (!candidates.includes(k)) candidates.push(k);
    }
  }

  for (const targetKey of candidates) {
    const lowerTarget = targetKey.toLowerCase();
    const candidateBlocks = selectCandidateKeyBlockIndices(
      meta.keyBlocks,
      targetKey,
      meta.isStripKey,
      false
    );

    for (const blockIdx of candidateBlocks) {
      const entries = await readKeyBlockEntries(blob, meta, blockIdx);
      let matchIdx = entries.findIndex((e) => e.key === targetKey);
      if (matchIdx === -1) {
        matchIdx = entries.findIndex((e) => e.key.toLowerCase() === lowerTarget);
      }
      if (matchIdx === -1) continue;

      const start = entries[matchIdx].recordStartOffset;
      let end: number;
      if (matchIdx + 1 < entries.length) {
        end = entries[matchIdx + 1].recordStartOffset;
      } else if (blockIdx + 1 < meta.keyBlocks.length) {
        const nextEntries = await readKeyBlockEntries(blob, meta, blockIdx + 1);
        end =
          nextEntries.length > 0
            ? nextEntries[0].recordStartOffset
            : meta.totalRecordDecompressedSize;
      } else {
        end = meta.totalRecordDecompressedSize;
      }

      const bytes = await readRecordRangeBytes(blob, meta.recordBlocks, start, end);
      if (bytes.length > 0) {
        return bytes;
      }
    }
  }

  return null;
}

function cleanMddHeadwordDisplay(rawKey: string, isMddStyle: boolean): string {
  if (!isMddStyle) return rawKey;
  return rawKey.replace(/^[\\/]+/, '').replace(/\.(?:html?|txt)$/i, '') || rawKey;
}

async function lookupExactWord(
  blob: Blob,
  meta: MdictDictionaryRecord,
  word: string,
  visited = new Set<string>()
): Promise<{ matchedHeadword: string; htmlDefinitions: string[] } | null> {
  const visitKey = word.toLowerCase();
  if (visited.has(visitKey) || visited.size >= 4) return null;
  visited.add(visitKey);

  const isMddStyle = meta.headerTag === 'Library_Data' || meta.fileExt === 'mdd';
  const blockSet = new Set<number>(
    selectCandidateKeyBlockIndices(meta.keyBlocks, word, meta.isStripKey, meta.isCaseSensitive)
  );
  if (isMddStyle && !word.startsWith('\\') && !word.startsWith('/')) {
    for (const idx of selectCandidateKeyBlockIndices(
      meta.keyBlocks,
      `\\${word}`,
      meta.isStripKey,
      meta.isCaseSensitive
    )) {
      blockSet.add(idx);
    }
    for (const idx of selectCandidateKeyBlockIndices(
      meta.keyBlocks,
      `/${word}`,
      meta.isStripKey,
      meta.isCaseSensitive
    )) {
      blockSet.add(idx);
    }
  }
  const candidateBlocks = Array.from(blockSet).sort((a, b) => a - b);

  const matchedRanges: Array<{ key: string; start: number; end: number }> = [];
  const lowerTarget = word.toLowerCase();
  const strippedTarget = stripKeyForSort(word);

  for (const blockIdx of candidateBlocks) {
    const entries = await readKeyBlockEntries(blob, meta, blockIdx);
    const exactIndices: number[] = [];
    const ciIndices: number[] = [];
    const strippedIndices: number[] = [];

    for (let i = 0; i < entries.length; i++) {
      const k = entries[i].key;
      if (k === word) {
        exactIndices.push(i);
      } else if (k.toLowerCase() === lowerTarget) {
        ciIndices.push(i);
      } else if (isMddStyle) {
        const noSlash = k.replace(/^[\\/]+/, '');
        const stem = noSlash.replace(/\.(?:html?|txt)$/i, '');
        if (noSlash === word || stem === word) {
          exactIndices.push(i);
        } else if (
          noSlash.toLowerCase() === lowerTarget ||
          stem.toLowerCase() === lowerTarget
        ) {
          ciIndices.push(i);
        } else if (meta.isStripKey && strippedTarget && stripKeyForSort(k) === strippedTarget) {
          strippedIndices.push(i);
        }
      } else if (meta.isStripKey && strippedTarget && stripKeyForSort(k) === strippedTarget) {
        strippedIndices.push(i);
      }
    }

    const chosen =
      exactIndices.length > 0
        ? exactIndices
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

    if (exactIndices.length > 0) break;
  }

  if (matchedRanges.length === 0) return null;

  const htmlDefinitions: string[] = [];
  let matchedHeadword = cleanMddHeadwordDisplay(matchedRanges[0].key, isMddStyle);

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
  const candidates = buildEnglishLookupCandidates(rawQuery);
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

import { MdictDictionaryRecord, MdictDictionarySummary, MdictLookupResult } from '../types';
import {
  guessMimeFromPath,
  lookupInMdictBlob,
  lookupResourceInMdictBlob,
  parseMdictIndexFromBlob,
  sanitizeMdictCss,
  uint8ToBase64,
} from './mdict';

export function stripDictExt(fileName: string): string {
  return fileName.replace(/\.(mdx|mdd)$/i, '');
}

const DB_NAME = 'feiartical_mdict_db';
const DB_VERSION = 1;
const STORE_DICTS = 'dicts';
const STORE_BLOBS = 'blobs';

const recordCache = new Map<string, MdictDictionaryRecord>();

function openMdictDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持本地词库存储 (IndexedDB)'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DICTS)) {
        db.createObjectStore(STORE_DICTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('打开词库数据库失败'));
  });
}

function toSummary(rec: MdictDictionaryRecord): MdictDictionarySummary {
  const fileExt = rec.fileExt || (rec.fileName.toLowerCase().endsWith('.mdd') ? 'mdd' : 'mdx');
  return {
    id: rec.id,
    fileName: rec.fileName,
    fileExt,
    title: rec.title,
    description: rec.description,
    numEntries: rec.numEntries,
    fileSize: rec.fileSize,
    addedAt: rec.addedAt,
    cssFileName: rec.cssFileName,
  };
}

export async function listMdictDictionaries(): Promise<MdictDictionarySummary[]> {
  const db = await openMdictDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DICTS, 'readonly');
    const store = tx.objectStore(STORE_DICTS);
    const req = store.getAll();
    req.onsuccess = () => {
      const records = (req.result || []) as MdictDictionaryRecord[];
      for (const r of records) {
        recordCache.set(r.id, r);
      }
      records.sort((a, b) => a.addedAt - b.addedAt);
      resolve(records.map(toSummary));
    };
    req.onerror = () => reject(req.error || new Error('读取词典列表失败'));
    tx.oncomplete = () => db.close();
  });
}

function decodeCssBytesText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

export async function importMdictFile(file: File): Promise<MdictDictionarySummary> {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.mdx') && !lower.endsWith('.mdd')) {
    throw new Error(`文件「${file.name}」不是受支持的 .mdx 或 .mdd 词典文件`);
  }

  const record = await parseMdictIndexFromBlob(file, file.name);
  const db = await openMdictDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_DICTS, STORE_BLOBS], 'readwrite');
    tx.objectStore(STORE_DICTS).put(record);
    tx.objectStore(STORE_BLOBS).put(file, record.id);
    tx.oncomplete = () => {
      recordCache.set(record.id, record);
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('保存词典文件失败'));
    };
  });

  return toSummary(record);
}

export async function deleteMdictDictionary(id: string): Promise<void> {
  const db = await openMdictDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_DICTS, STORE_BLOBS], 'readwrite');
    tx.objectStore(STORE_DICTS).delete(id);
    tx.objectStore(STORE_BLOBS).delete(id);
    tx.oncomplete = () => {
      recordCache.delete(id);
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('删除词典失败'));
    };
  });
}

async function decodeCssFileText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return decodeCssBytesText(bytes);
}

export async function attachMdictCss(
  dictId: string,
  cssFile: File
): Promise<MdictDictionarySummary> {
  if (!cssFile.name.toLowerCase().endsWith('.css')) {
    throw new Error(`文件「${cssFile.name}」不是 .css 样式文件`);
  }
  const rawCss = await decodeCssFileText(cssFile);
  const cleanedCss = sanitizeMdictCss(rawCss);

  const db = await openMdictDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DICTS, 'readwrite');
    const store = tx.objectStore(STORE_DICTS);
    const getReq = store.get(dictId);
    getReq.onsuccess = () => {
      const rec = getReq.result as MdictDictionaryRecord | undefined;
      if (!rec) {
        reject(new Error('未找到对应的词典记录'));
        return;
      }
      const updated: MdictDictionaryRecord = {
        ...rec,
        cssText: cleanedCss,
        cssFileName: cssFile.name,
      };
      store.put(updated);
      recordCache.set(dictId, updated);
      tx.oncomplete = () => {
        db.close();
        resolve(toSummary(updated));
      };
    };
    getReq.onerror = () => {
      db.close();
      reject(getReq.error || new Error('读取词典记录失败'));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('保存样式文件失败'));
    };
  });
}

export async function removeMdictCss(dictId: string): Promise<MdictDictionarySummary> {
  const db = await openMdictDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DICTS, 'readwrite');
    const store = tx.objectStore(STORE_DICTS);
    const getReq = store.get(dictId);
    getReq.onsuccess = () => {
      const rec = getReq.result as MdictDictionaryRecord | undefined;
      if (!rec) {
        reject(new Error('未找到对应的词典记录'));
        return;
      }
      const updated: MdictDictionaryRecord = {
        ...rec,
        cssText: undefined,
        cssFileName: undefined,
      };
      store.put(updated);
      recordCache.set(dictId, updated);
      tx.oncomplete = () => {
        db.close();
        resolve(toSummary(updated));
      };
    };
    getReq.onerror = () => {
      db.close();
      reject(getReq.error || new Error('读取词典记录失败'));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('移除样式失败'));
    };
  });
}

async function loadMdictRecordAndBlob(
  id: string
): Promise<{ record: MdictDictionaryRecord; blob: Blob } | null> {
  const db = await openMdictDb();
  return new Promise((resolve, reject) => {
    const cached = recordCache.get(id);
    const tx = db.transaction(cached ? [STORE_BLOBS] : [STORE_DICTS, STORE_BLOBS], 'readonly');
    const blobReq = tx.objectStore(STORE_BLOBS).get(id);
    const recReq = cached ? null : tx.objectStore(STORE_DICTS).get(id);

    let blobResult: Blob | undefined;
    let recResult: MdictDictionaryRecord | undefined = cached;

    blobReq.onsuccess = () => {
      blobResult = blobReq.result as Blob | undefined;
    };
    if (recReq) {
      recReq.onsuccess = () => {
        recResult = recReq.result as MdictDictionaryRecord | undefined;
        if (recResult) recordCache.set(id, recResult);
      };
    }

    tx.oncomplete = () => {
      db.close();
      if (!recResult || !blobResult) {
        resolve(null);
      } else {
        resolve({ record: recResult, blob: blobResult });
      }
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('读取词典数据失败'));
    };
  });
}

async function hydrateSelfContainedMddResources(
  result: MdictLookupResult,
  blob: Blob,
  record: MdictDictionaryRecord
): Promise<MdictLookupResult> {
  const isMdd = record.headerTag === 'Library_Data' || record.fileExt === 'mdd';
  if (!isMdd) return result;

  let resolvedCssText = result.dictCssText;
  if (!resolvedCssText) {
    const cssCandidates: string[] = [];
    for (const html of result.htmlDefinitions) {
      const linkRegex = /<link\b[^>]*href=["']([^"']+\.css(?:[?#][^"']*)?)["'][^>]*>/gi;
      let m: RegExpExecArray | null;
      while ((m = linkRegex.exec(html)) !== null) {
        if (m[1] && !cssCandidates.includes(m[1])) {
          cssCandidates.push(m[1]);
        }
      }
    }
    const stemCss = `${stripDictExt(record.fileName)}.css`;
    for (const fallback of [stemCss, 'style.css', 'default.css']) {
      if (!cssCandidates.includes(fallback)) cssCandidates.push(fallback);
    }
    for (const cssPath of cssCandidates) {
      const bytes = await lookupResourceInMdictBlob(blob, record, cssPath);
      if (bytes && bytes.length > 0) {
        resolvedCssText = sanitizeMdictCss(decodeCssBytesText(bytes));
        break;
      }
    }
  }

  if (typeof DOMParser === 'undefined') {
    return resolvedCssText !== result.dictCssText
      ? { ...result, dictCssText: resolvedCssText }
      : result;
  }

  const hydratedDefs: string[] = [];
  const imgCache = new Map<string, string | null>();
  for (const rawHtml of result.htmlDefinitions) {
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    const imgs = Array.from(doc.querySelectorAll('img'));
    for (const img of imgs) {
      const src = (img.getAttribute('src') || '').trim();
      if (!src || /^(?:data:|https?:|blob:)/i.test(src)) continue;
      let dataUrl = imgCache.get(src);
      if (dataUrl === undefined) {
        const bytes = await lookupResourceInMdictBlob(blob, record, src);
        dataUrl =
          bytes && bytes.length > 0
            ? `data:${guessMimeFromPath(src)};base64,${uint8ToBase64(bytes)}`
            : null;
        imgCache.set(src, dataUrl);
      }
      if (dataUrl) {
        img.setAttribute('src', dataUrl);
      }
    }
    hydratedDefs.push(doc.body.innerHTML);
  }

  return {
    ...result,
    dictCssText: resolvedCssText,
    htmlDefinitions: hydratedDefs,
  };
}

export async function lookupMdictWord(
  dictId: string,
  rawWord: string
): Promise<MdictLookupResult | null> {
  const loaded = await loadMdictRecordAndBlob(dictId);
  if (!loaded) return null;
  const result = await lookupInMdictBlob(loaded.blob, loaded.record, rawWord);
  if (!result) return null;
  return hydrateSelfContainedMddResources(result, loaded.blob, loaded.record);
}

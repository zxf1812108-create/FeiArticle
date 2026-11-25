import { deflateSync, inflateSync } from 'fflate';

const PAYLOAD_PREFIX = 'FEIENC1:';
const COMPRESSED_ENC_PREFIX = 'FEIENCZ1:';
const COMPRESSED_PLAIN_PREFIX = 'FEIZ1:';
const PBKDF2_ITERATIONS = 100_000;

const derivedKeyCache = new Map<string, CryptoKey>();
const sessionSaltCache = new Map<string, Uint8Array>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getOrCreateSessionSalt(password: string): Uint8Array {
  const cached = sessionSaltCache.get(password);
  if (cached) return cached;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  if (sessionSaltCache.size > 16) {
    sessionSaltCache.clear();
  }
  sessionSaltCache.set(password, salt);
  return salt;
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const cacheKey = `${password}::${bytesToBase64(salt)}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;

  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  if (derivedKeyCache.size > 64) {
    derivedKeyCache.clear();
  }
  derivedKeyCache.set(cacheKey, aesKey);
  return aesKey;
}

export function isEncryptedPayload(raw: string): boolean {
  return (
    typeof raw === 'string' &&
    (raw.startsWith(PAYLOAD_PREFIX) || raw.startsWith(COMPRESSED_ENC_PREFIX))
  );
}

export function isCompressedPlainPayload(raw: string): boolean {
  return typeof raw === 'string' && raw.startsWith(COMPRESSED_PLAIN_PREFIX);
}

export async function encryptText(
  plaintext: string,
  password: string,
  options?: { reuseSalt?: boolean; compress?: boolean }
): Promise<string> {
  if (!password) {
    throw new Error('请先在同步设置中填写加密密码');
  }
  const salt = options?.reuseSalt
    ? getOrCreateSessionSalt(password)
    : crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);
  const rawBytes = new TextEncoder().encode(plaintext);
  const payloadBytes = options?.compress ? deflateSync(rawBytes, { level: 6 }) : rawBytes;
  const prefix = options?.compress ? COMPRESSED_ENC_PREFIX : PAYLOAD_PREFIX;

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    payloadBytes as BufferSource
  );
  const cipherBytes = new Uint8Array(cipherBuffer);

  return `${prefix}${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(cipherBytes)}`;
}

export async function decryptText(payload: string, password: string): Promise<string> {
  const isCompressed =
    typeof payload === 'string' && payload.startsWith(COMPRESSED_ENC_PREFIX);
  const isUncompressed = typeof payload === 'string' && payload.startsWith(PAYLOAD_PREFIX);
  if (!isCompressed && !isUncompressed) return payload;
  if (!password) {
    throw new Error('数据已加密，请点击设置图标填写加密密码');
  }

  const prefixLen = isCompressed ? COMPRESSED_ENC_PREFIX.length : PAYLOAD_PREFIX.length;
  const parts = payload.slice(prefixLen).split(':');
  if (parts.length !== 3) {
    throw new Error('密文格式损坏，无法解密');
  }

  const salt = base64ToBytes(parts[0]);
  const iv = base64ToBytes(parts[1]);
  const cipherBytes = base64ToBytes(parts[2]);

  const key = await deriveAesKey(password, salt);
  try {
    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      cipherBytes as BufferSource
    );
    const plainBytes = new Uint8Array(plainBuffer);
    const decodedBytes = isCompressed ? inflateSync(plainBytes) : plainBytes;
    return new TextDecoder().decode(decodedBytes);
  } catch {
    throw new Error('解密失败，请检查加密密码是否正确');
  }
}

/**
 * Encode manifest JSON for Jianguoyun WebDAV storage:
 * - When encryptionPassword is set: Compress-then-Encrypt (`FEIENCZ1:`) using session-cached PBKDF2 salt (<2ms after first sync)
 * - When no encryptionPassword is set: Compress-only (`FEIZ1:`) to shrink JSON transfer by ~55%-70%
 */
export async function encodeManifestPayload(
  jsonText: string,
  encryptionPassword?: string
): Promise<string> {
  const trimmedPassword = (encryptionPassword || '').trim();
  if (trimmedPassword) {
    return encryptText(jsonText, trimmedPassword, { reuseSalt: true, compress: true });
  }
  const compressed = deflateSync(new TextEncoder().encode(jsonText), { level: 6 });
  return `${COMPRESSED_PLAIN_PREFIX}${bytesToBase64(compressed)}`;
}

/**
 * Decode manifest payload seamlessly across all formats:
 * - Plaintext JSON (legacy)
 * - Compress-only (`FEIZ1:`)
 * - Legacy uncompressed encrypted (`FEIENC1:`)
 * - Compress-then-Encrypt (`FEIENCZ1:`)
 */
export async function decodeManifestPayload(
  rawBody: string,
  encryptionPassword?: string
): Promise<{ ok: true; jsonText: string; wasEncrypted: boolean; wasCompressed: boolean } | { ok: false; reason: 'missing-password' | 'wrong-password' | 'corrupt'; message: string }> {
  const trimmed = (rawBody || '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'corrupt', message: '目录索引为空' };
  }

  if (isEncryptedPayload(trimmed)) {
    const pwd = (encryptionPassword || '').trim();
    if (!pwd) {
      return {
        ok: false,
        reason: 'missing-password',
        message: '云端目录数据已加密，请先在设置中填写加密密码',
      };
    }
    try {
      const jsonText = await decryptText(trimmed, pwd);
      return {
        ok: true,
        jsonText,
        wasEncrypted: true,
        wasCompressed: trimmed.startsWith(COMPRESSED_ENC_PREFIX),
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'wrong-password',
        message: err instanceof Error ? err.message : '云端目录数据解密失败，请检查加密密码',
      };
    }
  }

  if (isCompressedPlainPayload(trimmed)) {
    try {
      const bytes = base64ToBytes(trimmed.slice(COMPRESSED_PLAIN_PREFIX.length));
      const jsonText = new TextDecoder().decode(inflateSync(bytes));
      return { ok: true, jsonText, wasEncrypted: false, wasCompressed: true };
    } catch {
      return { ok: false, reason: 'corrupt', message: '云端压缩目录索引损坏' };
    }
  }

  return { ok: true, jsonText: trimmed, wasEncrypted: false, wasCompressed: false };
}

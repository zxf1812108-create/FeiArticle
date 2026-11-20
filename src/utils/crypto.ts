const PAYLOAD_PREFIX = 'FEIENC1:';
const PBKDF2_ITERATIONS = 100_000;

const derivedKeyCache = new Map<string, CryptoKey>();

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
  return typeof raw === 'string' && raw.startsWith(PAYLOAD_PREFIX);
}

export async function encryptText(plaintext: string, password: string): Promise<string> {
  if (!password) {
    throw new Error('请先在同步设置中填写加密密码');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  const cipherBytes = new Uint8Array(cipherBuffer);

  return `${PAYLOAD_PREFIX}${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(cipherBytes)}`;
}

export async function decryptText(payload: string, password: string): Promise<string> {
  if (!isEncryptedPayload(payload)) return payload;
  if (!password) {
    throw new Error('文档已加密，请长按同步图标填写加密密码');
  }

  const parts = payload.slice(PAYLOAD_PREFIX.length).split(':');
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
    return new TextDecoder().decode(plainBuffer);
  } catch {
    throw new Error('解密失败，请检查加密密码是否正确');
  }
}

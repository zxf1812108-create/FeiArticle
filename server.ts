import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '64mb' }));

// Validate target WebDAV URL to prevent SSRF to internal networks
function isAllowedWebDavUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    // Block localhost and private IP ranges
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function joinWebDavPath(baseUrl: string, relativePath: string): string {
  const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const cleanRel = relativePath.replace(/^\/+/, '');
  return `${cleanBase}${cleanRel}`;
}

interface WebDavProxyPayload {
  baseUrl: string;
  username: string;
  password: string;
  method: 'GET' | 'PUT' | 'MKCOL' | 'DELETE' | 'PROPFIND' | 'HEAD';
  relativePath?: string;
  body?: string;
  ifNoneMatch?: string;
  depth?: '0' | '1';
}

// Stateless WebDAV proxy for Jianguoyun (坚果云) and standard HTTPS WebDAV servers
app.post('/api/webdav/proxy', async (req, res) => {
  try {
    const payload = req.body as WebDavProxyPayload;
    if (!payload || !payload.baseUrl || !payload.username || !payload.password || !payload.method) {
      res.status(400).json({
        ok: false,
        status: 400,
        error: '缺少 WebDAV 必填连接参数（地址、账号、应用密码或方法）。',
      });
      return;
    }

    const allowedMethods = new Set(['GET', 'PUT', 'MKCOL', 'DELETE', 'PROPFIND', 'HEAD']);
    if (!allowedMethods.has(payload.method)) {
      res.status(400).json({ ok: false, status: 400, error: '不支持的 WebDAV 请求方法。' });
      return;
    }

    const targetUrl = joinWebDavPath(payload.baseUrl.trim(), payload.relativePath || '');
    if (!isAllowedWebDavUrl(targetUrl)) {
      res.status(400).json({
        ok: false,
        status: 400,
        error: '仅支持公网 HTTPS WebDAV 服务地址（如 https://dav.jianguoyun.com/dav/）。',
      });
      return;
    }

    const authToken = Buffer.from(`${payload.username}:${payload.password}`, 'utf-8').toString('base64');
    const headers: Record<string, string> = {
      Authorization: `Basic ${authToken}`,
      'User-Agent': 'FeiArtical-WebDAV-Client/1.0',
    };

    if (payload.ifNoneMatch) {
      headers['If-None-Match'] = payload.ifNoneMatch;
    }
    if (payload.method === 'PROPFIND') {
      headers['Depth'] = payload.depth || '0';
      headers['Content-Type'] = 'application/xml; charset=utf-8';
    }
    if (payload.method === 'PUT') {
      headers['Content-Type'] = targetUrl.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const upstream = await fetch(targetUrl, {
      method: payload.method,
      headers,
      body:
        payload.method === 'PUT'
          ? payload.body ?? ''
          : payload.method === 'PROPFIND'
            ? '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getetag/><D:getlastmodified/><D:getcontentlength/></D:prop></D:propfind>'
            : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const etag = upstream.headers.get('etag') || undefined;
    const lastModified = upstream.headers.get('last-modified') || undefined;
    const textBody = upstream.status === 304 || payload.method === 'HEAD' ? '' : await upstream.text();
    const bytesTransferred = Buffer.byteLength(textBody, 'utf-8');

    res.status(200).json({
      ok: upstream.ok || upstream.status === 304 || upstream.status === 207 || upstream.status === 201 || upstream.status === 204,
      status: upstream.status,
      statusText: upstream.statusText,
      etag,
      lastModified,
      body: textBody,
      bytesTransferred,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '网络请求失败';
    res.status(502).json({
      ok: false,
      status: 502,
      error: message.includes('abort') ? '连接坚果云超时，请检查网络或地址。' : `连接失败：${message}`,
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// LAN Direct Connect (电脑直连) preview server bridge
let lanEnabled = false;
let lanHtml = '';
let lanStateJson = JSON.stringify({ folders: [], docs: [] });
let lanPendingActions: unknown[] = [];
let lanAuthKey: Buffer | null = null;
const lanChallenges = new Map<string, number>();
const lanTokens = new Map<string, number>();
const lanIpFailures = new Map<string, { count: number; lockUntil: number }>();

function verifyLanToken(req: express.Request): boolean {
  if (!lanAuthKey) return true;
  const token = String(req.get('X-Lan-Token') || '').trim();
  if (!token) return false;
  const expiresAt = lanTokens.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    lanTokens.delete(token);
    return false;
  }
  return true;
}

app.post('/api/lan/start', (req, res) => {
  const { html, stateJson, password } = req.body as {
    html?: string;
    stateJson?: string;
    password?: string;
  };
  lanEnabled = true;
  if (typeof html === 'string') lanHtml = html;
  if (typeof stateJson === 'string') lanStateJson = stateJson;
  lanPendingActions = [];
  lanChallenges.clear();
  lanTokens.clear();
  lanIpFailures.clear();
  lanAuthKey =
    typeof password === 'string' && password.length > 0
      ? crypto.createHash('sha256').update(`fei-lan-auth-v1:${password}`, 'utf-8').digest()
      : null;
  const host = req.get('host') || `localhost:${PORT}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  res.json({ running: true, url: `${proto}://${host}/pc` });
});

app.post('/api/lan/stop', (_req, res) => {
  lanEnabled = false;
  lanPendingActions = [];
  lanAuthKey = null;
  lanChallenges.clear();
  lanTokens.clear();
  lanIpFailures.clear();
  res.json({ running: false });
});

app.post('/api/lan/state', (req, res) => {
  const { stateJson } = req.body as { stateJson?: string };
  if (typeof stateJson === 'string') {
    lanStateJson = stateJson;
  }
  res.json({ ok: true });
});

app.get('/api/lan/poll-actions', (_req, res) => {
  const actions = lanPendingActions;
  lanPendingActions = [];
  res.json({ actions });
});

app.get('/pc', (_req, res) => {
  if (!lanEnabled || !lanHtml) {
    res.status(503).type('text/plain; charset=utf-8').send('电脑直连未开启，请在手机端同步设置中打开「电脑直连」。');
    return;
  }
  res.type('text/html; charset=utf-8').send(lanHtml);
});

app.get('/api/auth/challenge', (_req, res) => {
  if (!lanEnabled) {
    res.status(503).json({ error: '电脑直连未开启' });
    return;
  }
  if (!lanAuthKey) {
    res.json({ required: false, nonce: '' });
    return;
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  lanChallenges.set(nonce, Date.now() + 60_000);
  res.json({ required: true, nonce });
});

app.post('/api/auth/login', (req, res) => {
  if (!lanEnabled) {
    res.status(503).json({ ok: false, error: '电脑直连未开启' });
    return;
  }
  if (!lanAuthKey) {
    res.json({ ok: true, token: 'open' });
    return;
  }
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const fail = lanIpFailures.get(ip);
  if (fail && fail.lockUntil > now) {
    res.status(429).json({ ok: false, error: '尝试次数过多，请 60 秒后重试' });
    return;
  }
  const { nonce, proof } = (req.body || {}) as { nonce?: string; proof?: string };
  const exp = typeof nonce === 'string' ? lanChallenges.get(nonce) : undefined;
  if (typeof nonce === 'string') lanChallenges.delete(nonce);
  if (!exp || exp < now || typeof proof !== 'string') {
    res.status(401).json({ ok: false, error: '校验已过期，请重试' });
    return;
  }
  const expected = crypto.createHmac('sha256', lanAuthKey).update(`pc:${nonce}`, 'utf-8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const actualBuf = Buffer.from(proof.toLowerCase(), 'utf-8');
  const match =
    expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
  if (!match) {
    const nextCount = (fail?.count || 0) + 1;
    lanIpFailures.set(ip, {
      count: nextCount >= 5 ? 0 : nextCount,
      lockUntil: nextCount >= 5 ? now + 60_000 : 0,
    });
    res.status(401).json({ ok: false, error: '加密密码错误' });
    return;
  }
  lanIpFailures.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  lanTokens.set(token, now + 12 * 60 * 60 * 1000);
  res.json({ ok: true, token });
});

app.get('/api/state', (req, res) => {
  if (!lanEnabled) {
    res.status(503).json({ error: '电脑直连未开启' });
    return;
  }
  if (!verifyLanToken(req)) {
    res.status(401).json({ error: '请先输入加密密码验证' });
    return;
  }
  res.type('application/json; charset=utf-8').send(lanStateJson);
});

app.post('/api/action', (req, res) => {
  if (!lanEnabled) {
    res.status(503).json({ error: '电脑直连未开启' });
    return;
  }
  if (!verifyLanToken(req)) {
    res.status(401).json({ error: '请先输入加密密码验证' });
    return;
  }
  lanPendingActions.push(req.body);
  res.json({ ok: true });
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FeiArtical server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '12mb' }));

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
      res.status(400).json({ error: '缺少 WebDAV 必填连接参数（地址、账号、应用密码或方法）。' });
      return;
    }

    const allowedMethods = new Set(['GET', 'PUT', 'MKCOL', 'DELETE', 'PROPFIND', 'HEAD']);
    if (!allowedMethods.has(payload.method)) {
      res.status(400).json({ error: '不支持的 WebDAV 请求方法。' });
      return;
    }

    const targetUrl = joinWebDavPath(payload.baseUrl.trim(), payload.relativePath || '');
    if (!isAllowedWebDavUrl(targetUrl)) {
      res.status(400).json({ error: '仅支持公网 HTTPS WebDAV 服务地址（如 https://dav.jianguoyun.com/dav/）。' });
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
        : 'text/markdown; charset=utf-8';
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
            ? '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:getlastmodified/><D:getcontentlength/></D:prop></D:propfind>'
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

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

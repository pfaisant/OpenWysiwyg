#!/usr/bin/env node
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.zip': 'application/zip',
};

const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: http: data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function contained(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function reply(req, res, status, message, extra = {}) {
  const body = `${message}\n`;
  res.writeHead(status, {
    ...securityHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export async function createStaticServer({ root = resolve(projectRoot, 'dist') } = {}) {
  const realRoot = await realpath(root);
  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((part) => part === '..' || part.startsWith('.'))) {
        reply(req, res, 400, 'Invalid path');
        return;
      }
    } catch {
      reply(req, res, 400, 'Invalid path');
      return;
    }

    try {
      let file = resolve(realRoot, `.${pathname}`);
      if (!contained(realRoot, file)) {
        reply(req, res, 403, 'Forbidden');
        return;
      }
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const realFile = await realpath(file);
      if (!contained(realRoot, realFile)) {
        reply(req, res, 403, 'Forbidden');
        return;
      }
      const info = await stat(realFile);
      if (!info.isFile()) {
        reply(req, res, 404, 'Not found');
        return;
      }
      const ext = extname(realFile).toLowerCase();
      const immutableAsset = pathname.startsWith('/assets/') && /-[\w-]{8,}\.[\w]+$/.test(pathname);
      const headers = {
        ...securityHeaders,
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': immutableAsset ? 'public, max-age=31536000, immutable' : 'no-store',
      };
      if (ext === '.zip') headers['Content-Disposition'] = `attachment; filename="${basename(realFile).replace(/[^a-zA-Z0-9._-]/g, '_')}"`;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(realFile);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      reply(req, res, error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500,
        error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'Not found' : 'Unable to read file');
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const hosts = [...new Set((process.env.HOSTS || process.env.HOST || '127.0.0.1').split(',').map(host => host.trim()).filter(Boolean))];
  if (!hosts.length) throw new Error('HOSTS must contain at least one bind address');
  const port = Number(process.env.PORT || 4321);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const servers = [];
  const close = async (code = 0) => {
    await Promise.all(servers.map(server => new Promise(done => server.close(done))));
    process.exit(code);
  };
  for (const host of hosts) {
    const server = await createStaticServer({ root: process.env.STATIC_ROOT || resolve(projectRoot, 'dist') });
    servers.push(server);
    server.on('error', (error) => { console.error(error.message); void close(1); });
    server.listen(port, host, () => console.log(`OpenWysiwyg: http://${host.includes(':') ? `[${host}]` : host}:${port}`));
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close(); });
}

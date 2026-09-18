const http = require('http');
const path = require('path');
const fs = require('fs');

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.VISTA_PORT || 43127);
const STATIC_ROOT = path.join(__dirname, 'src');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const resolved = path.resolve(STATIC_ROOT, requested);
  if (resolved !== STATIC_ROOT && !resolved.startsWith(`${STATIC_ROOT}${path.sep}`)) {
    sendJson(response, 403, { ok: false, error: '禁止访问该路径。' });
    return;
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      sendJson(response, 404, { ok: false, error: '文件不存在。' });
      return;
    }
    response.writeHead(200, {
      'content-type': mimeTypes[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    response.end(data);
  });
}

function startServer(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const url = new URL(request.url, `http://${HOST}:${port}`);
        if (request.method === 'GET' && url.pathname === '/api/health') {
          sendJson(response, 200, { ok: true, features: { music: true } });
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          sendJson(response, 404, { ok: false, error: '接口不存在。' });
          return;
        }
        serveStatic(response, url.pathname);
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message });
      }
    });
    server.once('error', reject);
    server.listen(port, HOST, () => resolve({ server, url: `http://${HOST}:${port}` }));
  });
}

module.exports = { startServer, DEFAULT_PORT };

if (require.main === module) {
  startServer().then(({ url }) => {
    console.log(`Vista Studio running at ${url}`);
  }).catch(error => {
    if (error.code !== 'EADDRINUSE') {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

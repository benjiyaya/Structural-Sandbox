/*
 * server.js — zero-dependency static file server.
 * Serves ./public at http://localhost:8181 (localhost only).
 * Usage: node server.js   (or: npm start)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8181;
const HOST = '127.0.0.1';
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer(function (req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400);
    res.end('400 Bad Request');
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  // Resolve inside ROOT; reject path traversal.
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, function () {
  console.log('Structural Architecture Simulator');
  console.log('Serving ' + ROOT);
  console.log('Open http://localhost:' + PORT + '/ in your browser');
});

#!/usr/bin/env node
/**
 * Xibo Player - Standalone Express Server
 *
 * Serves the PWA player without Electron. Use with Chromium kiosk mode
 * for systems where Electron's GPU acceleration doesn't work (e.g. NVIDIA
 * Optimus on Wayland — Electron's pre-built Chromium binary lacks the
 * one-line Vulkan-on-Wayland patch that distro Chromium packages include).
 *
 * Usage:
 *   node server-standalone.js [--port=8765] [--dev]
 *   # Then open Chromium: chromium-browser --kiosk --app=http://localhost:8765/player/pwa/
 */

const path = require('path');
const express = require('express');
const cors = require('cors');

const APP_VERSION = '0.9.0';

// Parse CLI args
const args = process.argv.slice(2);
const isDev = args.includes('--dev');
const portArg = args.find(a => a.startsWith('--port='));
const serverPort = portArg ? parseInt(portArg.split('=')[1], 10) : 8765;

// PWA dist path
const pwaPath = isDev
  ? path.join(__dirname, '../../pwa/dist')
  : path.join(__dirname, '../resources/pwa');

console.log(`[Server] PWA path: ${pwaPath}`);
console.log(`[Server] Port: ${serverPort}, Dev: ${isDev}`);

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'SOAPAction'],
  credentials: true,
}));

app.use(express.text({ type: 'text/xml', limit: '50mb' }));
app.use(express.text({ type: 'application/xml', limit: '50mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── XMDS SOAP Proxy ──────────────────────────────────────────────
app.all('/xmds-proxy', async (req, res) => {
  try {
    const cmsUrl = req.query.cms;
    if (!cmsUrl) return res.status(400).json({ error: 'Missing cms parameter' });

    const queryParams = new URLSearchParams(req.query);
    queryParams.delete('cms');
    const queryString = queryParams.toString();
    const xmdsUrl = `${cmsUrl}/xmds.php${queryString ? '?' + queryString : ''}`;

    console.log(`[Proxy] ${req.method} ${xmdsUrl}`);

    const headers = {
      'Content-Type': req.headers['content-type'] || 'text/xml; charset=utf-8',
      'User-Agent': `Xibo Player Standalone/${APP_VERSION}`,
    };
    if (req.headers['soapaction']) headers['SOAPAction'] = req.headers['soapaction'];

    const response = await fetch(xmdsUrl, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.body ? req.body : undefined,
    });

    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const responseText = await response.text();
    res.status(response.status).send(responseText);
    console.log(`[Proxy] ${response.status} (${responseText.length} bytes)`);
  } catch (error) {
    console.error('[Proxy] Error:', error.message);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
});

// ─── REST API Proxy ────────────────────────────────────────────────
app.all('/rest-proxy', async (req, res) => {
  try {
    const cmsUrl = req.query.cms;
    const apiPath = req.query.path;
    if (!cmsUrl) return res.status(400).json({ error: 'Missing cms parameter' });

    const queryParams = new URLSearchParams(req.query);
    queryParams.delete('cms');
    queryParams.delete('path');
    const queryString = queryParams.toString();
    const fullUrl = `${cmsUrl}${apiPath || ''}${queryString ? '?' + queryString : ''}`;

    console.log(`[REST Proxy] ${req.method} ${fullUrl}`);

    const headers = { 'User-Agent': `Xibo Player Standalone/${APP_VERSION}` };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    if (req.headers['accept']) headers['Accept'] = req.headers['accept'];
    if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];

    const fetchOptions = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const response = await fetch(fullUrl, fetchOptions);
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    const buffer = await response.arrayBuffer();
    res.status(response.status).send(Buffer.from(buffer));
    console.log(`[REST Proxy] ${response.status} (${buffer.byteLength} bytes)`);
  } catch (error) {
    console.error('[REST Proxy] Error:', error.message);
    res.status(500).json({ error: 'REST proxy error', message: error.message });
  }
});

// ─── File Download Proxy ───────────────────────────────────────────
app.get('/file-proxy', async (req, res) => {
  try {
    const cmsUrl = req.query.cms;
    const fileUrl = req.query.url;
    if (!cmsUrl || !fileUrl) return res.status(400).json({ error: 'Missing cms or url parameter' });

    const fullUrl = `${cmsUrl}${fileUrl}`;
    console.log(`[FileProxy] GET ${fullUrl}`);

    const headers = { 'User-Agent': `Xibo Player Standalone/${APP_VERSION}` };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
      console.log(`[FileProxy] Range: ${req.headers.range}`);
    }

    const response = await fetch(fullUrl, { headers });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
    console.log(`[FileProxy] ${response.status} (${buffer.byteLength} bytes)`);
  } catch (error) {
    console.error('[FileProxy] Error:', error.message);
    res.status(500).json({ error: 'File proxy error', message: error.message });
  }
});

// ─── Serve PWA static files ────────────────────────────────────────
app.use('/player/pwa', express.static(pwaPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw-pwa.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/player/pwa/');
    }
  },
}));

app.get('/', (req, res) => res.redirect('/player/pwa/'));
app.get('/player/pwa/{*splat}', (req, res) => res.sendFile(path.join(pwaPath, 'index.html')));

// Start
const server = app.listen(serverPort, 'localhost', () => {
  console.log(`[Server] Running on http://localhost:${serverPort}`);
  console.log(`[Server] Open http://localhost:${serverPort}/player/pwa/ in Chromium`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${serverPort} already in use. Try --port=XXXX`);
    process.exit(1);
  }
  console.error('[Server] Error:', err);
});

// Graceful shutdown
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

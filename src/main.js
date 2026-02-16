/**
 * Xibo Player - Electron Kiosk Wrapper
 *
 * Production-ready Electron wrapper that serves the PWA player
 * in a fullscreen kiosk mode with all necessary security and features.
 *
 * Architecture:
 * - Express server serves PWA dist files on localhost
 * - XMDS/REST proxy routes handle CMS CORS issues
 * - BrowserWindow loads the PWA from localhost (enables Service Worker)
 * - Preload script exposes minimal API for Electron-specific features
 * - Session-level CORS headers for direct CMS requests from the renderer
 */

const { app, BrowserWindow, ipcMain, powerSaveBlocker, globalShortcut, Menu, Tray, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const Store = require('electron-store');
const AutoLaunch = require('electron-auto-launch');

// GPU acceleration flags — must be set before app.whenReady()
// Electron 40+ (Chromium 144) auto-detects Wayland via ozone-platform-hint=auto.
// Do NOT force --ozone-platform=wayland — it breaks Vulkan/GL negotiation.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features',
  'AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL,' +
  'VaapiVideoDecoder,VaapiVideoEncoder,VaapiOnNvidiaGPUs,' +
  'AcceleratedVideoEncoder,CanvasOopRasterization');

// Version
const APP_VERSION = '0.9.0';

// Configuration
const CONFIG_DEFAULTS = {
  cmsUrl: '',
  hardwareKey: '',
  serverPort: 8765,
  kioskMode: true,
  autoLaunch: false,
  fullscreen: true,
  hideMouseCursor: true,
  preventSleep: true,
  width: 1920,
  height: 1080,
};

const store = new Store({
  defaults: CONFIG_DEFAULTS,
  name: 'xibo-player-config',
});

// Auto-launch configuration
const autoLauncher = new AutoLaunch({
  name: 'Xibo Player',
  isHidden: false,
});

// Global state
let mainWindow = null;
let tray = null;
let expressServer = null;
let powerSaveBlockerId = null;
const isDev = process.argv.includes('--dev');
const noKiosk = process.argv.includes('--no-kiosk');

// Parse --port=XXXX argument
const portArg = process.argv.find(arg => arg.startsWith('--port='));
const cliPort = portArg ? parseInt(portArg.split('=')[1], 10) : null;

// Parse --cms-url=URL and --cms-key=KEY for auto-config injection
const cmsUrlArg = process.argv.find(arg => arg.startsWith('--cms-url='));
const cmsKeyArg = process.argv.find(arg => arg.startsWith('--cms-key='));
const displayNameArg = process.argv.find(arg => arg.startsWith('--display-name='));
const cliCmsUrl = cmsUrlArg ? cmsUrlArg.split('=').slice(1).join('=') : null;
const cliCmsKey = cmsKeyArg ? cmsKeyArg.split('=').slice(1).join('=') : null;
const cliDisplayName = displayNameArg ? displayNameArg.split('=').slice(1).join('=') : null;

/**
 * Get the path to PWA dist files.
 * - Dev mode: uses ../pwa/dist (relative to electron-pwa source)
 * - Production: uses resources/pwa (bundled by electron-builder extraResources)
 */
function getPwaPath() {
  if (isDev) {
    return path.join(__dirname, '../../pwa/dist');
  }
  return path.join(process.resourcesPath, 'pwa');
}

/**
 * Create and configure the Express server to serve PWA files
 */
function createExpressServer() {
  const serverPort = cliPort || store.get('serverPort', CONFIG_DEFAULTS.serverPort);
  const pwaPath = getPwaPath();

  console.log(`[Express] PWA path: ${pwaPath}`);
  console.log(`[Express] Starting server on port: ${serverPort}`);

  const expressApp = express();

  // Enable CORS for all origins (needed for XMDS requests from renderer)
  expressApp.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'SOAPAction'],
    credentials: true,
  }));

  // Parse various body types
  expressApp.use(express.text({ type: 'text/xml', limit: '50mb' }));
  expressApp.use(express.text({ type: 'application/xml', limit: '50mb' }));
  expressApp.use(express.json({ limit: '10mb' }));
  expressApp.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ─── XMDS SOAP Proxy ──────────────────────────────────────────────
  // Solves CORS issues by proxying SOAP/XML requests to the CMS.
  // The PWA renderer sends requests to localhost:PORT/xmds-proxy?cms=URL
  expressApp.all('/xmds-proxy', async (req, res) => {
    try {
      const cmsUrl = req.query.cms;
      if (!cmsUrl) {
        console.error('[Proxy] No CMS URL in request');
        return res.status(400).json({ error: 'Missing cms parameter' });
      }

      // Construct XMDS URL with original query parameters (except cms)
      const queryParams = new URLSearchParams(req.query);
      queryParams.delete('cms');
      const queryString = queryParams.toString();
      const xmdsUrl = `${cmsUrl}/xmds.php${queryString ? '?' + queryString : ''}`;

      console.log(`[Proxy] ${req.method} ${xmdsUrl}`);

      const headers = {
        'Content-Type': req.headers['content-type'] || 'text/xml; charset=utf-8',
        'User-Agent': `Xibo Player Electron/${APP_VERSION}`,
      };

      // Copy SOAPAction header if present (required for SOAP)
      if (req.headers['soapaction']) {
        headers['SOAPAction'] = req.headers['soapaction'];
      }

      const response = await fetch(xmdsUrl, {
        method: req.method,
        headers: headers,
        body: req.method !== 'GET' && req.body ? req.body : undefined,
      });

      const contentType = response.headers.get('content-type');
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }

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
  // Forwards REST API requests (used by RestClient transport).
  // The PWA renderer sends requests to localhost:PORT/rest-proxy?cms=URL&path=/pwa/...
  expressApp.all('/rest-proxy', async (req, res) => {
    try {
      const cmsUrl = req.query.cms;
      const apiPath = req.query.path;
      if (!cmsUrl) {
        return res.status(400).json({ error: 'Missing cms parameter' });
      }

      // Build the full CMS REST URL
      const queryParams = new URLSearchParams(req.query);
      queryParams.delete('cms');
      queryParams.delete('path');
      const queryString = queryParams.toString();
      const fullUrl = `${cmsUrl}${apiPath || ''}${queryString ? '?' + queryString : ''}`;

      console.log(`[REST Proxy] ${req.method} ${fullUrl}`);

      const headers = {
        'User-Agent': `Xibo Player Electron/${APP_VERSION}`,
      };

      // Copy relevant headers
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
      if (req.headers['accept']) headers['Accept'] = req.headers['accept'];
      if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];

      const fetchOptions = {
        method: req.method,
        headers,
      };

      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
        fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }

      const response = await fetch(fullUrl, fetchOptions);

      // Copy response headers (skip encoding headers — Node fetch already decompresses)
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
  // Handles media and layout file downloads with Range request support.
  // Used by the Service Worker to download files through the Electron proxy.
  expressApp.get('/file-proxy', async (req, res) => {
    try {
      const cmsUrl = req.query.cms;
      const fileUrl = req.query.url;

      if (!cmsUrl || !fileUrl) {
        return res.status(400).json({ error: 'Missing cms or url parameter' });
      }

      const fullUrl = `${cmsUrl}${fileUrl}`;
      console.log(`[FileProxy] GET ${fullUrl}`);

      const headers = {
        'User-Agent': `Xibo Player Electron/${APP_VERSION}`,
      };

      // Support Range requests for chunked downloads
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
        console.log(`[FileProxy] Range: ${req.headers.range}`);
      }

      const response = await fetch(fullUrl, { headers });

      // Copy response headers
      res.status(response.status);
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      res.setHeader('Access-Control-Allow-Origin', '*');

      // Stream response body
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));

      console.log(`[FileProxy] ${response.status} (${buffer.byteLength} bytes)`);
    } catch (error) {
      console.error('[FileProxy] Error:', error.message);
      res.status(500).json({ error: 'File proxy error', message: error.message });
    }
  });

  // ─── Serve PWA static files ────────────────────────────────────────
  // Served at /player/pwa/ to match the path scheme expected by the PWA
  // (Service Worker scope, cache URLs, etc.)
  expressApp.use('/player/pwa', express.static(pwaPath, {
    // Set proper MIME types and caching
    setHeaders: (res, filePath) => {
      // Service worker must not be cached by the browser
      if (filePath.endsWith('sw-pwa.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/player/pwa/');
      }
    },
  }));

  // Redirect root to /player/pwa/
  expressApp.get('/', (req, res) => {
    res.redirect('/player/pwa/');
  });

  // SPA fallback: sub-routes under /player/pwa/ serve index.html
  expressApp.get('/player/pwa/{*splat}', (req, res) => {
    res.sendFile(path.join(pwaPath, 'index.html'));
  });

  // Start server
  expressServer = expressApp.listen(serverPort, 'localhost', () => {
    console.log(`[Express] Server running on http://localhost:${serverPort}`);
  });

  expressServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Express] Port ${serverPort} is already in use. Try --port=XXXX`);
      dialog.showErrorBox(
        'Port in use',
        `Port ${serverPort} is already in use.\nTry running with --port=XXXX or stop the other process.`
      );
      app.quit();
    } else {
      console.error('[Express] Server error:', err);
    }
  });

  return serverPort;
}

/**
 * Create the main browser window with kiosk mode settings
 */
function createWindow() {
  const kioskMode = noKiosk ? false : store.get('kioskMode', CONFIG_DEFAULTS.kioskMode);
  const fullscreen = noKiosk ? false : store.get('fullscreen', CONFIG_DEFAULTS.fullscreen);
  const width = store.get('width', CONFIG_DEFAULTS.width);
  const height = store.get('height', CONFIG_DEFAULTS.height);

  console.log(`[Window] Creating window (kiosk: ${kioskMode}, fullscreen: ${fullscreen}, dev: ${isDev})`);

  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    fullscreen: fullscreen,
    kiosk: kioskMode,
    frame: !kioskMode,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Allow service worker registration from localhost
      // webSecurity stays enabled (default) - CORS handled via proxy + session headers
    },
  });

  // ─── Session-level CORS handling ────────────────────────────────────
  // 1. Intercept OPTIONS preflight requests and return 200 with CORS headers
  //    (the CMS may not handle OPTIONS, which causes CORS preflight failures)
  // 2. Add CORS headers to all other responses from external servers
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['*://*/*'] },
    (details, callback) => {
      // For OPTIONS preflight requests to external servers, we let them through
      // but will fix the response in onHeadersReceived
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};

    // Remove any existing CORS headers to prevent duplication
    // (e.g. SWAG/nginx already adds Access-Control-Allow-Origin: *,
    //  and a second * from us makes the browser reject the response)
    for (const key of Object.keys(headers)) {
      const lk = key.toLowerCase();
      if (lk === 'access-control-allow-origin' ||
          lk === 'access-control-allow-methods' ||
          lk === 'access-control-allow-headers' ||
          lk === 'access-control-max-age') {
        delete headers[key];
      }
    }

    // Set CORS headers (single source of truth)
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS'];
    headers['Access-Control-Allow-Headers'] = ['Content-Type, SOAPAction, Authorization, Accept'];
    headers['Access-Control-Max-Age'] = ['86400'];

    // For OPTIONS preflight responses that return non-2xx status,
    // override to 200 so the browser CORS check passes
    if (details.method === 'OPTIONS' && details.statusCode >= 400) {
      callback({
        responseHeaders: headers,
        statusLine: 'HTTP/1.1 200 OK',
      });
      return;
    }

    callback({ responseHeaders: headers });
  });

  console.log('[Session] CORS headers and preflight handling configured');

  // Hide menu bar
  Menu.setApplicationMenu(null);

  // Load PWA from local server at /player/pwa/
  const serverPort = cliPort || store.get('serverPort', CONFIG_DEFAULTS.serverPort);
  const url = `http://localhost:${serverPort}/player/pwa/`;

  console.log(`[Window] Loading URL: ${url}`);

  // Inject CMS config into PWA localStorage if CLI args provided.
  // Always overwrite when --cms-url is given (authoritative), but preserve
  // any existing hardwareKey so the display doesn't re-register.
  if (cliCmsUrl) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.executeJavaScript(`
        (function() {
          let existing = {};
          try { existing = JSON.parse(localStorage.getItem('xibo_config') || '{}'); } catch(e) {}
          const config = {
            cmsAddress: ${JSON.stringify(cliCmsUrl)},
            cmsKey: ${JSON.stringify(cliCmsKey || '')},
            displayName: ${JSON.stringify(cliDisplayName || 'Electron Player')},
            hardwareKey: existing.hardwareKey || '',
            xmrChannel: existing.xmrChannel || ''
          };
          const prev = localStorage.getItem('xibo_config');
          localStorage.setItem('xibo_config', JSON.stringify(config));
          if (!prev || JSON.parse(prev).cmsAddress !== config.cmsAddress) {
            location.reload();
          }
          return config.cmsAddress;
        })()
      `).then((addr) => {
        console.log(`[Config] CMS config set: ${addr}`);
      }).catch(err => {
        console.error('[Config] Failed to inject config:', err.message);
      });
    });
  }

  mainWindow.loadURL(url);

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Hide mouse cursor after inactivity (digital signage mode)
    if (store.get('hideMouseCursor', CONFIG_DEFAULTS.hideMouseCursor)) {
      setupCursorHiding();
    }
  });

  // Prevent accidental window close in kiosk mode
  mainWindow.on('close', (event) => {
    if (!app.isQuitting && kioskMode) {
      event.preventDefault();
      return false;
    }
  });

  // Open DevTools in dev mode
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // ─── Navigation protection ─────────────────────────────────────────
  // Allow navigation within the local server (including setup.html, index.html)
  // Block navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    const serverPort = cliPort || store.get('serverPort', CONFIG_DEFAULTS.serverPort);
    const allowedOrigin = `http://localhost:${serverPort}`;

    if (!navUrl.startsWith(allowedOrigin)) {
      console.log('[Window] Blocked navigation to:', navUrl);
      event.preventDefault();
    }
  });

  // Handle new window requests (open in default browser)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  // Log renderer console output to main process console (useful for debugging)
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (isDev || level >= 2) { // level 2 = warning, 3 = error
      const prefix = level === 3 ? '[Renderer ERROR]' : level === 2 ? '[Renderer WARN]' : '[Renderer]';
      console.log(`${prefix} ${message}`);
    }
  });

  // Handle renderer crashes
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[Window] Render process gone:', details.reason, details.exitCode);
    if (details.reason !== 'clean-exit') {
      console.log('[Window] Reloading after crash...');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      }, 3000);
    }
  });

  return mainWindow;
}

/**
 * Setup cursor hiding after 5 seconds of mouse inactivity
 */
function setupCursorHiding() {
  let cursorTimeout = null;
  let cursorHidden = false;

  const hideCursor = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.insertCSS('html.cursor-hidden, html.cursor-hidden * { cursor: none !important; }')
        .then((key) => {
          mainWindow.webContents.executeJavaScript('document.documentElement.classList.add("cursor-hidden")');
          cursorHidden = true;
        })
        .catch(() => {});
    }
  };

  const showCursor = () => {
    if (cursorHidden && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript('document.documentElement.classList.remove("cursor-hidden")')
        .catch(() => {});
      cursorHidden = false;
    }
  };

  const resetCursorTimeout = () => {
    showCursor();
    clearTimeout(cursorTimeout);
    cursorTimeout = setTimeout(hideCursor, 5000);
  };

  // Inject mousemove listener into the renderer page
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      document.addEventListener('mousemove', () => {
        if (window.electronAPI && window.electronAPI.resetCursorTimeout) {
          window.electronAPI.resetCursorTimeout();
        }
      });
    `).catch(() => {});
  });

  ipcMain.on('reset-cursor-timeout', resetCursorTimeout);

  // Start initial timeout
  cursorTimeout = setTimeout(hideCursor, 5000);
}

/**
 * Prevent system display from sleeping (digital signage must stay on)
 */
function preventSystemSleep() {
  if (store.get('preventSleep', CONFIG_DEFAULTS.preventSleep)) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    console.log(`[PowerSaver] Display sleep prevented (ID: ${powerSaveBlockerId})`);
  }
}

/**
 * Create system tray with control menu
 */
function createSystemTray() {
  const iconPath = path.join(__dirname, '../resources/icon.png');

  try {
    tray = new Tray(iconPath);
  } catch (err) {
    // Tray creation can fail in headless environments
    console.warn('[Tray] Failed to create system tray:', err.message);
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Xibo Player v${APP_VERSION}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show Player',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Reload Player',
      click: () => {
        if (mainWindow) {
          mainWindow.reload();
        }
      },
    },
    {
      label: 'Restart Player',
      click: () => {
        app.relaunch();
        app.isQuitting = true;
        app.quit();
      },
    },
    { type: 'separator' },
    {
      label: 'Configuration',
      click: () => {
        showConfigDialog();
      },
    },
    {
      label: 'Toggle DevTools',
      visible: isDev,
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.toggleDevTools();
        }
      },
    },
    {
      label: 'Auto-start on Boot',
      type: 'checkbox',
      checked: store.get('autoLaunch', false),
      click: (menuItem) => {
        toggleAutoLaunch(menuItem.checked);
      },
    },
    { type: 'separator' },
    {
      label: 'Exit Player',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(`Xibo Player v${APP_VERSION}`);
}

/**
 * Toggle auto-launch on system boot
 */
async function toggleAutoLaunch(enable) {
  try {
    if (enable) {
      await autoLauncher.enable();
      store.set('autoLaunch', true);
      console.log('[AutoLaunch] Enabled');
    } else {
      await autoLauncher.disable();
      store.set('autoLaunch', false);
      console.log('[AutoLaunch] Disabled');
    }
  } catch (error) {
    console.error('[AutoLaunch] Error:', error);
  }
}

/**
 * Show configuration dialog
 */
function showConfigDialog() {
  const config = {
    cmsUrl: store.get('cmsUrl', ''),
    hardwareKey: store.get('hardwareKey', ''),
    serverPort: store.get('serverPort', CONFIG_DEFAULTS.serverPort),
    kioskMode: store.get('kioskMode', CONFIG_DEFAULTS.kioskMode),
  };

  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Configuration',
    message: 'Xibo Player Configuration',
    detail: `CMS URL: ${config.cmsUrl || 'Not set (configured in PWA setup)'}
Hardware Key: ${config.hardwareKey || 'Auto-generated by PWA'}
Server Port: ${config.serverPort}
Kiosk Mode: ${config.kioskMode ? 'Enabled' : 'Disabled'}
Version: ${APP_VERSION}

Configuration is managed through the PWA setup page.
To reconfigure, clear localStorage in DevTools.

User data: ${app.getPath('userData')}`,
    buttons: ['OK', 'Open Config Folder'],
  }).then((result) => {
    if (result.response === 1) {
      require('electron').shell.openPath(app.getPath('userData'));
    }
  });
}

/**
 * Setup global keyboard shortcuts
 */
function setupGlobalShortcuts() {
  // Show system tray menu with Ctrl+Shift+F12
  globalShortcut.register('CommandOrControl+Shift+F12', () => {
    console.log('[Shortcut] Showing system tray menu');
    if (tray) {
      tray.popUpContextMenu();
    }
  });

  // Reload page with Ctrl+Shift+R
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    console.log('[Shortcut] Reloading page');
    if (mainWindow) {
      mainWindow.reload();
    }
  });

  // Toggle DevTools with Ctrl+Shift+I (dev mode only)
  if (isDev) {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (mainWindow) {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }

  // Emergency exit with Ctrl+Shift+Q
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    console.log('[Shortcut] Emergency exit');
    app.isQuitting = true;
    app.quit();
  });
}

/**
 * Setup IPC handlers for communication with the renderer process
 */
function setupIpcHandlers() {
  // Get Electron-side configuration
  ipcMain.handle('get-config', () => {
    return {
      cmsUrl: store.get('cmsUrl', ''),
      hardwareKey: store.get('hardwareKey', ''),
      serverPort: store.get('serverPort', CONFIG_DEFAULTS.serverPort),
    };
  });

  // Set Electron-side configuration
  ipcMain.handle('set-config', (event, config) => {
    if (config.cmsUrl !== undefined) store.set('cmsUrl', config.cmsUrl);
    if (config.hardwareKey !== undefined) store.set('hardwareKey', config.hardwareKey);
    if (config.serverPort !== undefined) store.set('serverPort', config.serverPort);

    console.log('[Config] Configuration updated:', config);
    return true;
  });

  // Get system information for hardware key generation
  ipcMain.handle('get-system-info', () => {
    const os = require('os');
    return {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      hostname: os.hostname(),
      totalMemory: os.totalmem(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
    };
  });

  // Capture screenshot using Electron's native API
  // Much better than html2canvas: captures everything including video frames,
  // composited layers, WebGL, etc. with zero DOM manipulation.
  ipcMain.handle('capture-screenshot', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return null;
    }

    try {
      const image = await mainWindow.webContents.capturePage();
      // Return as JPEG base64 (matches XMDS submitScreenShot format)
      const jpegBuffer = image.toJPEG(80);
      return jpegBuffer.toString('base64');
    } catch (error) {
      console.error('[Screenshot] Capture failed:', error.message);
      return null;
    }
  });

  // Get app version
  ipcMain.handle('get-version', () => {
    return APP_VERSION;
  });

  // Reload the player
  ipcMain.on('reload-player', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
    }
  });

  // Restart the application
  ipcMain.on('restart-app', () => {
    app.relaunch();
    app.isQuitting = true;
    app.quit();
  });
}

/**
 * Application initialization
 */
app.whenReady().then(async () => {
  console.log(`[App] Starting Xibo Player v${APP_VERSION}`);
  console.log(`[App] User data path: ${app.getPath('userData')}`);
  console.log(`[App] Development mode: ${isDev}`);
  console.log(`[App] Kiosk mode: ${!noKiosk}`);
  console.log(`[App] Electron: ${process.versions.electron}, Chrome: ${process.versions.chrome}`);

  // Create Express server to serve PWA files
  createExpressServer();

  // Create main window
  createWindow();

  // Setup system integrations
  preventSystemSleep();
  createSystemTray();
  setupGlobalShortcuts();
  setupIpcHandlers();

  // Setup auto-launch if enabled
  if (store.get('autoLaunch', false)) {
    try {
      await autoLauncher.enable();
    } catch (err) {
      console.warn('[AutoLaunch] Failed to enable:', err.message);
    }
  }

  console.log('[App] Xibo Player started successfully');
});

/**
 * macOS specific: Re-create window when dock icon is clicked
 */
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

/**
 * Cleanup on quit
 */
app.on('will-quit', () => {
  // Unregister all global shortcuts
  globalShortcut.unregisterAll();

  // Stop power save blocker
  if (powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }

  // Close Express server
  if (expressServer) {
    expressServer.close();
  }
});

/**
 * Handle window close
 */
app.on('window-all-closed', () => {
  // On macOS, keep app running in dock
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Handle unhandled errors gracefully
 */
process.on('uncaughtException', (error) => {
  console.error('[App] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[App] Unhandled rejection at:', promise, 'reason:', reason);
});

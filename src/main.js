/**
 * Xibo Player - Electron Kiosk Wrapper
 *
 * This is a production-ready Electron wrapper that serves the PWA player
 * in a fullscreen kiosk mode with all necessary security and features.
 */

const { app, BrowserWindow, ipcMain, powerSaveBlocker, globalShortcut, Menu, Tray, dialog } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const Store = require('electron-store');
const AutoLaunch = require('electron-auto-launch');

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

/**
 * Create and configure the Express server to serve PWA files
 */
function createExpressServer() {
  const serverPort = store.get('serverPort', CONFIG_DEFAULTS.serverPort);
  const pwaPath = isDev
    ? path.join(__dirname, '../../pwa/dist')
    : path.join(process.resourcesPath, 'pwa');

  console.log('[Express] PWA path:', pwaPath);
  console.log('[Express] Starting server on port:', serverPort);

  const expressApp = express();

  // Enable CORS for all origins (needed for XMDS requests)
  expressApp.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
  }));

  // Parse text/xml bodies (XMDS uses XML)
  expressApp.use(express.text({ type: 'text/xml' }));
  expressApp.use(express.text({ type: 'application/xml' }));
  expressApp.use(express.json());
  expressApp.use(express.urlencoded({ extended: true }));

  // XMDS Proxy - Forward SOAP/XML requests to actual CMS server
  // This solves CORS issues by making all requests same-origin (localhost:8765)
  // Standard proxy pattern - keeps security enabled in renderer
  expressApp.all('/xmds-proxy', async (req, res) => {
    try {
      // Get CMS URL from query parameter (passed by XMDS client)
      const cmsUrl = req.query.cms;

      if (!cmsUrl) {
        console.error('[Proxy] No CMS URL in request');
        return res.status(400).json({ error: 'Missing cms parameter' });
      }

      // Construct XMDS URL with original query parameters (except cms)
      const queryParams = new URLSearchParams(req.query);
      queryParams.delete('cms'); // Remove our proxy parameter
      const queryString = queryParams.toString();
      const xmdsUrl = `${cmsUrl}/xmds.php${queryString ? '?' + queryString : ''}`;

      console.log(`[Proxy] ${req.method} ${xmdsUrl}`);

      // Build headers for CMS request
      const headers = {
        'Content-Type': req.headers['content-type'] || 'text/xml; charset=utf-8',
        'User-Agent': 'Xibo Player Electron/0.9.0',
      };

      // Copy SOAPAction header if present (required for SOAP)
      if (req.headers['soapaction']) {
        headers['SOAPAction'] = req.headers['soapaction'];
      }

      // Forward the request to the CMS
      const response = await fetch(xmdsUrl, {
        method: req.method,
        headers: headers,
        body: req.method !== 'GET' && req.body ? req.body : undefined,
      });

      // Copy response headers
      const contentType = response.headers.get('content-type');
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }

      // Send response with CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      const responseText = await response.text();
      res.status(response.status).send(responseText);

      console.log(`[Proxy] ✓ ${response.status} (${responseText.length} bytes)`);
    } catch (error) {
      console.error('[Proxy] ✗ Error:', error.message);
      res.status(500).json({ error: 'Proxy error', message: error.message });
    }
  });

  // File Download Proxy - Forward GetFile requests to CMS
  // Handles media, layout files with proper Range request support
  expressApp.get('/file-proxy', async (req, res) => {
    try {
      const cmsUrl = req.query.cms;
      const fileUrl = req.query.url;

      if (!cmsUrl || !fileUrl) {
        return res.status(400).json({ error: 'Missing cms or url parameter' });
      }

      const fullUrl = `${cmsUrl}${fileUrl}`;
      console.log(`[FileProxy] GET ${fullUrl}`);

      // Build headers (copy Range header for partial content)
      const headers = {
        'User-Agent': 'Xibo Player Electron/0.9.0',
      };

      if (req.headers.range) {
        headers['Range'] = req.headers.range;
        console.log(`[FileProxy] Range request: ${req.headers.range}`);
      }

      // Forward request
      const response = await fetch(fullUrl, { headers });

      // Copy response headers
      res.status(response.status);
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      // Add CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Stream response
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));

      console.log(`[FileProxy] ✓ ${response.status} (${buffer.byteLength} bytes)`);
    } catch (error) {
      console.error('[FileProxy] ✗ Error:', error.message);
      res.status(500).json({ error: 'File proxy error', message: error.message });
    }
  });

  // Serve PWA files at /player/pwa/ (matches hardcoded paths in SW and cache URLs)
  expressApp.use('/player/pwa', express.static(pwaPath));

  // Redirect root to /player/pwa/
  expressApp.get('/', (req, res) => {
    res.redirect('/player/pwa/');
  });

  // Handle sub-routes under /player/pwa/ by serving index.html (SPA support)
  expressApp.get('/player/pwa/*', (req, res) => {
    res.sendFile(path.join(pwaPath, 'index.html'));
  });

  // Start server
  expressServer = expressApp.listen(serverPort, 'localhost', () => {
    console.log(`[Express] Server running on http://localhost:${serverPort}`);
  });

  return serverPort;
}

/**
 * Create the main browser window with kiosk mode settings
 */
function createWindow() {
  const kioskMode = store.get('kioskMode', CONFIG_DEFAULTS.kioskMode);
  const fullscreen = store.get('fullscreen', CONFIG_DEFAULTS.fullscreen);
  const width = store.get('width', CONFIG_DEFAULTS.width);
  const height = store.get('height', CONFIG_DEFAULTS.height);

  console.log('[Window] Creating window with kiosk mode:', kioskMode);

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
      sandbox: true, // Keep sandbox enabled for security
      // webSecurity enabled (default) - CORS handled via session.webRequest
    },
  });

  // Configure session to add CORS headers to external XMDS requests
  // This is the standard Electron approach for handling CORS in kiosk apps
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // Add CORS headers to all responses from external servers
    const headers = details.responseHeaders || {};

    // Add CORS headers
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS'];
    headers['Access-Control-Allow-Headers'] = ['Content-Type, SOAPAction, Authorization'];

    callback({ responseHeaders: headers });
  });

  console.log('[Session] CORS headers configured for all external requests');

  // Hide menu bar
  Menu.setApplicationMenu(null);

  // Load PWA from local server at /player/pwa/ (matches SW scope and cache paths)
  const serverPort = store.get('serverPort', CONFIG_DEFAULTS.serverPort);
  const url = `http://localhost:${serverPort}/player/pwa/`;

  console.log('[Window] Loading URL:', url);
  mainWindow.loadURL(url);

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Hide mouse cursor after 5 seconds of inactivity
    if (store.get('hideMouseCursor', CONFIG_DEFAULTS.hideMouseCursor)) {
      setupCursorHiding();
    }
  });

  // Prevent window from being closed accidentally
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

  // Prevent navigation away from PWA
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    const serverPort = store.get('serverPort', CONFIG_DEFAULTS.serverPort);
    const allowedUrl = `http://localhost:${serverPort}`;

    if (!navUrl.startsWith(allowedUrl)) {
      console.log('[Window] Blocked navigation to:', navUrl);
      event.preventDefault();
    }
  });

  // Handle new windows (open in default browser)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

/**
 * Setup cursor hiding after inactivity
 */
function setupCursorHiding() {
  let cursorTimeout = null;

  const hideCursor = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.insertCSS('* { cursor: none !important; }');
    }
  };

  const showCursor = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.insertCSS('* { cursor: auto !important; }');
    }
  };

  const resetCursorTimeout = () => {
    showCursor();
    clearTimeout(cursorTimeout);
    cursorTimeout = setTimeout(hideCursor, 5000);
  };

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      document.addEventListener('mousemove', () => {
        window.electronAPI.resetCursorTimeout();
      });
    `);
  });

  ipcMain.on('reset-cursor-timeout', resetCursorTimeout);
}

/**
 * Prevent system from sleeping
 */
function preventSystemSleep() {
  if (store.get('preventSleep', CONFIG_DEFAULTS.preventSleep)) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    console.log('[PowerSaver] Display sleep prevented. ID:', powerSaveBlockerId);
  }
}

/**
 * Create system tray with control menu
 */
function createSystemTray() {
  const iconPath = path.join(__dirname, '../resources/icon.png');

  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Xibo Player',
      enabled: false,
    },
    {
      type: 'separator',
    },
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
      label: 'Restart Player',
      click: () => {
        app.relaunch();
        app.quit();
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Configuration',
      click: () => {
        showConfigDialog();
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
    {
      type: 'separator',
    },
    {
      label: 'Exit Player',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip('Xibo Player');
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
    detail: `CMS URL: ${config.cmsUrl || 'Not set'}
Hardware Key: ${config.hardwareKey || 'Not set'}
Server Port: ${config.serverPort}
Kiosk Mode: ${config.kioskMode ? 'Enabled' : 'Disabled'}

To change configuration, edit:
${app.getPath('userData')}/config.json`,
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
  // Exit kiosk mode with Ctrl+Shift+F12
  globalShortcut.register('CommandOrControl+Shift+F12', () => {
    console.log('[Shortcut] Showing system tray');
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

  // Toggle DevTools with Ctrl+Shift+I (only in dev mode)
  if (isDev) {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (mainWindow) {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }
}

/**
 * Setup IPC handlers
 */
function setupIpcHandlers() {
  // Get configuration
  ipcMain.handle('get-config', () => {
    return {
      cmsUrl: store.get('cmsUrl', ''),
      hardwareKey: store.get('hardwareKey', ''),
      serverPort: store.get('serverPort', CONFIG_DEFAULTS.serverPort),
    };
  });

  // Set configuration
  ipcMain.handle('set-config', (event, config) => {
    if (config.cmsUrl !== undefined) store.set('cmsUrl', config.cmsUrl);
    if (config.hardwareKey !== undefined) store.set('hardwareKey', config.hardwareKey);
    if (config.serverPort !== undefined) store.set('serverPort', config.serverPort);

    console.log('[Config] Configuration updated:', config);
    return true;
  });

  // Get system info for hardware key generation
  ipcMain.handle('get-system-info', () => {
    return {
      platform: process.platform,
      arch: process.arch,
      cpus: require('os').cpus().length,
      hostname: require('os').hostname(),
    };
  });
}

/**
 * Application initialization
 */
app.whenReady().then(async () => {
  console.log('[App] Starting Xibo Player');
  console.log('[App] User data path:', app.getPath('userData'));
  console.log('[App] Development mode:', isDev);

  // Create Express server
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
    await autoLauncher.enable();
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
  // Unregister all shortcuts
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
  // On macOS, keep app running
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Handle crashes and errors
 */
process.on('uncaughtException', (error) => {
  console.error('[App] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[App] Unhandled rejection at:', promise, 'reason:', reason);
});

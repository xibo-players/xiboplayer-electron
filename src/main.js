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

const { app, BrowserWindow, ipcMain, powerSaveBlocker, globalShortcut, Menu, Tray, dialog, nativeImage, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const AutoLaunch = require('electron-auto-launch');

// XDG-compliant paths: config in ~/.config, data in ~/.local/share
// Config (electron-store, preferences): ~/.config/xiboplayer/electron/
app.setPath('userData', path.join(app.getPath('appData'), 'xiboplayer', 'electron'));
// Session data (Cache, IndexedDB, Service Worker, cookies): ~/.local/share/xiboplayer/electron/
const dataHome = process.env.XDG_DATA_HOME || path.join(require('os').homedir(), '.local', 'share');
app.setPath('sessionData', path.join(dataHome, 'xiboplayer', 'electron'));

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
const APP_VERSION = '0.2.1';

// Configuration
const CONFIG_DEFAULTS = {
  cmsUrl: '',
  cmsKey: '',
  displayName: '',
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

// Persist CLI CMS args into the store so they survive restarts and
// are available for server-side config injection via the proxy.
if (cliCmsUrl) {
  store.set('cmsUrl', cliCmsUrl);
  if (cliCmsKey) store.set('cmsKey', cliCmsKey);
  if (cliDisplayName) store.set('displayName', cliDisplayName);
}

// Read CMS config from config.json (master config file — always wins over store)
const os = require('os');
const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const configFilePath = path.join(configDir, 'xiboplayer', 'electron', 'config.json');

try {
  const fileConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
  if (fileConfig.cmsUrl) store.set('cmsUrl', fileConfig.cmsUrl);
  if (fileConfig.cmsKey) store.set('cmsKey', fileConfig.cmsKey);
  if (fileConfig.displayName) store.set('displayName', fileConfig.displayName);
  console.log(`[Config] Loaded from ${configFilePath}: ${fileConfig.cmsUrl}`);
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.warn(`[Config] Failed to read config.json: ${err.message}`);
  }
}

/**
 * Get the path to PWA dist files.
 * - Dev mode: uses ../xiboplayer-pwa/dist (sibling repo)
 * - Production: uses @xiboplayer/pwa/dist from node_modules (bundled by electron-builder)
 */
function getPwaPath() {
  if (isDev) {
    return path.join(__dirname, '../../xiboplayer-pwa/dist');
  }
  // In production, resolve from node_modules inside the asar/unpacked app
  return path.join(__dirname, '../node_modules/@xiboplayer/pwa/dist');
}

/**
 * Clear Service Worker registrations when the bundled PWA version changes.
 * Reads version from the PWA's package.json and compares with the stored
 * version in electron-store.  On mismatch, wipes SW + caches so the new
 * build starts clean (no stale content-hashed assets).
 */
async function clearStaleServiceWorker() {
  try {
    const pwaPath = getPwaPath();
    const pkgPath = path.join(pwaPath, '../package.json');
    const pwaVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    const lastVersion = store.get('_pwaVersion', '');

    if (lastVersion && lastVersion !== pwaVersion) {
      console.log(`[SW-Clean] PWA version changed: ${lastVersion} → ${pwaVersion}, clearing session data`);
      const sessionDir = app.getPath('sessionData');
      const dirs = ['Service Worker', 'Cache', 'Code Cache', 'blob_storage'];
      for (const dir of dirs) {
        const target = path.join(sessionDir, dir);
        try {
          fs.rmSync(target, { recursive: true, force: true });
        } catch (_) {}
      }
    } else if (!lastVersion) {
      console.log(`[SW-Clean] First run, recording PWA version ${pwaVersion}`);
    }
    store.set('_pwaVersion', pwaVersion);
  } catch (err) {
    console.warn('[SW-Clean] Version check failed (non-fatal):', err.message);
  }
}

/**
 * Create and configure the Express server to serve PWA files.
 * Uses @xiboplayer/proxy for CORS proxy routes and PWA static serving.
 */
async function createExpressServer() {
  const serverPort = cliPort || store.get('serverPort', CONFIG_DEFAULTS.serverPort);
  const pwaPath = getPwaPath();

  console.log(`[Express] PWA path: ${pwaPath}`);
  console.log(`[Express] Starting server on port: ${serverPort}`);

  // Build cmsConfig from store (populated by CLI args or config file edits)
  const cmsUrl = store.get('cmsUrl', '');
  const cmsKey = store.get('cmsKey', '');
  const displayName = store.get('displayName', '');
  const cmsConfig = cmsUrl ? { cmsUrl, cmsKey, displayName } : undefined;

  const { createProxyApp } = await import('@xiboplayer/proxy');
  const expressApp = createProxyApp({ pwaPath, appVersion: APP_VERSION, cmsConfig, configFilePath });

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
    width,
    height,
    fullscreen,
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

  // ─── Forward Service Worker console logs to main process ────────────
  // SW logs don't appear in webContents.on('console-message'). This
  // captures them so they show up in /tmp/electron-pwa.log alongside
  // renderer logs, making download/chunk debugging visible.
  mainWindow.webContents.session.serviceWorkers.on('console-message', (_event, details) => {
    const level = details.logLevel || 'info';
    const prefix = level === 'error' ? '[SW ERROR]' : level === 'warning' ? '[SW WARN]' : '[SW]';
    console.log(`${prefix} ${details.message}`);
  });

  // ─── Auto-approve permissions (no dialogs in kiosk mode) ─────────────
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['geolocation', 'notifications', 'media', 'mediaKeySystem', 'fullscreen'];
    callback(allowed.includes(permission));
  });

  // ─── Auto-approve screen capture (no permission dialog) ──────────────
  // If the PWA calls getDisplayMedia() (e.g. before electronAPI is ready),
  // auto-select the BrowserWindow as the capture source instead of showing
  // Chrome's screen-sharing picker dialog.
  mainWindow.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['window'] });
    // Prefer our own window; fall back to first available source
    const selfSource = sources.find(s => s.name === mainWindow.getTitle()) || sources[0];
    callback({ video: selfSource, audio: 'loopback' });
  });

  // Hide menu bar
  Menu.setApplicationMenu(null);

  // Load PWA from local server at /player/
  // In dev mode, enable DEBUG logging via URL param (logger defaults to WARNING)
  const serverPort = cliPort || store.get('serverPort', CONFIG_DEFAULTS.serverPort);
  const logParam = isDev ? '?logLevel=DEBUG' : '';
  const url = `http://localhost:${serverPort}/player/${logParam}`;

  console.log(`[Window] Loading URL: ${url}`);

  // CMS config injection is now handled server-side by @xiboplayer/proxy.
  // The proxy injects a <script> into index.html that pre-seeds localStorage
  // before the PWA loads, eliminating the race condition with did-finish-load.

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
    if (true) { // TODO: revert to (isDev || level >= 2) once startup is stable
      // Filter out upstream XMR framework bug: console.debug(event) logs "[object MessageEvent]"
      if (message === '[object MessageEvent]') return;
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
    // Get MAC address of first non-internal interface with a real MAC
    let macAddress = 'n/a';
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const cfg of iface) {
        if (!cfg.internal && cfg.mac && cfg.mac !== '00:00:00:00:00:00') {
          macAddress = cfg.mac;
          break;
        }
      }
      if (macAddress !== 'n/a') break;
    }
    return {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      hostname: os.hostname(),
      totalMemory: os.totalmem(),
      macAddress,
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
  await createExpressServer();

  // Clear stale Service Worker when bundled PWA version changes.
  // A version mismatch means the SW may cache index.html referencing
  // content-hashed assets (main-XXXX.js) that no longer exist in the
  // new build — Express would serve HTML fallback → MIME type error
  // → black screen.  Clearing only on version change preserves offline
  // capability during normal operation.
  await clearStaleServiceWorker();

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
 * Handle SIGTERM/SIGINT for clean systemd shutdown
 */
process.on('SIGTERM', () => {
  console.log('[App] Received SIGTERM, shutting down');
  if (expressServer) expressServer.close();
  app.quit();
});

process.on('SIGINT', () => {
  console.log('[App] Received SIGINT, shutting down');
  if (expressServer) expressServer.close();
  app.quit();
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

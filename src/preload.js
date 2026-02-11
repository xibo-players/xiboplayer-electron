/**
 * Preload script - Security bridge between main and renderer process
 *
 * This script runs in a privileged context and exposes a minimal API
 * to the renderer process through the contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Configuration management
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (config) => ipcRenderer.invoke('set-config', config),

  // System information for hardware key
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // Cursor timeout reset
  resetCursorTimeout: () => ipcRenderer.send('reset-cursor-timeout'),

  // Platform detection
  platform: process.platform,
  isElectron: true,
});

// Log that preload script loaded
console.log('[Preload] Preload script initialized');

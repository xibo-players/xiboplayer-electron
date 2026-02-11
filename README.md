# Xibo Player - Electron Kiosk Wrapper

Production-ready Electron kiosk application that wraps the Xibo PWA player for easy deployment on desktop systems.

## Features

### Kiosk Mode
- **Fullscreen display** - No window chrome or decorations
- **Keyboard shortcut protection** - Disables system shortcuts
- **Mouse cursor hiding** - Auto-hides after 5 seconds of inactivity
- **Navigation protection** - Prevents navigation away from player
- **Always on top** - Cannot be minimized or covered

### System Integration
- **Auto-start on boot** - systemd user service support
- **Prevent system sleep** - Display stays on during playback
- **System tray control** - Hidden menu accessible via Ctrl+Shift+F12
- **Service management** - Easy enable/disable via systemd

### Local HTTP Server
- **Serves PWA files** - Built-in Express server on localhost:8765
- **CORS enabled** - Proper headers for XMDS communication
- **Zero configuration** - Works out of the box

### Configuration
- **Persistent storage** - electron-store for configuration
- **Command-line arguments** - Override settings at startup
- **JSON config file** - Easy manual editing if needed
- **Config UI** - Access via system tray menu

## Installation

### From RPM (Fedora/RHEL)

```bash
sudo rpm -i xibo-player-1.0.0-x86_64.rpm
```

### From DEB (Debian/Ubuntu)

```bash
sudo dpkg -i xibo-player-1.0.0-amd64.deb
```

### From AppImage (Universal Linux)

```bash
chmod +x xibo-player-1.0.0-x86_64.AppImage
./xibo-player-1.0.0-x86_64.AppImage
```

## Configuration

### Configuration File

Location: `~/.config/xibo-player/config.json`

```json
{
  "cmsUrl": "https://your-cms.example.com",
  "hardwareKey": "your-hardware-key",
  "serverPort": 8765,
  "kioskMode": true,
  "autoLaunch": false,
  "fullscreen": true,
  "hideMouseCursor": true,
  "preventSleep": true,
  "width": 1920,
  "height": 1080
}
```

### Command-Line Arguments

```bash
# Development mode (enables DevTools)
xibo-player --dev

# Custom port
xibo-player --port=8080

# Disable kiosk mode
xibo-player --no-kiosk
```

### Environment Variables

```bash
# Override CMS URL
export XIBO_CMS_URL="https://cms.example.com"

# Override hardware key
export XIBO_HARDWARE_KEY="your-key"

# Run in development mode
export NODE_ENV=development
```

## Usage

### Starting the Player

```bash
# Run from command line
xibo-player

# Or launch from applications menu
# Applications → AudioVideo → Xibo Player
```

### Auto-Start on Boot

**Enable:**
```bash
systemctl --user enable xibo-player.service
systemctl --user start xibo-player.service
```

**Disable:**
```bash
systemctl --user stop xibo-player.service
systemctl --user disable xibo-player.service
```

**Check status:**
```bash
systemctl --user status xibo-player.service
```

**View logs:**
```bash
journalctl --user -u xibo-player.service -f
```

### Keyboard Shortcuts

- **Ctrl+Shift+F12** - Show system tray menu
- **Ctrl+Shift+R** - Reload player
- **Ctrl+Shift+I** - Toggle DevTools (dev mode only)

### System Tray Menu

Right-click the system tray icon (or press Ctrl+Shift+F12) to access:

- Show Player
- Restart Player
- Configuration
- Auto-start on Boot
- Exit Player

## Building from Source

### Prerequisites

```bash
cd platforms/electron-pwa
npm install
```

### Build PWA First

The Electron wrapper serves the PWA, so build it first:

```bash
cd ../pwa
npm run build
```

### Build Packages

```bash
cd ../electron-pwa

# Build all Linux packages
npm run build:linux

# Or build specific formats
npm run build:rpm      # Fedora/RHEL
npm run build:deb      # Debian/Ubuntu
npm run build:appimage # Universal Linux

# Windows
npm run build:win

# All platforms
npm run build:all
```

Packages are created in `dist-packages/`:

```
dist-packages/
├── xibo-player-1.0.0-x86_64.rpm
├── xibo-player-1.0.0-amd64.deb
└── xibo-player-1.0.0-x86_64.AppImage
```

## Development

### Run in Development Mode

```bash
# Terminal 1: Start PWA dev server
cd platforms/pwa
npm run dev

# Terminal 2: Start Electron
cd platforms/electron-pwa
npm run dev
```

This enables:
- Hot reload
- DevTools access (Ctrl+Shift+I)
- Console logging
- Error reporting

### Debug Output

Set environment variable for verbose logging:

```bash
DEBUG=* xibo-player
```

## Architecture

### Main Process (src/main.js)

The main process handles:
- Window management and kiosk mode
- Express server for serving PWA files
- System integrations (auto-launch, power management)
- Configuration storage
- IPC communication with renderer

### Renderer Process

The renderer is the PWA player loaded from `http://localhost:8765`:
- Uses the existing PWA built with Vite
- Full access to PWA features (cache, offline, etc.)
- Communicates with main via IPC when needed

### Preload Script (src/preload.js)

Security bridge between main and renderer:
- Exposes minimal API via contextBridge
- Prevents direct Node.js access
- Maintains security best practices

### Express Server

Built-in HTTP server:
- Serves PWA files from `resources/pwa/`
- Runs on localhost:8765 (configurable)
- CORS enabled for XMDS communication
- SPA routing support

## Packaging Details

### RPM Package

- **Install location:** `/opt/Xibo Player/`
- **Binary location:** `/usr/bin/xibo-player` (symlink)
- **Config location:** `~/.config/xibo-player/`
- **Systemd service:** `~/.config/systemd/user/xibo-player.service`
- **Desktop entry:** `~/.local/share/applications/xibo-player.desktop`

### DEB Package

Same structure as RPM, compatible with:
- Debian 10+
- Ubuntu 20.04+
- Linux Mint 20+

### AppImage

- **Self-contained** - No installation required
- **Portable** - Run from any location
- **Compatible** - Works on most Linux distributions

## Security

### Sandboxing

The renderer process runs in a sandbox with:
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

### Content Security Policy

The PWA sets appropriate CSP headers to prevent XSS attacks.

### CORS Configuration

The Express server enables CORS only for:
- PWA assets (localhost)
- XMDS API endpoints (configured CMS URL)

### Permissions

The app requests minimal permissions:
- Display management (fullscreen, prevent sleep)
- Network access (HTTP server, XMDS communication)
- File system access (config and cache storage)

## Troubleshooting

### Player won't start

```bash
# Check if port is available
sudo netstat -tulpn | grep 8765

# Try different port
xibo-player --port=8080

# Check logs
journalctl --user -u xibo-player.service -n 50
```

### Black screen

```bash
# Check PWA files exist
ls -la ~/.local/share/xibo-player/pwa/

# Rebuild PWA
cd platforms/pwa
npm run build

# Reinstall package
sudo rpm -i --force xibo-player-*.rpm
```

### CORS errors

Make sure your CMS allows requests from `http://localhost:8765`.

In the CMS, add to allowed origins:
- `http://localhost:8765`
- `http://127.0.0.1:8765`

### Service won't auto-start

```bash
# Enable lingering (user service without login)
loginctl enable-linger $USER

# Check service status
systemctl --user status xibo-player.service

# View full logs
journalctl --user -u xibo-player.service --no-pager
```

### Can't exit kiosk mode

Press **Ctrl+Shift+F12** to show system tray menu, then select "Exit Player".

Or from terminal:
```bash
pkill -f xibo-player
```

## Uninstallation

### RPM
```bash
sudo rpm -e xibo-player
```

### DEB
```bash
sudo dpkg -r xibo-player
```

### AppImage
Just delete the `.AppImage` file.

### Remove Configuration

Configuration files are preserved during uninstallation. To remove manually:

```bash
rm -rf ~/.config/xibo-player
rm -rf ~/.config/systemd/user/xibo-player.service
rm -rf ~/.local/share/applications/xibo-player.desktop
```

## License

AGPL-3.0 - See LICENSE file for details.

## Support

- **GitHub Issues:** https://github.com/tecman/xibo_players/issues
- **Documentation:** https://xibo.org.uk/docs/
- **Community Forum:** https://community.xibo.org.uk/

## Credits

- **Xibo CMS:** https://xibosignage.com
- **Electron:** https://www.electronjs.org/
- **Express:** https://expressjs.com/

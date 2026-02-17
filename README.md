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
sudo dnf install xiboplayer-electron-*.rpm
```

## Configuration

### Configuration File

Location: `~/.config/@xiboplayer/electron-pwa/config.json`

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
xiboplayer-electron --dev

# Custom port
xiboplayer-electron --port=8080

# Disable kiosk mode
xiboplayer-electron --no-kiosk
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
xiboplayer-electron

# Or launch from applications menu
# Applications → AudioVideo → Xibo Player
```

### Auto-Start on Boot

**Enable:**
```bash
systemctl --user enable xiboplayer-electron.service
systemctl --user start xiboplayer-electron.service
```

**Disable:**
```bash
systemctl --user stop xiboplayer-electron.service
systemctl --user disable xiboplayer-electron.service
```

**Check status:**
```bash
systemctl --user status xiboplayer-electron.service
```

**View logs:**
```bash
journalctl --user -u xiboplayer-electron.service -f
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

```bash
npm install
npm run make
```

This builds the RPM via electron-forge into `out/make/rpm/x86_64/`.
For production builds, use the external RPM spec instead.

## Development

### Run in Development Mode

```bash
npx electron . --dev --no-kiosk
```

This enables:
- Hot reload
- DevTools access (Ctrl+Shift+I)
- Console logging
- Error reporting

### Debug Output

Set environment variable for verbose logging:

```bash
DEBUG=* xiboplayer-electron
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
- Uses the PWA built from `@xiboplayer/*` packages (installed via npm)
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
- **Binary location:** `/usr/bin/xiboplayer-electron` (symlink)
- **Config location:** `~/.config/@xiboplayer/electron-pwa/`
- **Systemd service:** `~/.config/systemd/user/xiboplayer-electron.service`
- **Desktop entry:** `~/.local/share/applications/xiboplayer-electron.desktop`

## Security

### Sandboxing

The renderer process runs in a sandbox with:
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

### Content Security Policy

The PWA sets appropriate CSP headers to prevent XSS attacks.

### GPU Hardware Acceleration

The player enables GPU-accelerated video decode and compositing via command-line flags
(`ignore-gpu-blocklist`, `enable-gpu-rasterization`, `VaapiVideoDecoder`, etc.).

For hardware video decode, install the appropriate VAAPI driver for your GPU:

| GPU | Package (Fedora) | Notes |
|-----|-------------------|-------|
| Intel | `libva-intel-media-driver` | Works out of the box on most distros |
| AMD | `mesa-va-drivers` | Included with Mesa |
| NVIDIA | `libva-nvidia-driver` | RPM Fusion; bridges VAAPI → NVDEC |

Verify with `vainfo`:
```bash
sudo dnf install libva-utils
vainfo
```

### CORS Configuration

Electron strips any existing CORS headers from server responses and replaces them
with its own `Access-Control-Allow-Origin: *`. This prevents double-header issues
when reverse proxies (e.g. SWAG/nginx) also add CORS headers.

### Permissions

The app requests minimal permissions:
- Display management (fullscreen, prevent sleep)
- Network access (HTTP server, XMDS communication)
- File system access (config and cache storage)

## Troubleshooting

### Player won't start

```bash
# Check if port is available
ss -tlnp | grep 8765

# Try different port
xiboplayer-electron --port=8080

# Check logs
journalctl --user -u xiboplayer-electron.service -n 50
```

### Black screen

```bash
# Check PWA files exist
ls -la ~/.local/share/@xiboplayer/electron-pwa/pwa/

# Reinstall package
sudo dnf reinstall xiboplayer-electron-*.rpm
```

### CORS errors

Electron automatically strips existing CORS headers from server responses and replaces them with its own `Access-Control-Allow-Origin: *`. This prevents double-header issues when reverse proxies (e.g. SWAG/nginx) also add CORS headers.

If you still see CORS errors, check:
- The CMS is reachable from the player
- No intermediate proxy is stripping Electron's injected headers

### Service won't auto-start

```bash
# Enable lingering (user service without login)
loginctl enable-linger $USER

# Check service status
systemctl --user status xiboplayer-electron.service

# View full logs
journalctl --user -u xiboplayer-electron.service --no-pager
```

### Can't exit kiosk mode

Press **Ctrl+Shift+F12** to show system tray menu, then select "Exit Player".

Or from terminal:
```bash
pkill -f xiboplayer-electron
```

## Uninstallation

### RPM
```bash
sudo dnf remove xiboplayer-electron
```

### Remove Configuration

Configuration files are preserved during uninstallation. To remove manually:

```bash
rm -rf ~/.config/@xiboplayer/electron-pwa
rm -rf ~/.config/systemd/user/xiboplayer-electron.service
rm -rf ~/.local/share/applications/xiboplayer-electron.desktop
```

## Support

- **GitHub Issues:** https://github.com/xibo-players/xiboplayer-electron/issues

## Credits

- **Xibo CMS:** https://xibosignage.com
- **Electron:** https://www.electronjs.org/

## License

AGPL-3.0-or-later

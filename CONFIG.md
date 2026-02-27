# Electron Player Configuration

Configuration file: `~/.config/xiboplayer/electron/config.json`

## Full Reference

```jsonc
{
  // CMS connection — set via Setup screen (S key) or here
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "your-server-key",
  "displayName": "Lobby Screen 1",

  // Local server port (default: 8765)
  "serverPort": 8765,

  // Window and display
  "kioskMode": true,
  "fullscreen": true,
  "hideMouseCursor": true,
  "preventSleep": true,
  "width": 1920,
  "height": 1080,

  // Auto-launch on login
  "autoLaunch": false,

  // CMS transport: "auto" (default) or "xmds" (force SOAP for unpatched Xibo CMS)
  "transport": "auto",

  // Keyboard and mouse controls
  "controls": {
    "keyboard": {
      "debugOverlays": false,
      "setupKey": false,
      "playbackControl": false,
      "videoControls": false
    },
    "mouse": {
      "statusBarOnHover": false
    }
  }
}
```

## Transport

| Value | Description |
|-------|-------------|
| `"auto"` (default) | Try REST API first, fall back to SOAP if the CMS lacks REST endpoints |
| `"xmds"` | Force SOAP/XMDS transport — use this for unpatched Xibo CMS without REST API |

Omitting `transport` or setting it to any value other than `"xmds"` uses auto-detection.

## Controls

The `controls` section gates keyboard shortcuts and mouse behavior in the player. All controls default to `false` (disabled). Omitting `controls` entirely means no keyboard shortcuts or mouse hover will be active — a clean, locked-down kiosk.

### Keyboard

| Key | Group | Default | Action |
|-----|-------|---------|--------|
| `D` | `debugOverlays` | **false** | Toggle download progress overlay |
| `T` | `debugOverlays` | **false** | Toggle timeline/schedule overlay |
| `S` | `setupKey` | **false** | Toggle CMS setup screen |
| `V` | `videoControls` | **false** | Toggle native `<video>` controls |
| `ArrowRight` / `PageDown` | `playbackControl` | **false** | Skip to next layout |
| `ArrowLeft` / `PageUp` | `playbackControl` | **false** | Skip to previous layout |
| `Space` | `playbackControl` | **false** | Pause / resume playback |
| `R` | `playbackControl` | **false** | Revert to scheduled layout |
| Media keys | `playbackControl` | **false** | Next/prev/pause/play (MediaSession API) |

Set a group to `true` to enable keys in that group:

```json
{
  "controls": {
    "keyboard": {
      "setupKey": true,
      "playbackControl": true
    }
  }
}
```

### Mouse

| Setting | Default | Action |
|---------|---------|--------|
| `statusBarOnHover` | **false** | Show status bar (CMS URL, player status) when mouse hovers over the player |

Set to `true` to show the status bar during development:

```json
{
  "controls": {
    "mouse": {
      "statusBarOnHover": true
    }
  }
}
```

## Development Example

For development with all controls and debug overlays enabled:

```json
{
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "your-key",
  "displayName": "Lobby-1",
  "kioskMode": true,
  "fullscreen": true,
  "hideMouseCursor": true,
  "controls": {
    "keyboard": {
      "debugOverlays": true,
      "setupKey": true,
      "playbackControl": true,
      "videoControls": true
    },
    "mouse": {
      "statusBarOnHover": true
    }
  }
}
```

## Config Flow

```
config.json
  → main.js reads controls
    → passes to @xiboplayer/proxy as playerConfig
      → proxy injects into localStorage['xibo_config'].controls
        → PWA main.ts reads controls, gates keyboard handlers
        → PWA index.html reads controls, gates hover CSS
```

Changes to `config.json` require a player restart to take effect.

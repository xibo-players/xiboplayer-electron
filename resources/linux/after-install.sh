#!/bin/bash
#
# Post-install script for Xibo Player
# This script runs after the package is installed
#

set -e

INSTALL_DIR="/opt/Xibo Player"
USER_HOME="$HOME"
CONFIG_DIR="$USER_HOME/.config/xibo-player"

echo "Xibo Player post-installation script"

# Create config directory if it doesn't exist
if [ ! -d "$CONFIG_DIR" ]; then
    echo "Creating config directory: $CONFIG_DIR"
    mkdir -p "$CONFIG_DIR"
    chmod 755 "$CONFIG_DIR"
fi

# Create default config if it doesn't exist
if [ ! -f "$CONFIG_DIR/config.json" ]; then
    echo "Creating default configuration"
    cat > "$CONFIG_DIR/config.json" << 'EOF'
{
  "cmsUrl": "",
  "hardwareKey": "",
  "serverPort": 8765,
  "kioskMode": true,
  "autoLaunch": false,
  "fullscreen": true,
  "hideMouseCursor": true,
  "preventSleep": true,
  "width": 1920,
  "height": 1080
}
EOF
    chmod 644 "$CONFIG_DIR/config.json"
fi

# Create systemd user service directory
SYSTEMD_USER_DIR="$USER_HOME/.config/systemd/user"
if [ ! -d "$SYSTEMD_USER_DIR" ]; then
    echo "Creating systemd user directory: $SYSTEMD_USER_DIR"
    mkdir -p "$SYSTEMD_USER_DIR"
fi

# Create systemd service file
SERVICE_FILE="$SYSTEMD_USER_DIR/xibo-player.service"
echo "Creating systemd service: $SERVICE_FILE"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Xibo Player - Digital Signage
After=graphical.target
Wants=graphical.target

[Service]
Type=simple
Environment=DISPLAY=:0
ExecStart="$INSTALL_DIR/xibo-player" --no-sandbox
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

chmod 644 "$SERVICE_FILE"

# Reload systemd user daemon
if [ -n "$DBUS_SESSION_BUS_ADDRESS" ]; then
    echo "Reloading systemd user daemon"
    systemctl --user daemon-reload || true
fi

# Create desktop entry
DESKTOP_DIR="$USER_HOME/.local/share/applications"
if [ ! -d "$DESKTOP_DIR" ]; then
    mkdir -p "$DESKTOP_DIR"
fi

DESKTOP_FILE="$DESKTOP_DIR/xibo-player.desktop"
echo "Creating desktop entry: $DESKTOP_FILE"

cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=Xibo Player
Comment=Digital Signage Player
Exec="$INSTALL_DIR/xibo-player" %U
Terminal=false
Type=Application
Icon=xibo-player
Categories=AudioVideo;Video;Player;
StartupNotify=true
StartupWMClass=Xibo Player
EOF

chmod 644 "$DESKTOP_FILE"

# Update desktop database
if command -v update-desktop-database > /dev/null 2>&1; then
    echo "Updating desktop database"
    update-desktop-database "$DESKTOP_DIR" || true
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Xibo Player installed successfully!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Configuration file: $CONFIG_DIR/config.json"
echo ""
echo "To start Xibo Player now:"
echo "  xibo-player"
echo ""
echo "To enable auto-start on boot (user service):"
echo "  systemctl --user enable xibo-player.service"
echo "  systemctl --user start xibo-player.service"
echo ""
echo "To view logs:"
echo "  journalctl --user -u xibo-player.service -f"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exit 0

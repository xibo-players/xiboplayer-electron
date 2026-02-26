#!/bin/bash
# Build xiboplayer-electron DEB from pre-built Electron app
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="${1:-0.5.13}"
NAME="xiboplayer-electron"

# Detect architecture
case "$(uname -m)" in
    x86_64)  ARCH="amd64"; ELECTRON_ARCH="x64" ;;
    aarch64) ARCH="arm64"; ELECTRON_ARCH="arm64" ;;
    *)       echo "ERROR: Unsupported architecture: $(uname -m)"; exit 1 ;;
esac

echo "==> Building $NAME DEB v$VERSION for $ARCH"

# Detect the electron-builder output directory
# For x64: linux-unpacked
# For other architectures: linux-{arch}-unpacked
if [ -d "$ELECTRON_DIR/dist-packages/linux-unpacked" ]; then
    LINUX_UNPACKED="linux-unpacked"
elif [ -d "$ELECTRON_DIR/dist-packages/linux-${ELECTRON_ARCH}-unpacked" ]; then
    LINUX_UNPACKED="linux-${ELECTRON_ARCH}-unpacked"
else
    echo "ERROR: Build artifacts not found!"
    echo "       Expected: dist-packages/linux-unpacked/ or dist-packages/linux-${ELECTRON_ARCH}-unpacked/"
    echo "       Run 'pnpm run build:linux' first"
    exit 1
fi

echo "==> Using build artifacts from: $LINUX_UNPACKED"

# Create DEB package directory structure
DEB_DIR="$ELECTRON_DIR/deb-pkg/$NAME"
rm -rf "$DEB_DIR"
mkdir -p "$DEB_DIR/DEBIAN"
mkdir -p "$DEB_DIR/usr/bin"
mkdir -p "$DEB_DIR/usr/lib/xiboplayer"
mkdir -p "$DEB_DIR/usr/share/applications"
mkdir -p "$DEB_DIR/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$DEB_DIR/usr/lib/systemd/user"

echo "==> Installing files..."

# Copy Electron app bundle
cp -a "$ELECTRON_DIR/dist-packages/$LINUX_UNPACKED/"* "$DEB_DIR/usr/lib/xiboplayer/"

# Create wrapper script
cat > "$DEB_DIR/usr/bin/xiboplayer" << 'WRAPPER'
#!/bin/bash
# Xibo Player (Electron) — launcher
exec /usr/lib/xiboplayer/xiboplayer "$@"
WRAPPER
chmod 755 "$DEB_DIR/usr/bin/xiboplayer"

# Desktop entry
cat > "$DEB_DIR/usr/share/applications/xiboplayer.desktop" << 'DESKTOP'
[Desktop Entry]
Name=Xibo Player
Comment=Digital Signage Player for Xibo CMS
Exec=xiboplayer
Icon=xiboplayer
Terminal=false
Type=Application
Categories=AudioVideo;Player;
Keywords=signage;digital;kiosk;xibo;
StartupWMClass=xiboplayer
DESKTOP

# Copy icon if available
if [ -f "$DEB_DIR/usr/lib/xiboplayer/resources/app.asar.unpacked/resources/pwa/favicon.png" ]; then
    cp "$DEB_DIR/usr/lib/xiboplayer/resources/app.asar.unpacked/resources/pwa/favicon.png" \
       "$DEB_DIR/usr/share/icons/hicolor/256x256/apps/xiboplayer.png"
else
    echo "Warning: Icon not found in unpacked resources, skipping"
fi

# Systemd user service
cat > "$DEB_DIR/usr/lib/systemd/user/xiboplayer.service" << 'SERVICE'
[Unit]
Description=Xibo Player - Digital Signage (Electron)
After=graphical-session.target
Wants=graphical-session.target
PartOf=graphical-session.target
Documentation=https://github.com/xibo-players/xiboplayer-electron

[Service]
Type=simple
ExecStart=/usr/bin/xiboplayer --no-sandbox
Restart=always
RestartSec=10
Environment=NODE_ENV=production
TimeoutStopSec=10
KillMode=mixed
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=xiboplayer

[Install]
WantedBy=graphical-session.target
SERVICE

# Calculate installed size (in KB)
INSTALLED_SIZE=$(du -sk "$DEB_DIR" | cut -f1)

# Create control file
cat > "$DEB_DIR/DEBIAN/control" << EOF
Package: xiboplayer-electron
Version: ${VERSION}
Section: misc
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${INSTALLED_SIZE}
Depends: libgtk-3-0, libnss3, libasound2, libgbm1, libatspi2.0-0, libxtst6, xdg-utils
Conflicts: xiboplayer-pwa
Maintainer: Pau Aliagas <linuxnow@gmail.com>
Description: Xibo digital signage player (Electron)
 Xibo Player wrapped in Electron for desktop and kiosk digital signage.
 Provides a native application with built-in HTTP server, offline support,
 system tray integration, and automatic launch via systemd.
Homepage: https://xiboplayer.org
EOF

# Build DEB package
echo "==> Building DEB package..."
DEB_FILE="${NAME}_${VERSION}_${ARCH}.deb"
dpkg-deb --build "$DEB_DIR" "$ELECTRON_DIR/dist-packages/$DEB_FILE"

# Show result
if [ -f "$ELECTRON_DIR/dist-packages/$DEB_FILE" ]; then
    echo ""
    echo "==> Built: $DEB_FILE ($(du -h "$ELECTRON_DIR/dist-packages/$DEB_FILE" | cut -f1))"
    echo "    Install: sudo apt install $ELECTRON_DIR/dist-packages/$DEB_FILE"
    echo "    Enable:  systemctl --user enable --now xiboplayer.service"
else
    echo "ERROR: DEB not found in dist-packages/"
    exit 1
fi

# Clean up binary build
rm -rf "$DEB_DIR"

# --- Build source package (once, arch-independent) ---
SRC_MARKER="$ELECTRON_DIR/dist-packages/.source-built"
if [ ! -f "$SRC_MARKER" ]; then
    echo "==> Building source package..."
    SRC_BUILD="$ELECTRON_DIR/deb-src"
    rm -rf "$SRC_BUILD"
    SRC_NAME="${NAME}-${VERSION}"
    mkdir -p "$SRC_BUILD/$SRC_NAME"

    # Create orig tarball from repo source (exclude build artifacts)
    tar czf "$SRC_BUILD/${NAME}_${VERSION}.orig.tar.gz" \
        -C "$ELECTRON_DIR" \
        --exclude=dist-packages --exclude=deb-pkg --exclude=deb-src \
        --exclude=node_modules --exclude=.git \
        --transform="s|^\.|${SRC_NAME}|" .

    # Extract for dpkg-source
    cd "$SRC_BUILD"
    tar xf "${NAME}_${VERSION}.orig.tar.gz"

    # Create debian/ directory
    mkdir -p "$SRC_BUILD/$SRC_NAME/debian/source"
    echo "3.0 (quilt)" > "$SRC_BUILD/$SRC_NAME/debian/source/format"

    cat > "$SRC_BUILD/$SRC_NAME/debian/control" << EOF
Source: ${NAME}
Section: misc
Priority: optional
Maintainer: Pau Aliagas <linuxnow@gmail.com>
Build-Depends: debhelper (>= 12), nodejs, npm
Standards-Version: 4.6.0
Homepage: https://xiboplayer.org

Package: ${NAME}
Architecture: any
Depends: libgtk-3-0, libnss3, libasound2, libgbm1, libatspi2.0-0, libxtst6, xdg-utils
Description: Xibo digital signage player (Electron)
 Xibo Player wrapped in Electron for desktop and kiosk digital signage.
 Provides a native application with built-in HTTP server, offline support,
 system tray integration, and automatic launch via systemd.
EOF

    cat > "$SRC_BUILD/$SRC_NAME/debian/changelog" << EOF
${NAME} (${VERSION}) stable; urgency=medium

  * Release ${VERSION}

 -- Pau Aliagas <linuxnow@gmail.com>  $(date -R)
EOF

    cat > "$SRC_BUILD/$SRC_NAME/debian/rules" << 'EOF'
#!/usr/bin/make -f
%:
	dh $@
EOF
    chmod +x "$SRC_BUILD/$SRC_NAME/debian/rules"

    echo "12" > "$SRC_BUILD/$SRC_NAME/debian/compat"

    # Build source package
    cd "$SRC_BUILD/$SRC_NAME"
    dpkg-source -b .
    cd "$SCRIPT_DIR"

    # Copy source package files to output
    cp "$SRC_BUILD"/*.dsc "$ELECTRON_DIR/dist-packages/" 2>/dev/null || true
    cp "$SRC_BUILD"/*.orig.tar.* "$ELECTRON_DIR/dist-packages/" 2>/dev/null || true
    cp "$SRC_BUILD"/*.debian.tar.* "$ELECTRON_DIR/dist-packages/" 2>/dev/null || true

    echo "==> Source package files:"
    ls -lh "$ELECTRON_DIR/dist-packages/"*.dsc "$ELECTRON_DIR/dist-packages/"*.tar.* 2>/dev/null || true

    touch "$SRC_MARKER"
    rm -rf "$SRC_BUILD"
fi

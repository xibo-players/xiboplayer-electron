#!/bin/bash
# Build Xibo Player RPM package from pre-built Electron app
set -e

SPEC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SPEC_DIR/../../.." && pwd)"
ELECTRON_DIR="$PROJECT_ROOT/platforms/electron-pwa"
VERSION="0.9.0"
NAME="xibo-player"

echo "==> Building Xibo Player RPM"
echo "    Version: $VERSION"
echo "    Project root: $PROJECT_ROOT"
echo ""

# Check if linux-unpacked exists
if [ ! -d "$ELECTRON_DIR/dist-packages/linux-unpacked" ]; then
    echo "ERROR: linux-unpacked directory not found!"
    echo "       Run 'npm run build' in platforms/electron-pwa first"
    exit 1
fi

# Create RPM build tree
echo "==> Setting up RPM build tree..."
mkdir -p ~/rpmbuild/{SOURCES,SPECS,BUILD,RPMS,SRPMS}

# Create source tarball from linux-unpacked
echo "==> Creating source tarball from linux-unpacked..."
cd "$ELECTRON_DIR/dist-packages"
TARBALL="$HOME/rpmbuild/SOURCES/$NAME-$VERSION-linux-x64.tar.gz"

tar czf "$TARBALL" \
    --transform "s,^linux-unpacked,$NAME-$VERSION-linux-x64," \
    linux-unpacked

echo "    Created: $TARBALL"
echo "    Size: $(du -h "$TARBALL" | cut -f1)"

# Copy spec file
echo "==> Copying spec file..."
cp "$SPEC_DIR/xibo-player.spec" ~/rpmbuild/SPECS/

# Build RPM
echo "==> Building RPM..."
cd ~/rpmbuild/SPECS
rpmbuild -ba xibo-player.spec

# Show results
echo ""
echo "==> Build complete!"
echo ""
echo "RPM packages:"
RPM_FILE=$(ls -1 ~/rpmbuild/RPMS/x86_64/$NAME-$VERSION-*.rpm 2>/dev/null | head -1)
if [ -n "$RPM_FILE" ]; then
    ls -lh "$RPM_FILE"
    RPM_SIZE=$(du -h "$RPM_FILE" | cut -f1)
    echo "    Size: $RPM_SIZE"
else
    echo "  (none found)"
fi
echo ""
echo "Source RPM:"
ls -lh ~/rpmbuild/SRPMS/$NAME-$VERSION-*.src.rpm 2>/dev/null || echo "  (none found)"
echo ""

if [ -n "$RPM_FILE" ]; then
    # Copy to dist-packages
    echo "==> Copying RPM to dist-packages..."
    cp "$RPM_FILE" "$ELECTRON_DIR/dist-packages/"
    echo "    Copied to: $ELECTRON_DIR/dist-packages/$(basename "$RPM_FILE")"
    echo ""

    echo "Install with:"
    echo "  sudo dnf install $ELECTRON_DIR/dist-packages/$(basename "$RPM_FILE")"
    echo ""
    echo "Or:"
    echo "  sudo rpm -ivh $ELECTRON_DIR/dist-packages/$(basename "$RPM_FILE")"
    echo ""
    echo "Enable auto-start:"
    echo "  systemctl --user enable xibo-player.service"
    echo "  systemctl --user start xibo-player.service"
fi

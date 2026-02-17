#!/bin/bash
# Build xiboplayer-electron RPM from pre-built Electron app
set -e

SPEC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SPEC_DIR/.." && pwd)"
VERSION="${1:-0.9.0}"
NAME="xiboplayer-electron"

echo "==> Building $NAME RPM v$VERSION"

# Check if linux-unpacked exists
if [ ! -d "$ELECTRON_DIR/dist-packages/linux-unpacked" ]; then
    echo "ERROR: dist-packages/linux-unpacked/ not found!"
    echo "       Run 'pnpm run build:linux' first"
    exit 1
fi

# Create RPM build tree
mkdir -p ~/rpmbuild/{SOURCES,SPECS,BUILD,RPMS,SRPMS}

# Create source tarball (rpmbuild expects to unpack to linux-unpacked/)
echo "==> Creating source tarball..."
TARBALL="$HOME/rpmbuild/SOURCES/$NAME-$VERSION-linux-unpacked.tar.gz"
tar czf "$TARBALL" -C "$ELECTRON_DIR/dist-packages" linux-unpacked
echo "    $TARBALL ($(du -h "$TARBALL" | cut -f1))"

# Copy spec and build
cp "$SPEC_DIR/xiboplayer-electron.spec" ~/rpmbuild/SPECS/
echo "==> Running rpmbuild..."
rpmbuild -bb ~/rpmbuild/SPECS/xiboplayer-electron.spec \
    --define "_version $VERSION"

# Show result
RPM_FILE=$(ls -1t ~/rpmbuild/RPMS/x86_64/$NAME-$VERSION-*.rpm 2>/dev/null | head -1)
if [ -n "$RPM_FILE" ]; then
    cp "$RPM_FILE" "$ELECTRON_DIR/dist-packages/"
    echo ""
    echo "==> Built: $(basename "$RPM_FILE") ($(du -h "$RPM_FILE" | cut -f1))"
    echo "    Install: sudo dnf install $ELECTRON_DIR/dist-packages/$(basename "$RPM_FILE")"
    echo "    Enable:  systemctl --user enable --now xiboplayer.service"
else
    echo "ERROR: RPM not found in ~/rpmbuild/RPMS/"
    exit 1
fi

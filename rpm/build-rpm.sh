#!/bin/bash
# Build xiboplayer-electron RPM from pre-built Electron app
set -e

SPEC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SPEC_DIR/.." && pwd)"
VERSION="${1:-0.5.20}"
NAME="xiboplayer-electron"

echo "==> Building $NAME RPM v$VERSION"

# Detect architecture for electron-builder output directory
case "$(uname -m)" in
    x86_64)  ELECTRON_ARCH="x64" ;;
    aarch64) ELECTRON_ARCH="arm64" ;;
    *)
        echo "ERROR: Unsupported architecture: $(uname -m)"
        echo "       Only x86_64 and aarch64 are supported"
        exit 1
        ;;
esac

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

# Create RPM build tree
mkdir -p ~/rpmbuild/{SOURCES,SPECS,BUILD,RPMS,SRPMS}

# Create source tarball (rpmbuild expects to unpack to linux-unpacked/)
echo "==> Creating source tarball..."
TARBALL="$HOME/rpmbuild/SOURCES/$NAME-$VERSION-linux-unpacked.tar.gz"
# Copy icon, config, and docs into the build artifacts so they end up in the tarball
cp "$ELECTRON_DIR/resources/icon.png" "$ELECTRON_DIR/dist-packages/$LINUX_UNPACKED/icon.png"
cp "$ELECTRON_DIR/config.json" "$ELECTRON_DIR/dist-packages/$LINUX_UNPACKED/"
cp "$ELECTRON_DIR/config.json.example" "$ELECTRON_DIR/dist-packages/$LINUX_UNPACKED/"
cp "$ELECTRON_DIR/CONFIG.md" "$ELECTRON_DIR/dist-packages/$LINUX_UNPACKED/"
cp "$ELECTRON_DIR/README.md" "$ELECTRON_DIR/dist-packages/$LINUX_UNPACKED/"
# Create tarball with the directory renamed to linux-unpacked if needed
if [ "$LINUX_UNPACKED" = "linux-unpacked" ]; then
    tar czf "$TARBALL" -C "$ELECTRON_DIR/dist-packages" linux-unpacked
else
    # For architecture-specific names, rename to linux-unpacked in the tarball
    tar czf "$TARBALL" -C "$ELECTRON_DIR/dist-packages" --transform="s|$LINUX_UNPACKED|linux-unpacked|" "$LINUX_UNPACKED"
fi
echo "    $TARBALL ($(du -h "$TARBALL" | cut -f1))"

# Copy spec and build
cp "$SPEC_DIR/xiboplayer-electron.spec" ~/rpmbuild/SPECS/
echo "==> Running rpmbuild..."
rpmbuild -ba ~/rpmbuild/SPECS/xiboplayer-electron.spec \
    --define "_version $VERSION"

# Show result
ARCH=$(uname -m)
RPM_FILE=$(ls -1t ~/rpmbuild/RPMS/$ARCH/$NAME-$VERSION-*.rpm 2>/dev/null | head -1)
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

# Copy SRPM to output
SRPM_FILE=$(ls -1t ~/rpmbuild/SRPMS/$NAME-$VERSION-*.src.rpm 2>/dev/null | head -1)
if [ -n "$SRPM_FILE" ]; then
    cp "$SRPM_FILE" "$ELECTRON_DIR/dist-packages/"
    echo "==> SRPM: $(basename "$SRPM_FILE") ($(du -h "$SRPM_FILE" | cut -f1))"
fi

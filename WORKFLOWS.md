# Package Building Workflows

This repository contains GitHub Actions workflows for building RPM and DEB packages with multi-architecture support.

## Workflows

### RPM Workflow (`.github/workflows/rpm.yml`)
Builds signed RPM packages for Fedora 43 on x86_64 and aarch64 architectures.

### DEB Workflow (`.github/workflows/deb.yml`)
Builds signed DEB packages for Ubuntu 24.04 on amd64 and arm64 architectures.

## Triggering Builds

### Automatic (Tag Push)
Push a version tag to trigger both workflows:
```bash
git tag v0.9.0
git push origin v0.9.0
```

### Manual (workflow_dispatch)
Go to Actions → Select workflow → Run workflow → Enter version

## Required Secrets

Before running the workflows, add these secrets to your repository:

1. **RPM_GPG_KEY** - Your GPG private key for signing RPMs
2. **RPM_GPG_PASSPHRASE** - Passphrase for the RPM GPG key
3. **DEB_GPG_KEY** - Your GPG private key for signing DEBs
4. **DEB_GPG_PASSPHRASE** - Passphrase for the DEB GPG key

To add secrets: Repository Settings → Secrets and variables → Actions → New repository secret

## Build Process

### RPM Build
1. Builds on Fedora 43 containers (x86_64 and aarch64)
2. Installs Node.js 20+ and pnpm
3. Runs `pnpm install` and `pnpm run build:linux`
4. Executes `rpm/build-rpm.sh` to create RPM from Electron app
5. Signs RPMs with GPG
6. Publishes to gh-pages branch: `rpm/fedora/43/{x86_64,aarch64}/`

### DEB Build
1. Builds on Ubuntu 24.04 containers (amd64 and arm64)
2. Installs Node.js 20+ and pnpm
3. Runs `pnpm install` and `pnpm run build:linux`
4. Executes `deb/build-deb.sh` to create DEB from Electron app
5. Signs DEBs with GPG
6. Publishes to gh-pages branch: `deb/ubuntu/24.04/{amd64,arm64}/`

## Package Details

- **Package name:** xiboplayer-electron
- **Installation path:** /usr/lib/xiboplayer/
- **Wrapper script:** /usr/bin/xiboplayer
- **Systemd service:** /usr/lib/systemd/user/xiboplayer.service
- **Desktop entry:** /usr/share/applications/xiboplayer.desktop
- **Conflicts with:** xiboplayer-pwa

## Dependencies

### RPM (Fedora)
- gtk3, nss, alsa-lib, mesa-libgbm, at-spi2-core, libXtst, xdg-utils

### DEB (Ubuntu)
- libgtk-3-0, libnss3, libasound2, libgbm1, libatspi2.0-0, libxtst6, xdg-utils

## Repository Configuration

After packages are published to gh-pages, users can install them:

### Fedora/RHEL (DNF)
```bash
# Add repository
sudo tee /etc/yum.repos.d/xiboplayer-electron.repo << 'EOF'
[xiboplayer-electron]
name=Xiboplayer Electron Repository
baseurl=https://xibo-players.github.io/xiboplayer-electron/rpm/fedora/43/$basearch/
enabled=1
gpgcheck=1
gpgkey=https://xibo-players.github.io/xiboplayer-electron/rpm/RPM-GPG-KEY-xiboplayer-electron
EOF

# Install
sudo dnf install xiboplayer-electron

# Enable service
systemctl --user enable --now xiboplayer.service
```

### Ubuntu/Debian (APT)
```bash
# Add repository key
curl -fsSL https://xibo-players.github.io/xiboplayer-electron/deb/DEB-GPG-KEY-xiboplayer-electron | \
  sudo gpg --dearmor -o /usr/share/keyrings/xiboplayer-electron.gpg

# Add repository
echo "deb [signed-by=/usr/share/keyrings/xiboplayer-electron.gpg] https://xibo-players.github.io/xiboplayer-electron/deb/ubuntu/24.04/ ./" | \
  sudo tee /etc/apt/sources.list.d/xiboplayer-electron.list

# Install
sudo apt update
sudo apt install xiboplayer-electron

# Enable service
systemctl --user enable --now xiboplayer.service
```

## Troubleshooting

### Workflow Fails at Build Step
- Ensure Node.js dependencies are correctly specified in package.json
- Check that `pnpm run build:linux` completes successfully locally

### GPG Signing Fails
- Verify GPG secrets are correctly added to repository
- Ensure GPG key format is correct (use `gpg --export-secret-keys --armor`)

### Repository Publishing Fails
- Check that gh-pages branch exists or can be created
- Verify GITHUB_TOKEN has write permissions

## Local Testing

### Test RPM Build
```bash
# Install dependencies
sudo dnf install nodejs pnpm rpm-build rpmdevtools

# Build Electron app
pnpm install
pnpm run build:linux

# Build RPM
./rpm/build-rpm.sh 0.9.0
```

### Test DEB Build
```bash
# Install dependencies
sudo apt install nodejs npm build-essential dpkg-dev

# Install pnpm
npm install -g pnpm

# Build Electron app
pnpm install
pnpm run build:linux

# Build DEB
./deb/build-deb.sh 0.9.0
```

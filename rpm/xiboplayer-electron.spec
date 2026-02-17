%global debug_package %{nil}

Name:           xiboplayer-electron
Version:        %{_version}
Release:        1%{?dist}
Summary:        Xibo digital signage player (Electron)

License:        AGPL-3.0-or-later
URL:            https://github.com/linuxnow/xibo_players
Source0:        xiboplayer-electron-%{version}-linux-unpacked.tar.gz

ExclusiveArch:  x86_64 aarch64
BuildRequires:  systemd-rpm-macros

Requires:       gtk3
Requires:       nss
Requires:       alsa-lib
Requires:       mesa-libgbm
Requires:       at-spi2-core
Requires:       libXtst
Requires:       xdg-utils
Recommends:     libva
Recommends:     mesa-dri-drivers

Conflicts:      xiboplayer-pwa

%description
Xibo Player wrapped in Electron for desktop and kiosk digital signage.
Provides a native application with built-in HTTP server, offline support,
system tray integration, and automatic launch via systemd.

%prep
%setup -q -n linux-unpacked

%build
# Pre-built Electron binary, nothing to build

%install
# Electron app bundle
install -dm755 %{buildroot}%{_libdir}/xiboplayer
cp -a * %{buildroot}%{_libdir}/xiboplayer/

# Wrapper script
install -Dm755 /dev/stdin %{buildroot}%{_bindir}/xiboplayer << 'WRAPPER'
#!/bin/bash
# Xibo Player (Electron) — launcher
exec %{_libdir}/xiboplayer/xiboplayer "$@"
WRAPPER

# Desktop entry
install -Dm644 /dev/stdin %{buildroot}%{_datadir}/applications/xiboplayer.desktop << 'DESKTOP'
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

# Icon
install -Dm644 %{buildroot}%{_libdir}/xiboplayer/resources/app.asar.unpacked/resources/pwa/favicon.png \
    %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/xiboplayer.png 2>/dev/null || \
    echo "Icon not found in unpacked resources, skipping"

# Systemd user service
install -Dm644 /dev/stdin %{buildroot}%{_userunitdir}/xiboplayer.service << 'SERVICE'
[Unit]
Description=Xibo Player - Digital Signage (Electron)
After=graphical-session.target
Wants=graphical-session.target
PartOf=graphical-session.target
Documentation=https://github.com/linuxnow/xibo_players

[Service]
Type=simple
ExecStart=%{_bindir}/xiboplayer --no-sandbox
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

%files
%{_bindir}/xiboplayer
%{_libdir}/xiboplayer/
%{_datadir}/applications/xiboplayer.desktop
%{_userunitdir}/xiboplayer.service

%post
touch --no-create %{_datadir}/icons/hicolor &>/dev/null || :
gtk-update-icon-cache %{_datadir}/icons/hicolor &>/dev/null || :

%postun
if [ $1 -eq 0 ] ; then
    touch --no-create %{_datadir}/icons/hicolor &>/dev/null
    gtk-update-icon-cache %{_datadir}/icons/hicolor &>/dev/null || :
fi

%changelog
* Mon Feb 16 2026 Pau Aliagas <linuxnow@gmail.com> - 0.9.0-1
- New RPM spec with proper Fedora FHS paths
- Electron bundle in /usr/lib64/xiboplayer/
- Systemd user service for auto-start

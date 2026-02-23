%global debug_package %{nil}

# Electron bundles Chromium which links legacy compat stubs (libc.so,
# libdl.so.2, libpthread.so.0, librt.so.1).  On Fedora 38+ these are
# all merged into glibc / libc.so.6.  Filter them so dnf doesn't pull
# in glibc-devel or fail to resolve.
# Also filter the bundled libffmpeg.so (shipped inside the Electron tree).
%global __requires_exclude ^(libc\\.so\\(\\)|libdl\\.so\\.2|libpthread\\.so\\.0|librt\\.so\\.1|libffmpeg\\.so)

Name:           xiboplayer-electron
Version:        %{_version}
Release:        2%{?dist}
Summary:        Xibo digital signage player (Electron)

License:        AGPL-3.0-or-later
URL:            https://github.com/xibo-players/%{name}
Source0:        %{name}-%{version}-linux-unpacked.tar.gz

ExclusiveArch:  x86_64 aarch64
BuildRequires:  systemd-rpm-macros

# Bundled components — Fedora Packaging Guidelines §Bundling
Provides:       bundled(electron) = 40

Requires:       gtk3
Requires:       nss
Requires:       alsa-lib
Requires:       mesa-libgbm
Requires:       at-spi2-core
Requires:       libXtst
Requires:       xdg-utils
Recommends:     libva
Recommends:     mesa-dri-drivers

%description
Xibo Player wrapped in Electron for desktop and kiosk digital signage.
Provides a native application with built-in HTTP server, offline support,
system tray integration, and automatic launch via systemd.

%prep
%setup -q -n linux-unpacked

%build
# Pre-built Electron binary — nothing to compile

%install
# Electron app bundle
install -dm755 %{buildroot}%{_libdir}/%{name}
cp -a * %{buildroot}%{_libdir}/%{name}/

# Wrapper script
install -Dm755 /dev/stdin %{buildroot}%{_bindir}/%{name} << 'WRAPPER'
#!/bin/bash
exec %{_libdir}/xiboplayer-electron/xiboplayer "$@"
WRAPPER

# Desktop entry
install -Dm644 /dev/stdin %{buildroot}%{_datadir}/applications/%{name}.desktop << 'DESKTOP'
[Desktop Entry]
Name=XiboPlayer Electron
Comment=Digital Signage Player for Xibo CMS (Electron)
Exec=xiboplayer-electron
Icon=xiboplayer
Terminal=false
Type=Application
Categories=Utility;
Keywords=signage;digital;kiosk;xibo;
StartupWMClass=xiboplayer
DESKTOP

# Icon
install -Dm644 %{buildroot}%{_libdir}/%{name}/resources/app.asar.unpacked/resources/pwa/favicon.png \
    %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/xiboplayer.png 2>/dev/null || \
    echo "Icon not found in unpacked resources, skipping"

# Systemd user service
install -Dm644 /dev/stdin %{buildroot}%{_userunitdir}/%{name}.service << 'SERVICE'
[Unit]
Description=Xibo Player - Digital Signage (Electron)
After=graphical-session.target
Wants=graphical-session.target
PartOf=graphical-session.target
Documentation=https://github.com/xibo-players/xiboplayer-electron

[Service]
Type=simple
ExecStart=%{_bindir}/xiboplayer-electron --no-sandbox
Restart=always
RestartSec=10
Environment=NODE_ENV=production
TimeoutStopSec=10
KillMode=mixed
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=xiboplayer-electron

[Install]
WantedBy=graphical-session.target
SERVICE

%files
%{_bindir}/%{name}
%{_libdir}/%{name}/
%{_datadir}/applications/%{name}.desktop
%{_userunitdir}/%{name}.service

%post
# Register alternatives (higher priority than Chromium)
alternatives --install %{_bindir}/xiboplayer xiboplayer %{_bindir}/%{name} 60

touch --no-create %{_datadir}/icons/hicolor &>/dev/null || :
gtk-update-icon-cache %{_datadir}/icons/hicolor &>/dev/null || :

%preun
if [ "$1" -eq 0 ]; then
    alternatives --remove xiboplayer %{_bindir}/%{name}
fi

%postun
if [ $1 -eq 0 ] ; then
    touch --no-create %{_datadir}/icons/hicolor &>/dev/null
    gtk-update-icon-cache %{_datadir}/icons/hicolor &>/dev/null || :
fi

%changelog
* Mon Feb 23 2026 Pau Aliagas <linuxnow@gmail.com> - 0.4.5-1
- Fix

* Mon Feb 23 2026 Pau Aliagas <linuxnow@gmail.com> - 0.4.4-1
- Bump to 0.4.4

* Mon Feb 23 2026 Pau Aliagas <linuxnow@gmail.com> - 0.4.3-1
- Bump to 0.4.3

* Sat Feb 22 2026 Pau Aliagas <linuxnow@gmail.com> - 0.4.1-2
- Fix @xiboplayer/pwa dependency range to pull 0.4.x from npm

* Sun Feb 22 2026 Pau Aliagas <linuxnow@gmail.com> - 0.4.1-1
- Fix timeline duration calculation, overlay alignment, and remaining-duration display

* Sat Feb 21 2026 Pau Aliagas <linuxnow@gmail.com> - 0.4.0-1
- Multi-display

* Sat Feb 21 2026 Pau Aliagas <linuxnow@gmail.com> - 0.3.7-1
- Bump to 0.3.7

* Thu Feb 20 2026 Pau Aliagas <linuxnow@gmail.com> - 0.3.4-1
- Bump to 0.3.4 (unified versioning across all packages)
- Pick up SDK 0.3.4 with RSA key generation (@xiboplayer/crypto)
- Pick up PWA 0.3.4 with crypto dependency

* Thu Feb 20 2026 Pau Aliagas <linuxnow@gmail.com> - 0.3.1-1
- Pick up @xiboplayer/pwa 0.3.2 with service worker refactor
- Pick up SDK 0.3.0 (@xiboplayer/sw split out)

* Wed Feb 19 2026 Pau Aliagas <linuxnow@gmail.com> - 0.3.0-1
- Bump SDK dependencies to 0.3.0 (SW refactored into @xiboplayer/sw)

* Tue Feb 18 2026 Pau Aliagas <linuxnow@gmail.com> - 0.2.0-1
- Filter bogus libc.so/libdl/libpthread/librt auto-requires
- Add Provides: bundled(electron) per Fedora Bundling guidelines
- Conflict with xiboplayer-chromium (not xiboplayer-pwa)

* Mon Feb 16 2026 Pau Aliagas <linuxnow@gmail.com> - 0.1.0-1
- Initial RPM with Fedora FHS paths
- Electron bundle in /usr/lib64/xiboplayer/
- Systemd user service for auto-start

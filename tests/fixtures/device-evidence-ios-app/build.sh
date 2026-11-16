#!/bin/sh
# Builds the fixture app of the macOS device test into ./build/Fixture.app, in the folder it is run in (the project's own build command runs in a checkout, so this is that command).
# The headline is read from ./headline.txt (the base checkout and the candidate checkout hold different ones), so the two builds differ in that one text.
# Needs Xcode's command-line tools and the iOS simulator SDK. No Xcode project: one swiftc call, an Info.plist, an ad-hoc signature. Nothing here is a secret and nothing is kept outside ./build.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
headline=$(cat headline.txt)
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=x86_64 ;; esac
rm -rf build
mkdir -p build/Fixture.app build/src
sed "s|@HEADLINE@|$headline|" "$here/main.swift" > build/src/main.swift
xcrun swiftc -target "$arch-apple-ios17.0-simulator" -sdk "$sdk" -o build/Fixture.app/Fixture build/src/main.swift
cat > build/Fixture.app/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>io.rovara.fixture-app</string>
  <key>CFBundleName</key><string>Fixture</string>
  <key>CFBundleExecutable</key><string>Fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer></array>
  <key>UILaunchScreen</key><dict/>
</dict>
</plist>
PLIST
xcrun codesign --force --sign - build/Fixture.app

#!/usr/bin/env bash
# Builds the two fixture apps of the device-executor CI test: before.apk (headline "Total: 10") and after.apk (headline "Total: 12"), differing in that one text.
# Usage: build.sh <output directory>
# Needs a JDK (javac, keytool), the Android SDK's build tools (aapt2, d8, zipalign, apksigner) and one platform's android.jar: ANDROID_HOME (or ANDROID_SDK_ROOT) names the SDK, JAVA_HOME the JDK.
# GitHub's ubuntu runners have all of it. The signing key is made fresh each time in a scratch directory and thrown away with it; nothing here is a secret and nothing is kept.
set -euo pipefail

out=${1:?usage: build.sh <output directory>}
here=$(cd "$(dirname "$0")" && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[ -n "$sdk" ] && [ -d "$sdk" ] || { echo "build.sh: ANDROID_HOME is not set to an Android SDK" >&2; exit 2; }
java_bin=${JAVA_HOME:+$JAVA_HOME/bin/}

# The newest build tools and the newest platform with an android.jar.
tools=$(ls -d "$sdk"/build-tools/*/ | sort -V | tail -n 1)
tools=${tools%/}
jar=$(ls "$sdk"/platforms/android-*/android.jar | sort -V | tail -n 1)
[ -x "$tools/aapt2" ] && [ -f "$jar" ] || { echo "build.sh: no build tools or platform in $sdk" >&2; exit 2; }
echo "build.sh: build tools $(basename "$tools"), $(dirname "$jar" | xargs basename)"

mkdir -p "$out"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
password=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
"${java_bin}keytool" -genkeypair -keystore "$scratch/key.jks" -storepass "$password" -keypass "$password" -alias fixture -dname "CN=Rovara fixture" \
  -keyalg RSA -keysize 2048 -validity 3650 >/dev/null 2>&1

build() {
  local name=$1 headline=$2
  local work="$scratch/$name"
  mkdir -p "$work/src/io/rovara/fixture" "$work/classes" "$work/dex"
  sed "s|@HEADLINE@|$headline|" "$here/src/io/rovara/fixture/MainActivity.java" > "$work/src/io/rovara/fixture/MainActivity.java"
  "${java_bin}javac" -source 8 -target 8 -Xlint:-options -classpath "$jar" -d "$work/classes" "$work/src/io/rovara/fixture/MainActivity.java"
  # shellcheck disable=SC2046
  "$tools/d8" --lib "$jar" --min-api 24 --output "$work/dex" $(find "$work/classes" -name '*.class')
  "$tools/aapt2" link -o "$work/app.unsigned.apk" -I "$jar" --manifest "$here/AndroidManifest.xml" --min-sdk-version 24 --target-sdk-version 34
  (cd "$work/dex" && zip -q -u "$work/app.unsigned.apk" classes.dex)
  "$tools/zipalign" -f 4 "$work/app.unsigned.apk" "$work/app.aligned.apk"
  "$tools/apksigner" sign --ks "$scratch/key.jks" --ks-pass "pass:$password" --key-pass "pass:$password" --out "$out/$name.apk" "$work/app.aligned.apk"
  "$tools/apksigner" verify "$out/$name.apk"
}

build before "Total: 10"
build after "Total: 12"
ls -l "$out"

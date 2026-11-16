# The device executor for Rovara's Android device evidence (DEC 244, slice 2; linux/amd64 only: Google ships no supported Linux arm64 emulator). It runs the Android emulator and Maestro against
# the app that the task sandbox built, and the program in packages/verifier/src/executor/device-evidence-entry.ts. The worker starts it NEXT TO the task sandbox, never inside it:
# `--network container:<sandbox>` (the one thing they share), `--device /dev/kvm` (this container only), one read-only mount of the built apps, every capability dropped, a read-only root, the default
# seccomp and AppArmor profiles; packages/verifier/src/host/device-executor.ts writes those arguments and checks them. It never holds credentials: nothing is passed in but the plan.
# Pinned: the base image by digest, the Android command-line tools and Maestro by SHA-256. NOT pinned: the emulator, platform-tools and system image sdkmanager installs (Google's repository checks each one's
# own SHA-1); the build prints what it installed. Installing them accepts the Android SDK licence terms non-interactively (see the report of the lane that added this file).
# Base images come from ECR Public by digest: CodeBuild's shared IPs hit Docker Hub pull limits.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /opt/agentx
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/model-runtime/package.json packages/model-runtime/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/verifier/package.json packages/verifier/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/broker/package.json packages/broker/package.json
COPY packages/local-adapters/package.json packages/local-adapters/package.json
COPY packages/aws-adapters/package.json packages/aws-adapters/package.json
COPY packages/testing/package.json packages/testing/package.json
COPY packages/slack-service/package.json packages/slack-service/package.json
COPY upstream/e2e-0.20.0.tgz upstream/e2e-0.20.0.tgz
COPY infra/package.json infra/package.json
RUN npm ci --ignore-scripts

COPY packages/contracts packages/contracts
COPY packages/verifier packages/verifier
RUN npx tsc -b packages/contracts packages/verifier --pretty false
RUN npm prune --omit=dev --workspaces

# The Android SDK pieces and Maestro, fetched here so the final image holds no download tool (no curl, no sdkmanager).
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS android

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*
ENV ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_HOME=/opt/android-sdk ANDROID_AVD_HOME=/opt/android-avd

# commandlinetools-linux-16111833 (Google's own SHA-1 for it is e025545c62a8e64c7559119566a569fb1dec5f60).
RUN curl -fsSL -o /tmp/cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip \
    && echo "0877a1d048fe4a24efe2eff536ca4223f7adeb58648bb81909d33c446918cfa8  /tmp/cmdline-tools.zip" | sha256sum --check - \
    && mkdir -p /opt/android-sdk/cmdline-tools \
    && unzip -q /tmp/cmdline-tools.zip -d /opt/android-sdk/cmdline-tools \
    && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip
RUN yes | /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null
# API 34, the plain Android Open Source Project image (no Google apps, no accounts), for x86-64.
RUN /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager "platform-tools" "emulator" "system-images;android-34;default;x86_64" \
    && /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --list_installed
# The AVD goes to an explicit --path: the first CI run (2026-11-16) showed this avdmanager (command-line tools 23.0.0) exits 0 without creating it under ANDROID_AVD_HOME. If its own rovara.ini is not in
# ANDROID_AVD_HOME afterwards, this writes the three-line pointer the emulator reads; a missing config.ini lists where avdmanager did put things and fails the build.
RUN mkdir -p /opt/android-avd \
    && echo no | /opt/android-sdk/cmdline-tools/latest/bin/avdmanager create avd --force --name rovara --package "system-images;android-34;default;x86_64" --device pixel_5 --path /opt/android-avd/rovara.avd \
    ; cfg=/opt/android-avd/rovara.avd/config.ini \
    && if [ ! -f "$cfg" ]; then echo "avdmanager did not create $cfg; found:"; find / -xdev \( -name 'rovara.avd' -o -name 'rovara.ini' \) 2>/dev/null; ls -la /opt/android-avd "$HOME/.android" 2>&1; exit 1; fi \
    && if [ ! -f /opt/android-avd/rovara.ini ]; then printf 'avd.ini.encoding=UTF-8\npath=/opt/android-avd/rovara.avd\ntarget=android-34\n' > /opt/android-avd/rovara.ini; fi \
    && for kv in hw.lcd.width=720 hw.lcd.height=1280 hw.lcd.density=320 hw.ramSize=2048 disk.dataPartition.size=2G hw.gpu.enabled=yes hw.gpu.mode=swiftshader_indirect hw.keyboard=yes \
                 hw.sdCard=no hw.audioInput=no hw.audioOutput=no hw.camera.back=none hw.camera.front=none showDeviceFrame=no; do \
         key="${kv%%=*}"; sed -i "/^${key}=/d" "$cfg"; echo "$kv" >> "$cfg"; \
       done \
    && rm -f /opt/android-avd/rovara.avd/sdcard.img \
    && cat "$cfg" /opt/android-avd/rovara.ini
# No command-line tools in the final image: nothing can install anything at run time.
RUN rm -rf /opt/android-sdk/cmdline-tools
# The container runs as uid 10001, not root: whatever sdkmanager and avdmanager created must be readable and runnable by it (never writable: the AVD is started `-read-only`).
RUN chmod -R go-w,a+rX /opt/android-sdk /opt/android-avd

# Maestro 2.12.1 (Apache-2.0), by SHA-256.
RUN curl -fsSL -o /tmp/maestro.zip https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.12.1/maestro.zip \
    && echo "54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7  /tmp/maestro.zip" | sha256sum --check - \
    && mkdir -p /opt/maestro-unpack && unzip -q /tmp/maestro.zip -d /opt/maestro-unpack \
    && mv /opt/maestro-unpack/maestro /opt/maestro \
    && rm -rf /tmp/maestro.zip /opt/maestro-unpack

FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# The libraries the emulator's own binaries ask for (read from their dynamic sections), and the JRE Maestro runs on.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jre-headless libx11-6 libxcb1 libxext6 libxi6 libice6 libsm6 libxkbfile1 libpulse0 libdrm2 libgbm1 libdbus-1-3 libnss3 libpng16-16 \
       libuuid1 libbsd0 libexpat1 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" /opt/java \
    && useradd --uid 10001 --create-home --home-dir /home/android --shell /usr/sbin/nologin android

WORKDIR /opt/agentx
COPY --from=build /opt/agentx/package-lock.json ./package-lock.json
COPY --from=build /opt/agentx/node_modules ./node_modules
COPY --from=build /opt/agentx/packages/contracts ./packages/contracts
COPY --from=build /opt/agentx/packages/verifier ./packages/verifier
COPY --from=android /opt/android-sdk /opt/android-sdk
COPY --from=android /opt/android-avd /opt/android-avd
COPY --from=android /opt/maestro /opt/maestro

# Fail the BUILD, not the first run, when the emulator or adb cannot load: every shared library the headless emulator needs must be found, and the tools must start (no KVM is needed to print a version).
# The emulator's own libraries (emulator/lib64) are found by the `emulator` launcher, which sets LD_LIBRARY_PATH before it starts qemu; the qemu ldd below sets the same one (the first CI run listed 13 of them as not found without it).
RUN test -x /opt/android-sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless && test -x /opt/android-sdk/emulator/emulator && test -x /opt/android-sdk/platform-tools/adb \
    && export LD_LIBRARY_PATH=/opt/android-sdk/emulator/lib64 \
    && ! ldd /opt/android-sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless | grep "not found" \
    && ! ldd /opt/android-sdk/emulator/emulator | grep "not found" \
    && unset LD_LIBRARY_PATH \
    && /opt/android-sdk/emulator/emulator -version | head -n 3 \
    && /opt/android-sdk/platform-tools/adb version \
    && JAVA_HOME=/opt/java /opt/maestro/bin/maestro --version

ENV ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_HOME=/opt/android-sdk ANDROID_AVD_HOME=/opt/android-avd JAVA_HOME=/opt/java NODE_ENV=production HOME=/home/android
ENV MAESTRO_CLI_NO_ANALYTICS=true MAESTRO_DISABLE_UPDATE_CHECK=true
USER android
CMD ["node", "/opt/agentx/packages/verifier/dist/executor/device-evidence-entry.js"]

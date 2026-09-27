# Throwaway probe for issue #55: does the AgentCore Instances runtime permit nested containers?
# Build --platform linux/arm64 to match AGENTX_PRODUCTION_OPERATING_SYSTEM (LINUX_ARM64).
# Deliberately sets no USER: the probe reports the platform's default identity and capabilities.
# Base image by digest from ECR Public, matching environments/base/Dockerfile.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        fuse-overlayfs \
        iptables \
        libcap2-bin \
        podman \
        procps \
        slirp4netns \
        uidmap \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global @devcontainers/cli@0.72.0 && npm cache clean --force

# Podman's image store lives on the workspace volume: it avoids overlay-on-overlay against the
# container's own rootfs, and it is the only writable path that survives session stop/resume.
ENV AGENTX_WORKSPACE_ROOT=/mnt/workspace \
    PROBE_ROOT=/mnt/workspace/.probe \
    CONTAINERS_STORAGE_CONF=/mnt/workspace/.probe/storage.conf \
    PORT=8080

COPY probe.sh /usr/local/bin/probe.sh
COPY server.mjs /usr/local/bin/server.mjs
RUN chmod +x /usr/local/bin/probe.sh

EXPOSE 8080
CMD ["node", "/usr/local/bin/server.mjs"]

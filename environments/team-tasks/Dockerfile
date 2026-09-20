# syntax=docker/dockerfile:1.7
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /opt/agentx
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/broker/package.json packages/broker/package.json
COPY infra/package.json infra/package.json
RUN npm ci --ignore-scripts
COPY packages/contracts packages/contracts
COPY packages/worker packages/worker
RUN npx tsc -b packages/contracts packages/worker --pretty false
RUN npm prune --omit=dev --workspaces

FROM python:3.12.14-slim-bookworm@sha256:eb5be8e5b4d0a159c237946bbdd06356dda5d19c30fc4f7843e8046d3a590333
RUN test "$(uname -m)" = aarch64 && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils libstdc++6 git openssh-client make && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /tmp/bootstrap-node
COPY environments/team-tasks/toolchains.json environments/team-tasks/verify-download.mjs /opt/team-tasks/
RUN for tool in workerNode appNode uv; do \
      url=$(/tmp/bootstrap-node -p "require('/opt/team-tasks/toolchains.json')['$tool'].url"); \
      dest=$(/tmp/bootstrap-node -p "require('/opt/team-tasks/toolchains.json')['$tool'].path"); \
      curl --fail --location --retry 3 "$url" -o /tmp/tool.tar; \
      /tmp/bootstrap-node /opt/team-tasks/verify-download.mjs "$tool" /tmp/tool.tar || exit 1; \
      mkdir -p "$dest" && tar -xf /tmp/tool.tar --strip-components=1 -C "$dest" || exit 1; \
    done && rm /tmp/tool.tar /tmp/bootstrap-node
ENV PATH="/opt/agentx-node/bin:/usr/local/bin:/usr/bin:/bin" \
    PLAYWRIGHT_BROWSERS_PATH=/opt/team-tasks/browsers \
    AGENTX_WORKSPACE_ROOT=/mnt/workspace NODE_ENV=production PORT=8080
COPY environments/team-tasks/browser/package*.json /opt/team-tasks/browser/
RUN cd /opt/team-tasks/browser && npm ci --ignore-scripts && \
    npx playwright install --with-deps chromium && npm cache clean --force && \
    rm -rf /var/lib/apt/lists/* && dpkg-query -W > /opt/team-tasks/os-packages.tsv
WORKDIR /opt/agentx
COPY --from=build /opt/agentx/node_modules ./node_modules
COPY --from=build /opt/agentx/packages/contracts ./packages/contracts
COPY --from=build /opt/agentx/packages/worker ./packages/worker
COPY environments/team-tasks/app-env environments/team-tasks/prepare-app.sh /opt/team-tasks/bin/
COPY environments/team-tasks/check-workspace.mjs environments/team-tasks/smoke.mjs /opt/team-tasks/
RUN chmod 755 /opt/team-tasks/bin/* && /usr/sbin/useradd --create-home --uid 1000 agentx && \
    mkdir -p /mnt/workspace && chown agentx:agentx /mnt/workspace
EXPOSE 8080
USER agentx
CMD ["/opt/agentx-node/bin/node", "/opt/agentx/packages/worker/dist/main.js"]

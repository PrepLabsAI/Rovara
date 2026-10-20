# The browser executor for Rovara's real-Chromium E2E checks (linux/arm64). It runs the pinned e2e
# runner (e2e@0.20.0, @e2e-dev/web@0.14.0) against an application that sits on the same internal
# network; the entrypoint and the smoke check live in packages/verifier/src/executor.
# It never holds credentials: the runtime starts it with every capability dropped and no AWS_*, AGENTX_*,
# PI_*, GIT_* or token variables. The command is a default, so the CI smoke check can replace it.
# Chromium runs with its own sandbox (no --no-sandbox), which needs the pinned seccomp profile
# packages/verifier/assets/executor-seccomp.json: the runtime starts this image with it, and without it Chromium does not start.
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
COPY packages/slack-service/package.json packages/slack-service/package.json
COPY upstream/e2e-0.20.0.tgz upstream/e2e-0.20.0.tgz
COPY infra/package.json infra/package.json
RUN npm ci --ignore-scripts

COPY packages/contracts packages/contracts
COPY packages/verifier packages/verifier
RUN npx tsc -b packages/contracts packages/verifier --pretty false
RUN npm prune --omit=dev --workspaces

FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

WORKDIR /opt/agentx
COPY --from=build /opt/agentx/package-lock.json ./package-lock.json
COPY --from=build /opt/agentx/node_modules ./node_modules
COPY --from=build /opt/agentx/packages/contracts ./packages/contracts
COPY --from=build /opt/agentx/packages/verifier ./packages/verifier

# Chromium and the system libraries it needs, as root. `npm ci --ignore-scripts` ran no install script of
# playwright-core, so the browser comes from this explicit step: npx finds the locked 1.63.0 in node_modules
# and does not download another copy. The browsers live outside any home directory so the unprivileged
# user below reads them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright-core@1.63.0 install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
USER node
CMD ["node", "/opt/agentx/packages/verifier/dist/executor/entry.js"]

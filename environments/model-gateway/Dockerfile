# Cloud model gateway for ECS Fargate (linux/arm64): the one image both the serving tasks (GATEWAY_MODE=serve) and the daily
# price-fetch task (GATEWAY_MODE=price-fetch) run (infra/lib/model-gateway.ts). Built from the context that
# scripts/model-gateway-image.ts assembles (an explicit file list, not the checkout), so nothing else can enter the image.
# The package imports only node: built-ins, so the image holds its compiled output and no node_modules. The compiler is installed
# from environments/model-gateway/toolchain (versions and integrity hashes copied from the root lockfile) in the build stage only.
# No secret is baked in: provider keys are read at run time from Secrets Manager with the task's own role.
# Base image: ECR Public, by digest (the same pin as environments/slack/Dockerfile).
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /build
COPY environments/model-gateway/toolchain/package.json environments/model-gateway/toolchain/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/model-gateway packages/model-gateway
RUN node_modules/.bin/tsc -b packages/model-gateway --pretty false \
    && test -f packages/model-gateway/dist/main.js \
    && find packages/model-gateway/dist \( -name "*.d.ts" -o -name "*.d.ts.map" \) -delete

FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# No package install here: Node carries its own root certificates, so the final image adds nothing to the digest-pinned base but the gateway output.
WORKDIR /opt/gateway
COPY --from=build /build/packages/model-gateway/package.json ./packages/model-gateway/package.json
COPY --from=build /build/packages/model-gateway/dist ./packages/model-gateway/dist

ENV NODE_ENV=production \
    GATEWAY_PORT=8080
# main.js must handle SIGTERM (drain, then exit) and write nothing to disk: the infra gives the container a read-only root filesystem.
# Non-root, the same numeric user infra/lib/model-gateway.ts runs the container as (the base image's `node` user).
USER 1000:1000
EXPOSE 8080
# The load balancer's own check is /healthz (ECS ignores this line); it is for `docker run`. The price-fetch task serves nothing.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "if ((process.env.GATEWAY_MODE ?? 'serve') !== 'serve') process.exit(0); fetch('http://127.0.0.1:' + (process.env.GATEWAY_PORT ?? '8080') + '/healthz', { signal: AbortSignal.timeout(2500) }).then((response) => process.exit(response.status === 200 ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/model-gateway/dist/main.js"]

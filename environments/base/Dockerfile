# The EC2 worker image is built with --platform linux/arm64.
# The production Instances profile controls architecture through its capacity provider.
# Base images come from ECR Public by digest: CodeBuild's shared IPs hit Docker Hub pull limits.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /opt/agentx
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/model-runtime/package.json packages/model-runtime/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/broker/package.json packages/broker/package.json
COPY packages/slack-service/package.json packages/slack-service/package.json
COPY infra/package.json infra/package.json
RUN npm ci --ignore-scripts

COPY packages/model-runtime packages/model-runtime
COPY packages/contracts packages/contracts
COPY packages/worker packages/worker
RUN npx tsc -b packages/contracts packages/worker --pretty false
RUN npm prune --omit=dev --workspaces

# The Docker CLI and Compose plugin, which run a project's devcontainer through the EC2 host's
# Docker (#121). Pinned by checksum; Docker publishes none for its static builds, so those two were
# computed from the downloads.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS tools
ARG TARGETARCH
ARG DOCKER_VERSION=29.8.1
ARG COMPOSE_VERSION=v5.5.1
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) arch=aarch64; docker_sha=667395fbffab52901b80181dfbb39ea76da2fbd7642c4fbddd24e42146b07b48; compose_sha=732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7 ;; \
      amd64) arch=x86_64; docker_sha=d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70; compose_sha=db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576 ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/docker.tgz "https://download.docker.com/linux/static/stable/$arch/docker-$DOCKER_VERSION.tgz"; \
    echo "$docker_sha  /tmp/docker.tgz" | sha256sum -c -; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    curl -fsSL -o /tmp/docker-compose "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-$arch"; \
    echo "$compose_sha  /tmp/docker-compose" | sha256sum -c -; \
    install -D -m 0755 /tmp/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose

FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tools /usr/local/bin/docker /usr/local/bin/docker
COPY --from=tools /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
WORKDIR /opt/agentx
COPY --from=build /opt/agentx/node_modules ./node_modules
COPY --from=build /opt/agentx/packages/model-runtime ./packages/model-runtime
COPY --from=build /opt/agentx/packages/contracts ./packages/contracts
COPY --from=build /opt/agentx/packages/worker ./packages/worker

ENV AGENTX_WORKSPACE_ROOT=/mnt/workspace \
    NODE_ENV=production \
    PORT=8080
EXPOSE 8080
USER node
CMD ["node", "packages/worker/dist/main.js"]

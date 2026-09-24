# Hosted Slack orchestrator for ECS Fargate (linux/arm64). It consumes the Slack request queue and runs the
# Pi orchestrator with AgentX tools and approved MCP tools; coding still runs in the AgentCore worker.
# Base images come from ECR Public by digest: CodeBuild's shared IPs hit Docker Hub pull limits.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /opt/agentx
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/broker/package.json packages/broker/package.json
COPY packages/slack-service/package.json packages/slack-service/package.json
COPY infra/package.json infra/package.json
RUN npm ci --ignore-scripts

COPY packages/contracts packages/contracts
COPY packages/orchestrator packages/orchestrator
COPY packages/slack-service packages/slack-service
RUN npx tsc -b packages/contracts packages/orchestrator packages/slack-service --pretty false
RUN npm prune --omit=dev --workspaces

FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/agentx
COPY --from=build /opt/agentx/node_modules ./node_modules
COPY --from=build /opt/agentx/packages/contracts ./packages/contracts
COPY --from=build /opt/agentx/packages/orchestrator ./packages/orchestrator
COPY --from=build /opt/agentx/packages/slack-service ./packages/slack-service

ENV NODE_ENV=production \
    STATE_DIRECTORY=/tmp/agentx-slack
USER node
CMD ["node", "packages/slack-service/dist/main.js"]

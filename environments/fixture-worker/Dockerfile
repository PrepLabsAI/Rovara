# Isolated fixture worker.
#
# It runs the REAL runTaskInvocation, candidate freezer and artifact/receipt path
# against a deterministic session that only edits files. There is no model client, no
# provider credential and no network: the image cannot reach one even if asked.
#
# The base is pinned by registry digest. The image this Dockerfile produces is a LOCAL
# build; its local image ID is not a distributable registry pin and must not be quoted
# as one.
FROM node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

# The candidate freezer shells out to git, so the image needs it. Nothing else is added.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin fixture

WORKDIR /opt/fixture-worker
# Built worker/contracts/host code and their runtime dependencies. The candidate source
# is NOT baked in: it is streamed per run, so the image is the same for every job.
COPY node_modules ./node_modules
COPY packages ./packages
COPY environments/fixture-worker/run.mjs ./run.mjs

# Scratch is the only writable place the run needs; the orchestrator mounts it as tmpfs.
RUN mkdir -p /scratch && chown fixture:fixture /scratch
USER fixture
ENV NODE_ENV=production
ENTRYPOINT ["node", "/opt/fixture-worker/run.mjs"]

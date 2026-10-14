#!/bin/sh
set -eu

unavailable() {
  printf 'UNAVAILABLE: %s\n' "$1" >&2
  exit 2
}

node22=${AGENTX_NODE22:-}
[ -n "$node22" ] || unavailable 'set AGENTX_NODE22 to the pinned Node 22.23.2 executable'
[ -x "$node22" ] || unavailable 'AGENTX_NODE22 is not an executable file'
node_version=$("$node22" --version 2>/dev/null) || unavailable 'pinned Node executable could not report its version'
[ "$node_version" = 'v22.23.2' ] || unavailable "expected Node v22.23.2, got $node_version"
[ "$("$node22" -p 'process.execPath')" = "$node22" ] || unavailable 'Node executable path did not remain exact'

tmp=${TMPDIR:-}
[ -n "$tmp" ] && [ -d "$tmp" ] || unavailable 'provide a fresh, pre-created TMPDIR'
[ ! -L "$tmp" ] || unavailable 'TMPDIR cannot be a symbolic link'
[ -z "$(find "$tmp" -mindepth 1 -print -quit)" ] || unavailable 'TMPDIR must be empty before Vitest starts'
tmp_owner=$(stat -f '%u' "$tmp" 2>/dev/null || stat -c '%u' "$tmp") || unavailable 'could not verify TMPDIR ownership'
[ "$tmp_owner" = "$(id -u)" ] || unavailable 'TMPDIR must be owned by the current user'
tmp_real=$(cd "$tmp" && pwd -P)

journey=${P0_NATIVE_JOURNEY_TEST:-tests/e2e/p0-native-journey.test.ts}
case "$journey" in
  tests/e2e/p0-native-journey.test.ts|tests/e2e/p0-native-journey-5b.test.ts|tests/unit/e2e-feature-plan-intent.test.ts|tests/unit/e2e-execution-plan.test.ts|tests/unit/e2e-review-fix3.test.ts|tests/contract/e2e-feature-verifier-catalog.test.ts|tests/contract/task-workflow-invocation.test.ts|tests/contract/task-workflow-contracts.test.ts|tests/contract/admin-read-projects.test.ts|tests/contract/admin-actions.test.ts|tests/contract/workflow-e2e-current-authority.test.ts|tests/contract/workflow-e2e-notifier-projection.test.ts|tests/contract/developer-task-notifier.test.ts|tests/contract/workflow-e2e-cancellation.test.ts|tests/contract/loop-candidate-untracked.test.ts|tests/contract/verifier-image-closure.test.ts) ;;
  *) unavailable 'journey test path is outside the fixed P0 acceptance allowlist' ;;
esac
case "$journey" in
  tests/e2e/p0-native-journey.test.ts|tests/e2e/p0-native-journey-5b.test.ts)
    evidence=${CONTAINED_FOUNDATION_EVIDENCE_DIR:-}
    [ -n "$evidence" ] && [ -d "$evidence" ] || unavailable 'pre-create CONTAINED_FOUNDATION_EVIDENCE_DIR outside the fresh TMPDIR'
    evidence_real=$(cd "$evidence" && pwd -P)
    case "$evidence_real/" in "$tmp_real/"*) unavailable 'contained evidence directory must be outside TMPDIR' ;; esac
    command -v docker >/dev/null 2>&1 || unavailable 'Docker CLI is unavailable'
    image='node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9'
    image_info=$(docker image inspect "$image" --format '{{.RepoDigests}} {{.Os}} {{.Architecture}}' 2>/dev/null) || unavailable 'pinned Docker image is unavailable locally; this command never pulls images'
    case "$image_info" in *"$image"*' linux arm64'*) ;; *) unavailable 'local pinned Docker image identity or platform does not match' ;; esac
    ;;
esac

if ! "$node22" node_modules/typescript/bin/tsc -b --force --pretty false; then
  printf 'FAIL: own-source TypeScript emit did not complete\n' >&2
  exit 1
fi
if [ "$journey" = 'tests/e2e/p0-native-journey.test.ts' ] || [ "$journey" = 'tests/e2e/p0-native-journey-5b.test.ts' ]; then
  P0_NATIVE_LAUNCHER_RECEIPT="$evidence_real.launcher-preflight.json" \
    "$node22" --input-type=module -e '
      import { createHash } from "node:crypto";
      import { execFileSync } from "node:child_process";
      import { readFileSync, realpathSync, writeFileSync } from "node:fs";
      import { resolve } from "node:path";
      const expected = realpathSync(resolve("packages/verifier/dist/index.js"));
      const resolved = realpathSync(new URL(import.meta.resolve("@agentx/verifier")));
      const runtimePath = realpathSync(resolve("packages/verifier/dist/runtime-cli.js"));
      const entryBytes = readFileSync(expected);
      const runtimeBytes = readFileSync(runtimePath);
      const runtimeExport = await import("@agentx/verifier");
      if (resolved !== expected || typeof runtimeExport.runE2EActualCli !== "function" || !entryBytes.toString("utf8").includes("./runtime-cli.js")) {
        throw new Error("resolved verifier entry/runtime does not come from the current checkout emitted dist");
      }
      const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
      const receipt = {
        schemaVersion: "p0-native-launcher-preflight/v1",
        sourceRoot: realpathSync(process.cwd()),
        sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        node: { execPath: process.execPath, version: process.version, platform: process.platform, arch: process.arch },
        buildArgv: ["node_modules/typescript/bin/tsc", "-b", "--force", "--pretty", "false"],
        verifier: { resolvedEntry: resolved, entrySha256: sha(entryBytes), runtimeCli: runtimePath, runtimeCliSha256: sha(runtimeBytes) },
        evidenceRoot: realpathSync(process.env.CONTAINED_FOUNDATION_EVIDENCE_DIR),
        tmpDirectory: realpathSync(process.env.TMPDIR),
        dockerHost: process.env.DOCKER_HOST ?? null,
      };
      writeFileSync(process.env.P0_NATIVE_LAUNCHER_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    '
fi
exec "$node22" node_modules/vitest/vitest.mjs run "$journey" --reporter=dot

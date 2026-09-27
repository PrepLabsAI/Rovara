import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { ec2WorkerUserData, type Ec2WorkerBootConfig } from "../../packages/contracts/src/session.js";

// Runs the EC2 boot script for real in a privileged Amazon Linux 2023 container on arm64: a loop
// device stands in for the EBS volume, and mkfs, blkid and mount are the real tools. Only the AWS,
// Docker and systemd boundaries are shims. Opt in with AGENTX_BOOT_SCRIPT_DOCKER=1; it needs Docker
// with privileged containers.
const ENABLED = process.env.AGENTX_BOOT_SCRIPT_DOCKER === "1";
const IMAGE = "agentx-boot-script-test";
const VOLUME_ID = "vol-0123456789abcdef0";
const WORKER_IMAGE = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`;

const HARNESS = String.raw`
set -u
truncate -s 512M /tmp/volume.img
device=$(losetup --find --show /tmp/volume.img)
case "$VOLUME_STATE" in
  existing)
    mkfs.ext4 -q "$device"; mkdir -p /tmp/seed; mount "$device" /tmp/seed
    echo kept > /tmp/seed/work.txt; umount /tmp/seed ;;
  foreign) mkfs.xfs -q "$device" ;;
  blank) ;;
esac
mkdir -p /shims
name=$(basename "$device")
cat > /shims/lsblk <<EOF
#!/bin/bash
echo "$name vol0123456789abcdef0"
EOF
cat > /shims/curl <<'EOF'
#!/bin/bash
case "$*" in
  *api/token*) echo token ;;
  *placement/region*) echo us-east-1 ;;
  *instance-id*) echo i-0123456789abcdef0 ;;
  *) exit 22 ;;
esac
EOF
printf '#!/bin/bash\necho password\n' > /shims/aws
printf '#!/bin/bash\ncat > /dev/null 2>&1 <&0 || true\necho "docker $*" >> /tmp/calls.log\n' > /shims/docker
printf '#!/bin/bash\necho "systemctl $*" >> /tmp/calls.log\n' > /shims/systemctl
printf '#!/bin/bash\necho "dnf $*" >> /tmp/calls.log\nexit 1\n' > /shims/dnf
chmod +x /shims/*
touch /tmp/calls.log /etc/fstab
echo "$USER_DATA_B64" | base64 -d > /tmp/user-data.sh
PATH=/shims:$PATH AGENTX_DEVICE_WAIT_SECONDS=4 bash /tmp/user-data.sh
echo "@@exit=$?"
echo "@@type=$(blkid --probe --output value --match-tag TYPE "$device")"
echo "@@mounted=$(mountpoint -q /mnt/workspace && echo yes || echo no)"
echo "@@owner=$(stat -c %u:%g /mnt/workspace 2>/dev/null)"
echo "@@kept=$(cat /mnt/workspace/work.txt 2>/dev/null)"
echo "@@envmode=$(stat -c %a /etc/agentx/worker.env 2>/dev/null)"
echo "@@fstab"; cat /etc/fstab
echo "@@env"; cat /etc/agentx/worker.env 2>/dev/null
echo "@@unit"; cat /etc/systemd/system/agentx-worker.service 2>/dev/null
echo "@@calls"; cat /tmp/calls.log
umount /mnt/workspace 2>/dev/null; losetup --detach "$device"
`;

function config(overrides: Partial<Ec2WorkerBootConfig> = {}): Ec2WorkerBootConfig {
  return {
    workspaceId: randomUUID(),
    generation: 1,
    volumeId: VOLUME_ID,
    expectNewVolume: true,
    workerImage: WORKER_IMAGE,
    invokePublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
    controlPlaneUrl: "https://control.example.test",
    modelProvider: "amazon-bedrock",
    modelId: "us.anthropic.claude-sonnet-5-v1:0",
    promptCacheRetention: "long",
    logGroupName: "/agentx/production/worker",
    ...overrides,
  };
}

async function boot(bootConfig: Ec2WorkerBootConfig, volumeState: "blank" | "existing" | "foreign") {
  const script = await readFile(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
  const userData = Buffer.from(ec2WorkerUserData(bootConfig, script), "utf8").toString("base64");
  const result = spawnSync("docker", [
    "run", "--rm", "--privileged", "--platform", "linux/arm64",
    "--env", `VOLUME_STATE=${volumeState}`,
    "--env", `USER_DATA_B64=${userData}`,
    IMAGE, "bash", "-c", HARNESS,
  ], { encoding: "utf8", timeout: 120_000 });
  const output = result.stdout;
  const field = (name: string) => new RegExp(`^@@${name}=(.*)$`, "m").exec(output)?.[1] ?? "";
  const section = (name: string) => output.split(`@@${name}\n`)[1]?.split("\n@@")[0] ?? "";
  return {
    exit: Number(field("exit")), type: field("type"), mounted: field("mounted") === "yes", owner: field("owner"),
    kept: field("kept"), envMode: field("envmode"),
    fstab: section("fstab"), env: section("env"), unit: section("unit"), calls: section("calls"), log: result.stderr,
  };
}

describe.skipIf(!ENABLED)("EC2 boot script on arm64", () => {
  beforeAll(() => {
    execFileSync("docker", ["build", "--platform", "linux/arm64", "--tag", IMAGE, "-"], {
      input: "FROM public.ecr.aws/amazonlinux/amazonlinux:2023\nRUN dnf install -y e2fsprogs xfsprogs util-linux procps-ng && dnf clean all && mkdir -p /etc/systemd/system\n",
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 300_000,
    });
  }, 300_000);

  it("formats a new volume, mounts it for the worker user and starts the pinned image", async () => {
    const bootConfig = config();
    const result = await boot(bootConfig, "blank");
    expect(result.exit, result.log).toBe(0);
    expect(result.type).toBe("ext4");
    expect(result.mounted).toBe(true);
    expect(result.owner).toBe("1000:1000");
    expect(result.fstab).toMatch(/^UUID=[0-9a-f-]+ \/mnt\/workspace ext4 defaults,noatime,nofail 0 2$/m);
    expect(result.envMode).toBe("600");
    expect(result.env).toContain(`AGENTX_WORKSPACE_ID=${bootConfig.workspaceId}`);
    expect(result.env).toContain("AGENTX_SESSION_GENERATION=1");
    expect(result.env).toContain(`AGENTX_INVOKE_PUBLIC_KEY=${bootConfig.invokePublicKey}`);
    expect(result.env).toContain("AGENTX_WORKSPACE_ROOT=/mnt/workspace");
    expect(result.env).toContain("AWS_REGION=us-east-1");
    expect(result.unit).toContain("RequiresMountsFor=/mnt/workspace");
    expect(result.unit).toContain("--network host");
    expect(result.unit).toContain(`--log-opt awslogs-stream=${bootConfig.workspaceId}/1/i-0123456789abcdef0`);
    expect(result.unit).toContain(` ${WORKER_IMAGE}\n`);
    expect(result.calls).toContain("docker login --username AWS --password-stdin 111122223333.dkr.ecr.us-east-1.amazonaws.com");
    expect(result.calls).toContain(`docker pull ${WORKER_IMAGE}`);
    expect(result.calls).toContain("systemctl enable --now agentx-worker.service");
  }, 180_000);

  it("mounts an existing volume without formatting it", async () => {
    const result = await boot(config({ generation: 4, expectNewVolume: false }), "existing");
    expect(result.exit, result.log).toBe(0);
    expect(result.kept).toBe("kept");
    expect(result.log).toContain("already has an ext4 filesystem");
    expect(result.log).not.toContain("formatting");
  }, 180_000);

  it("refuses to format a volume that should hold a workspace but has no filesystem", async () => {
    const result = await boot(config({ generation: 2, expectNewVolume: false }), "blank");
    expect(result.exit).not.toBe(0);
    expect(result.log).toMatch(/should hold a workspace but has no filesystem; refusing to format it/);
    expect(result.type).toBe("");
    expect(result.mounted).toBe(false);
    expect(result.calls).not.toContain("docker");
  }, 180_000);

  it("refuses a volume carrying another filesystem, even when a new volume was expected", async () => {
    const result = await boot(config(), "foreign");
    expect(result.exit).not.toBe(0);
    expect(result.log).toMatch(/unexpected signature \(xfs\)/);
    expect(result.type).toBe("xfs");
    expect(result.mounted).toBe(false);
  }, 180_000);

  it("fails when the volume is never attached", async () => {
    const result = await boot(config({ volumeId: "vol-0fffffffffffffff0" }), "blank");
    expect(result.exit).not.toBe(0);
    expect(result.log).toMatch(/was not attached within 4s/);
  }, 180_000);
});

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { ec2WorkerBootScript, type Ec2WorkerBootConfig } from "../../packages/contracts/src/session.js";

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
# The disk view: lsblk shows the root disk, then the volume's disk unless LSBLK_MODE hides it
# ("none") or shows it only once the boot script has rescanned the PCI bus ("after-rescan"). BY_ID
# links the disk under /dev/disk/by-id; SYSFS gives it an NVMe name whose sysfs serial is padded.
# The script reads them under /tmp/host, never the container's own /sys or PCI bus.
cat > /shims/lsblk <<EOF
#!/bin/bash
echo "nvme0n1 vol0aaaaaaaaaaaaaaaa"
case "\$LSBLK_MODE" in
  none) ;;
  after-rescan) [[ "\$(cat /tmp/host/sys/bus/pci/rescan 2>/dev/null)" == 1 ]] && echo "$name vol0123456789abcdef0" ;;
  *) echo "$name vol0123456789abcdef0" ;;
esac
EOF
mkdir -p /tmp/host/sys/block/nvme0n1/device /tmp/host/sys/bus/pci /tmp/host/dev/disk/by-id
# With RESCAN_FAILS, the rescan file is a directory, so writing it fails.
[[ -z "$RESCAN_FAILS" ]] || mkdir /tmp/host/sys/bus/pci/rescan
printf 'vol0aaaaaaaaaaaaaaaa\n' > /tmp/host/sys/block/nvme0n1/device/serial
[[ -z "$BY_ID" ]] || ln -s "$device" /tmp/host/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0
if [[ -n "$SYSFS" ]]; then
  IFS=: read -r major minor < "/sys/class/block/$name/dev"
  mknod /dev/nvme9n1 b "$major" "$minor"
  mkdir -p /tmp/host/sys/block/nvme9n1/device
  printf 'vol0123456789abcdef0    \n' > /tmp/host/sys/block/nvme9n1/device/serial
fi
# The metadata token call fails CURL_FAILURES times before it succeeds.
cat > /shims/curl <<'EOF'
#!/bin/bash
case "$*" in
  *api/token*)
    count=$(( $(cat /tmp/curl.count 2>/dev/null || echo 0) + 1 )); echo "$count" > /tmp/curl.count
    echo "curl token" >> /tmp/calls.log
    (( count > CURL_FAILURES )) || exit 7
    echo token ;;
  *placement/region*) echo us-east-1 ;;
  *instance-id*) echo i-0123456789abcdef0 ;;
  *) exit 22 ;;
esac
EOF
# The registry password call fails every time when AWS_FAILS is set.
printf '#!/bin/bash\necho "aws $*" >> /tmp/calls.log\n[[ -z "$AWS_FAILS" ]] || exit 255\necho password\n' > /shims/aws
# Docker pull fails DOCKER_PULL_FAILURES times before it succeeds.
cat > /tmp/docker-shim <<'EOF'
#!/bin/bash
cat > /dev/null 2>&1 <&0 || true
echo "docker $*" >> /tmp/calls.log
if [[ "$1" == pull ]]; then
  count=$(( $(cat /tmp/pull.count 2>/dev/null || echo 0) + 1 )); echo "$count" > /tmp/pull.count
  (( count > DOCKER_PULL_FAILURES )) || exit 1
fi
EOF
chmod +x /tmp/docker-shim
# Without DNF_FAILURES, Docker is already installed. With it, the docker install fails that many
# times ("always": every time) and then installs the docker shim.
if [[ -z "$DNF_FAILURES" ]]; then cp /tmp/docker-shim /shims/docker; fi
cat > /shims/dnf <<'EOF'
#!/bin/bash
echo "dnf $*" >> /tmp/calls.log
[[ "$1" == install ]] || exit 0
count=$(( $(cat /tmp/dnf.count 2>/dev/null || echo 0) + 1 )); echo "$count" > /tmp/dnf.count
if [[ "$DNF_FAILURES" != always ]] && (( count > DNF_FAILURES )); then cp /tmp/docker-shim /shims/docker; exit 0; fi
exit 1
EOF
# systemctl fails the one call named by SYSTEMCTL_FAILS, such as "restart docker.service".
printf '#!/bin/bash\necho "systemctl $*" >> /tmp/calls.log\n[[ "$*" != "$SYSTEMCTL_FAILS" ]]\n' > /shims/systemctl
printf '#!/bin/bash\necho "udevadm $*" >> /tmp/calls.log\n' > /shims/udevadm
# Records the wait instead of waiting, so the retry backoff costs the test nothing.
printf '#!/bin/bash\necho "sleep $*" >> /tmp/calls.log\n' > /shims/sleep
# Records the transient unit's options and runs its command in the background, as systemd would.
cat > /shims/systemd-run <<'EOF'
#!/bin/bash
options=""
while [[ "$1" == --* ]]; do options="$options $1"; shift; done
echo "systemd-run$options" >> /tmp/calls.log
setsid "$@" > /dev/null 2>&1 < /dev/null &
EOF
chmod +x /shims/*
touch /tmp/calls.log /etc/fstab
# Stands in for the socket the Docker daemon creates; the worker unit reads its group.
mkdir -p /var/run && touch /var/run/docker.sock
echo "$USER_DATA_B64" | base64 -d > /tmp/user-data.sh
# The container is privileged, so AGENTX_HOST_ROOT must stay: without it the script would rescan the
# real PCI bus. The rescan test fails if it goes, since it reads the rescan file under /tmp/host.
PATH=/shims:$PATH AGENTX_HOST_ROOT=/tmp/host bash /tmp/user-data.sh
echo "@@exit=$?"
echo "@@ping=$(python3 - <<'EOF'
import time, urllib.error, urllib.request
for _ in range(50):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/ping", timeout=1) as response:
            print(response.status, response.read().decode()); break
    except urllib.error.HTTPError as error:
        print(error.code, error.read().decode()); break
    except OSError:
        time.sleep(0.1)
else:
    print("unreachable")
EOF
)"
echo "@@rescan=$(cat /tmp/host/sys/bus/pci/rescan 2>/dev/null)"
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

interface Faults {
  dnfFailures?: number | "always";
  pullFailures?: number;
  curlFailures?: number;
  awsFails?: boolean;
  systemctlFails?: string;
  deadlineSeconds?: number;
  /** How lsblk shows the volume's disk: with its serial (the default), not at all, or only after a PCI rescan. */
  lsblk?: "match" | "none" | "after-rescan";
  /** Links the volume's disk under /dev/disk/by-id. */
  byId?: boolean;
  /** Lists the volume's disk in sysfs as nvme9n1, with its serial padded. */
  sysfs?: boolean;
  /** Makes every write to the PCI rescan file fail. */
  rescanFails?: boolean;
}

async function boot(bootConfig: Ec2WorkerBootConfig, volumeState: "blank" | "existing" | "foreign", faults: Faults = {}) {
  const script = await readFile(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
  // The script cloud-init runs once it unpacks the gzip user data (#229).
  const userData = Buffer.from(ec2WorkerBootScript(bootConfig, script), "utf8").toString("base64");
  const result = spawnSync("docker", [
    "run", "--rm", "--privileged", "--platform", "linux/arm64",
    "--env", `VOLUME_STATE=${volumeState}`,
    "--env", `DNF_FAILURES=${faults.dnfFailures ?? ""}`,
    "--env", `DOCKER_PULL_FAILURES=${faults.pullFailures ?? 0}`,
    "--env", `SYSTEMCTL_FAILS=${faults.systemctlFails ?? ""}`,
    "--env", `CURL_FAILURES=${faults.curlFailures ?? 0}`,
    "--env", `AWS_FAILS=${faults.awsFails ? "1" : ""}`,
    "--env", `AGENTX_BOOT_DEADLINE_SECONDS=${faults.deadlineSeconds ?? ""}`,
    "--env", `LSBLK_MODE=${faults.lsblk ?? "match"}`,
    "--env", `BY_ID=${faults.byId ? "1" : ""}`,
    "--env", `SYSFS=${faults.sysfs ? "1" : ""}`,
    "--env", `RESCAN_FAILS=${faults.rescanFails ? "1" : ""}`,
    "--env", `USER_DATA_B64=${userData}`,
    IMAGE, "bash", "-c", HARNESS,
  ], { encoding: "utf8", timeout: 120_000 });
  const output = result.stdout;
  const field = (name: string) => new RegExp(`^@@${name}=(.*)$`, "m").exec(output)?.[1] ?? "";
  const section = (name: string) => output.split(`@@${name}\n`)[1]?.split(/(?:^|\n)@@/)[0] ?? "";
  const calls = section("calls");
  return {
    exit: Number(field("exit")), type: field("type"), mounted: field("mounted") === "yes", owner: field("owner"),
    kept: field("kept"), envMode: field("envmode"), ping: field("ping"), rescan: field("rescan"),
    fstab: section("fstab"), env: section("env"), unit: section("unit"), calls, log: result.stderr,
    sleeps: calls.split("\n").filter((line) => line.startsWith("sleep ")).map((line) => Number(line.slice("sleep ".length))),
    count: (call: string) => calls.split("\n").filter((line) => line === call).length,
  };
}

/** What the instance answers on /ping after a failed boot, for the provisioner's probe. */
const bootFailedPing = (reason: string) => `503 ${JSON.stringify({ status: "BootFailed", reason })}`;

/** The waits between tries: each doubles from 2 seconds, plus up to half of it as jitter. */
function expectBackoff(sleeps: number[], retries: number) {
  expect(sleeps).toHaveLength(retries);
  sleeps.forEach((wait, index) => {
    const base = 2 ** (index + 1);
    expect(wait).toBeGreaterThanOrEqual(base);
    expect(wait).toBeLessThanOrEqual(base * 1.5);
  });
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
    // A healthy boot neither waits nor reports a failure: /ping is left to the worker.
    expect(result.sleeps).toEqual([]);
    expect(result.calls).not.toContain("systemd-run");
    expect(result.calls).not.toContain("dnf");
    expect(result.ping).toBe("unreachable");
    expect(result.log).not.toContain("retrying");
    // lsblk finds the disk at once, so the PCI bus is never rescanned.
    expect(result.rescan).toBe("");
    expect(result.calls).not.toContain("udevadm");
    expect(result.log).not.toContain("rescan");
    expect(result.log).toMatch(/formatting new volume vol-0123456789abcdef0 \(\/dev\/loop\d+\) as ext4/);
  }, 180_000);

  it("retries a failing Docker install with growing waits and boots once it succeeds", async () => {
    const result = await boot(config(), "blank", { dnfFailures: 2 });
    expect(result.exit, result.log).toBe(0);
    expect(result.count("dnf install -y docker")).toBe(3);
    expectBackoff(result.sleeps, 2);
    expect(result.log).toMatch(/agentx-boot: could not install Docker: package download failed \(try 1 of 5\); retrying in [23]s/);
    expect(result.log).toMatch(/agentx-boot: could not install Docker: package download failed \(try 2 of 5\); retrying in [4-6]s/);
    expect(result.calls).toContain(`docker pull ${WORKER_IMAGE}`);
    expect(result.calls).toContain("systemctl enable --now agentx-worker.service");
    expect(result.calls).not.toContain("systemd-run");
    expect(result.ping).toBe("unreachable");
  }, 180_000);

  it("gives up on the Docker install after 5 tries and reports why on /ping", async () => {
    const result = await boot(config(), "blank", { dnfFailures: "always" });
    expect(result.exit).not.toBe(0);
    expect(result.count("dnf install -y docker")).toBe(5);
    expectBackoff(result.sleeps, 4);
    expect(result.log).toContain("agentx-boot: FAILED: could not install Docker: package download failed after 5 tries");
    expect(result.calls).not.toContain("docker pull");
    expect(result.unit).toBe("");
    expect(result.count("systemd-run --unit=agentx-boot-failure --collect --property=Type=notify")).toBe(1);
    expect(result.ping).toBe(bootFailedPing("could not install Docker: package download failed after 5 tries"));
  }, 180_000);

  it("stops retrying at the boot deadline and reports it", async () => {
    // The first wait (2 or 3 seconds) would pass a 2 second deadline, so the boot fails at once.
    const result = await boot(config(), "blank", { dnfFailures: "always", deadlineSeconds: 2 });
    expect(result.exit).not.toBe(0);
    expect(result.count("dnf install -y docker")).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.ping).toBe(bootFailedPing("could not install Docker: package download failed after 1 try, out of time"));
  }, 180_000);

  it("retries a failing instance metadata read and boots once it succeeds", async () => {
    const result = await boot(config(), "blank", { curlFailures: 1 });
    expect(result.exit, result.log).toBe(0);
    expect(result.count("curl token")).toBe(3);
    expectBackoff(result.sleeps, 1);
    expect(result.log).toMatch(/could not read the instance's placement\/region from instance metadata \(try 1 of 5\); retrying in [23]s/);
    expect(result.env).toContain("AWS_REGION=us-east-1\n");
    expect(result.unit).toContain("awslogs-stream=");
  }, 180_000);

  it("gives up on the registry login after 5 tries and reports why on /ping", async () => {
    const result = await boot(config(), "blank", { awsFails: true });
    expect(result.exit).not.toBe(0);
    expect(result.count("aws ecr get-login-password --region us-east-1")).toBe(5);
    expectBackoff(result.sleeps, 4);
    expect(result.calls).not.toContain("docker pull");
    expect(result.log).not.toContain("password\n");
    expect(result.ping).toBe(bootFailedPing("could not log in to the worker image registry after 5 tries"));
  }, 180_000);

  it("retries a failing image pull and boots once it succeeds", async () => {
    const result = await boot(config(), "blank", { pullFailures: 1 });
    expect(result.exit, result.log).toBe(0);
    expect(result.count(`docker pull ${WORKER_IMAGE}`)).toBe(2);
    expectBackoff(result.sleeps, 1);
    expect(result.log).toMatch(/could not download the worker image \(try 1 of 5\); retrying in [23]s/);
    expect(result.calls).toContain("systemctl enable --now agentx-worker.service");
    expect(result.ping).toBe("unreachable");
  }, 180_000);

  it("gives up on the image pull after 5 tries and reports why on /ping", async () => {
    const result = await boot(config(), "blank", { pullFailures: 99 });
    expect(result.exit).not.toBe(0);
    expect(result.count(`docker pull ${WORKER_IMAGE}`)).toBe(5);
    expectBackoff(result.sleeps, 4);
    expect(result.unit).toBe("");
    expect(result.ping).toBe(bootFailedPing("could not download the worker image after 5 tries"));
  }, 180_000);

  it("mounts an existing volume without formatting it", async () => {
    const result = await boot(config({ generation: 4, expectNewVolume: false }), "existing");
    expect(result.exit, result.log).toBe(0);
    expect(result.kept).toBe("kept");
    expect(result.log).toContain("already has an ext4 filesystem");
    expect(result.log).not.toContain("formatting");
  }, 180_000);

  it("reports the step that stopped the boot when a command fails without a reason of its own", async () => {
    const result = await boot(config(), "blank", { systemctlFails: "restart docker.service" });
    expect(result.exit).not.toBe(0);
    expect(result.log).toContain("agentx-boot: FAILED: the boot stopped while trying to set up Docker (exit status 1)");
    expect(result.sleeps).toEqual([]);
    expect(result.ping).toBe(bootFailedPing("the boot stopped while trying to set up Docker (exit status 1)"));
  }, 180_000);

  it("refuses to format a volume that should hold a workspace but has no filesystem", async () => {
    const result = await boot(config({ generation: 2, expectNewVolume: false }), "blank");
    expect(result.exit).not.toBe(0);
    expect(result.log).toMatch(/should hold a workspace but has no filesystem; refusing to format it/);
    expect(result.type).toBe("");
    expect(result.mounted).toBe(false);
    expect(result.calls).not.toContain("docker");
    expect(result.ping).toBe(bootFailedPing(`volume ${VOLUME_ID} should hold a workspace but has no filesystem; refusing to format it`));
  }, 180_000);

  it("refuses a volume carrying another filesystem, even when a new volume was expected", async () => {
    const result = await boot(config(), "foreign");
    expect(result.exit).not.toBe(0);
    expect(result.log).toMatch(/unexpected signature \(xfs\)/);
    expect(result.type).toBe("xfs");
    expect(result.mounted).toBe(false);
  }, 180_000);

  it("finds the volume's disk through /dev/disk/by-id when lsblk shows no serial for it (#223)", async () => {
    const result = await boot(config(), "blank", { lsblk: "none", byId: true });
    expect(result.exit, result.log).toBe(0);
    expect(result.log).toMatch(/formatting new volume vol-0123456789abcdef0 \(\/dev\/loop\d+\) as ext4/);
    expect(result.mounted).toBe(true);
    expect(result.sleeps).toEqual([]);
    expect(result.rescan).toBe("");
    expect(result.calls).toContain("systemctl enable --now agentx-worker.service");
  }, 180_000);

  it("finds the volume's disk through its padded sysfs serial when lsblk and by-id miss it (#223)", async () => {
    const result = await boot(config(), "blank", { lsblk: "none", sysfs: true });
    expect(result.exit, result.log).toBe(0);
    expect(result.log).toContain("formatting new volume vol-0123456789abcdef0 (/dev/nvme9n1) as ext4");
    expect(result.mounted).toBe(true);
    expect(result.sleeps).toEqual([]);
    expect(result.rescan).toBe("");
    expect(result.calls).toContain("systemctl enable --now agentx-worker.service");
  }, 180_000);

  it("rescans the PCI bus after 20 seconds and finds a disk the kernel missed (#223)", async () => {
    const result = await boot(config(), "blank", { lsblk: "after-rescan" });
    expect(result.exit, result.log).toBe(0);
    // Ten 2 second waits (20 seconds), one rescan, then the disk is there.
    expect(result.sleeps).toEqual(Array(10).fill(2));
    expect(result.rescan).toBe("1");
    expect(result.count("udevadm settle --timeout=10")).toBe(1);
    expect(result.log).toContain(
      "agentx-boot: workspace disk vol-0123456789abcdef0 has not appeared after 20s; rescanning the PCI bus (1 of 3)",
    );
    expect(result.mounted).toBe(true);
    expect(result.calls).toContain("systemctl enable --now agentx-worker.service");
    expect(result.ping).toBe("unreachable");
  }, 180_000);

  it("fails after 120 seconds and 3 rescans when the disk never appears, saying what it saw (#223)", async () => {
    const result = await boot(config({ volumeId: "vol-0fffffffffffffff0" }), "blank");
    const reason = "workspace disk vol-0fffffffffffffff0 is attached in AWS but did not appear on this machine after 120s (rescanned 3 times)";
    expect(result.exit).not.toBe(0);
    expect(result.sleeps).toEqual(Array(60).fill(2));
    expect(result.count("udevadm settle --timeout=10")).toBe(3);
    expect(result.log).toContain("has not appeared after 20s; rescanning the PCI bus (1 of 3)");
    expect(result.log).toContain("has not appeared after 50s; rescanning the PCI bus (2 of 3)");
    expect(result.log).toContain("has not appeared after 80s; rescanning the PCI bus (3 of 3)");
    // What the machine did see, so an operator can tell a missing disk from a mismatched one.
    expect(result.log).toContain("agentx-boot: lsblk saw: nvme0n1 vol0aaaaaaaaaaaaaaaa\n");
    expect(result.log).toMatch(/agentx-boot: lsblk saw: loop\d+ vol0123456789abcdef0\n/);
    expect(result.log).toContain("agentx-boot: sysfs saw: nvme0n1 vol0aaaaaaaaaaaaaaaa\n");
    expect(result.log).toContain(`agentx-boot: FAILED: ${reason}\n`);
    expect(result.mounted).toBe(false);
    expect(result.calls).not.toContain("docker");
    // Reported once, although fail ran in a command substitution's subshell.
    expect(result.count("systemd-run --unit=agentx-boot-failure --collect --property=Type=notify")).toBe(1);
    expect(result.ping).toBe(bootFailedPing(reason));
  }, 180_000);

  it("says so when the PCI rescan cannot be written, and does not count it as a rescan (#223)", async () => {
    const result = await boot(config({ volumeId: "vol-0fffffffffffffff0" }), "blank", { rescanFails: true });
    const reason = "workspace disk vol-0fffffffffffffff0 is attached in AWS but did not appear on this machine after 120s (rescanned 0 times)";
    expect(result.exit).not.toBe(0);
    expect(result.sleeps).toEqual(Array(60).fill(2));
    expect(result.log.split("\n").filter((line) => line === "agentx-boot: could not rescan the PCI bus")).toHaveLength(3);
    expect(result.count("udevadm settle --timeout=10")).toBe(3);
    expect(result.ping).toBe(bootFailedPing(reason));
  }, 180_000);
});

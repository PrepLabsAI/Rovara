// DEC 254zm: the EC2 worker's test-services stage (packages/worker/ec2/test-services-stage.sh) and boot.sh's hook, run in bash with fake host commands. Every path the stage writes as root is
// replaced by a temporary one; every line that decides something runs as written.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mirroredStarterEntries } from "../../packages/contracts/src/test-service-mirror.js";
import { parseBootFacts } from "../../packages/worker/src/test-services-report.js";

const stage = readFileSync(new URL("../../packages/worker/ec2/test-services-stage.sh", import.meta.url), "utf8");
const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const WORKER_IMAGE = `${REGISTRY}/agentx-staging/worker@sha256:${"a".repeat(64)}`;
const references = mirroredStarterEntries(REGISTRY, "staging").map((entry) => entry.reference);

interface Host {
  dir: string;
  envFile: string;
  runDir: string;
  calls: string;
  rules: string;
  rules6: string;
  pulled: string;
  units: string;
  restore: string;
  daemon: string;
}

/** A fake host: iptables with a rules file, mounts as marker files, docker answering the stage's calls. Options turn single steps into failures. */
function host(options: { failDockerRestart?: boolean; failPull?: RegExp; failAllPulls?: boolean; failLogin?: boolean; failIp6Insert?: boolean; noMetadataBlock?: boolean; refs?: string[]; list?: string } = {}): Host {
  const dir = mkdtempSync(join(tmpdir(), "ts-stage-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const h: Host = {
    dir, envFile: join(dir, "worker.env"), runDir: join(dir, "run-agentx-test-services"), calls: join(dir, "calls.log"), rules: join(dir, "rules"), rules6: join(dir, "rules6"),
    pulled: join(dir, "pulled"), units: join(dir, "systemd"), restore: join(dir, "restore.sh"), daemon: join(dir, "daemon.json"),
  };
  mkdirSync(h.units);
  writeFileSync(h.envFile, "AWS_REGION=us-west-2\nAGENTX_SANDBOX_IMAGE=x\n");
  writeFileSync(h.rules, options.noMetadataBlock === true ? "" : "DOCKER-USER -d 169.254.169.254/32 -j DROP\n");
  writeFileSync(h.rules6, "");
  writeFileSync(h.pulled, "");
  writeFileSync(join(dir, "refs"), `${(options.refs ?? references).join("\n")}\n`);
  writeFileSync(join(dir, "list"), `${options.list ?? JSON.stringify(mirroredStarterEntries(REGISTRY, "staging"))}\n`);
  writeFileSync(join(dir, "firewall"), "exit 0\n");
  // boot.sh's ensure_docker wrote this before the stage runs.
  writeFileSync(h.daemon, '{"data-root": "/mnt/workspace/.docker"}\n');
  const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\nprintf '%s %s\\n' "${name}" "$*" >>"${h.calls}"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const table = (file: string, failInsert: boolean) => `case "$1" in
  -C) shift; grep -qxF -- "$*" "${file}" ;;
  -I) shift; ${failInsert ? "exit 1" : `printf '%s\\n' "$*" >>"${file}"`} ;;
  -S) grep "^$2 " "${file}" | sed 's/^/-A /'; exit 0 ;;
  *) exit 1 ;;
esac`;
  fake("iptables", table(h.rules, false));
  fake("ip6tables", table(h.rules6, options.failIp6Insert === true));
  fake("timeout", 'while [[ "$1" == -* ]]; do shift; done; shift; exec "$@"');
  fake("install", 'for last; do :; done; [[ "$*" == *-d* ]] && mkdir -p "$last"; exit 0');
  fake("mount", 'for last; do :; done; touch "$last/.mounted"');
  fake("umount", 'rm -f "$1/.mounted"');
  fake("mountpoint", 'test -e "$2/.mounted"');
  // With failDockerRestart, Docker does not come back on the stage's daemon.json (it does on the original one).
  fake("systemctl", options.failDockerRestart === true ? `[[ "$*" == "restart docker.service" ]] && grep -q default-address-pools "${h.daemon}" && exit 1; exit 0` : "exit 0");
  fake("aws", "printf 'password\\n'");
  const failPull = options.failAllPulls === true ? "1" : options.failPull === undefined ? "" : options.failPull.source;
  fake("docker", `case "$1" in
  run) for a; do :; done
       case " $* " in *" refs "*) cat "${join(dir, "refs")}" ;; *" list "*) cat "${join(dir, "list")}" ;; *) exit 1 ;; esac ;;
  login) cat >/dev/null; ${options.failLogin === true ? "exit 1" : "exit 0"} ;;
  logout) exit 0 ;;
  pull) ${failPull === "1" ? "exit 1" : failPull === "" ? ":" : `[[ "$2" =~ ${failPull} ]] && exit 1`}; printf '%s\\n' "$2" >>"${h.pulled}" ;;
  image) grep -qxF -- "$3" "${h.pulled}" ;;
  version) printf '25.0.8\\n' ;;
  *) exit 1 ;;
esac`);
  return h;
}

/** The stage's text with the root-owned paths moved into the fake host. */
function stageFor(h: Host): string {
  return stage
    .split("/run/agentx-test-services").join(h.runDir)
    .split("/usr/local/libexec/rovara-test-services-restore").join(h.restore)
    .split("/etc/systemd/system").join(h.units)
    .split("/etc/docker/daemon.json").join(h.daemon)
    .split("/usr/local/libexec/rovara-container-firewall").join(join(h.dir, "firewall"));
}

function runStage(h: Host, environment: Record<string, string> = {}): { status: number | null; stderr: string } {
  const program = `set -uo pipefail
log() { printf 'agentx-boot: %s\\n' "$*" >&2; }
try_seconds() { printf '%s\\n' "$1"; }
WORKER_ENV_FILE=${h.envFile}; WORKER_UID=$(id -u); WORKER_GID=$(id -g); WORKER_UNIT=agentx-worker.service; FIREWALL_UNIT=rovara-container-firewall.service; DOCKER_DATA_ROOT=/mnt/workspace/.docker
BOOT_DEADLINE=$((SECONDS + 480))
${stageFor(h)}
test_services_stage_main us-west-2`;
  const ran = spawnSync("bash", ["-c", program], { encoding: "utf8", env: { PATH: `${join(h.dir, "bin")}:${process.env.PATH ?? ""}`, AGENTX_WORKER_IMAGE: WORKER_IMAGE, AGENTX_LOG_GROUP: "/agentx/staging/worker", ...environment } });
  return { status: ran.status, stderr: ran.stderr };
}

const envLines = (h: Host): string[] => readFileSync(h.envFile, "utf8").split("\n").filter((line) => line !== "");
const factsOf = (h: Host) => parseBootFacts(envLines(h).find((line) => line.startsWith("AGENTX_TEST_SERVICES_BOOT_FACTS="))?.slice("AGENTX_TEST_SERVICES_BOOT_FACTS=".length));
const mounted = (h: Host): boolean => existsSync(join(h.runDir, ".mounted"));
const calls = (h: Host): string[] => (existsSync(h.calls) ? readFileSync(h.calls, "utf8").split("\n").filter((line) => line !== "") : []);

describe("the test-services stage on a worker", () => {

  it.each([
    ["every pull fails", { failAllPulls: true }, { prepull: "failed", prepulled: 0 }],
  ] as const)("withholds test services when %s: no owner list, the run directory unmounted, `all` written, and the stage reports a failure the boot only logs", (_name, options, facts) => {
    const h = host(options);
    const result = runStage(h);
    expect(result.status).not.toBe(0);
    const lines = envLines(h);
    expect(lines.some((line) => line.startsWith("AGENTX_TEST_SERVICES_OWNER_IMAGES="))).toBe(false);
    expect(lines).toContain("AGENTX_TEST_SERVICES_NOT_PULLED=all");
    expect(mounted(h)).toBe(false);
    expect(factsOf(h)).toMatchObject(facts);
    if (options === undefined || !("failAllPulls" in options)) expect(calls(h).some((line) => line.startsWith("docker pull"))).toBe(false);
  });

  it("withholds test services, pulling nothing, when the IPv6 drop into the host cannot be added, and says why in the boot facts", () => {
    const h = host({ failIp6Insert: true });
    const result = runStage(h);
    expect(result.status).not.toBe(0);
    expect(envLines(h)).toContain("AGENTX_TEST_SERVICES_NOT_PULLED=all");
    expect(factsOf(h)).toMatchObject({ ipv6Drops: false, ipv6DropsReason: "rule-not-added" });
    expect(calls(h).some((line) => line.startsWith("docker pull") || line.startsWith("docker login"))).toBe(false);
    expect(mounted(h)).toBe(false);
  });


  it("refuses an owner list that is not one line of entries, and withholds", () => {
    const h = host({ list: "not json" });
    expect(runStage(h).status).not.toBe(0);
    expect(envLines(h).some((line) => line.startsWith("AGENTX_TEST_SERVICES_OWNER_IMAGES="))).toBe(false);
    expect(envLines(h)).toContain("AGENTX_TEST_SERVICES_NOT_PULLED=all");
  });

});

describe("boot.sh's test-services hook", () => {

  it("runs the stage only with AGENTX_TEST_SERVICES=1, after the worker environment and unit are written and before the worker starts, and a failure is only logged", () => {
    expect(bootScript).toContain('[[ ${AGENTX_TEST_SERVICES:-} != 1 ]] || test_services_stage "$region" || log "no test services on this worker (not fatal)"');
    const hook = bootScript.indexOf("test_services_stage \"$region\"");
    expect(bootScript.indexOf('write_worker_unit "$region" "$instance_id"\n')).toBeLessThan(hook);
    expect(hook).toBeLessThan(bootScript.indexOf('systemctl enable --now "$WORKER_UNIT"'));
  });

  it("copies the stage out of the digest-pinned worker image with no network, no capability and a read-only root, and runs it only when the copy worked", () => {
    const start = bootScript.indexOf("\ntest_services_stage() {");
    const body = bootScript.slice(start, bootScript.indexOf("\n}\n", start));
    expect(body).toContain('docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint cat "$AGENTX_WORKER_IMAGE" /opt/agentx/packages/worker/ec2/test-services-stage.sh >"$f" && . "$f" && test_services_stage_main "$1"');
    // Run with a docker that cannot copy: the stage is not sourced, the function fails, nothing else runs.
    const dir = mkdtempSync(join(tmpdir(), "ts-hook-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), "#!/bin/bash\nexit 1\n");
    writeFileSync(join(bin, "timeout"), '#!/bin/bash\nshift; exec "$@"\n');
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "timeout"), 0o755);
    const program = `try_seconds() { printf '%s\\n' "$1"; }\ntest_services_stage_main() { echo SOURCED; }\n${body.split("/run/agentx-ts-stage.sh").join(join(dir, "stage.sh"))}\n}\ntest_services_stage us-west-2`;
    const ran = spawnSync("bash", ["-c", program], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTX_WORKER_IMAGE: WORKER_IMAGE } });
    expect(ran.status).not.toBe(0);
    expect(ran.stdout).not.toContain("SOURCED");
  });

  it("gives the worker the run directory only while it is mounted", () => {
    expect(bootScript).toContain("t=/run/agentx-test-services; ! mountpoint -q $t || args+=(--volume $t:$t --env AGENTX_TEST_SERVICES_RUN_DIR=$t)");
  });

  it("ships the stage in the worker image: the image build copies packages/worker whole and nothing ignores the ec2 folder", () => {
    expect(readFileSync(new URL("../../environments/base/Dockerfile", import.meta.url), "utf8")).toContain("COPY --from=build /opt/agentx/packages/worker ./packages/worker");
    expect(readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8")).not.toMatch(/ec2|\.sh/u);
    expect(spawnSync("bash", ["-n"], { input: stage, encoding: "utf8" }).status).toBe(0);
  });
});

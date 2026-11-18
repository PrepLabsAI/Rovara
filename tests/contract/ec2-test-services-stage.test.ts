// DEC 254zm: the EC2 worker's test-services stage (packages/worker/ec2/test-services-stage.sh) and boot.sh's hook, run in bash with fake host commands. Every path the stage writes as root is
// replaced by a temporary one; every line that decides something runs as written.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gcpPackWorkerEntries, mirroredStarterEntries } from "../../packages/contracts/src/test-service-mirror.js";
import { ec2WorkerBootScript, type Ec2WorkerBootConfig } from "../../packages/contracts/src/session.js";
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
function host(options: { failDockerRestart?: boolean; failPull?: RegExp; failAllPulls?: boolean; failLogin?: boolean; failIp6Insert?: boolean; noMetadataBlock?: boolean; refs?: string[]; list?: string; packRefs?: string[]; packList?: string } = {}): Host {
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
  // L4-E8I: what the worker image's CLI prints for `pack-refs` and `pack-list` (only asked for while the pack setting is on).
  writeFileSync(join(dir, "packrefs"), `${(options.packRefs ?? []).join("\n")}\n`);
  writeFileSync(join(dir, "packlist"), `${options.packList ?? "[]"}\n`);
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
       case " $* " in *" pack-refs "*) cat "${join(dir, "packrefs")}" ;; *" pack-list "*) cat "${join(dir, "packlist")}" ;; *" refs "*) cat "${join(dir, "refs")}" ;; *" list "*) cat "${join(dir, "list")}" ;; *) exit 1 ;; esac ;;
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
  it("pulls the install's five starter copies by digest with one login that it removes, walls the run networks, mounts the run directory and hands the worker the owner list, its own image and the boot facts", () => {
    const h = host();
    const result = runStage(h);
    expect(result.status, result.stderr).toBe(0);
    const lines = envLines(h);
    expect(lines).toContain(`AGENTX_WORKER_IMAGE=${WORKER_IMAGE}`);
    expect(lines).toContain(`AGENTX_TEST_SERVICES_OWNER_IMAGES=${JSON.stringify(mirroredStarterEntries(REGISTRY, "staging"))}`);
    expect(lines.some((line) => line.startsWith("AGENTX_TEST_SERVICES_NOT_PULLED="))).toBe(false);
    expect(factsOf(h)).toEqual({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "ok", prepulled: 5, loggedOut: true, dockerVersion: "25.0.8" });
    expect(readFileSync(h.pulled, "utf8").trim().split("\n").sort()).toEqual([...references].sort());
    expect(readFileSync(h.rules, "utf8")).toContain("DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP");
    expect(readFileSync(h.rules6, "utf8").split("\n")).toEqual(expect.arrayContaining(["INPUT -i rvb+ -j DROP", "INPUT -i rvi+ -j DROP"]));
    expect(mounted(h)).toBe(true);
    const daemon = JSON.parse(readFileSync(h.daemon, "utf8")) as { "data-root": string; "default-address-pools": Array<{ base: string }> };
    expect(daemon["data-root"]).toBe("/mnt/workspace/.docker");
    expect(daemon["default-address-pools"].map((pool) => pool.base).some((base) => base.startsWith("172.29.") || base.startsWith("172.30.") || base.startsWith("10."))).toBe(false);
    // The worker image is read with no network, no capability and a read-only root; the login comes before the pulls and the logout after them.
    const log = calls(h);
    const runs = log.filter((line) => line.startsWith("docker run"));
    expect(runs.length).toBe(2);
    for (const line of runs) expect(line).toContain(`--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node ${WORKER_IMAGE} /opt/agentx/packages/worker/dist/test-services-mirror-cli.js`);
    const login = log.findIndex((line) => line.startsWith("docker login"));
    const firstPull = log.findIndex((line) => line.startsWith("docker pull"));
    const lastPull = log.map((line) => line.startsWith("docker pull")).lastIndexOf(true);
    expect(login).toBeGreaterThan(-1);
    expect(login).toBeLessThan(firstPull);
    expect(log.findIndex((line, index) => index > lastPull && line.startsWith("docker logout"))).toBeGreaterThan(-1);
    for (const line of log.filter((entry) => entry.startsWith("docker pull"))) expect(line).toMatch(/@sha256:[a-f0-9]{64}$/u);
    // The restore unit runs before the worker; the worker only wants it (a failure there never stops the worker).
    expect(readFileSync(join(h.units, "rovara-test-services.service"), "utf8")).toContain("Before=agentx-worker.service");
    expect(readFileSync(join(h.units, "agentx-worker.service.d", "20-test-services.conf"), "utf8")).toBe("[Unit]\nWants=rovara-test-services.service\nAfter=rovara-test-services.service\n");
  });

  it("partial pulls: the owner list holds exactly the copies that arrived, and the facts say partial", () => {
    const h = host({ failPull: /mysql/u });
    const result = runStage(h);
    expect(result.status, result.stderr).toBe(0);
    const list = calls(h).find((line) => line.startsWith("docker run") && line.includes(" list "))!;
    const named = list.slice(list.indexOf(" list ") + 6).split(" ").slice(2);
    expect(named.sort()).toEqual(references.filter((reference) => !reference.includes("mysql")).sort());
    expect(factsOf(h)).toMatchObject({ prepull: "partial", prepulled: 4 });
    expect(mounted(h)).toBe(true);
  });

  it.each([
    ["every pull fails", { failAllPulls: true }, { prepull: "failed", prepulled: 0 }],
    ["the registry login fails", { failLogin: true }, { prepull: "failed", prepulled: 0 }],
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

  it("Docker not coming back on the new address pools: the original daemon.json is put back and Docker restarted on it (the worker still needs Docker), and test services are withheld", () => {
    const h = host({ failDockerRestart: true });
    expect(runStage(h).status).not.toBe(0);
    expect(readFileSync(h.daemon, "utf8")).toBe('{"data-root": "/mnt/workspace/.docker"}\n');
    expect(existsSync(`${h.daemon}.before-test-services`)).toBe(false);
    expect(calls(h).filter((line) => line === "systemctl restart docker.service")).toHaveLength(2);
    const log = calls(h);
    expect(log.indexOf("systemctl reset-failed docker.service")).toBeGreaterThan(log.indexOf("systemctl restart docker.service"));
    expect(log.indexOf("systemctl reset-failed docker.service")).toBeLessThan(log.lastIndexOf("systemctl restart docker.service"));
    expect(envLines(h)).toContain("AGENTX_TEST_SERVICES_NOT_PULLED=all");
    expect(calls(h).some((line) => line.startsWith("docker pull"))).toBe(false);
  });

  it("withholds test services, pulling nothing, when the metadata block is not in place after Docker's restart", () => {
    const h = host({ noMetadataBlock: true });
    expect(runStage(h).status).not.toBe(0);
    expect(envLines(h)).toContain("AGENTX_TEST_SERVICES_NOT_PULLED=all");
    expect(calls(h).some((line) => line.startsWith("docker pull"))).toBe(false);
  });

  it("takes only references of the fixed form for THIS registry and environment, and with none it changes nothing on the host", () => {
    const h = host({ refs: [`docker.io/library/postgres@sha256:${"1".repeat(64)}`, `${REGISTRY}/agentx-prod--test-services/postgres-16/postgres@sha256:${"2".repeat(64)}`, `${REGISTRY}/agentx-staging--test-services/postgres-16/postgres:16`, `999988887777.dkr.ecr.us-west-2.amazonaws.com/agentx-staging--test-services/postgres-16/postgres@sha256:${"3".repeat(64)}`] });
    expect(runStage(h).status).not.toBe(0);
    expect(envLines(h)).toEqual(["AWS_REGION=us-west-2", "AGENTX_SANDBOX_IMAGE=x"]);
    expect(readFileSync(h.daemon, "utf8")).toBe('{"data-root": "/mnt/workspace/.docker"}\n');
    expect(calls(h).some((line) => line.startsWith("docker pull") || line.startsWith("systemctl"))).toBe(false);
  });

  it("takes at most nine references, whatever the worker image prints", () => {
    const many = Array.from({ length: 12 }, (_, index) => `${REGISTRY}/agentx-staging--test-services/postgres-${String(index + 10)}/postgres@sha256:${String(index % 10).repeat(64)}`);
    const h = host({ refs: many });
    expect(runStage(h).status).toBe(0);
    expect(readFileSync(h.pulled, "utf8").trim().split("\n")).toHaveLength(9);
  });

  it("pulls only the references that passed, when the worker image names some others too", () => {
    const h = host({ refs: [...references.slice(0, 2), `docker.io/library/redis@sha256:${"4".repeat(64)}`] });
    expect(runStage(h).status).toBe(0);
    expect(readFileSync(h.pulled, "utf8").trim().split("\n").sort()).toEqual(references.slice(0, 2).sort());
  });

  it.each([
    ["a worker image outside this account's ECR", { AGENTX_WORKER_IMAGE: `docker.io/library/node@sha256:${"a".repeat(64)}` }],
    ["a log group that is not a named environment's", { AGENTX_LOG_GROUP: "/agentx/staging/other" }],
    ["an environment name that is not one", { AGENTX_LOG_GROUP: "/agentx/Staging_1/worker" }],
  ])("does nothing at all for %s", (_name, environment) => {
    const h = host();
    expect(runStage(h, environment).status).not.toBe(0);
    expect(calls(h)).toEqual([]);
    expect(envLines(h)).toEqual(["AWS_REGION=us-west-2", "AGENTX_SANDBOX_IMAGE=x"]);
  });

  it("refuses an owner list that is not one line of entries, and withholds", () => {
    const h = host({ list: "not json" });
    expect(runStage(h).status).not.toBe(0);
    expect(envLines(h).some((line) => line.startsWith("AGENTX_TEST_SERVICES_OWNER_IMAGES="))).toBe(false);
    expect(envLines(h)).toContain("AGENTX_TEST_SERVICES_NOT_PULLED=all");
  });

  it("the restore script puts the walls and the run directory back after a reboot, and withholds (never failing the unit) when it cannot", () => {
    const ok = host();
    expect(runStage(ok).status).toBe(0);
    const restore = readFileSync(ok.restore, "utf8");
    // After a reboot: no mount, no rules but the container firewall's metadata block.
    writeFileSync(ok.rules, "DOCKER-USER -d 169.254.169.254/32 -j DROP\n");
    writeFileSync(ok.rules6, "");
    spawnSync("rm", ["-f", join(ok.runDir, ".mounted")]);
    const env = { PATH: `${join(ok.dir, "bin")}:${process.env.PATH ?? ""}` };
    expect(spawnSync("bash", ["-c", restore], { encoding: "utf8", env }).status).toBe(0);
    expect(mounted(ok)).toBe(true);
    expect(readFileSync(ok.rules, "utf8")).toContain("DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP");
    expect(envLines(ok)).not.toContain("AGENTX_TEST_SERVICES_NOT_PULLED=all");
    // The metadata block lost: withheld, unmounted, the unit still succeeds.
    writeFileSync(ok.rules, "");
    expect(spawnSync("bash", ["-c", restore], { encoding: "utf8", env }).status).toBe(0);
    expect(mounted(ok)).toBe(false);
    expect(envLines(ok)).toContain("AGENTX_TEST_SERVICES_NOT_PULLED=all");
  });
});

describe("boot.sh's test-services hook", () => {
  const config: Ec2WorkerBootConfig = {
    workspaceId: "11111111-2222-4333-8444-555555555555", generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false, workerImage: WORKER_IMAGE, invokePublicKey: "QUJD",
    controlPlaneUrl: "https://abc.execute-api.us-west-2.amazonaws.com", modelProvider: "amazon-bedrock", modelId: "m", promptCacheRetention: "long", logGroupName: "/agentx/staging/worker",
  };

  it("renders AGENTX_TEST_SERVICES=1 for Code's launch only when the configuration asks for test services", () => {
    expect(ec2WorkerBootScript({ ...config, testServices: true }, bootScript)).toContain("export AGENTX_TEST_SERVICES='1'");
    expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export AGENTX_TEST_SERVICES=");
  });

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

// ---- L4-E8I (owner DEC 254zzz62): the GCP pack in the stage. Off by default: the stage does exactly what it did (the tests above run it with no pack setting and pass unchanged).
describe("the test-services stage: the GCP pack", () => {
  const packOn = (groups: string) => ({ ROVARA_TEST_SERVICES_GCP_PACK: groups });
  const entriesFor = (groups: string) => gcpPackWorkerEntries(REGISTRY, "staging", groups);
  const refsOf = (groups: string) => [...new Set(entriesFor(groups).map((entry) => entry.reference))];
  const sdk = refsOf("pulled")[0]!;
  const starterList = JSON.stringify(mirroredStarterEntries(REGISTRY, "staging"));
  const pulledOf = (h: Host) => readFileSync(h.pulled, "utf8").trim().split("\n").sort();
  const ownerImages = (h: Host): Array<{ reference: string; family: string }> => JSON.parse(envLines(h).find((line) => line.startsWith("AGENTX_TEST_SERVICES_OWNER_IMAGES="))!.slice("AGENTX_TEST_SERVICES_OWNER_IMAGES=".length)) as Array<{ reference: string; family: string }>;

  it("with the pack on: pulls the starters, the mirrored copies from this account's ECR and Google's SDK image by digest from gcr.io, and the owner list holds all of them (the SDK image once per family)", () => {
    const h = host({ packRefs: refsOf("mirrored:pulled"), packList: JSON.stringify(entriesFor("mirrored:pulled")) });
    const result = runStage(h, packOn("mirrored:pulled"));
    expect(result.status, result.stderr).toBe(0);
    expect(pulledOf(h)).toEqual([...references, ...refsOf("mirrored:pulled")].sort());
    expect(sdk).toMatch(/^gcr\.io\/google\.com\/cloudsdktool\/google-cloud-cli@sha256:[a-f0-9]{64}$/u);
    const owner = ownerImages(h);
    expect(owner.map((entry) => entry.family).sort()).toEqual(["bigtable", "datastore", "firestore", "gcs", "mongodb", "mysql", "postgres", "postgres", "pubsub", "redis", "spanner"]);
    expect(owner.filter((entry) => entry.reference === sdk).map((entry) => entry.family).sort()).toEqual(["bigtable", "datastore", "firestore", "pubsub"]);
    // The starters' boot facts are about the starters only.
    expect(factsOf(h)).toMatchObject({ prepull: "ok", prepulled: 5 });
    // The worker image's CLI is asked with no network, no capability and a read-only root, exactly as for the starters.
    for (const line of calls(h).filter((entry) => entry.startsWith("docker run"))) expect(line).toContain("--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node");
    expect(result.stderr).toContain("the GCP pack (mirrored:pulled): 3 of 3 image(s) arrived");
  });

  it("the SDK image is pulled by digest only, from gcr.io or us-docker.pkg.dev, with no login to Google (the one login is this account's ECR, removed after)", () => {
    for (const host_ of ["gcr.io", "us-docker.pkg.dev"]) {
      const reference = `${host_}/google.com/cloudsdktool/google-cloud-cli@sha256:${"a".repeat(64)}`;
      const h = host({ packRefs: [reference], packList: JSON.stringify([{ reference, family: "pubsub", version: "594.0.0" }]) });
      expect(runStage(h, packOn("pulled")).status).toBe(0);
      expect(pulledOf(h)).toContain(reference);
    }
    const h = host({ packRefs: refsOf("pulled"), packList: JSON.stringify(entriesFor("pulled")) });
    runStage(h, packOn("pulled"));
    const logins = calls(h).filter((line) => line.startsWith("docker login"));
    expect(logins).toHaveLength(1);
    expect(logins[0]).toContain(REGISTRY);
    expect(calls(h).some((line) => /docker (login|logout) .*(gcr\.io|pkg\.dev)/u.test(line))).toBe(false);
    for (const line of calls(h).filter((entry) => entry.startsWith("docker pull"))) expect(line).toMatch(/@sha256:[a-f0-9]{64}$/u);
  });

  it.each([
    ["another registry host", `eu.gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:${"b".repeat(64)}`],
    ["a lookalike host", `gcr.io.evil.example/google.com/cloudsdktool/google-cloud-cli@sha256:${"b".repeat(64)}`],
    ["a host with a port", `gcr.io:5000/google.com/cloudsdktool/google-cloud-cli@sha256:${"b".repeat(64)}`],
    ["storage.googleapis.com", `storage.googleapis.com/x/y@sha256:${"b".repeat(64)}`],
    ["Docker Hub", `docker.io/library/redis@sha256:${"b".repeat(64)}`],
    ["a tag", "gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators"],
    ["another account's ECR", `999988887777.dkr.ecr.us-west-2.amazonaws.com/agentx-staging--test-services/spanner-1.5.59/spanner@sha256:${"c".repeat(64)}`],
    ["another environment's copy", `${REGISTRY}/agentx-prod--test-services/spanner-1.5.59/spanner@sha256:${"c".repeat(64)}`],
    ["a repository in the pull-through prefix", `${REGISTRY}/agentx-staging/worker@sha256:${"c".repeat(64)}`],
  ])("pulls nothing from %s, whatever the worker image prints", (_name, bad) => {
    const h = host({ packRefs: [bad], packList: "[]" });
    expect(runStage(h, packOn("mirrored:pulled")).status).toBe(0);
    expect(pulledOf(h)).toEqual([...references].sort());
    expect(calls(h).some((line) => line.startsWith("docker pull") && line.includes(bad))).toBe(false);
  });

  it("takes at most four pack references", () => {
    const many = Array.from({ length: 6 }, (_, index) => `gcr.io/cloud-spanner-emulator/emulator${index}@sha256:${String(index).repeat(64)}`);
    const h = host({ packRefs: many, packList: "[]" });
    expect(runStage(h, packOn("mirrored")).status).toBe(0);
    expect(pulledOf(h).filter((line) => line.startsWith("gcr.io/"))).toHaveLength(4);
  });

  it.each([undefined, "", "off", "none", "Mirrored", "mirrored,pulled", "mirrored:pulled:bigquery:pulled", "mirrored; touch /x", "$(id)", "mirrored:", ":mirrored", "pulled::mirrored"])("setting %j: no pack is asked for, planned or pulled, and the stage is the one it was", (setting) => {
    const h = host({ packRefs: refsOf("mirrored:pulled"), packList: JSON.stringify(entriesFor("mirrored:pulled")) });
    const result = runStage(h, setting === undefined ? {} : packOn(setting));
    expect(result.status, result.stderr).toBe(0);
    expect(pulledOf(h)).toEqual([...references].sort());
    expect(calls(h).some((line) => line.includes("pack-refs") || line.includes("pack-list"))).toBe(false);
    expect(readFileSync(h.envFile, "utf8")).toContain(`AGENTX_TEST_SERVICES_OWNER_IMAGES=${starterList}`);
  });

  it("a pack that fails never costs the starters: its pulls fail, the owner list is the starters', and the stage still succeeds", () => {
    const h = host({ failPull: /gcr\.io|spanner|gcs/u, packRefs: refsOf("mirrored:pulled"), packList: JSON.stringify(entriesFor("mirrored:pulled")) });
    const result = runStage(h, packOn("mirrored:pulled"));
    expect(result.status, result.stderr).toBe(0);
    expect(pulledOf(h)).toEqual([...references].sort());
    expect(envLines(h)).toContain(`AGENTX_TEST_SERVICES_OWNER_IMAGES=${starterList}`);
    expect(result.stderr).toContain("0 of 3 image(s) arrived");
  });

  it("an unusable pack owner list is left out, and the starters' list is untouched", () => {
    const h = host({ packRefs: refsOf("mirrored"), packList: "not json" });
    const result = runStage(h, packOn("mirrored"));
    expect(result.status, result.stderr).toBe(0);
    expect(pulledOf(h)).toEqual([...references, ...refsOf("mirrored")].sort());
    expect(envLines(h)).toContain(`AGENTX_TEST_SERVICES_OWNER_IMAGES=${starterList}`);
    expect(result.stderr).toContain("the pack's owner list was not usable");
  });

  it("the sealed box's rules are the same with the pack on: the stage adds no firewall rule, network, route or address pool for it", () => {
    const off = host();
    expect(runStage(off).status).toBe(0);
    const on = host({ packRefs: refsOf("mirrored:pulled"), packList: JSON.stringify(entriesFor("mirrored:pulled")) });
    expect(runStage(on, packOn("mirrored:pulled")).status).toBe(0);
    expect(readFileSync(on.rules, "utf8")).toBe(readFileSync(off.rules, "utf8"));
    expect(readFileSync(on.rules6, "utf8")).toBe(readFileSync(off.rules6, "utf8"));
    expect(readFileSync(on.daemon, "utf8")).toBe(readFileSync(off.daemon, "utf8"));
    const touched = (h: Host) => calls(h).filter((line) => /^(iptables|ip6tables|systemctl) /u.test(line));
    expect(touched(on)).toEqual(touched(off));
    expect(calls(on).some((line) => /docker (network|run .*--network (?!none))/u.test(line))).toBe(false);
  });

  it("the walls and the run directory code is byte for byte what it was, and the pack's code never touches a firewall, a network or an address", () => {
    const fn = (name: string) => {
      const start = stage.indexOf(`\n${name}() {`);
      return stage.slice(start + 1, stage.indexOf("\n}\n", start) + 3);
    };
    // The text of the functions that put the sealed box's walls up (pinned: any edit to them, a widening included, changes the hash and must be reviewed).
    const walls = ["ts_metadata_blocked", "ts_wall_run_networks", "ts_run_walls_present", "ts_ipv6_active", "ts_wall_ipv6", "ts_mount_run_dir", "ts_withhold", "ts_address_pools", "ts_install_restore_unit"].map(fn).join("");
    expect(createHash("sha256").update(walls).digest("hex")).toBe("990067525d1b971cdfe121a47f258ac173a27682d89759b609bd7ae4f503ead0");
    const pack = fn("ts_pack_references");
    expect(pack).toContain("--network none");
    expect(pack).not.toMatch(/iptables|ip6tables|DOCKER-USER|docker network|--network (?!none)|docker pull|curl|wget|nc |ssh/u);
    // Exactly one pull site, and it is the one that was there (a pack pull goes through ts_pull, by digest).
    expect(stage.match(/docker pull/gu)).toHaveLength(1);
    // The only registry hosts the stage names for a source pull: one pattern, exactly the two (no wildcard, no storage host, no other Google name).
    expect(stage.match(/\(gcr\\\.io\|us-docker\\\.pkg\\\.dev\)/gu)).toHaveLength(1);
    expect(stage).not.toMatch(/googleapis|\*\.gcr|eu\.gcr|asia\.gcr|artifactregistry/u);
  });
});

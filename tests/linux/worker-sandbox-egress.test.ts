// Lane L4-NETG (DEC 254zzz77): the sandbox egress gateway of an EC2 worker host, on REAL Docker. The boot's own stage (packages/worker/ec2/sandbox-egress.sh) is run unchanged as root against the CI runner's Docker and iptables, with
// only the three reads from the worker image (the gateway program and the two deny lists, which the contract test proves are the contracts' own: a read left to run here would run in the CI node image, which has no /opt/agentx/node_modules) and the systemd unit replaced; the runner's Node image stands in for the worker image.
// Then each claim is shown from where a sandbox sits, against a control that is NOT behind the wall, so a failure is the wall and not a broken test:
//   - the sandbox network is internal and the gateway is its only way out;
//   - a raw-IP HTTPS connection and DNS-over-HTTPS by IP fail from the sandbox network;
//   - a push-capable registry name fails from a sandbox (name server and TLS name) while the HOST still reaches it;
//   - an allowed name works through the gateway;
//   - a devcontainer started through the wrapper is on the same network with the same limits;
//   - a gateway that fails to start FAILS the stage (the boot).
// Lane L4-NETG2 (DEC 254zzz90) adds, on the same real Docker:
//   - a dev container's image build (the classic builder through the wrapper) has no way to a raw address or a registry name, and reaches an allowed name through the gateway; a build on an ordinary user bridge (the control) does reach the raw address;
//   - the verifier's contained E2E build commands (createDockerApplicationHost with `buildEgress`) the same, and no rvb build bridge is made;
//   - docker0 and a left-over agentx-task bridge cannot forward (the stage's walls), while an ordinary user bridge (the control) can.
// Lane L4-NETG3 (DEC 254zzz105) adds: the Docker DAEMON's own fetches go through the gateway's daemon proxy (ADD <url> to a raw address is refused and the proxy's log names it, an ADD of an allowed name works, a TLS GET of the registry API
// of the registries the sandbox side is denied works through the proxy's tunnel, an image on a raw address is refused, the dev container CLI sends a feature download through the proxy), judged by the gateway's own refusal log.
// THIS FILE RUNS ALONE (its own CI step, last): it restarts Docker twice, sets the daemon-wide name server and proxy and walls docker0, and its afterAll takes back every firewall rule the stage added.
// The stage runs its REAL daemon step here: /etc/docker/daemon.json gets the gateway as default name server and Docker is restarted (the original file is put back after).
// Needs ROVARA_DOCKER=1, passwordless sudo, and the container firewall of boot.sh (the CI job installs it first, as for the other network-wall tests).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { lookup as hostLookup } from "node:dns/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/contracts/src/egress-gateway-source.js";
import { SANDBOX_REGISTRY_DENY, SANDBOX_S3_DENY } from "../../packages/contracts/src/sandbox-deny-domains.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { verifyExecutorSeccompProfile } from "../../packages/verifier/src/host/executor-seccomp.js";
import { BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES, encodeBrowserEvidenceExecutorPlan } from "../../packages/contracts/src/index.js";
import { browserEvidenceExecutorArgs, parseCaptureOutput } from "../../packages/worker/src/browser-evidence-run.js";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { createLinuxHost, linuxRunInput } from "../support/linux-runtime.js";
import { ensureLocalImage } from "../support/ci-images.js";
import { APP_NODE_IMAGE } from "../support/linux-runtime.js";
import { docker, sudo } from "../support/linux-network-walls.js";
import { repoExecutorSeccompProfilePath } from "../../scripts/executor-smoke.js";

const run = promisify(execFile);
const stagePath = new URL("../../packages/worker/ec2/sandbox-egress.sh", import.meta.url).pathname;
const wrapperPath = new URL("../../packages/worker/ec2/devcontainer-docker.sh", import.meta.url).pathname;
const GATEWAY_IP = "172.28.250.2";
const NETWORK = "rovara-snet";
// A host name, not an image: the registry the sandbox side is denied (a bare host keeps the CI image guard, which reads every `host/path`, to real image references).
const REGISTRY_HOST = "ghcr.io";
// A digest-pinned reference on a raw address: only ever fetched by a daemon that must refuse it.
const RAW_ADDRESS_IMAGE = `203.0.113.7:5000/netg3/probe@sha256:${"0".repeat(64)}`;
const CONTROL_NETWORK = "rovara-netg2-ctl";
const HELD_CONTAINER = "rovara-netg2-held";
const DAEMON_JSON = "/etc/docker/daemon.json";

let dir = "";
let failureFile = "";
let stageFile = "";
let firewallScript = "";
let daemonBefore: string | undefined;
let agentxDirExisted = false;
let allowDirExisted = false;
let rulesBefore: Record<string, string[]> = {};

const RULE_CHAINS: ReadonlyArray<readonly [string, string]> = [["iptables", "DOCKER-USER"], ["iptables", "INPUT"], ["ip6tables", "INPUT"]];
/** The rules in each chain the stage touches, as `-S` prints them (`-A CHAIN ...`). */
async function ruleSnapshot(): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};
  for (const [tool, chain] of RULE_CHAINS) found[`${tool} ${chain}`] = (await sudo(tool, "-S", chain)).stdout.split("\n").filter((line) => line.startsWith("-A "));
  return found;
}
/** Deletes every rule that is there now and was not before the stage (the stage's walls), so a later step of the job sees the firewall it had. */
async function takeBackRules(): Promise<void> {
  const now = await ruleSnapshot();
  for (const [tool, chain] of RULE_CHAINS) {
    const before = new Set(rulesBefore[`${tool} ${chain}`] ?? []);
    for (const line of now[`${tool} ${chain}`] ?? []) if (!before.has(line)) await sudo(tool, "-D", ...line.slice(3).split(" "));
  }
}

/** The stage, as boot.sh runs it, with the worker-image reads replaced by files. `program` is the gateway program the container runs. */
async function stage(program: string, names: readonly string[] = SANDBOX_REGISTRY_DENY): Promise<{ code: number; failure: string; output: string }> {
  await writeFile(join(dir, "program"), program);
  await writeFile(join(dir, "names"), names.join("\n"));
  await writeFile(join(dir, "s3names"), SANDBOX_S3_DENY.join("\n"));
  await rm(failureFile, { force: true });
  const script = `set -uo pipefail
log() { printf 'agentx-boot: %s\\n' "$*" >&2; }
fail() { log "FAILED: $*"; printf '%s\\n' "$*" >"${failureFile}"; exit 1; }
try_seconds() { printf '%s\\n' "$1"; }
BOOT_STEP=start; WORKER_ENV_FILE="${join(dir, "worker.env")}"; WORKER_UNIT=agentx-worker.service; FIREWALL_UNIT=rovara-container-firewall.service
AGENTX_WORKER_IMAGE="${APP_NODE_IMAGE}"
. "${stageFile}"
se_program() { cat "${join(dir, "program")}"; }
se_denied_names() { cat "${join(dir, "names")}"; }
se_denied_s3_names() { cat "${join(dir, "s3names")}"; }
se_install_restore_unit() { return 0; }
sandbox_egress_main`;
  const result = await sudo("bash", "-c", script);
  return { code: result.code, failure: await readFile(failureFile, "utf8").catch(() => ""), output: result.stderr };
}

/** Node source run in a container ON the sandbox network, like a sandbox: its name server is the gateway. */
const sandbox = (script: string) => docker("run", "--rm", "--pull=never", "--network", NETWORK, "--dns", GATEWAY_IP, "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", script);
/** The control: the same script on an ordinary user-defined bridge with a way out, the way a sandbox runs today (`bridge` mode; the default bridge docker0 itself is walled by the stage now). */
const onBridge = (script: string) => docker("run", "--rm", "--pull=never", "--network", CONTROL_NETWORK, "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", script);

const connectOutcome = (host: string, port: number): string => `
const n=require('net');const s=n.connect({host:${JSON.stringify(host)},port:${String(port)},timeout:4000});
s.on('connect',()=>{console.log('open');process.exit(0)});s.on('timeout',()=>{console.log('timeout');process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(0)});`;
const lookupOutcome = (name: string): string => `require('dns').lookup(${JSON.stringify(name)},{family:4},(e,a)=>{console.log(e?e.code:a);process.exit(0)});`;
const httpsOutcome = (url: string): string => `
const https=require('https');const r=https.get(${JSON.stringify(url)},{timeout:8000,rejectUnauthorized:false,headers:{accept:'application/dns-json'}},res=>{console.log('status '+res.statusCode);res.resume();res.on('end',()=>process.exit(0))});
r.on('timeout',()=>{console.log('timeout');process.exit(0)});r.on('error',e=>{console.log('error '+e.code);process.exit(0)});`;
const tlsHelloOutcome = (host: string, name: string): string => `
const t=require('tls');const s=t.connect({host:${JSON.stringify(host)},port:443,servername:${JSON.stringify(name)},rejectUnauthorized:false,timeout:5000});
s.on('secureConnect',()=>{console.log('handshake');process.exit(0)});s.on('timeout',()=>{console.log('timeout');process.exit(0)});s.on('error',e=>{console.log('error '+e.code);process.exit(0)});`;

/** The HOST's own HTTPS (the vitest process runs on the host network, exactly like the worker and the host's Docker): the status, or the error code. */
function hostHttps(host: string): Promise<string> {
  return new Promise((resolve) => {
    const req = request({ host, path: "/v2/", method: "GET", timeout: 8000 }, (res) => { res.resume(); resolve(`status ${String(res.statusCode)}`); });
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
    req.on("error", (error: NodeJS.ErrnoException) => resolve(`error ${error.code ?? "unknown"}`));
    req.end();
  });
}

describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("the sandbox egress gateway of a worker host", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rovara-se-"));
    failureFile = join(dir, "failure");
    await ensureLocalImage(APP_NODE_IMAGE, WEB_API_BUILD_IMAGE);
    // The stage as boot.sh runs it, except that the container firewall it puts back after the Docker restart is the one this runner installed (the job's "Wall containers off" step), and /etc/docker/daemon.json exists.
    const runnerFirewall = process.env.RUNNER_TEMP === undefined ? "" : join(process.env.RUNNER_TEMP, "container-firewall.sh");
    firewallScript = runnerFirewall !== "" && existsSync(runnerFirewall) ? runnerFirewall : join(dir, "noop-firewall.sh");
    if (firewallScript === join(dir, "noop-firewall.sh")) await writeFile(firewallScript, "#!/bin/bash\nexit 0\n");
    stageFile = join(dir, "sandbox-egress.sh");
    await writeFile(stageFile, (await readFile(stagePath, "utf8")).split("/usr/local/libexec/rovara-container-firewall").join(firewallScript));
    agentxDirExisted = existsSync("/etc/agentx");
    allowDirExisted = existsSync("/var/lib/rovara-egress");
    rulesBefore = await ruleSnapshot();
    const had = await sudo("test", "-f", DAEMON_JSON);
    daemonBefore = had.code === 0 ? (await sudo("cat", DAEMON_JSON)).stdout : undefined;
    if (daemonBefore !== undefined) await writeFile(join(dir, "daemon.before"), daemonBefore);
    if (daemonBefore === undefined) await sudo("bash", "-c", `mkdir -p /etc/docker && echo '{}' > ${DAEMON_JSON}`);
    // A user bridge with a way out (the control), and a left-over agentx-task network that something still holds, as a bridge-mode session leaves it.
    await docker("network", "create", CONTROL_NETWORK);
    await docker("network", "create", "agentx-task");
    // --restart always: the stage restarts Docker before it removes the left-over network, and a stopped container holds no endpoint; the daemon brings this one back while it restores state, so the network stays held (as it is on a worker whose old sandbox is still running).
    const held = await docker("run", "-d", "--name", HELD_CONTAINER, "--restart", "always", "--pull=never", "--network", "agentx-task", APP_NODE_IMAGE, "sleep", "3600");
    expect(held.code, held.stderr).toBe(0);
    await writeFile(join(dir, "worker.env"), "AWS_REGION=us-west-2\n");
    const made = await stage(EGRESS_GATEWAY_SOURCE);
    expect(made.code, `${made.failure}\n${made.output}`).toBe(0);
  }, 300_000);
  afterAll(async () => {
    await docker("rm", "--force", HELD_CONTAINER);
    await docker("rm", "--force", "rovara-egw");
    await docker("network", "rm", "agentx-task");
    await docker("network", "rm", CONTROL_NETWORK);
    await docker("network", "rm", NETWORK);
    await docker("network", "rm", "rovara-xnet");
    await sudo("rm", "-f", "/etc/agentx/worker-dns");
    if (!agentxDirExisted) await sudo("rmdir", "/etc/agentx");
    if (!allowDirExisted) await sudo("rm", "-rf", "/var/lib/rovara-egress");
    await takeBackRules();
    // Docker's own configuration is put back, and Docker restarted on it with the runner's container firewall.
    await sudo("rm", "-f", "/etc/systemd/system/docker.service.d/30-rovara-build-proxy.conf");
    await sudo("systemctl", "daemon-reload");
    if (daemonBefore === undefined) await sudo("rm", "-f", DAEMON_JSON);
    else await sudo("cp", join(dir, "daemon.before"), DAEMON_JSON);
    await sudo("systemctl", "restart", "docker.service");
    for (let attempt = 0; attempt < 15; attempt += 1) { if ((await docker("info")).code === 0) break; await new Promise((resolve) => setTimeout(resolve, 2000)); }
    await sudo("bash", firewallScript);
    await rm(dir, { recursive: true, force: true });
  }, 240_000);

  it("the sandbox network is internal, has no host address, and the gateway is on exactly its two networks", async () => {
    const inspected = await docker("network", "inspect", "--format", "{{.Driver}}|{{.Internal}}|{{index .Options \"com.docker.network.bridge.inhibit_ipv4\"}}|{{index .Options \"com.docker.network.bridge.name\"}}|{{.EnableIPv6}}", NETWORK);
    expect(inspected.stdout.trim()).toBe("bridge|true|true|rvs0|false");
    const gateway = await docker("inspect", "--format", "{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.CapDrop}}|{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{end}}", "rovara-egw");
    expect(gateway.stdout.trim()).toBe("true|unless-stopped|true|[ALL]|rovara-snet rovara-xnet");
    const env = await readFile(join(dir, "worker.env"), "utf8");
    expect(env).toContain(`AGENTX_SANDBOX_EGRESS=gateway\nAGENTX_SANDBOX_NETWORK=${NETWORK}\nAGENTX_SANDBOX_DNS=${GATEWAY_IP}\n`);
  });

  // The S3 deny list is read by the stage from the contracts, exactly as in production (here through the same stub as the registry list); an S3 name is refused to a sandbox though the HOST resolves it.
  it("an S3 name the host resolves is NXDOMAIN to a sandbox (the S3 deny list the stage read from the contracts is in force), in every spelling that list covers", async () => {
    const control = await hostLookup("s3.amazonaws.com", { family: 4 }).then((found) => found.address, () => "");
    expect(control, "the runner must resolve S3 itself, or this proves nothing").toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
    for (const name of ["s3.amazonaws.com", "netg3-no-such-bucket.s3.amazonaws.com", "s3.us-west-2.amazonaws.com", "netg3-no-such-bucket.s3.us-west-2.amazonaws.com", "netg3-no-such-bucket.s3.dualstack.us-west-2.amazonaws.com", "s3-us-west-2.amazonaws.com"]) {
      const looked = await sandbox(lookupOutcome(name));
      expect(looked.stdout.trim(), `${name}: ${looked.stderr}`).toBe("ENOTFOUND");
    }
    // The gateway's own config carries the stage's deny list: every name of it, read from the contracts at test time.
    const create = (await docker("inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", "rovara-egw")).stdout;
    const config = JSON.parse(/ROVARA_GW_CONFIG=(.*)/u.exec(create)![1]!) as { sandboxDeniedS3: string[] };
    expect(config.sandboxDeniedS3).toEqual([...SANDBOX_S3_DENY]);
  }, 120_000);

  it("a raw-IP HTTPS connection fails from a sandbox though it works from a container on the default bridge", async () => {
    const control = await onBridge(connectOutcome("1.1.1.1", 443));
    expect(control.stdout.trim(), `control: ${control.stderr}`).toBe("open");
    for (const address of ["1.1.1.1", "8.8.8.8", "140.82.112.4"]) {
      const result = await sandbox(connectOutcome(address, 443));
      expect(result.stdout.trim(), `${address}: ${result.stderr}`).toMatch(/^(ENETUNREACH|EHOSTUNREACH|timeout)$/u);
    }
  }, 120_000);

  it("DNS-over-HTTPS by address fails from a sandbox (the resolver bypass), though it answers from the default bridge", async () => {
    const control = await onBridge(httpsOutcome("https://1.1.1.1/dns-query?name=example.com&type=A"));
    expect(control.stdout.trim(), `control: ${control.stderr}`).toMatch(/^status \d{3}$/u);
    const blocked = await sandbox(httpsOutcome("https://1.1.1.1/dns-query?name=example.com&type=A"));
    expect(blocked.stdout.trim(), blocked.stderr).toMatch(/^error (ENETUNREACH|EHOSTUNREACH)$|^timeout$/u);
    // A TLS name for a resolver that is not on the host resolver's list cannot be reached by pointing the sandbox's own client at the gateway either: no answer for the name, so nothing to connect to.
    const named = await sandbox(lookupOutcome("cloudflare-dns.com.evil-resolver.invalid"));
    expect(named.stdout.trim()).toBe("ENOTFOUND");
  }, 120_000);

  it("a push-capable registry name fails from a sandbox, by name server, by TLS name and by pointing a client straight at the gateway, while the host still reaches the registry", async () => {
    for (const name of ["ghcr.io", "registry-1.docker.io", "gcr.io", "us-docker.pkg.dev", "quay.io", "public.ecr.aws"]) {
      const looked = await sandbox(lookupOutcome(name));
      expect(looked.stdout.trim(), `${name}: ${looked.stderr}`).toBe("ENOTFOUND");
    }
    const viaClient = await sandbox(httpsOutcome(`https://${REGISTRY_HOST}/v2/`));
    expect(viaClient.stdout.trim(), viaClient.stderr).toMatch(/^error /u);
    for (const name of ["ghcr.io", "registry-1.docker.io", "123456789012.dkr.ecr.us-west-2.amazonaws.com"]) {
      const hello = await sandbox(tlsHelloOutcome(GATEWAY_IP, name));
      expect(hello.stdout.trim(), `${name}: ${hello.stderr}`).toMatch(/^error /u);
    }
    // The host (this process and the host's Docker) is not behind the gateway.
    const host = await hostHttps("ghcr.io");
    expect(host, "the host's own path to the registry").toMatch(/^status (200|401|403|404)$/u);
  }, 180_000);

  it("an allowed name works through the gateway: it resolves to the gateway and the TLS connection reaches the real site", async () => {
    const control = await hostHttps("registry.npmjs.org");
    const looked = await sandbox(lookupOutcome("registry.npmjs.org"));
    expect(looked.stdout.trim(), looked.stderr).toBe(GATEWAY_IP);
    const fetched = await sandbox(httpsOutcome("https://registry.npmjs.org/"));
    if (/^status /u.test(control)) expect(fetched.stdout.trim(), `${fetched.stderr}`).toMatch(/^status \d{3}$/u);
    else expect(fetched.stdout.trim()).toMatch(/^(status \d{3}|error .*|timeout)$/u);
  }, 120_000);

  it("a sandbox cannot reach the host, the metadata address, the gateway's other side or another private address", async () => {
    for (const target of [["169.254.169.254", 80], ["172.28.251.2", 443], ["172.28.251.2", 3128], ["172.28.250.1", 22], ["10.0.0.1", 443]] as const) {
      const result = await sandbox(connectOutcome(target[0], target[1]));
      expect(result.stdout.trim(), `${target[0]}: ${result.stderr}`).toMatch(/^(ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|timeout)$/u);
    }
  }, 120_000);

  it("a devcontainer started through the wrapper is on the sandbox network with the gateway as its only name server and no NET_RAW, and cannot reach a raw address", async () => {
    const real = (await run("which", ["docker"])).stdout.trim();
    const wrapper = join(dir, "devcontainer-docker.sh");
    await writeFile(wrapper, (await readFile(wrapperPath, "utf8")).split("/usr/local/bin/docker").join(real));
    await chmod(wrapper, 0o755);
    const env = { ...process.env, AGENTX_SANDBOX_NETWORK: NETWORK, AGENTX_SANDBOX_DNS: GATEWAY_IP };
    const viaWrapper = (...args: string[]) => run(wrapper, args, { env }).then((done) => ({ code: 0, stdout: done.stdout, stderr: done.stderr }), (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
    const created = await viaWrapper("create", "--name", "rovara-dc-probe", "--pull=never", APP_NODE_IMAGE, "sleep", "30");
    expect(created.code, created.stderr).toBe(0);
    try {
      const facts = await docker("inspect", "--format", "{{.HostConfig.NetworkMode}}|{{.HostConfig.Dns}}|{{.HostConfig.CapDrop}}|{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{end}}", "rovara-dc-probe");
      // Docker prints a capability as given (NET_RAW) or normalised (CAP_NET_RAW) by version: the same capability either way (the worker's own check, devcontainer-policy.ts dropsNetRaw, accepts both).
      const [mode, dnsServers, capDrop, networks] = facts.stdout.trim().split("|");
      expect([mode, dnsServers, (capDrop ?? "").replace(/CAP_/gu, ""), (networks ?? "").trim()]).toEqual([NETWORK, `[${GATEWAY_IP}]`, "[NET_RAW]", NETWORK]);
    } finally {
      await docker("rm", "--force", "rovara-dc-probe");
    }
    const raw = await viaWrapper("run", "--rm", "--pull=never", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", connectOutcome("1.1.1.1", 443));
    expect(raw.stdout.trim(), raw.stderr).toMatch(/^(ENETUNREACH|EHOSTUNREACH|timeout)$/u);
    const ghcr = await viaWrapper("run", "--rm", "--pull=never", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", lookupOutcome("ghcr.io"));
    expect(ghcr.stdout.trim(), ghcr.stderr).toBe("ENOTFOUND");
    // Without the environment the wrapper starts nothing.
    const refused = await run(wrapper, ["run", "--rm", APP_NODE_IMAGE, "true"], { env: { ...process.env, AGENTX_SANDBOX_NETWORK: "", AGENTX_SANDBOX_DNS: "" } }).then(() => 0, (error: { code?: number }) => error.code ?? 1);
    expect(refused).toBe(125);
  }, 180_000);

  // ---- Lane L4-NETG2 (DEC 254zzz90) ----
  it("docker0 and a left-over agentx-task bridge cannot forward (the stage's walls), though an ordinary user bridge can", async () => {
    const control = await onBridge(connectOutcome("1.1.1.1", 443));
    expect(control.stdout.trim(), `control: ${control.stderr}`).toBe("open");
    const onDefaultBridge = await docker("run", "--rm", "--pull=never", "--network", "bridge", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", connectOutcome("1.1.1.1", 443));
    expect(onDefaultBridge.stdout.trim(), onDefaultBridge.stderr).toMatch(/^(timeout|ENETUNREACH|EHOSTUNREACH)$/u);
    // The left-over network was held by a container, so the stage could not remove it and walled its bridge instead.
    expect((await docker("network", "inspect", "--format", "{{.Name}}", "agentx-task")).stdout.trim()).toBe("agentx-task");
    const onTaskBridge = await docker("run", "--rm", "--pull=never", "--network", "agentx-task", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", connectOutcome("1.1.1.1", 443));
    expect(onTaskBridge.stdout.trim(), onTaskBridge.stderr).toMatch(/^(timeout|ENETUNREACH|EHOSTUNREACH)$/u);
    // A name lookup from docker0 does not get an answer either (the daemon's default name server is the gateway, which docker0 cannot reach).
    const looked = await docker("run", "--rm", "--pull=never", "--network", "bridge", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", lookupOutcome("registry.npmjs.org"));
    expect(looked.stdout.trim(), looked.stderr).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
    const daemon = await sudo("cat", DAEMON_JSON);
    expect(daemon.stdout).toContain(`"dns": ["${GATEWAY_IP}"]`);
  }, 180_000);

  // H1 of REVIEW-1: the daemon's default name server is the gateway now, which a container on the HOST network cannot reach; the worker's launcher gives it the host's resolvers with --dns.
  it("a host-network container (the worker) resolves names when given the host resolvers the stage wrote, as the launcher does", async () => {
    const written = (await sudo("cat", "/etc/agentx/worker-dns")).stdout.split("\n").filter(Boolean);
    expect(written.length).toBeGreaterThan(0);
    for (const address of written) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
    expect(written.some((address) => address.startsWith("127."))).toBe(false);
    const withDns = await docker("run", "--rm", "--pull=never", "--network", "host", ...written.flatMap((address) => ["--dns", address]), "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", lookupOutcome("registry.npmjs.org"));
    expect(withDns.stdout.trim(), withDns.stderr).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
  }, 120_000);

  /** The wrapper (the real docker's path put in), run as the devcontainer CLI runs it. */
  async function wrapperDocker(args: string[], environment: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const real = (await run("which", ["docker"])).stdout.trim();
    const wrapper = join(dir, "devcontainer-docker-build.sh");
    await writeFile(wrapper, (await readFile(wrapperPath, "utf8")).split("/usr/local/bin/docker").join(real));
    await chmod(wrapper, 0o755);
    const env = { ...process.env, AGENTX_SANDBOX_NETWORK: NETWORK, AGENTX_SANDBOX_DNS: GATEWAY_IP, DOCKER_BUILDKIT: "1", ...environment };
    // (DOCKER_BUILDKIT=1 on purpose: the runner has the buildx plugin, like the worker image, and the wrapper itself must keep the build on the classic builder.)
    return run(wrapper, args, { env, maxBuffer: 10_000_000 }).then((done) => ({ code: 0, stdout: done.stdout, stderr: done.stderr }), (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  }
  /** A build context holding one Dockerfile whose RUN lines are `steps`. */
  async function context(name: string, steps: string[]): Promise<string> {
    // Under a folder of their own: the stage's stubs keep files in `dir` named `names`, `s3names` and `program`, and a build context called `names` collided with one (EEXIST).
    const folder = join(dir, "contexts", name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "Dockerfile"), `FROM ${APP_NODE_IMAGE}\n${steps.join("\n")}\n`);
    return folder;
  }
  // The script a RUN step runs: exit 0 when the address CANNOT be reached, 1 when it can.
  const runNode = (script: string): string => `RUN node -e ${JSON.stringify(script)}`;
  const mustNotConnect = (host: string): string => runNode(`const s=require('net').connect({host:${JSON.stringify(host)},port:443,timeout:4000});s.on('connect',()=>process.exit(1));s.on('timeout',()=>process.exit(0));s.on('error',()=>process.exit(0));`);
  const mustNotResolve = (name: string): string => runNode(`require('dns').lookup(${JSON.stringify(name)},{family:4},(e)=>process.exit(e?0:1));`);

  it("a dev container's IMAGE BUILD through the wrapper cannot reach a raw address or resolve a push-capable registry, though the same build on an ordinary user bridge reaches the raw address", async () => {
    // The classic builder is what the worker's devcontainer CLI uses (the worker image has no buildx, and the wrapper refuses it). A runner without it skips the build checks.
    const probe = await wrapperDocker(["build", "-q", "-t", "rovara-netg2-probe", await context("probe", ["RUN true"])]);
    // The production worker image has no buildx, so its docker CLI uses the classic builder; a runner that cannot run it must FAIL here, not pass without checking anything.
    expect(probe.code, `the classic builder must work through the wrapper: ${probe.stderr.slice(0, 400)}`).toBe(0);
    const raw = await context("raw", [mustNotConnect("1.1.1.1"), mustNotConnect("8.8.8.8")]);
    // --no-cache on every build here: a cached RUN layer would not run again, so a control build would "pass" without making its connection.
    const walled = await wrapperDocker(["build", "--no-cache", "-t", "rovara-netg2-raw", raw]);
    expect(walled.code, `${walled.stdout}\n${walled.stderr}`).toBe(0);
    // The control: the very same build on an ordinary user bridge, with a way out, FAILS at the RUN line because the address connects.
    const control = await run("docker", ["build", "--no-cache", "--network", CONTROL_NETWORK, "-t", "rovara-netg2-control", raw], { env: { ...process.env, DOCKER_BUILDKIT: "0" }, maxBuffer: 10_000_000 }).then(() => ({ code: 0, err: "" }), (error: { code?: number; stderr?: string }) => ({ code: error.code ?? 1, err: error.stderr ?? "" }));
    expect(control.code, `the control build must reach the raw address, or this test proves nothing: ${control.err.slice(-400)}`).not.toBe(0);
    const names = await context("names", ["ghcr.io", "registry-1.docker.io", "gcr.io", "123456789012.dkr.ecr.us-west-2.amazonaws.com"].map(mustNotResolve));
    const named = await wrapperDocker(["build", "--no-cache", "-t", "rovara-netg2-names", names]);
    expect(named.code, `${named.stdout}\n${named.stderr}`).toBe(0);
    // A build that names its own network is refused and runs nothing.
    const own = await wrapperDocker(["build", "--network", "host", "-t", "rovara-netg2-own", raw]);
    expect(own.code).toBe(125);
    for (const tag of ["probe", "raw", "control", "names", "own"]) await docker("rmi", "--force", `rovara-netg2-${tag}`);
  }, 600_000);

  it("npm reaches the registry from a dev container image build through the gateway (an allowed name works)", async () => {
    const probe = await wrapperDocker(["build", "-q", "-t", "rovara-netg2-probe2", await context("probe2", ["RUN true"])]);
    expect(probe.code, probe.stderr.slice(0, 400)).toBe(0);
    const control = await hostHttps("registry.npmjs.org");
    const built = await wrapperDocker(["build", "-t", "rovara-netg2-npm", await context("npm", ["RUN npm ping --registry https://registry.npmjs.org/"])]);
    if (/^status /u.test(control)) expect(built.code, `${built.stdout}\n${built.stderr}`).toBe(0);
    for (const tag of ["probe2", "npm"]) await docker("rmi", "--force", `rovara-netg2-${tag}`);
  }, 600_000);

  describe("the verifier's contained E2E build commands (buildEgress)", () => {
    async function buildThroughHost(command: { program: string; args: string[] }, buildEgress: { network: string; dns: string } | undefined) {
      const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", recipeBuild: [{ ...command, cwd: ".", timeoutMs: 120_000, env: {} }] });
      const { host } = await createLinuxHost(fixture, buildEgress === undefined ? {} : { buildEgress });
      const result = await runIsolatedE2EApplication({ input: linuxRunInput(fixture) as never, compiled: fixture.compiled, ports: host, signal: AbortSignal.timeout(280_000) });
      const runId = fixture.plan.runId;
      return { result, build: host.readBuildResult(runId), log: host.readDiagnostics(runId).buildLogTail,
        leftovers: { containers: (await docker("ps", "-a", "--filter", `label=rovara.run=${runId}`, "--format", "{{.Names}}")).stdout.trim(), networks: (await docker("network", "ls", "--filter", `label=rovara.run=${runId}`, "--format", "{{.Name}}")).stdout.trim() } };
    }
    // Exits 9 when the address connects, 0 when it cannot (a refusal or a timeout).
    const reach = (host: string) => ({ program: "node", args: ["-e", `const s=require('net').connect({host:${JSON.stringify(host)},port:443,timeout:4000});s.on('connect',()=>process.exit(9));s.on('timeout',()=>process.exit(0));s.on('error',()=>process.exit(0));`] });

    it("an rvb-style build cannot reach a raw address when it runs on the gateway network, and no rvb build bridge is made", async () => {
      const walled = await buildThroughHost(reach("1.1.1.1"), { network: NETWORK, dns: GATEWAY_IP });
      expect(walled.build, walled.log).toMatchObject({ commandIndex: 1, exitCode: 0 });
      expect(walled.leftovers).toEqual({ containers: "", networks: "" });
      // The control: the run's own build bridge (today's behaviour, no buildEgress) DOES reach it, so the build ends with the exit code 9.
      const control = await buildThroughHost(reach("1.1.1.1"), undefined);
      expect(control.build, control.log).toMatchObject({ commandIndex: 1, exitCode: 9 });
    }, 600_000);

    it("npm reaches the registry from such a build through the gateway", async () => {
      const control = await hostHttps("registry.npmjs.org");
      const built = await buildThroughHost({ program: "npm", args: ["ping", "--registry", "https://registry.npmjs.org/"] }, { network: NETWORK, dns: GATEWAY_IP });
      if (/^status /u.test(control)) expect(built.build, built.log).toMatchObject({ commandIndex: 1, exitCode: 0 });
    }, 600_000);
  });

  // ---- Lane L4-NETG3 (DEC 254zzz105): the daemon's own fetches ----
  const PROXY_HOST = "172.28.251.2";
  /** One request to the daemon proxy from the host (this process is on the host network, as the daemon is): the status line, or "" when nothing answered. */
  function proxyAsk(text: string): Promise<string> {
    return new Promise((resolve) => {
      let received = "";
      const socket = netConnect({ host: PROXY_HOST, port: 3128 }, () => socket.write(text));
      socket.on("data", (chunk) => { received += chunk.toString("latin1"); });
      socket.on("error", () => resolve(received));
      socket.on("close", () => resolve(received));
      setTimeout(() => { socket.destroy(); resolve(received); }, 8000).unref();
    });
  }
  const statusLine = (text: string): string => text.split("\r\n")[0] ?? "";
  const gatewayLog = async (): Promise<string> => { const logs = await docker("logs", "rovara-egw"); return `${logs.stdout}${logs.stderr}`; };

  it("the daemon proxy answers the host and refuses a raw address, an S3 bucket and a port other than 443, and tunnels an allowed registry name", async () => {
    expect(statusLine(await proxyAsk("CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\n\r\n"))).toMatch(/^HTTP\/1\.1 403/u);
    expect(statusLine(await proxyAsk("CONNECT netg3-test-bucket.s3.us-west-2.amazonaws.com:443 HTTP/1.1\r\nHost: x\r\n\r\n"))).toMatch(/^HTTP\/1\.1 403/u);
    expect(statusLine(await proxyAsk("CONNECT registry-1.docker.io:22 HTTP/1.1\r\nHost: x\r\n\r\n"))).toMatch(/^HTTP\/1\.1 403/u);
    expect(statusLine(await proxyAsk("CONNECT netg3-not-a-real-name.invalid:443 HTTP/1.1\r\nHost: x\r\n\r\n"))).toMatch(/^HTTP\/1\.1 403/u);
    // An allowed name (the runner's resolver answers it): the registry the sandbox side is denied is tunnelled for the daemon.
    if (/^status /u.test(await hostHttps("registry-1.docker.io"))) expect(statusLine(await proxyAsk("CONNECT registry-1.docker.io:443 HTTP/1.1\r\nHost: registry-1.docker.io:443\r\n\r\n"))).toMatch(/^HTTP\/1\.1 200/u);
  }, 60_000);

  it("an ADD of a URL on a raw address FAILS in a build (the daemon's own fetch is refused by the proxy, which says so in its log), while an ADD of an allowed name works", async () => {
    const refusedBefore = (await gatewayLog()).split("\n").filter((line) => line.includes("proxy_refused")).length;
    const bad = await context("add-raw", [`ADD http://1.1.1.1/netg3-probe /netg3-probe`]);
    const failed = await run("docker", ["build", "--network", NETWORK, "-t", "rovara-netg3-add-raw", bad], { env: { ...process.env, DOCKER_BUILDKIT: "0" }, maxBuffer: 10_000_000 }).then(() => 0, (error: { code?: number }) => error.code ?? 1);
    expect(failed, "ADD of a raw address must not succeed").not.toBe(0);
    const log = await gatewayLog();
    expect(log.split("\n").filter((line) => line.includes("proxy_refused")).length, "the refusal must be the proxy's").toBeGreaterThan(refusedBefore);
    expect(log).toMatch(/"event":"proxy_refused"[^\n]*"host":"1\.1\.1\.1"/u);
    if (/^status /u.test(await hostHttps("registry.npmjs.org"))) {
      const good = await context("add-name", ["ADD https://registry.npmjs.org/ /netg3-registry-answer"]);
      const built = await run("docker", ["build", "--network", NETWORK, "-t", "rovara-netg3-add-name", good], { env: { ...process.env, DOCKER_BUILDKIT: "0" }, maxBuffer: 10_000_000 }).then(() => ({ code: 0, err: "" }), (error: { code?: number; stderr?: string }) => ({ code: error.code ?? 1, err: error.stderr ?? "" }));
      expect(built.code, built.err.slice(0, 500)).toBe(0);
    }
    for (const tag of ["add-raw", "add-name"]) await docker("rmi", "--force", `rovara-netg3-${tag}`);
  }, 600_000);

  /** A TLS GET through the daemon proxy, as a registry client does: CONNECT, a handshake with the host's name, then GET /v2/. The status, or the failure. */
  function tunnelRegistry(host: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = netConnect({ host: PROXY_HOST, port: 3128 }, () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
      let head = "";
      const onData = (chunk: Buffer): void => {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        socket.removeListener("data", onData);
        if (!/^HTTP\/1\.1 200/u.test(head)) { socket.destroy(); resolve(statusLine(head)); return; }
        const secure = tlsConnect({ socket, servername: host });
        let answer = "";
        secure.on("secureConnect", () => secure.write(`GET /v2/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
        secure.on("data", (chunk2: Buffer) => { answer += chunk2.toString("latin1"); });
        secure.on("close", () => resolve(statusLine(answer)));
        secure.on("error", (error: Error) => resolve(`error ${error.message}`));
      };
      socket.on("data", onData);
      socket.on("error", () => resolve("socket error"));
      setTimeout(() => { socket.destroy(); resolve("timeout"); }, 20_000).unref();
    });
  }

  it("registries reach the daemon through the proxy (a TLS GET of the registry API through the tunnel answers), and an image on a raw address:port is refused by it", async () => {
    // The daemon creating a container from an image it does not hold fetches it: from a raw address that is refused, and the proxy's own log says so.
    // (Not a pull the CI image guard governs: an unroutable TEST-NET address that only the proxy ever sees; never copy this for a real image.)
    const refused = await docker("create", RAW_ADDRESS_IMAGE);
    expect(refused.code).not.toBe(0);
    expect(await gatewayLog()).toMatch(/"event":"proxy_refused"[^\n]*"host":"203\.0\.113\.7"|"event":"proxy_refused"[^\n]*"reason":"port"/u);
    // The registries the sandbox side is denied are allowed for the daemon, where the runner's resolver answers them.
    for (const host of ["registry-1.docker.io", REGISTRY_HOST, "public.ecr.aws"]) {
      if (!/^status /u.test(await hostHttps(host))) continue;
      expect(await tunnelRegistry(host), host).toMatch(/^HTTP\/1\.[01] (200|401|403|404)/u);
    }
  }, 300_000);

  it("the dev container CLI, given the proxy in its environment, sends its feature download through it: a feature on a raw address is refused by the proxy, and the proxy's log names it (the CLI honours the proxy variables)", async () => {
    const cli = new URL("../../node_modules/@devcontainers/cli/devcontainer.js", import.meta.url).pathname;
    const env = { ...process.env, HTTP_PROXY: `http://${PROXY_HOST}:3128`, HTTPS_PROXY: `http://${PROXY_HOST}:3128`, http_proxy: `http://${PROXY_HOST}:3128`, https_proxy: `http://${PROXY_HOST}:3128`, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
    const features = (reference: string) => run(process.execPath, [cli, "features", "info", "manifest", reference], { env, timeout: 90_000, maxBuffer: 10_000_000 }).then((done) => ({ code: 0, out: done.stdout, err: done.stderr }), (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, out: error.stdout ?? "", err: error.stderr ?? "" }));
    const bad = await features("203.0.113.9/netg3/feature:1");
    expect(bad.code).not.toBe(0);
    expect(await gatewayLog(), `the CLI must have gone through the proxy (its own output: ${`${bad.out}${bad.err}`.slice(0, 400)})`).toMatch(/"event":"proxy_refused"[^\n]*"host":"203\.0\.113\.9"/u);
  }, 300_000);

  // F11 (BE-0): the real capture executor joins a gateway-mode task sandbox. The
  // separate Chromium probe below uses the same executor hardening without the
  // screenshot driver's loopback-only origin filter, so it tests the network wall.
  it("F11: capture shares the gateway sandbox loopback and cannot use other egress or reach another container", async () => {
    const image = process.env.ROVARA_EXECUTOR_IMAGE ?? "rovara-e2e-executor:ci";
    const fixture = join(process.cwd(), "tests/fixtures/browser-evidence-app");
    const suffix = randomBytes(5).toString("hex");
    const sandboxName = `rovara-be0-sbx-${suffix}`;
    const captureName = `rovara-be0-cap-${suffix}`;
    const probeName = `rovara-be0-probe-${suffix}`;
    const remoteName = `rovara-be0-peer-${suffix}`;
    const innerName = `rovara-be0-inner-${suffix}`;
    const port = 4321;
    const remotePort = 4567;
    const marker = `be0-peer-${suffix}`;
    const seccomp = verifyExecutorSeccompProfile(repoExecutorSeccompProfilePath());
    const removed: string[] = [sandboxName, captureName, probeName, remoteName, innerName];
    try {
      const present = await docker("image", "inspect", image);
      expect(present.code, `CI must preload ${image}: ${present.stderr}`).toBe(0);
      expect((await sudo("cat", DAEMON_JSON)).stdout).toContain(`"dns": ["${GATEWAY_IP}"]`);
      expect((await sudo("cat", "/etc/systemd/system/docker.service.d/30-rovara-build-proxy.conf")).stdout).toContain("http://172.28.251.2:3128");

      // The project server exists only in its task sandbox, bound to its loopback.
      const started = await docker("run", "-d", "--pull=never", "--name", sandboxName, "--network", NETWORK, "--dns", GATEWAY_IP,
        "--cap-drop=ALL", "--security-opt", "no-new-privileges", "-v", `${fixture}:/fixture:ro`, "--env", `PORT=${String(port)}`,
        "--workdir", "/fixture/after", image, "node", "../server.mjs");
      expect(started.code, started.stderr).toBe(0);
      const ready = await docker("exec", sandboxName, "node", "-e", `fetch('http://127.0.0.1:${String(port)}/health').then(async r=>{console.log(r.status+' '+await r.text())}).catch(e=>{console.log(e.message);process.exit(1)})`);
      expect(ready.stdout.trim(), ready.stderr).toBe("200 ok");

      // A control proves both raw-IP routes work from a container with ordinary egress.
      for (const address of ["1.1.1.1", "8.8.8.8"]) {
        const control = await onBridge(connectOutcome(address, 443));
        expect(control.stdout.trim(), `raw-IP control ${address}: ${control.stderr}`).toBe("open");
      }

      // A live peer on the stale agentx-task bridge (and one on rovara-snet) has
      // a unique response. Controls verify the peers before Chromium probes them.
      const peerScript = `require('http').createServer((_,r)=>r.end(${JSON.stringify(marker)})).listen(${String(remotePort)},'0.0.0.0')`;
      for (const [name, network] of [[remoteName, "agentx-task"], [innerName, NETWORK]] as const) {
        const peer = await docker("run", "-d", "--pull=never", "--name", name, "--network", network, "--cap-drop=ALL", "--security-opt", "no-new-privileges", image, "node", "-e", peerScript);
        expect(peer.code, peer.stderr).toBe(0);
      }
      const remoteIp = (await docker("inspect", "--format", `{{(index .NetworkSettings.Networks "agentx-task").IPAddress}}`, remoteName)).stdout.trim();
      const innerIp = (await docker("inspect", "--format", `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, innerName)).stdout.trim();
      expect(remoteIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
      expect(innerIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
      for (const [network, address] of [["agentx-task", remoteIp], [NETWORK, innerIp]] as const) {
        const control = await docker("run", "--rm", "--pull=never", "--network", network, "--cap-drop=ALL", "--security-opt", "no-new-privileges", image,
          "node", "-e", `fetch('http://${address}:${String(remotePort)}').then(r=>r.text()).then(t=>{console.log(t);process.exit(t===${JSON.stringify(marker)}?0:1)}).catch(e=>{console.log(e.message);process.exit(2)})`);
        expect(control.stdout.trim(), `${network} peer control: ${control.stderr}`).toBe(marker);
      }

      // Run the production capture in the executor image with exactly its usual
      // isolation flags; keep it detached briefly to inspect the live namespace.
      const plan = encodeBrowserEvidenceExecutorPlan({ port, readyPath: "/health", routes: ["/checkout", "/missing", "/busy"], maskSelectors: [], runMs: 60_000, pageMs: 15_000 });
      const captureArgs = browserEvidenceExecutorArgs({ image, sandbox: sandboxName, name: captureName, seccompProfile: seccomp, plan });
      expect(captureArgs.filter((value) => value === "--network")).toHaveLength(1);
      expect(captureArgs).toContain(`container:${sandboxName}`);
      expect(captureArgs).not.toContain("-v");
      expect(captureArgs).not.toContain("-e");
      expect(captureArgs).toContain("--cap-drop=ALL");
      expect(captureArgs).toContain("--read-only");
      expect(captureArgs).toContain(`seccomp=${seccomp}`);
      expect(captureArgs).toContain("--memory");
      const detachedArgs = captureArgs.filter((value) => value !== "--rm");
      detachedArgs.splice(1, 0, "--detach");
      const launched = await docker(...detachedArgs);
      expect(launched.code, launched.stderr).toBe(0);
      const mode = await docker("inspect", "--format", "{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.CapDrop}}|{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{end}}", captureName);
      expect(mode.stdout.trim()).toBe(`container:${sandboxName}|true|[ALL]|`);

      // Chromium's shared network namespace has just the app listener, never a
      // DevTools or proxy listener of its own.
      const listeners = await docker("exec", sandboxName, "node", "-e", "const fs=require('fs');const p=new Set();for(const f of ['/proc/net/tcp','/proc/net/tcp6']){try{for(const l of fs.readFileSync(f,'utf8').trim().split('\\n').slice(1)){const c=l.trim().split(/\\s+/);if(c[3]==='0A')p.add(parseInt(c[1].split(':').pop(),16))}}catch(e){if(f==='/proc/net/tcp')throw e}}console.log(JSON.stringify([...p].sort((a,b)=>a-b)))");
      expect(JSON.parse(listeners.stdout.trim()) as number[]).toEqual([port]);
      const captureWait = run("docker", ["wait", captureName], { timeout: 120_000 }).then(() => undefined, () => undefined);
      // The /busy route holds the executor open long enough to inspect the listener table.
      await captureWait;
      const captureLog = await docker("logs", captureName);
      const captured = parseCaptureOutput(Buffer.from(captureLog.stdout), ["/checkout", "/missing", "/busy"]);
      expect(captured?.app, `${captureLog.stderr}\n${captureLog.stdout.slice(0, 300)}`).toBe("ready");
      const checkout = captured?.shots.get("/checkout");
      expect(checkout).toMatchObject({ t: "shot", ok: true });
      if (checkout?.t !== "shot" || !checkout.ok) throw new Error("/checkout was not captured");
      const jpeg = Buffer.from(checkout.jpegBase64, "base64");
      expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(jpeg.byteLength).toBeGreaterThan(0);
      expect(jpeg.byteLength).toBeLessThanOrEqual(BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES);
      expect(captured?.shots.get("/missing")).toMatchObject({ t: "shot", ok: false, reason: "page_did_not_load" });
      expect(captured?.shots.has("/busy")).toBe(false);

      const closedPlan = encodeBrowserEvidenceExecutorPlan({ port: port + 1, readyPath: "/health", routes: ["/checkout"], maskSelectors: [], runMs: 2_000, pageMs: 2_000 });
      const closed = await docker(...browserEvidenceExecutorArgs({ image, sandbox: sandboxName, name: `${captureName}-closed`, seccompProfile: seccomp, plan: closedPlan }));
      expect(closed.code, closed.stderr).toBe(0);
      const noApp = parseCaptureOutput(Buffer.from(closed.stdout), ["/checkout"]);
      expect(noApp?.app).toBe("time_limit");
      expect(noApp?.shots.size).toBe(0);

      // Test-only Chromium has no origin filter. Its local success is a required
      // launch control; only explicit network-denial errors count as a wall.
      const probeScript = `const {openEvidenceChromium}=require('/opt/agentx/packages/verifier/dist/executor/browser-evidence-chromium.js');(async()=>{const c=await openEvidenceChromium({signal:AbortSignal.timeout(90000)});try{const p=await c.browser.newPage();const out={};const local=await p.goto('http://127.0.0.1:${String(port)}/checkout',{waitUntil:'domcontentloaded',timeout:10000});out.local={status:local&&local.status(),body:(await p.locator('body').innerText()).slice(0,2000)};for(const [key,url] of Object.entries(${JSON.stringify({ raw1: "https://1.1.1.1/", raw2: "https://8.8.8.8/", registry: "https://ghcr.io/v2/", peer: `http://${remoteIp}:${String(remotePort)}/`, inner: `http://${innerIp}:${String(remotePort)}/`, host: "http://172.28.251.2:443/", gatewayDns: "http://172.28.250.2:443/", gatewayInner: "http://172.28.250.1:22/", metadata: "http://169.254.169.254/", daemonProxy: "http://172.28.251.2:3128/" })})){try{const r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:8000});out[key]={status:r&&r.status(),body:(await p.locator('body').innerText().catch(()=>'' )).slice(0,2000)}}catch(e){out[key]={error:String(e.message)}}}try{const r=await p.goto('https://registry.npmjs.org/',{waitUntil:'domcontentloaded',timeout:20000});out.allowed={status:r&&r.status(),body:(await p.locator('body').innerText()).slice(0,2000)}}catch(e){out.allowed={error:String(e.message)}}console.log(JSON.stringify(out))}finally{await c.close()}})().catch(e=>{console.error(e);process.exit(1)})`;
      const probeArgs = browserEvidenceExecutorArgs({ image, sandbox: sandboxName, name: probeName, seccompProfile: seccomp, plan });
      const imageIndex = probeArgs.indexOf(image);
      probeArgs.splice(imageIndex + 1, probeArgs.length, "node", "-e", probeScript);
      const probe = await docker(...probeArgs);
      expect(probe.code, probe.stderr).toBe(0);
      const result = JSON.parse(probe.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, { status?: number; body?: string; error?: string }>;
      expect(result.local?.status).toBe(200);
      expect(result.local?.body).toContain("Account");
      for (const key of ["raw1", "raw2"] as const) expect(result[key]?.error, `${key}: ${JSON.stringify(result[key])}`).toMatch(/net::ERR_(ADDRESS_UNREACHABLE|CONNECTION_TIMED_OUT|CONNECTION_REFUSED)/u);
      for (const key of ["peer", "inner"] as const) expect(result[key]?.error, `${key}: ${JSON.stringify(result[key])}`).toMatch(/net::ERR_(ADDRESS_UNREACHABLE|CONNECTION_TIMED_OUT|CONNECTION_REFUSED)/u);
      for (const key of ["host", "gatewayDns", "gatewayInner", "metadata", "daemonProxy"] as const) expect(result[key]?.error, `${key}: ${JSON.stringify(result[key])}`).toMatch(/net::ERR_(ADDRESS_UNREACHABLE|CONNECTION_TIMED_OUT|CONNECTION_REFUSED)/u);
      expect(result.registry?.error).toMatch(/net::ERR_NAME_NOT_RESOLVED/u);
      const deniedHost = await hostHttps("ghcr.io");
      expect(deniedHost, "host/daemon registry control").toMatch(/^status (200|401|403|404)$/u);
      expect(result.allowed).toMatchObject({ status: 200 });
      expect(result.allowed?.body).toMatch(/^\s*\{[\s\S]*\}\s*$/u);
      expect(() => { void (JSON.parse(result.allowed?.body ?? "") as unknown); }).not.toThrow();
      expect(await gatewayLog()).toMatch(/"event":"proxy_refused"/u);
    } finally {
      for (const name of removed) await docker("rm", "--force", name);
      await docker("rm", "--force", `${captureName}-closed`);
    }
  }, 900_000);

  // LAST: it replaces the gateway with a broken one.
  it("FAILS the boot when the gateway cannot start (it comes up and dies at once), and never leaves the worker an environment", async () => {
    await rm(join(dir, "worker.env"), { force: true });
    await writeFile(join(dir, "worker.env"), "AWS_REGION=us-west-2\n");
    const broken = `"use strict";\n// ${"x".repeat(21_000)}\nprocess.exit(3);\n`;
    const result = await stage(broken);
    expect(result.code).not.toBe(0);
    expect(result.failure).toMatch(/sandbox egress gateway|did not pass its checks/u);
    expect(await readFile(join(dir, "worker.env"), "utf8")).toBe("AWS_REGION=us-west-2\n");
  }, 180_000);
});

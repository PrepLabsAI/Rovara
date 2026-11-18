// Lane L4-NETG (DEC 254zzz77): the sandbox egress gateway of an EC2 worker host, on REAL Docker. The boot's own stage (packages/worker/ec2/sandbox-egress.sh) is run unchanged as root against the CI runner's Docker and iptables, with
// only the two reads from the worker image (the gateway program and the deny list, which the unit test proves are the contracts' own) and the systemd unit replaced; the runner's Node image stands in for the worker image.
// Then each claim is shown from where a sandbox sits, against a control that is NOT behind the wall, so a failure is the wall and not a broken test:
//   - the sandbox network is internal and the gateway is its only way out;
//   - a raw-IP HTTPS connection and DNS-over-HTTPS by IP fail from the sandbox network;
//   - a push-capable registry name fails from a sandbox (name server and TLS name) while the HOST still reaches it;
//   - an allowed name works through the gateway;
//   - a devcontainer started through the wrapper is on the same network with the same limits;
//   - a gateway that fails to start FAILS the stage (the boot).
// Needs ROVARA_DOCKER=1, passwordless sudo, and the container firewall of boot.sh (the CI job installs it first, as for the other network-wall tests).
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/contracts/src/egress-gateway-source.js";
import { SANDBOX_REGISTRY_DENY } from "../../packages/contracts/src/sandbox-deny-domains.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { ensureLocalImage } from "../support/ci-images.js";
import { APP_NODE_IMAGE } from "../support/linux-runtime.js";
import { docker, sudo } from "../support/linux-network-walls.js";

const run = promisify(execFile);
const stagePath = new URL("../../packages/worker/ec2/sandbox-egress.sh", import.meta.url).pathname;
const wrapperPath = new URL("../../packages/worker/ec2/devcontainer-docker.sh", import.meta.url).pathname;
const GATEWAY_IP = "172.28.250.2";
const NETWORK = "rovara-snet";

let dir = "";
let failureFile = "";

/** The stage, as boot.sh runs it, with the worker-image reads replaced by files. `program` is the gateway program the container runs. */
async function stage(program: string, names: readonly string[] = SANDBOX_REGISTRY_DENY): Promise<{ code: number; failure: string; output: string }> {
  await writeFile(join(dir, "program"), program);
  await writeFile(join(dir, "names"), names.join("\n"));
  await rm(failureFile, { force: true });
  const script = `set -uo pipefail
log() { printf 'agentx-boot: %s\\n' "$*" >&2; }
fail() { log "FAILED: $*"; printf '%s\\n' "$*" >"${failureFile}"; exit 1; }
try_seconds() { printf '%s\\n' "$1"; }
BOOT_STEP=start; WORKER_ENV_FILE="${join(dir, "worker.env")}"; WORKER_UNIT=agentx-worker.service; FIREWALL_UNIT=rovara-container-firewall.service
AGENTX_WORKER_IMAGE="${APP_NODE_IMAGE}"
. "${stagePath}"
se_program() { cat "${join(dir, "program")}"; }
se_denied_names() { cat "${join(dir, "names")}"; }
se_install_restore_unit() { return 0; }
sandbox_egress_main`;
  const result = await sudo("bash", "-c", script);
  return { code: result.code, failure: await readFile(failureFile, "utf8").catch(() => ""), output: result.stderr };
}

/** Node source run in a container ON the sandbox network, like a sandbox: its name server is the gateway. */
const sandbox = (script: string) => docker("run", "--rm", "--pull=never", "--network", NETWORK, "--dns", GATEWAY_IP, "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", script);
/** The control: the same script on Docker's default bridge, the way a sandbox runs today (`bridge` mode). */
const onBridge = (script: string) => docker("run", "--rm", "--pull=never", "--network", "bridge", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", script);

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
    const made = await stage(EGRESS_GATEWAY_SOURCE);
    expect(made.code, `${made.failure}\n${made.output}`).toBe(0);
  }, 300_000);
  afterAll(async () => {
    await docker("rm", "--force", "rovara-egw");
    await docker("network", "rm", NETWORK);
    await docker("network", "rm", "rovara-xnet");
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it("the sandbox network is internal, has no host address, and the gateway is on exactly its two networks", async () => {
    const inspected = await docker("network", "inspect", "--format", "{{.Driver}}|{{.Internal}}|{{index .Options \"com.docker.network.bridge.inhibit_ipv4\"}}|{{index .Options \"com.docker.network.bridge.name\"}}|{{.EnableIPv6}}", NETWORK);
    expect(inspected.stdout.trim()).toBe("bridge|true|true|rvs0|false");
    const gateway = await docker("inspect", "--format", "{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.CapDrop}}|{{range $n, $c := .NetworkSettings.Networks}}{{$n}} {{end}}", "rovara-egw");
    expect(gateway.stdout.trim()).toBe("true|unless-stopped|true|[ALL]|rovara-snet rovara-xnet");
    const env = await readFile(join(dir, "worker.env"), "utf8");
    expect(env).toContain(`AGENTX_SANDBOX_EGRESS=gateway\nAGENTX_SANDBOX_NETWORK=${NETWORK}\nAGENTX_SANDBOX_DNS=${GATEWAY_IP}\n`);
  });

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
    const viaClient = await sandbox(httpsOutcome("https://ghcr.io/v2/"));
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
    for (const target of [["169.254.169.254", 80], ["172.28.251.2", 443], ["172.28.250.1", 22], ["10.0.0.1", 443]] as const) {
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
      expect(facts.stdout.trim()).toBe(`${NETWORK}|[${GATEWAY_IP}]|[NET_RAW]|${NETWORK} `);
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

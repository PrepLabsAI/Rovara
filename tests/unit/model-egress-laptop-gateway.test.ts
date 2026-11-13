// TE-F1c (design 3.2 item 4): the laptop's name block. The egress gateway reads ONE list for the worker's network and the sandboxes' network (`localAllowedDomains()`, which is the cloud's default list and so holds
// api.anthropic.com, api.openai.com, chatgpt.com, auth.openai.com and openrouter.ai). The design's "model hosts are simply left off the laptop list" is not true of the code, and taking them off the list would break the worker
// (ChatGPT plans, the agent's own provider). So the gateway gets a SANDBOX-ONLY deny list: the sandboxes' name server answers NXDOMAIN and their forwarders refuse; the worker's network is untouched.
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { builtinModelCatalog } from "@agentx/contracts";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/broker/src/local/isolation/egress-gateway-source.js";
import { gatewayConfig, type GatewayInput } from "../../packages/broker/src/local/isolation/stack.js";
import { LOCAL_DEFAULT_ALLOW_DOMAINS, hostIsAllowed } from "../../packages/broker/src/local/isolation/allow-list.js";
import { laptopBlockEvidenceInput, laptopSandboxDenyList } from "../../packages/broker/src/local/model-egress/name-block.js";
import { DockerWorkerMachines } from "../../packages/broker/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const scratch: string[] = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });
afterEach(() => undefined);

interface Gateway {
  hostAllowed(host: string, role?: string): boolean;
  answerFor(message: Buffer, localIp: string, role?: string): Buffer | undefined;
}
async function load(config: Record<string, unknown>): Promise<Gateway> {
  const directory = await mkdtemp(join(tmpdir(), "gw-"));
  scratch.push(directory);
  const file = join(directory, "program.cjs");
  await writeFile(file, EGRESS_GATEWAY_SOURCE);
  const saved = { ...process.env };
  Object.assign(process.env, { ROVARA_GW_CONFIG: JSON.stringify(config), ROVARA_GW_LIBRARY: "1" });
  try {
    return createRequire(import.meta.url)(file) as Gateway;
  } finally {
    delete process.env.ROVARA_GW_CONFIG;
    delete process.env.ROVARA_GW_LIBRARY;
    Object.assign(process.env, saved);
  }
}
/** A DNS query for an A record of `name`. */
function query(name: string): Buffer {
  const labels = name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}
const rcode = (reply: Buffer | undefined): number | undefined => (reply === undefined ? undefined : reply.readUInt16BE(2) & 0xf);

describe("what the laptop gateway really reads", () => {
  it("is the cloud's default list for BOTH networks: the model hosts ARE on it today", () => {
    for (const host of ["api.anthropic.com", "api.openai.com", "chatgpt.com", "auth.openai.com", "openrouter.ai"]) expect(hostIsAllowed(host, LOCAL_DEFAULT_ALLOW_DOMAINS), host).toBe(true);
  });
});

describe("the sandbox-only deny list in the gateway program", () => {
  const denied = laptopSandboxDenyList();
  const config = { allowed: [...LOCAL_DEFAULT_ALLOW_DOMAINS, "*.example-ok.dev"], sandboxDenied: denied };
  it("refuses a model host for the sandbox network and answers it for the worker network", async () => {
    const gateway = await load(config);
    for (const host of ["api.openai.com", "api.anthropic.com", "openrouter.ai"]) {
      expect(gateway.hostAllowed(host, "worker"), `${host} worker`).toBe(true);
      expect(gateway.hostAllowed(host), `${host} no role`).toBe(true);
      expect(gateway.hostAllowed(host, "sandbox"), `${host} sandbox`).toBe(false);
    }
  });
  it("still lets the sandbox reach everything else on the list", async () => {
    const gateway = await load(config);
    for (const host of ["github.com", "registry.npmjs.org", "pypi.org", "a.example-ok.dev"]) expect(gateway.hostAllowed(host, "sandbox"), host).toBe(true);
  });
  it("blocks a wildcard entry (Azure OpenAI) for every subdomain, in any case", async () => {
    const gateway = await load({ allowed: ["*.openai.azure.com", "github.com"], sandboxDenied: ["*.openai.azure.com"] });
    expect(gateway.hostAllowed("my-resource.openai.azure.com", "sandbox")).toBe(false);
    expect(gateway.hostAllowed("a.b.openai.azure.com", "sandbox")).toBe(false);
    expect(gateway.hostAllowed("my-resource.openai.azure.com", "worker")).toBe(true);
    expect(gateway.hostAllowed("openai.azure.com.evil.dev", "sandbox")).toBe(false);
  });
  it("the sandbox's name server says NXDOMAIN for a model host; the worker's answers", async () => {
    const gateway = await load(config);
    expect(rcode(gateway.answerFor(query("api.openai.com"), "172.20.0.2", "sandbox"))).toBe(3);
    expect(rcode(gateway.answerFor(query("api.openai.com"), "172.20.0.2", "worker"))).toBe(0);
    expect(rcode(gateway.answerFor(query("api.openai.com"), "172.20.0.2"))).toBe(0);
    expect(rcode(gateway.answerFor(query("github.com"), "172.20.0.2", "sandbox"))).toBe(0);
  });
  it("with no deny list nothing changes for anyone", async () => {
    const gateway = await load({ allowed: LOCAL_DEFAULT_ALLOW_DOMAINS });
    expect(gateway.hostAllowed("api.openai.com", "sandbox")).toBe(true);
  });
});

describe("the list itself", () => {
  it("holds every host of the FULL built-in catalog and the company's gateway hosts, and the Azure suffix as a wildcard", () => {
    const list = laptopSandboxDenyList();
    for (const row of builtinModelCatalog().rows) {
      // (Google's token hosts are catalog auth hosts today and are never denied: DECISIONS 174, tested below.)
      for (const host of [...row.hosts, ...row.authHosts].filter((entry) => !/^(?:oauth2|sts|iamcredentials)\.googleapis\.com$/u.test(entry))) expect(list, host).toContain(host);
      for (const suffix of row.hostSuffixes) expect(list).toContain(`*.${suffix}`);
    }
    expect(list).toContain("*.openai.azure.com");
    expect(laptopSandboxDenyList([], [{ host: "llm.acme.dev" }])).toContain("llm.acme.dev");
    // extra rows are ADDED to the built-in catalog: a partial list never shrinks the block
    expect(laptopSandboxDenyList([{ hosts: ["new.example.com"], authHosts: [], hostSuffixes: [] }])).toEqual(expect.arrayContaining(["new.example.com", "api.openai.com"]));
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("Google's token hosts are never denied (DECISIONS 174)", () => {
  it("are not on the deny list, and a sandbox still reaches them through the gateway when they are on the allow list", async () => {
    const hosts = ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"];
    const denied = laptopSandboxDenyList([], [{ host: "llm.acme.dev" }]);
    for (const host of hosts) expect(denied, host).not.toContain(host);
    expect(denied.some((entry) => entry.startsWith("*.") && hosts.some((host) => host.endsWith(entry.slice(1))))).toBe(false);
    const gateway = await load({ allowed: [...LOCAL_DEFAULT_ALLOW_DOMAINS, ...hosts], sandboxDenied: denied });
    for (const host of hosts) expect(gateway.hostAllowed(host, "sandbox"), host).toBe(true);
  });
});

describe("the evidence of the laptop", () => {
  it("with the gateway's sandbox deny list active the round is blocked by name; without it, 'not blocked on this machine'", () => {
    const on = laptopBlockEvidenceInput(true);
    expect(on).toMatchObject({ blockMode: "by_name", azureOpenAiNotBlocked: false });
    expect(on.machineBlock).toBeUndefined();
    expect(on.blockList).toContain("api.openai.com");
    const off = laptopBlockEvidenceInput(false);
    expect(off).toMatchObject({ blockMode: "none", machineBlock: "not_blocked", blockList: [] });
  });
});

describe("the gateway's configuration and the machine that sets it", () => {
  const input = (extra: Partial<GatewayInput> = {}): GatewayInput => ({
    image: "x", labels: [], names: {} as never, nets: { worker: { subnet: "172.20.0.0/24" }, sandbox: { subnet: "172.21.0.0/24" }, external: { subnet: "172.22.0.0/24" } }, allowed: ["github.com"], workspaceId: "w", callback: { tcpPort: 1 }, user: "1000:1000", ...extra,
  });
  it("carries the deny list only when one is given", () => {
    expect(gatewayConfig(input())).not.toHaveProperty("sandboxDenied");
    expect(gatewayConfig(input({ sandboxDenied: [] }))).not.toHaveProperty("sandboxDenied");
    expect(gatewayConfig(input({ sandboxDenied: ["api.openai.com"] }))).toMatchObject({ sandboxDenied: ["api.openai.com"] });
  });
  it("a machine told to deny model hosts in sandboxes starts a gateway that does; a machine told nothing (or an empty list) is unchanged", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-gw-"));
    scratch.push(stateDirectory);
    const docker = new FakeDocker();
    const signer = createEphemeralInvokeSigner();
    const start = async (denied?: readonly string[]) => {
      const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer, docker, fetch: docker.fetch, ...(denied === undefined ? {} : { modelHostsDeniedInSandbox: denied }) });
      const handle = await machines.start({ machineKey: "ws-deny", companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
      const gateway = docker.containers.get(`rovara-gw-${handle.machineId.slice("rovara-worker-".length)}`)!;
      return { config: JSON.parse(gateway.environment.ROVARA_GW_CONFIG!) as Record<string, unknown>, args: JSON.stringify(gateway.args) };
    };
    const plain = await start();
    expect(plain.config).not.toHaveProperty("sandboxDenied");
    const empty = await start([]);
    expect(empty.args).toBe(plain.args);
    expect(empty.config).not.toHaveProperty("sandboxDenied");
    const denying = await start(laptopSandboxDenyList());
    expect(denying.config.sandboxDenied).toEqual(laptopSandboxDenyList());
  });
});

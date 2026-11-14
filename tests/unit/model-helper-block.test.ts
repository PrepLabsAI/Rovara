// TE-F1b: the by-name block of model hosts (te-f1 design 3.1 to 3.4). The `--add-host` list and the sealed DNS table are GENERATED from the catalog (F0a's `modelHostBlockList`), so a catalog row cannot exist without a block
// entry; no wildcard exists anywhere; a project with no model row gets the same names pointed at the dropped address, only behind the company gate; the round's block mode is `by_name` and nothing in the lane makes
// "sealed" for an unsealed round. Last, the lane's required test: no request reaches a real model host (offline; the recorder on loopback, the tripwire on every door).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import {
  NOT_SEALED_BLOCKED_BY_NAME_SENTENCE, builtinModelCatalog, checkModelHost, evidenceLinesFor, findRedirectEscapes, modelHostBlockList, modelHostSuffixBlockList, redirectEscapeSentence,
  type CompanyGatewayRow, type ModelCatalogRow,
} from "@agentx/contracts";
import { installNetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import {
  MODEL_BLACKHOLE_ADDRESS, MODEL_HOST_BLOCK_GATE_NAME, AZURE_OPENAI_NOT_BLOCKED_SENTENCE, blockModeForRound, modelBlockEvidenceInput, sealedModelBlockEvidenceInput, modelBlockHosts, modelHostAddHostArgs, planModelHostBlock, resolveWithBlock, sealedModelHostPairs,
} from "../../packages/worker/src/model-helper-block.js";
import { ModelHostRecorder } from "../../packages/worker/src/model-helper-recorder.js";
import { MODEL_HELPER_ALIAS } from "../../packages/worker/src/run-network.js";

const rows = (): readonly ModelCatalogRow[] => builtinModelCatalog().rows;
const gateway = (id: string, host: string): CompanyGatewayRow => ({ id, host, family: "openai_compatible", auth: { scheme: "bearer" } });
const GATEWAYS: readonly CompanyGatewayRow[] = [gateway("corp-gw", "llm.gateway-example.com"), gateway("team-gw", "ai.team-example.org")];
const HELPER_IP = "172.30.7.9";

/** The names an `--add-host` argument list points at an address. */
const addHostPairs = (args: readonly string[]): Array<[string, string]> => args.flatMap((arg, index) => (args[index - 1] === "--add-host" ? [arg.split(":") as [string, string]] : []));

describe("the block list is generated from the catalog, never written by hand", () => {
  it("holds every model host, every gateway host and every regional Vertex host", () => {
    const hosts = modelBlockHosts(rows(), GATEWAYS);
    for (const row of rows()) for (const host of row.hosts) expect(hosts, host).toContain(host);
    for (const host of GATEWAYS.map((entry) => entry.host)) expect(hosts).toContain(host);
    for (const host of ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"]) expect(hosts).not.toContain(host);
    const vertex = rows().find((row) => row.id === "vertex");
    expect(vertex).toBeDefined();
    const regional = vertex!.hosts.filter((host) => /-aiplatform\.googleapis\.com$/u.test(host));
    expect(regional.length).toBeGreaterThan(30);
    for (const host of regional) expect(hosts).toContain(host);
    for (const host of ["generativelanguage.googleapis.com", "api.openai.com", "api.anthropic.com", "openrouter.ai", "us-central1-aiplatform.googleapis.com"]) expect(hosts).toContain(host);
  });
  it("is F0a's model-host list, with no token host even without Google rows", () => {
    expect(modelBlockHosts(rows(), GATEWAYS)).toEqual(modelHostBlockList(rows(), GATEWAYS));
    const noGoogle = rows().filter((row) => !["vertex", "gemini", "gemini-openai"].includes(row.id));
    for (const host of ["iamcredentials.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com"]) expect(modelBlockHosts(noGoogle, [])).not.toContain(host);
    expect(modelBlockHosts(noGoogle, [])).toContain("api.openai.com");
  });
  it("keeps token hosts out of helper, blackhole and sealed DNS mappings", () => {
    for (const hasModelRow of [true, false]) {
      const block = planModelHostBlock({ hasModelRow, helperIp: HELPER_IP, nonAiGate: true, wallsOffered: true });
      for (const host of ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"]) {
        expect(resolveWithBlock(block, host)).toBeUndefined();
        expect(addHostPairs(modelHostAddHostArgs(block)).map(([name]) => name)).not.toContain(host);
        expect(sealedModelHostPairs(block).map((pair) => pair.split("=")[0])).not.toContain(host);
      }
      expect(resolveWithBlock(block, "firebasevertexai.googleapis.com")).toBe(hasModelRow ? HELPER_IP : MODEL_BLACKHOLE_ADDRESS);
      expect(resolveWithBlock(block, "api.openai.com")).toBe(hasModelRow ? HELPER_IP : MODEL_BLACKHOLE_ADDRESS);
    }
  });
  it("a row added to the catalog without any block code gets a block entry in BOTH the --add-host list and the sealed DNS table", () => {
    const extra: ModelCatalogRow = { ...rows().find((row) => row.id === "openai")!, id: "newprovider", hosts: ["api.new-provider-example.com"], pathPrefix: "/v1" };
    const block = planModelHostBlock({ rows: [...rows(), extra], gatewayRows: [], hasModelRow: true, helperIp: HELPER_IP });
    expect(addHostPairs(modelHostAddHostArgs(block)).map(([host]) => host)).toContain("api.new-provider-example.com");
    expect(sealedModelHostPairs(block).map((pair) => pair.split("=")[0])).toContain("api.new-provider-example.com");
  });
  it("the --add-host names and the sealed DNS table names are the same set, each at the helper's address", () => {
    const block = planModelHostBlock({ rows: rows(), gatewayRows: GATEWAYS, hasModelRow: true, helperIp: HELPER_IP });
    const addHost = addHostPairs(modelHostAddHostArgs(block));
    const sealed = sealedModelHostPairs(block).map((pair) => pair.split("=") as [string, string]);
    const modelNames = (pairs: Array<[string, string]>) => pairs.filter(([host]) => host !== MODEL_HELPER_ALIAS).map(([host]) => host).sort();
    expect(modelNames(addHost)).toEqual(modelBlockHosts(rows(), GATEWAYS));
    expect(modelNames(sealed)).toEqual(modelBlockHosts(rows(), GATEWAYS));
    for (const [, address] of [...addHost, ...sealed]) expect(address).toBe(HELPER_IP);
  });
});

describe("no wildcard, and no host that is not a model host", () => {
  it("every blocked name is one exact lower-case public host name", () => {
    for (const host of modelBlockHosts(rows(), GATEWAYS)) expect(checkModelHost(host), host).toEqual({ ok: true, host });
  });
  it("never blocks Cloud Storage or the shared Google API names", () => {
    const hosts = modelBlockHosts(rows(), GATEWAYS);
    for (const host of ["storage.googleapis.com", "www.googleapis.com", "googleapis.com", "oauth2.googleapis.com.evil.example", "compute.googleapis.com", "cloudresourcemanager.googleapis.com", "secretmanager.googleapis.com"]) expect(hosts).not.toContain(host);
    expect(hosts.filter((host) => host.endsWith(".googleapis.com")).every((host) => /^(?:[a-z0-9-]+-)?aiplatform(?:\.mtls)?\.googleapis\.com$|^generativelanguage(?:\.mtls)?\.googleapis\.com$|^firebasevertexai\.googleapis\.com$|^aiplatform\.[a-z0-9-]+\.rep(?:\.mtls)?\.googleapis\.com$/u.test(host))).toBe(true);
    for (const arg of modelHostAddHostArgs(planModelHostBlock({ rows: rows(), gatewayRows: GATEWAYS, hasModelRow: true, helperIp: HELPER_IP }))) expect(arg).not.toContain("*");
  });
  it("refuses a wildcard, an address, a scheme and a path wherever a host could come from (a row, a gateway, the planner)", () => {
    for (const bad of ["*.googleapis.com", "*", "https://api.openai.com", "api.openai.com/v1", "10.0.0.5", "localhost", "API.OPENAI.COM", "a b.example.com", ""]) {
      const row: ModelCatalogRow = { ...rows()[0]!, hosts: [bad] };
      expect(() => planModelHostBlock({ rows: [row], gatewayRows: [], hasModelRow: true, helperIp: HELPER_IP }), bad).toThrow();
      expect(() => planModelHostBlock({ rows: [], gatewayRows: [gateway("g", bad)], hasModelRow: true, helperIp: HELPER_IP }), bad).toThrow();
    }
  });
  it("lists a host SUFFIX row (Azure OpenAI) as not blockable by name, never as a host", () => {
    const block = planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: true, helperIp: HELPER_IP });
    expect(block.suffixesNotBlockedByName).toEqual(modelHostSuffixBlockList(rows()));
    expect(block.suffixesNotBlockedByName).toContain("openai.azure.com");
    expect(block.hosts.some((host) => host.endsWith("openai.azure.com"))).toBe(false);
  });
});

describe("where the names point", () => {
  it("a project with a model row: every name at the helper (.9), plus the helper's own name", () => {
    const block = planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: true, helperIp: HELPER_IP });
    expect(block).toMatchObject({ mode: "by_name", target: "helper", address: HELPER_IP, helperAlias: true });
    const pairs = addHostPairs(modelHostAddHostArgs(block));
    expect(pairs).toContainEqual([MODEL_HELPER_ALIAS, HELPER_IP]);
    expect(pairs.length).toBe(modelBlockHosts(rows(), []).length + 1);
  });
  it("a project with no model row, behind the company gate: the same names at 10.255.255.1, no helper name", () => {
    expect(MODEL_BLACKHOLE_ADDRESS).toBe("10.255.255.1");
    expect(MODEL_HOST_BLOCK_GATE_NAME).toBe("modelHostBlockNonAi");
    const block = planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: false, nonAiGate: true, wallsOffered: true });
    expect(block).toMatchObject({ mode: "by_name", target: "blackhole", address: "10.255.255.1", helperAlias: false });
    const pairs = addHostPairs(modelHostAddHostArgs(block));
    expect(pairs.every(([, address]) => address === "10.255.255.1")).toBe(true);
    expect(pairs.some(([host]) => host === MODEL_HELPER_ALIAS)).toBe(false);
    expect(pairs.map(([host]) => host).sort()).toEqual(modelBlockHosts(rows(), []));
  });
  it("a project with no model row and the gate off or absent: no block at all (today's behaviour), mode none", () => {
    for (const nonAiGate of [false, undefined]) {
      const block = planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: false, ...(nonAiGate === undefined ? {} : { nonAiGate }) });
      expect(block).toMatchObject({ mode: "none", target: "none", address: undefined, hosts: [], helperAlias: false });
      expect(modelHostAddHostArgs(block)).toEqual([]);
    }
  });
  it("the gate does not change a project WITH a model row (the helper is the product, the gate is for non-AI projects)", () => {
    for (const nonAiGate of [true, false, undefined]) {
      const block = planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: true, helperIp: HELPER_IP, ...(nonAiGate === undefined ? {} : { nonAiGate }) });
      expect(block.target).toBe("helper");
    }
  });
  it("refuses a helper address that is not .9 of a run network, and a model-row project with no helper address", () => {
    for (const bad of ["172.30.7.8", "172.30.7.10", "172.30.7.19", "172.29.7.9", "10.255.255.1", "8.8.8.8", "172.30.7.9 ", "172.30.256.9", "", "172.30.7.09"]) {
      expect(() => planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: true, helperIp: bad }), bad).toThrow();
    }
    expect(() => planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: true })).toThrow();
  });
  it("the sealed DNS table has the same names at the same address, as `name=address` pairs (the sealed helper's --host shape)", () => {
    const block = planModelHostBlock({ rows: rows(), gatewayRows: GATEWAYS, hasModelRow: true, helperIp: HELPER_IP });
    const pairs = sealedModelHostPairs(block);
    expect(pairs.every((pair) => /^[a-z0-9.-]+=172\.30\.7\.9$/u.test(pair))).toBe(true);
    expect(sealedModelHostPairs(planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: false, nonAiGate: true, wallsOffered: true }))).toEqual([]);
  });
  it("resolveWithBlock answers the block's address for a blocked name (any case, trailing dot) and undefined for any other", () => {
    const block = planModelHostBlock({ rows: rows(), gatewayRows: GATEWAYS, hasModelRow: true, helperIp: HELPER_IP });
    expect(resolveWithBlock(block, "api.openai.com")).toBe(HELPER_IP);
    expect(resolveWithBlock(block, "API.OPENAI.COM.")).toBe(HELPER_IP);
    expect(resolveWithBlock(block, MODEL_HELPER_ALIAS)).toBe(HELPER_IP);
    expect(resolveWithBlock(block, "storage.googleapis.com")).toBeUndefined();
    expect(resolveWithBlock(block, "registry.npmjs.org")).toBeUndefined();
  });
});

describe("the block mode of a round: by name, and sealed only from a sealed plan", () => {
  it("the working round and the unsealed check round are by_name; anything unknown is read as unsealed; check_sealed is never read from a free string", () => {
    expect(blockModeForRound("working")).toBe("by_name");
    expect(blockModeForRound("check_unsealed")).toBe("by_name");
    for (const odd of [undefined, null, "", "sealed", "SEALED", "check_sealed ", "check-sealed", 1, {}, ["check_sealed"], "__proto__"]) expect(blockModeForRound(odd), typeof odd).toBe("by_name");
    expect(() => blockModeForRound("check_sealed")).toThrow();
  });
  it("the evidence input of an unsealed round carries blockMode by_name, the block list and the suffixes, and its lines say 'not sealed; model hosts blocked by name only'", () => {
    const block = planModelHostBlock({ rows: rows(), gatewayRows: GATEWAYS, hasModelRow: true, helperIp: HELPER_IP });
    for (const kind of ["working", "check_unsealed"] as const) {
      const input = modelBlockEvidenceInput(kind, block);
      expect(input.blockMode).toBe("by_name");
      expect(input.blockList).toEqual(modelBlockHosts(rows(), GATEWAYS));
      expect(input.hostSuffixes).toEqual(modelHostSuffixBlockList(rows()));
      const lines = evidenceLinesFor(kind, { classes: [], blockList: input.blockList, hostSuffixes: input.hostSuffixes, observedHosts: ["api.openai.com"] });
      expect(lines[0]).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
      expect(lines).toContain(redirectEscapeSentence("api.openai.com"));
      expect(lines.some((line) => /(?<!not )sealed/iu.test(line))).toBe(false);
    }
  });
  it("a project with no block at all reports mode none, never by_name or sealed", () => {
    const none = planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: false });
    expect(modelBlockEvidenceInput("working", none).blockMode).toBe("none");
  });
  it("refuses a by-name block with check_sealed: a sealed round's evidence is not made from a by-name block", () => {
    const blocks = [planModelHostBlock({ gatewayRows: [], hasModelRow: true, helperIp: HELPER_IP }), planModelHostBlock({ gatewayRows: [], hasModelRow: false, nonAiGate: true, wallsOffered: true }), planModelHostBlock({ gatewayRows: [], hasModelRow: false })];
    for (const block of blocks) expect(() => modelBlockEvidenceInput("check_sealed", block)).toThrow();
  });
  it("sealed is derived from the sealed plan: its DNS helper arguments must carry every model host at the helper's address, and the working sandbox must be detached", () => {
    const block = planModelHostBlock({ gatewayRows: GATEWAYS, hasModelRow: true, helperIp: HELPER_IP });
    const plan = (over: Partial<{ mustDetachWorking: boolean; dnsHelperRunArgs: string[] }> = {}) => ({ mustDetachWorking: true as const, dnsHelperRunArgs: ["run", ...sealedModelHostPairs(block).flatMap((pair) => ["--host", pair])], ...over }) as Parameters<typeof sealedModelBlockEvidenceInput>[0];
    const input = sealedModelBlockEvidenceInput(plan(), block);
    expect(input).toEqual({ blockMode: "sealed", blockList: [...block.hosts], hostSuffixes: [], azureOpenAiNotBlocked: false });
    // The plan 9d builds today carries no model host: nothing can claim sealed yet.
    expect(() => sealedModelBlockEvidenceInput(plan({ dnsHelperRunArgs: ["run"] }), block)).toThrow();
    expect(() => sealedModelBlockEvidenceInput(plan({ dnsHelperRunArgs: plan().dnsHelperRunArgs.slice(0, -2) }), block)).toThrow();
    expect(() => sealedModelBlockEvidenceInput(plan({ mustDetachWorking: false }), block)).toThrow();
    expect(() => sealedModelBlockEvidenceInput(plan(), planModelHostBlock({ gatewayRows: [], hasModelRow: false, nonAiGate: true, wallsOffered: true }))).toThrow();
    expect(() => sealedModelBlockEvidenceInput({} as never, block)).toThrow();
  });
  it("no input to the by-name functions makes an unsealed round read as sealed", () => {
    const blocks = [planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: true, helperIp: HELPER_IP }), planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: false, nonAiGate: true, wallsOffered: true }), planModelHostBlock({ rows: rows(), gatewayRows: [], hasModelRow: false })];
    for (const block of blocks) for (const kind of ["working", "check_unsealed", undefined, "x", 3] as const) expect(modelBlockEvidenceInput(kind as never, block).blockMode).not.toBe("sealed");
  });
});

describe("the catalog is never replaced (a partial `rows` still blocks every built-in host)", () => {
  it("passing one OpenAI row still blocks every built-in name (about 107) at the helper", () => {
    const full = modelBlockHosts(rows(), []);
    expect(full.length).toBeGreaterThan(100);
    const one = planModelHostBlock({ rows: [rows().find((row) => row.id === "openai")!], hasModelRow: true, helperIp: HELPER_IP });
    expect(one.hosts).toEqual(full);
    expect(one.suffixesNotBlockedByName).toEqual(modelHostSuffixBlockList(rows()));
    expect(addHostPairs(modelHostAddHostArgs(one)).length).toBe(full.length + 1);
    const none = planModelHostBlock({ rows: [], hasModelRow: false, nonAiGate: true, wallsOffered: true });
    expect(none.hosts).toEqual(full);
  });
});

describe("Azure OpenAI (a host suffix a hosts file cannot hold)", () => {
  it("blocks the project's own concrete resource host by name when it is known, at the helper's address", () => {
    const block = planModelHostBlock({ hasModelRow: true, helperIp: HELPER_IP, azureResourceHosts: ["myco-eastus.openai.azure.com"] });
    expect(block.hosts).toContain("myco-eastus.openai.azure.com");
    expect(addHostPairs(modelHostAddHostArgs(block))).toContainEqual(["myco-eastus.openai.azure.com", HELPER_IP]);
    expect(sealedModelHostPairs(block)).toContain(`myco-eastus.openai.azure.com=${HELPER_IP}`);
    const dropped = planModelHostBlock({ hasModelRow: false, nonAiGate: true, wallsOffered: true, azureResourceHosts: ["myco-eastus.openai.azure.com"] });
    expect(dropped.hosts).toContain("myco-eastus.openai.azure.com");
  });
  it("refuses a resource host that is not exactly one label under a catalog suffix", () => {
    for (const bad of ["openai.azure.com", "evil.example.com", "a.b.openai.azure.com", "*.openai.azure.com", "https://x.openai.azure.com", "X.openai.azure.com", "x.openai.azure.com.evil.example", "", "10.0.0.1"]) {
      expect(() => planModelHostBlock({ hasModelRow: true, helperIp: HELPER_IP, azureResourceHosts: [bad] }), bad).toThrow();
    }
  });
  it("the evidence input says Azure OpenAI is not blocked in the round whenever the suffix list is not empty, and the sentence is fixed", () => {
    expect(AZURE_OPENAI_NOT_BLOCKED_SENTENCE).toBe("Azure resource hosts under openai.azure.com, cognitiveservices.azure.com, services.ai.azure.com and models.ai.azure.com are not blocked in this round unless listed by name: clients can reach other resource hosts directly");
    const block = planModelHostBlock({ hasModelRow: true, helperIp: HELPER_IP, azureResourceHosts: ["myco.openai.azure.com"] });
    for (const kind of ["working", "check_unsealed"] as const) {
      const input = modelBlockEvidenceInput(kind, block);
      expect(input.hostSuffixes).toContain("openai.azure.com");
      expect(input.azureOpenAiNotBlocked).toBe(true);
    }
    expect(modelBlockEvidenceInput("working", planModelHostBlock({ hasModelRow: false })).azureOpenAiNotBlocked).toBe(false);
  });
});

describe("the non-AI blackhole needs the walls", () => {
  it("is applied only when the worker offers the walls; without them there is no block and the reason is recorded", () => {
    const withWalls = planModelHostBlock({ hasModelRow: false, nonAiGate: true, wallsOffered: true });
    expect(withWalls).toMatchObject({ mode: "by_name", target: "blackhole" });
    expect(withWalls.noBlockReason).toBeUndefined();
    for (const wallsOffered of [false, undefined]) {
      const block = planModelHostBlock({ hasModelRow: false, nonAiGate: true, ...(wallsOffered === undefined ? {} : { wallsOffered }) });
      expect(block).toMatchObject({ mode: "none", target: "none", hosts: [], noBlockReason: "walls_not_offered" });
      expect(modelHostAddHostArgs(block)).toEqual([]);
    }
    expect(planModelHostBlock({ hasModelRow: false, wallsOffered: true })).toMatchObject({ mode: "none", noBlockReason: "gate_off" });
  });
});

describe("the required test: no request reaches a real model host (offline)", () => {
  /** A TLS client's ClientHello for `servername`, sent to the recorder on loopback (the block's address is simulated by `resolveWithBlock`, which is what /etc/hosts does in the sandbox). */
  async function tlsHello(port: number, servername: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const client = tls.connect({ host: "127.0.0.1", port, servername });
      client.on("error", () => resolve());
      client.on("close", () => resolve());
    });
  }
  async function plainRequest(port: number, host: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.on("connect", () => socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0\r\n\r\n`));
      socket.on("error", () => resolve());
      socket.on("close", () => resolve());
    });
  }
  it("every blocked name resolves to the helper, and a client that ignores its redirect lands in the helper's record by name, with only loopback dialled", async () => {
    const block = planModelHostBlock({ rows: rows(), gatewayRows: GATEWAYS, hasModelRow: true, helperIp: HELPER_IP });
    const recorder = new ModelHostRecorder({ listenAddress: "127.0.0.1", allowedSources: ["127.0.0.1"], tlsPort: 0, httpPort: 0, readTimeoutMs: 500 });
    const ports = await recorder.start();
    const tripwire = installNetworkTripwire();
    const sample = ["generativelanguage.googleapis.com", "api.openai.com", "us-central1-aiplatform.googleapis.com", "firebasevertexai.googleapis.com", "api.anthropic.com", "llm.gateway-example.com", "openrouter.ai"];
    try {
      for (const host of sample) {
        // The name block: this is the address /etc/hosts gives the client. A name the block does not list would resolve to undefined here and the test would fail below.
        expect(resolveWithBlock(block, host), host).toBe(HELPER_IP);
        await tlsHello(ports.tls, host);
      }
      await plainRequest(ports.http, "api.openai.com");
    } finally {
      tripwire.restore();
      await recorder.stop();
    }
    // Only loopback was dialled: the tripwire refuses and records anything else.
    expect(tripwire.attempts).toEqual([]);
    const seen = recorder.snapshot();
    expect(seen.hosts).toEqual([...sample].sort());
    const escapes = findRedirectEscapes(block.hosts, seen.hosts, { hostSuffixes: block.suffixesNotBlockedByName });
    expect(escapes.map((entry) => entry.sentence).sort()).toEqual([...sample].sort().map((host) => redirectEscapeSentence(host)));
    expect(escapes.every((entry) => entry.kind === "ignored_redirect")).toBe(true);
  });
  it("the tripwire would catch a real dial: a connect to a blocked name's real address fails the test", () => {
    const tripwire = installNetworkTripwire();
    try {
      expect(() => net.connect({ host: "api.openai.com", port: 443 })).toThrow(/tripwire/u);
    } finally {
      tripwire.restore();
    }
    expect(tripwire.attempts.map((entry) => entry.target)).toEqual(["api.openai.com"]);
  });
});

describe("no callers yet (TE-F1b is additive: only task-sandbox.ts takes the block; nothing wires a helper into a task)", () => {
  const NEW_MODULES = ["model-helper-block", "model-helper-network", "model-helper-launch", "model-helper-recorder", "model-sandbox-env"];
  it("no file outside the lane's own files and tests imports the new modules, except task-sandbox.ts (the block)", () => {
    const pattern = NEW_MODULES.map((name) => `/${name}\\.js`).join("|");
    let found = "";
    try {
      found = execFileSync("git", ["grep", "-lE", pattern, "--", "packages", "scripts", "tests", "infra"], { encoding: "utf8" });
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error;
    }
    const importers = found.split("\n").filter((file) => file !== "").filter((file) => !NEW_MODULES.some((name) => file === `packages/worker/src/${name}.ts`) && !/^tests\/unit\/(?:model-helper-|model-sandbox-env|worker-model-helper-network)/u.test(file)
      // TE-F1c reads F1-b's evidence words (the Azure sentence and the block facts) in its ledger: exact files.
      && !["packages/worker/src/model-bridge-ledger.ts", "tests/unit/model-bridge-ledger.test.ts"].includes(file));
    expect(importers).toEqual(["packages/worker/src/task-sandbox.ts"]);
  });
  it("the worker's entry points do not start a model helper, advertise its feature, or call the gate", () => {
    for (const file of ["packages/worker/src/main.ts", "packages/worker/src/run-task.ts", "packages/worker/src/implemented-features.ts"]) {
      const text = (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })();
      expect(text, file).not.toMatch(/model-helper-(?:network|launch|block|recorder)|startModelHelper|modelHelperOffer|task\.modelHelper\.v1/u);
    }
  });
});

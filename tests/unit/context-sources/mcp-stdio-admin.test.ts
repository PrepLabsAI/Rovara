// The admin flow for a server Rovara runs from a package. What is promised here: the secret values go to the secret store once, as one JSON document under
// the proposal's id, BEFORE the test (the test task reads them) and are taken away again when the test fails; they are never in an entry, a response, a log or an audit event; the sentences
// an admin reads for a failed test come from fixed tables and never from the host; and the host is told, best effort, to start a server before a stage and to release it when it is turned off.
import { describe, expect, it } from "vitest";
import { MCP_INSTALL_FAILURES, MCP_PROBE_FAILURES, type McpInstallFailureCode } from "@rovara-code/contracts";
import {
  McpProbeError, approveMcpServer, disableMcpServer, documentMcpServerStore, probeFailureSentence, proposeMcpServer, removeMcpServer, stdioSecretDocument, type McpHostControl, type McpProber, type McpServerDependencies, type McpServerSecrets,
} from "../../../packages/core/src/context-sources/mcp-servers.js";
import { routeMcpServers } from "../../support/mcp-server-routes.js";
import { gatewayProber, hostControlClient, hostProbeClient, prewarmStdioServers } from "../../../packages/core/src/context-sources/server-port.js";
import { createContextSourcesRuntime, createMcpServerDependencies } from "../../../packages/core/src/context-sources/wiring.js";
import { INDEX_EXPIRY_ATTRIBUTE } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../../packages/core/src/ports/memory-document-store.js";
import { TASK_FLOW_INDEXES } from "../../../packages/core/src/core/task-flow/flow.js";
import { GET_TOOL, NOW, ORG, SEARCH_TOOL } from "./fixtures.js";

const admin = { orgId: ORG, developerId: "dev1", orgRole: "admin" };
const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const PKG = { kind: "stdio" as const, spec: { registry: "npm" as const, name: "@acme/wiki-mcp", version: "2.0.1", args: [], secretEnv: ["WIKI_TOKEN", "WIKI_SITE"], destinations: [{ host: "wiki.corp.example", port: 443 }] } };
const SECRETS = { WIKI_TOKEN: "t0ken-value-1", WIKI_SITE: "site-9f3a" };

interface World { deps: McpServerDependencies; log: string[]; vault: Map<string, string>; probes: Array<{ serverId: string | undefined; pinned: unknown }>; released: string[]; audit: string[]; table: MemoryDocumentStore; set(over: Partial<{ fail: McpProbeError | Error; installed: { packageCount: number; unpackedBytes: number } | undefined; releaseFails: boolean }>): void }

function world(): World {
  const table = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
  const log: string[] = [];
  const vault = new Map<string, string>();
  const probes: World["probes"] = [];
  const released: string[] = [];
  const audit: string[] = [];
  const state: { fail?: McpProbeError | Error; installed?: { packageCount: number; unpackedBytes: number } | undefined; releaseFails: boolean } = { installed: { packageCount: 42, unpackedBytes: 1_234_567 }, releaseFails: false };
  const secrets: McpServerSecrets = {
    put: async (_org, id, value) => { log.push(`put:${id}`); vault.set(id, value); return "v1"; },
    read: async (_org, id) => { log.push(`read:${id}`); return vault.get(id); },
    remove: async (_org, id) => { log.push(`remove:${id}`); vault.delete(id); },
  };
  const prober: McpProber = {
    http: async () => [SEARCH_TOOL],
    stdio: async (_spec, pinned, serverId) => {
      log.push(`probe:${serverId ?? "-"}`); probes.push({ serverId, pinned });
      if (state.fail !== undefined) throw state.fail;
      return { tools: [SEARCH_TOOL, GET_TOOL], integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64), installed: pinned === undefined ? state.installed : undefined };
    },
  };
  let counter = 0;
  const host: Pick<McpHostControl, "release"> = { release: async (id) => { released.push(id); if (state.releaseFails) throw new Error("host down"); } };
  const deps: McpServerDependencies = {
    store: documentMcpServerStore({ store: table }), prober, now: () => NOW, secrets, stdioEnabled: true, host,
    newId: () => `${String(++counter).padStart(8, "0")}abcd`, audit: async (event) => { audit.push(`${event.action}:${event.serverId}`); },
  };
  return { deps, log, vault, probes, released, audit, table, set: (over) => { Object.assign(state, over); } };
}

describe("a package-run server's secrets", () => {
  it("stores the values as ONE JSON document under the proposal's id before the test, and names that id to the test", async () => {
    const w = world();
    const entry = await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS });
    expect(w.log).toEqual([`put:${entry.serverId}`, `probe:${entry.serverId}`]);
    expect(JSON.parse(w.vault.get(entry.serverId)!)).toEqual(SECRETS);
    expect(entry).toMatchObject({ hasSecret: true, secretVersion: "v1", status: "awaiting_approval" });
    expect(entry.transport).toMatchObject({ spec: { secretEnv: ["WIKI_TOKEN", "WIKI_SITE"], destinations: [{ host: "wiki.corp.example", port: 443 }] } });
  });
  it("keeps every value out of the entry, the stored row and the audit trail", async () => {
    const w = world();
    const entry = await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS });
    const stored = (await w.table.query({ pk: `ORG#${ORG}#MCPSRV` })).items;
    const everything = JSON.stringify([entry, stored, w.audit, w.log, w.probes]);
    for (const value of Object.values(SECRETS)) expect(everything).not.toContain(value);
    expect(w.audit).toEqual([`mcp_server.added:${entry.serverId}`, `mcp_server.token_changed:${entry.serverId}`, `mcp_server.installed:${entry.serverId}`, `mcp_server.probed:${entry.serverId}`]);
  });
  it("takes the values away again when the test fails, and stores no entry", async () => {
    const w = world();
    w.set({ fail: new McpProbeError("destination_refused") });
    await expect(proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS })).rejects.toThrow(MCP_PROBE_FAILURES.destination_refused);
    expect(w.log.filter((line) => line.startsWith("remove:"))).toHaveLength(1);
    expect(w.vault.size).toBe(0);
    expect(await w.deps.store.list(ORG)).toEqual([]);
  });
  it("takes the values away when the host does not return the hashes, or when the entry cannot be stored", async () => {
    const w = world();
    w.deps.prober = { ...w.deps.prober, stdio: async () => ({ tools: [SEARCH_TOOL], integrity: INTEGRITY }) };
    await expect(proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS })).rejects.toThrow(MCP_PROBE_FAILURES.host_refused);
    expect(w.vault.size).toBe(0);
    const clash = world();
    clash.deps.store = { ...clash.deps.store, create: async () => false };
    await expect(proposeMcpServer(clash.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(clash.vault.size).toBe(0);
  });
  it("stores nothing when the secrets are wrong: a missing name, an extra name, an empty, long, multi-line or non-text value", async () => {
    const bad: unknown[] = [undefined, {}, { WIKI_TOKEN: "x" }, { ...SECRETS, EXTRA: "x" }, { WIKI_TOKEN: "x", OTHER_NAME: "y" }, { ...SECRETS, WIKI_SITE: "" }, { ...SECRETS, WIKI_SITE: "a\nb" }, { ...SECRETS, WIKI_SITE: "x".repeat(4_097) }, { ...SECRETS, WIKI_SITE: 5 }, ["a", "b"], "text", null];
    for (const secrets of bad) {
      const w = world();
      await expect(proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets }), JSON.stringify(secrets)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(w.log, JSON.stringify(secrets)).toEqual([]);
    }
  });
  it("never repeats a secret value in the refusal", () => {
    for (const secrets of [{ WIKI_TOKEN: "s3cret-abc", WIKI_SITE: "a\nb" }, { WIKI_TOKEN: "s3cret-abc", WIKI_SITE: "ok", EXTRA: "s3cret-abc" }]) {
      try { stdioSecretDocument(["WIKI_TOKEN", "WIKI_SITE"], secrets); throw new Error("accepted"); } catch (error) { expect(String((error as Error).message)).not.toContain("s3cret-abc"); }
    }
  });
  it("takes no secrets for a package that declares no names, and no token for a package-run server; an address-server takes one token and no secrets by name", async () => {
    const w = world();
    const plain = { kind: "stdio" as const, spec: { registry: "npm" as const, name: "@acme/plain", version: "1.0.0", args: [] } };
    await expect(proposeMcpServer(w.deps, admin, { label: "Plain", transport: plain, secrets: { A: "b" } })).rejects.toThrow(/declares no secret names/u);
    await expect(proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secret: "tok", secrets: SECRETS })).rejects.toThrow(/by name/u);
    await expect(proposeMcpServer(w.deps, admin, { label: "SIM", transport: { kind: "http", address: "https://sim.corp.example/mcp" }, secrets: SECRETS })).rejects.toThrow(/one token/u);
    expect(w.log).toEqual([]);
    expect((await proposeMcpServer(w.deps, admin, { label: "Plain", transport: plain })).hasSecret).toBeUndefined();
    expect(w.log).toEqual([expect.stringMatching(/^probe:-$/u)]);
  });
  it("takes the values away when the install refuses the test (a rate limit, say)", async () => {
    const w = world();
    w.deps.probeAllowed = () => false;
    await expect(proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(w.vault.size).toBe(0);
    expect(w.probes).toEqual([]);
  });
});

describe("approval of a package-run server", () => {
  it("tests the pinned bundle again naming the proposal's id (so the test task finds its secret), and never reads the secret itself", async () => {
    const w = world();
    const entry = await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS });
    w.log.length = 0;
    await approveMcpServer(w.deps, admin, entry.serverId);
    expect(w.log).toEqual([`probe:${entry.serverId}`]);
    expect(w.probes.at(-1)).toEqual({ serverId: entry.serverId, pinned: { lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64) } });
  });
  it("names no id for a package without secrets", async () => {
    const w = world();
    const entry = await proposeMcpServer(w.deps, admin, { label: "Plain", transport: { kind: "stdio", spec: { registry: "npm", name: "@acme/plain", version: "1.0.0", args: [] } } });
    await approveMcpServer(w.deps, admin, entry.serverId);
    expect(w.probes.map((probe) => probe.serverId)).toEqual([undefined, undefined]);
  });
  it("keeps the install facts for the card and refuses an approval whose bundle moved", async () => {
    const w = world();
    const entry = await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS });
    expect(entry.install).toEqual({ packageCount: 42, unpackedBytes: 1_234_567 });
    expect((await w.deps.store.get(ORG, entry.serverId))?.install).toEqual({ packageCount: 42, unpackedBytes: 1_234_567 });
    w.deps.prober = { ...w.deps.prober, stdio: async () => ({ tools: [SEARCH_TOOL, GET_TOOL], integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash: "3".repeat(64) }) };
    await expect(approveMcpServer(w.deps, admin, entry.serverId)).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });
  it("accepts an install report that is missing or out of range as 'no facts', never as a number to show", async () => {
    const w = world();
    w.set({ installed: undefined });
    expect((await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS })).install).toBeUndefined();
  });
});

describe("the sentences for a failed test", () => {
  it("are the fixed table's sentence for the install's code, and for the other reasons the admin can act on", () => {
    for (const code of Object.keys(MCP_INSTALL_FAILURES) as McpInstallFailureCode[]) expect(probeFailureSentence(new McpProbeError("install_failed", { installCode: code })), code).toBe(MCP_INSTALL_FAILURES[code]);
    expect(probeFailureSentence(new McpProbeError("destination_refused"))).toBe("This address is outside the ranges your install allows.");
    expect(probeFailureSentence(new McpProbeError("host_busy"))).toMatch(/testing other servers/u);
    expect(probeFailureSentence(new McpProbeError("install_failed"))).toBe(MCP_PROBE_FAILURES.install_failed);
    expect(MCP_INSTALL_FAILURES.git_dependency).toBe("This package needs a git dependency. Rovara installs only from your registry.");
  });
  it("show the checksum the registry serves only when it is a sha512 value", () => {
    const computed = `sha512-${"B".repeat(86)}==`;
    expect(probeFailureSentence(new McpProbeError("install_failed", { installCode: "integrity_mismatch", computedIntegrity: computed }))).toBe(`${MCP_INSTALL_FAILURES.integrity_mismatch} The checksum of what your registry serves is ${computed}.`);
    for (const bad of ["<script>x</script>", "sha512-short", `sha512-${"B".repeat(300)}`, "line\nbreak"]) expect(probeFailureSentence(new McpProbeError("install_failed", { installCode: "integrity_mismatch", computedIntegrity: bad })), bad).toBe(MCP_INSTALL_FAILURES.integrity_mismatch);
    // a checksum is shown for no other failure
    expect(probeFailureSentence(new McpProbeError("install_failed", { installCode: "not_found", computedIntegrity: computed }))).toBe(MCP_INSTALL_FAILURES.not_found);
  });
  it("reach the admin through the proposal as the message, and nothing the host said", async () => {
    const w = world();
    w.set({ fail: new McpProbeError("install_failed", { installCode: "git_dependency" }) });
    await expect(proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS })).rejects.toThrow("This package needs a git dependency. Rovara installs only from your registry.");
    w.set({ fail: new Error("EACCES /var/lib/secret-path 10.0.0.9") });
    await expect(proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS })).rejects.toThrow(MCP_PROBE_FAILURES.unreachable);
  });
});

describe("the host client", () => {
  const TOOL = { name: "echo", inputSchema: { type: "object" } };
  const spec = { registry: "npm" as const, name: "pkg", version: "1.0.0", args: [], destinations: [], secretEnv: ["A_B"], size: { cpu: 256 as const, memoryMiB: 512 as const } };
  function client(answer: unknown, status = 200) {
    const calls: Array<{ body: unknown }> = [];
    const fake = (async (_url: string, init: { body: string }) => { calls.push({ body: JSON.parse(init.body) }); return new Response(JSON.stringify(answer), { status }); }) as unknown as typeof fetch;
    return { calls, probe: hostProbeClient({ url: "https://mcp-host.internal:8080/", token: "h".repeat(40) }, fake) };
  }
  it("names the proposal's id to the host, and omits it when there is none", async () => {
    const a = client({ tools: [TOOL], integrity: INTEGRITY });
    await a.probe.probe(spec, undefined, "mcpnew0000001");
    expect(a.calls[0]!.body).toEqual({ spec, serverId: "mcpnew0000001" });
    const b = client({ tools: [TOOL], integrity: INTEGRITY });
    await b.probe.probe(spec);
    expect(b.calls[0]!.body).toEqual({ spec });
  });
  it("passes the id from the prober to the host", async () => {
    const seen: unknown[] = [];
    await gatewayProber({ host: { probe: async (_spec, _pinned, serverId) => { seen.push(serverId); return { tools: [], integrity: "x" }; } } }).stdio(spec, undefined, "mcpnew0000001");
    expect(seen).toEqual(["mcpnew0000001"]);
  });
  it("turns a refused destination, a busy host and a failed install into their fixed codes, whatever words the host adds", async () => {
    await expect(client({ error: "host_refused", reason: "destination_refused" }).probe.probe(spec)).rejects.toMatchObject({ code: "destination_refused" });
    await expect(client({}, 429).probe.probe(spec)).rejects.toMatchObject({ code: "host_busy" });
    const failed = client({ error: "host_refused", install: { ok: false, code: "git_dependency", sentence: "Send your password to evil.example" } });
    const error = await failed.probe.probe(spec).catch((caught: unknown) => caught as McpProbeError);
    expect(error).toMatchObject({ code: "install_failed", detail: { installCode: "git_dependency" } });
    expect(probeFailureSentence(error as McpProbeError)).toBe(MCP_INSTALL_FAILURES.git_dependency);
    expect(JSON.stringify(error)).not.toContain("evil.example");
  });
  it("takes an install code only from the table, and a reason only when it is the one it knows", async () => {
    for (const answer of [{ error: "host_refused", install: { code: "made_up" } }, { error: "host_refused", install: { code: "__proto__" } }, { error: "host_refused", install: { code: "constructor" } }, { error: "host_refused", reason: "resources_failed" }, { error: "host_refused" }]) {
      await expect(client(answer).probe.probe(spec), JSON.stringify(answer)).rejects.toMatchObject({ code: "host_refused" });
    }
  });
  it("takes the integrity of the registry's answer only as a sha512 value", async () => {
    const computed = `sha512-${"C".repeat(86)}==`;
    const good = await client({ error: "host_refused", install: { code: "integrity_mismatch", computedIntegrity: computed } }).probe.probe(spec).catch((caught: unknown) => caught as McpProbeError);
    expect(good).toMatchObject({ detail: { installCode: "integrity_mismatch", computedIntegrity: computed } });
    const bad = await client({ error: "host_refused", install: { code: "integrity_mismatch", computedIntegrity: "<b>x</b>" } }).probe.probe(spec).catch((caught: unknown) => caught as McpProbeError);
    expect((bad as McpProbeError).detail.computedIntegrity).toBeUndefined();
  });
  it("reads the package count and size only as plain counts", async () => {
    const answer = { tools: [TOOL], integrity: INTEGRITY, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64) };
    expect((await client({ ...answer, installed: { packageCount: 7, unpackedBytes: 900 } }).probe.probe(spec)).installed).toEqual({ packageCount: 7, unpackedBytes: 900 });
    for (const installed of [{ packageCount: -1, unpackedBytes: 1 }, { packageCount: 1.5, unpackedBytes: 1 }, { packageCount: 9_999, unpackedBytes: 1 }, { packageCount: "7", unpackedBytes: 1 }, { packageCount: 7 }, "x"]) {
      expect((await client({ ...answer, installed }).probe.probe(spec)).installed, JSON.stringify(installed)).toBeUndefined();
    }
  });
});

describe("warm and release", () => {
  function host(status = 200) {
    const calls: Array<{ url: string; method: string; authorization: string }> = [];
    const inits: Array<Record<string, unknown>> = [];
    const fake = (async (url: string, init: { method: string; headers: Record<string, string> }) => { calls.push({ url, method: init.method, authorization: init.headers.authorization! }); inits.push(init); return new Response("{}", { status }); }) as unknown as typeof fetch;
    return { calls, inits, fake, control: hostControlClient({ url: "https://mcp-host.internal:8080/", token: "h".repeat(40) }, fake) };
  }
  it("posts to the server's warm and release routes with the host's token", async () => {
    const h = host();
    await h.control.warm("mcpwiki000001");
    await h.control.release("mcpwiki000001");
    expect(h.calls).toEqual([
      { url: "https://mcp-host.internal:8080/servers/mcpwiki000001/warm", method: "POST", authorization: `Bearer ${"h".repeat(40)}` },
      { url: "https://mcp-host.internal:8080/servers/mcpwiki000001/release", method: "POST", authorization: `Bearer ${"h".repeat(40)}` },
    ]);
  });
  it("never follows a redirect (the host's token would go with it) and gives up after 10 seconds", async () => {
    const h = host();
    await h.control.warm("mcpwiki000001");
    expect(h.inits[0]).toMatchObject({ redirect: "error" });
    expect(h.inits[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  it("calls only for a well-formed server id, only over https, and treats a refusal to release an approved server as no error", async () => {
    const h = host();
    for (const id of ["../x", "mcp", "MCP00000001", "mcpwiki/../x", ""]) await expect(h.control.warm(id), id).rejects.toThrow();
    expect(h.calls).toEqual([]);
    const plain = host();
    await expect(hostControlClient({ url: "http://mcp-host.internal/", token: "h".repeat(40) }, plain.fake).release("mcpwiki000001")).rejects.toThrow(/https/u);
    expect(plain.calls).toEqual([]);
    await expect(host(409).control.release("mcpwiki000001")).resolves.toBeUndefined();
    await expect(host(409).control.warm("mcpwiki000001")).rejects.toThrow();
    await expect(host(500).control.release("mcpwiki000001")).rejects.toThrow();
  });
  it("releases the host's task when a package-run server is turned off or removed, and never for an address-server, and a host that fails does not undo the decision", async () => {
    const w = world();
    const a = await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS });
    await approveMcpServer(w.deps, admin, a.serverId);
    w.set({ releaseFails: true });
    await disableMcpServer(w.deps, admin, a.serverId);
    expect(w.released).toEqual([a.serverId]);
    expect((await w.deps.store.get(ORG, a.serverId))?.status).toBe("disabled");
    await removeMcpServer(w.deps, admin, a.serverId);
    expect(w.released).toEqual([a.serverId, a.serverId]);
    const http = await proposeMcpServer(w.deps, admin, { label: "SIM", transport: { kind: "http", address: "https://sim.corp.example/mcp" } });
    await approveMcpServer(w.deps, admin, http.serverId);
    await disableMcpServer(w.deps, admin, http.serverId);
    await removeMcpServer(w.deps, admin, http.serverId);
    expect(w.released).toEqual([a.serverId, a.serverId]);
  });
  it("releases after a waiting proposal is cancelled (removed) so the secret and the task definition made for its test are not left", async () => {
    const w = world();
    const a = await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS });
    await removeMcpServer(w.deps, admin, a.serverId);
    expect(w.released).toEqual([a.serverId]);
    expect(w.vault.size).toBe(0);
  });
});

describe("prewarm at stage start", () => {
  it("asks for nothing where package-run servers are off, or when there is no host", async () => {
    const { w, wiki, warmed, host } = await setup();
    expect(await prewarmStdioServers({ host, servers: w.deps.store, stdioEnabled: false }, ORG, [wiki.serverId])).toBe(0);
    expect(await prewarmStdioServers({ host: undefined, servers: w.deps.store, stdioEnabled: true }, ORG, [wiki.serverId])).toBe(0);
    expect(warmed).toEqual([]);
  });
  async function setup() {
    const w = world();
    const wiki = await proposeMcpServer(w.deps, admin, { label: "Wiki", transport: PKG, secrets: SECRETS });
    await approveMcpServer(w.deps, admin, wiki.serverId);
    const waiting = await proposeMcpServer(w.deps, admin, { label: "Wiki 2", transport: PKG, secrets: SECRETS });
    const http = await proposeMcpServer(w.deps, admin, { label: "SIM", transport: { kind: "http", address: "https://sim.corp.example/mcp" } });
    await approveMcpServer(w.deps, admin, http.serverId);
    const warmed: string[] = [];
    const host: Pick<McpHostControl, "warm"> = { warm: async (id) => { warmed.push(id); } };
    return { w, wiki, waiting, http, warmed, host };
  }
  it("asks the host to start each approved package-run server once, and no other server", async () => {
    const { w, wiki, waiting, http, warmed, host } = await setup();
    const asked = await prewarmStdioServers({ host, servers: w.deps.store, stdioEnabled: true }, ORG, [wiki.serverId, wiki.serverId, waiting.serverId, http.serverId, "mcpnothere0001"]);
    expect(asked).toBe(1);
    expect(warmed).toEqual([wiki.serverId]);
  });
  it("waits, for a short bound, until the host has accepted each request (so a function that is frozen as soon as it returns has sent them), and no longer", async () => {
    const { w, wiki } = await setup();
    const log: string[] = [];
    const slow: Pick<McpHostControl, "warm"> = { warm: async (id) => { log.push(`start:${id}`); await new Promise((resolve) => setTimeout(resolve, 30)); log.push(`accepted:${id}`); } };
    const asked = await prewarmStdioServers({ host: slow, servers: w.deps.store, stdioEnabled: true, waitMs: 1_000 }, ORG, [wiki.serverId]);
    expect(asked).toBe(1);
    expect(log).toEqual([`start:${wiki.serverId}`, `accepted:${wiki.serverId}`]);
    // a host that never answers holds the stage for the bound and not a moment longer
    const hanging: Pick<McpHostControl, "warm"> = { warm: () => new Promise<void>(() => undefined) };
    const began = Date.now();
    expect(await prewarmStdioServers({ host: hanging, servers: w.deps.store, stdioEnabled: true, waitMs: 60 }, ORG, [wiki.serverId])).toBe(1);
    const took = Date.now() - began;
    expect(took).toBeGreaterThanOrEqual(50);
    expect(took).toBeLessThan(1_000);
  });
  it("the requests go out together, not one after another, and the default bound is 2 seconds", async () => {
    const { w, wiki } = await setup();
    const second = await proposeMcpServer(w.deps, admin, { label: "Wiki 3", transport: PKG, secrets: SECRETS });
    await approveMcpServer(w.deps, admin, second.serverId);
    let inFlight = 0;
    let peak = 0;
    const host: Pick<McpHostControl, "warm"> = { warm: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((resolve) => setTimeout(resolve, 20)); inFlight -= 1; } };
    await prewarmStdioServers({ host, servers: w.deps.store, stdioEnabled: true }, ORG, [wiki.serverId, second.serverId]);
    expect(peak).toBe(2);
    const source = await (await import("node:fs/promises")).readFile("packages/core/src/context-sources/server-port.ts", "utf8");
    expect(source).toContain("deps.waitMs ?? 2_000");
  });
  it("never throws and never waits for long: a host that fails or hangs, and a registry that fails, are not the stage's problem; at most 16 are asked", async () => {
    const { w, wiki } = await setup();
    const hanging: Pick<McpHostControl, "warm"> = { warm: () => new Promise<void>(() => undefined) };
    expect(await prewarmStdioServers({ host: hanging, servers: w.deps.store, stdioEnabled: true, waitMs: 20 }, ORG, [wiki.serverId])).toBe(1);
    const failing: Pick<McpHostControl, "warm"> = { warm: async () => { throw new Error("down"); } };
    expect(await prewarmStdioServers({ host: failing, servers: w.deps.store, stdioEnabled: true }, ORG, [wiki.serverId])).toBe(1);
    expect(await prewarmStdioServers({ host: failing, servers: { get: async () => { throw new Error("table down"); } }, stdioEnabled: true }, ORG, [wiki.serverId])).toBe(0);
    let looked = 0;
    const many = Array.from({ length: 40 }, (_, index) => `mcpmany${String(index).padStart(6, "0")}`);
    await prewarmStdioServers({ host: failing, servers: { get: async () => { looked += 1; return undefined; } }, stdioEnabled: true }, ORG, many);
    expect(looked).toBe(16);
  });
});

describe("the route", () => {
  const caller = { orgId: ORG, developerId: "dev1", orgRole: "admin" } as never;
  it("accepts secrets by name, answers without any value, and refuses a body field it does not know", async () => {
    const w = world();
    const reply = await routeMcpServers(w.deps, caller, { method: "POST", path: "/v1/app/org/mcp-servers", headers: {}, requestId: "r", body: JSON.stringify({ label: "Wiki", transport: PKG, secrets: SECRETS }) }, new URL("https://example.test/"));
    const text = JSON.stringify(reply);
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
    expect(text).toContain("NEEDS_APPROVAL");
    expect(text).not.toContain("secretVersion");
    await expect(routeMcpServers(w.deps, caller, { method: "POST", path: "/v1/app/org/mcp-servers", headers: {}, requestId: "r", body: JSON.stringify({ label: "Wiki", transport: PKG, secrets: SECRETS, extra: "s3cret-leak" }) }, new URL("https://example.test/"))).rejects.toThrow(/field this route does not take/u);
    const listed = JSON.stringify(await routeMcpServers(w.deps, caller, { method: "GET", path: "/v1/app/org/mcp-servers", headers: {}, requestId: "r" }, new URL("https://example.test/")));
    for (const value of Object.values(SECRETS)) expect(listed).not.toContain(value);
    expect(listed).toContain("packageCount");
  });
});

describe("the host is wired only where package-run servers are on", () => {
  const common = (over: { stdioEnabled?: boolean; mcpHost?: { url: string; token: string } }) => ({
    store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }), now: () => NOW, requireAuthority: async () => undefined, connections: { read: async () => undefined, token: async () => undefined },
    serverSecrets: { put: async () => "v", read: async () => undefined, remove: async () => undefined }, stdioEnabled: over.stdioEnabled, mcpHost: over.mcpHost,
  });
  const HOST = { url: "https://mcp-host.internal:8080", token: "h".repeat(40) };
  it("gives the admin flow a host to release, and the runtime a way to prewarm, when the install runs package-run servers", () => {
    expect(createMcpServerDependencies(common({ stdioEnabled: true, mcpHost: HOST })).host).toBeDefined();
    expect(createContextSourcesRuntime(common({ stdioEnabled: true, mcpHost: HOST })).prewarm).toBeDefined();
  });
  it("gives neither with the switch off or without a host", () => {
    for (const over of [{ stdioEnabled: false, mcpHost: HOST }, { stdioEnabled: true }, {}]) {
      expect(createMcpServerDependencies(common(over)).host, JSON.stringify(over)).toBeUndefined();
      expect(createContextSourcesRuntime(common(over)).prewarm, JSON.stringify(over)).toBeUndefined();
    }
  });
});

// Stdio MCP host redesign, task T1: the new approval-binding fields on a package-run server, the env name rules, and the `needs_reapproval` status for entries that
// were stored before those fields existed.
import { describe, expect, it } from "vitest";
import {
  MCP_SERVER_STATUSES, McpServerEntrySchema, McpServerStatusSchema, McpStdioProposalSchema, McpStdioSpecSchema, mcpSecretEnvNameProblem, readStoredMcpServerEntry, stdioSpecIfComplete,
} from "@agentx/contracts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const base = { registry: "npm" as const, name: "@acme/sim-mcp", version: "1.4.2", args: [], integrity: INTEGRITY };
const full = { ...base, lockfileHash: HASH_A, bundleHash: HASH_B, destinations: [{ host: "jira.corp.example", port: 443 }], secretEnv: ["JIRA_TOKEN"], size: { cpu: 256, memoryMiB: 512 } };
const entryOver = (over: Record<string, unknown>) => ({
  serverId: "mcpabc123456", label: "Wiki", status: "approved", transport: { kind: "stdio", spec: full }, probe: { at: "2026-11-01T10:00:00Z", toolsHash: HASH_A, tools: [] },
  requestedBy: "dev1", requestedAt: "2026-11-01T10:00:00Z", ...over,
});

describe("T1: the stdio spec binds the install, the destinations, the secret names and the size", () => {
  it("accepts a complete spec and fills the defaults for the optional fields (no destinations, no secrets, the smallest size)", () => {
    expect(McpStdioSpecSchema.parse(full)).toEqual(full);
    const minimal = McpStdioSpecSchema.parse({ ...base, lockfileHash: HASH_A, bundleHash: HASH_B });
    expect(minimal).toMatchObject({ destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } });
  });
  it("requires both hashes, as 64 lower-case hex characters", () => {
    expect(McpStdioSpecSchema.safeParse(base).success).toBe(false);
    expect(McpStdioSpecSchema.safeParse({ ...base, lockfileHash: HASH_A }).success).toBe(false);
    expect(McpStdioSpecSchema.safeParse({ ...base, bundleHash: HASH_B }).success).toBe(false);
    for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), `sha256-${"a".repeat(64)}`, ""]) {
      expect(McpStdioSpecSchema.safeParse({ ...full, bundleHash: bad }).success, bad).toBe(false);
      expect(McpStdioSpecSchema.safeParse({ ...full, lockfileHash: bad }).success, bad).toBe(false);
    }
  });
  it("keeps the integrity required in a stored spec and refuses unknown fields", () => {
    const without: Record<string, unknown> = { ...full };
    delete without.integrity;
    expect(McpStdioSpecSchema.safeParse(without).success).toBe(false);
    expect(McpStdioSpecSchema.safeParse({ ...full, extra: 1 }).success).toBe(false);
  });
  it("allows at most 8 destinations, each a plain host name or IPv4 address with a port from 1 to 65535", () => {
    const hosts = (count: number) => Array.from({ length: count }, (_, index) => ({ host: `h${index}.corp.example`, port: 443 }));
    expect(McpStdioSpecSchema.safeParse({ ...full, destinations: hosts(8) }).success).toBe(true);
    expect(McpStdioSpecSchema.safeParse({ ...full, destinations: hosts(9) }).success).toBe(false);
    expect(McpStdioSpecSchema.safeParse({ ...full, destinations: [{ host: "10.1.2.3", port: 8443 }] }).success).toBe(true);
    for (const host of ["https://a.example", "a.example/path", "user@a.example", "a.example:443", "*.example", "a b.example", "", "-a.example", "a..example", "a.example.", "A.EXAMPLE", "[::1]", "x".repeat(254)]) {
      expect(McpStdioSpecSchema.safeParse({ ...full, destinations: [{ host, port: 443 }] }).success, host).toBe(false);
    }
    for (const port of [0, 65536, -1, 1.5, "443"]) expect(McpStdioSpecSchema.safeParse({ ...full, destinations: [{ host: "a.example", port }] }).success, String(port)).toBe(false);
  });
  it("refuses the same destination twice (it would hide a changed address behind a repeat)", () => {
    expect(McpStdioSpecSchema.safeParse({ ...full, destinations: [{ host: "a.example", port: 443 }, { host: "a.example", port: 443 }] }).success).toBe(false);
    expect(McpStdioSpecSchema.safeParse({ ...full, destinations: [{ host: "a.example", port: 443 }, { host: "a.example", port: 8443 }] }).success).toBe(true);
  });
  it("takes only task sizes Fargate offers, up to 1 vCPU and 2 GiB", () => {
    for (const [cpu, memoryMiB] of [[256, 512], [256, 1024], [256, 2048], [512, 1024], [512, 2048], [1024, 2048]] as const) {
      expect(McpStdioSpecSchema.safeParse({ ...full, size: { cpu, memoryMiB } }).success, `${cpu}/${memoryMiB}`).toBe(true);
    }
    for (const size of [{ cpu: 512, memoryMiB: 512 }, { cpu: 1024, memoryMiB: 512 }, { cpu: 1024, memoryMiB: 1024 }, { cpu: 2048, memoryMiB: 4096 }, { cpu: 256, memoryMiB: 4096 }, { cpu: 256 }, { cpu: 100, memoryMiB: 512 }]) {
      expect(McpStdioSpecSchema.safeParse({ ...full, size }).success, JSON.stringify(size)).toBe(false);
    }
  });
  it("does not let an admin type the hashes: a proposal has the integrity optional and no lockfileHash or bundleHash (the install computes them)", () => {
    expect(McpStdioProposalSchema.safeParse({ registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [] }).success).toBe(true);
    expect(McpStdioProposalSchema.safeParse({ ...base, destinations: full.destinations, secretEnv: full.secretEnv }).success).toBe(true);
    expect(McpStdioProposalSchema.safeParse({ ...base, bundleHash: HASH_B }).success).toBe(false);
    expect(McpStdioProposalSchema.safeParse({ ...base, lockfileHash: HASH_A }).success).toBe(false);
  });
});

describe("T1: env names a package-run server may be given", () => {
  it("accepts upper-case names of 2 to 64 characters", () => {
    for (const name of ["JIRA_TOKEN", "AB", "X1_2", "A".repeat(64)]) expect(mcpSecretEnvNameProblem(name), name).toBeUndefined();
    expect(McpStdioSpecSchema.safeParse({ ...full, secretEnv: ["JIRA_TOKEN", "WIKI_KEY"] }).success).toBe(true);
  });
  it("refuses the wrong shape", () => {
    for (const name of ["", "A", "a_b", "1ABC", "_ABC", "AB-C", "AB C", "AB=C", "A".repeat(65), "TOKEN\n", "TÖKEN"]) expect(mcpSecretEnvNameProblem(name), name).toBeDefined();
  });
  it("refuses the names that change how the program starts or reach the cloud (the design's list, and the dangerous neighbours of each)", () => {
    const denied = [
      "PATH", "HOME", "NODE_OPTIONS", "NODE_PATH", "TMPDIR", "SHELL", "LD_PRELOAD", "LD_LIBRARY_PATH", "AWS_ACCESS_KEY_ID", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_REGION",
      "ECS_CONTAINER_METADATA_URI_V4", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "DYLD_INSERT_LIBRARIES", "NPM_CONFIG_REGISTRY", "BASH_ENV", "IFS", "TMP", "TEMP", "USER", "PWD",
      "GLIBC_TUNABLES", "MALLOC_ARENA_MAX", "MALLOC_CONF", "RES_OPTIONS", "LOCALDOMAIN", "HOSTALIASES", "NLSPATH", "LOCPATH", "GCONV_PATH", "RES_RETRY", "OPENSSL_CONF", "OPENSSL_MODULES", "UV_THREADPOOL_SIZE", "UV_USE_IO_URING", "TZ", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "MCP_RUNNER_TOKEN", "ROVARA_ORG_ID",
    ];
    for (const name of denied) {
      expect(mcpSecretEnvNameProblem(name), name).toBeDefined();
      expect(McpStdioSpecSchema.safeParse({ ...full, secretEnv: [name] }).success, name).toBe(false);
    }
  });
  it("allows at most 8 names and no repeats", () => {
    const names = (count: number) => Array.from({ length: count }, (_, index) => `SECRET_${index}`);
    expect(McpStdioSpecSchema.safeParse({ ...full, secretEnv: names(8) }).success).toBe(true);
    expect(McpStdioSpecSchema.safeParse({ ...full, secretEnv: names(9) }).success).toBe(false);
    expect(McpStdioSpecSchema.safeParse({ ...full, secretEnv: ["A_B", "A_B"] }).success).toBe(false);
  });
});

describe("T1: entries stored before the new fields", () => {
  it("has a needs_reapproval status", () => {
    expect(MCP_SERVER_STATUSES).toContain("needs_reapproval");
    expect(McpServerStatusSchema.parse("needs_reapproval")).toBe("needs_reapproval");
  });
  it("reads a legacy approved or waiting stdio entry (no hashes) as needs_reapproval instead of throwing, whatever its status said", () => {
    const legacy = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], integrity: INTEGRITY };
    for (const status of ["approved", "awaiting_approval"]) {
      const read = readStoredMcpServerEntry(entryOver({ status, transport: { kind: "stdio", spec: legacy }, decidedBy: "dev2", decidedAt: "2026-11-01T11:00:00Z" }));
      expect(read, status).toMatchObject({ status: "needs_reapproval", serverId: "mcpabc123456", transport: { kind: "stdio", spec: { name: "@acme/sim-mcp", destinations: [], secretEnv: [] } } });
    }
    // one hash but not the other is just as incomplete
    expect(readStoredMcpServerEntry(entryOver({ transport: { kind: "stdio", spec: { ...legacy, lockfileHash: HASH_A } } }))?.status).toBe("needs_reapproval");
    expect(readStoredMcpServerEntry(entryOver({ transport: { kind: "stdio", spec: { ...legacy, bundleHash: HASH_B } } }))?.status).toBe("needs_reapproval");
  });
  it("never turns a legacy entry into an approved one: a disabled one stays disabled and a needs_reapproval one stays so", () => {
    const legacy = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], integrity: INTEGRITY };
    expect(readStoredMcpServerEntry(entryOver({ status: "disabled", transport: { kind: "stdio", spec: legacy } }))?.status).toBe("disabled");
    expect(readStoredMcpServerEntry(entryOver({ status: "needs_reapproval", transport: { kind: "stdio", spec: legacy } }))?.status).toBe("needs_reapproval");
  });
  it("reads a complete entry as it is, and an http entry untouched", () => {
    expect(readStoredMcpServerEntry(entryOver({}))).toMatchObject({ status: "approved", transport: { kind: "stdio", spec: full } });
    const http = entryOver({ transport: { kind: "http", address: "https://sim.corp.example/mcp" } });
    expect(readStoredMcpServerEntry(http)).toMatchObject({ status: "approved", transport: { kind: "http" } });
  });
  it("returns nothing for an item that is malformed in any other way (it is not served)", () => {
    expect(readStoredMcpServerEntry(undefined)).toBeUndefined();
    expect(readStoredMcpServerEntry("x")).toBeUndefined();
    expect(readStoredMcpServerEntry(entryOver({ transport: { kind: "stdio", spec: { ...full, bundleHash: "nope" } } }))).toBeUndefined();
    expect(readStoredMcpServerEntry(entryOver({ transport: { kind: "stdio", spec: { ...full, secretEnv: ["PATH"] } } }))).toBeUndefined();
    expect(readStoredMcpServerEntry(entryOver({ status: "bogus" }))).toBeUndefined();
  });
  it("the strict schema refuses an approved or waiting stdio entry without both hashes: a writer cannot store an incomplete approval", () => {
    const legacy = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], integrity: INTEGRITY };
    for (const status of ["approved", "awaiting_approval"]) expect(McpServerEntrySchema.safeParse(entryOver({ status, transport: { kind: "stdio", spec: legacy } })).success, status).toBe(false);
    expect(McpServerEntrySchema.safeParse(entryOver({ status: "needs_reapproval", transport: { kind: "stdio", spec: legacy } })).success).toBe(true);
    expect(McpServerEntrySchema.safeParse(entryOver({ status: "disabled", transport: { kind: "stdio", spec: legacy } })).success).toBe(true);
    expect(McpServerEntrySchema.safeParse(entryOver({})).success).toBe(true);
  });
  it("stdioSpecIfComplete gives the full spec only for an approved or waiting entry, never for a needs_reapproval or disabled one", () => {
    const parsed = McpServerEntrySchema.parse(entryOver({}));
    expect(stdioSpecIfComplete(parsed)).toEqual(full);
    const legacy = readStoredMcpServerEntry(entryOver({ transport: { kind: "stdio", spec: base } }))!;
    expect(stdioSpecIfComplete(legacy)).toBeUndefined();
    expect(stdioSpecIfComplete({ ...parsed, status: "needs_reapproval" })).toBeUndefined();
    expect(stdioSpecIfComplete({ ...parsed, status: "disabled" })).toBeUndefined();
    expect(stdioSpecIfComplete({ ...parsed, transport: { kind: "http", address: "https://sim.corp.example/mcp" } })).toBeUndefined();
  });
});

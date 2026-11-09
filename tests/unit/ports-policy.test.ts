// Port lane W0: Code's defaults for the policy seams and the model key stores pass the shared conformance suites.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MeterEntry, ModelUsage, PriceTable } from "@agentx/contracts";
import {
  CODE_HOST_COMMENT_METHOD,
  LOCAL_SESSION_METHOD,
  LOCAL_SESSION_SCHEME,
  createAllowAllAdmission,
  createLocalOwnerApprovers,
  createLocalOwnerIdentity,
  createNoopAuditSink,
  createPriceTableMetering,
  localOwnerPrincipal,
} from "../../packages/broker/src/ports/policy-defaults.js";
import { createEnvironmentModelKeyStore, createFileModelKeyStore, createLayeredModelKeyStore, createMemoryModelKeyStore, environmentVariableFor } from "../../packages/broker/src/ports/model-key-stores.js";
import { runAdmissionConformance, runApproversConformance, runAuditSinkConformance, runIdentityConformance, runMeteringConformance, runModelKeyStoreConformance } from "../support/ports/policy-conformance.js";

const owner = localOwnerPrincipal();
const SESSION = ["session", "value", "for", "tests"].join("-");

runAdmissionConformance("Code default (allow all)", {
  create: async () => createAllowAllAdmission(),
  admissible: { companyId: owner.companyId, action: "task.start", projectName: "web" },
});

runAuditSinkConformance("Code default (writes nothing)", { create: async () => createNoopAuditSink() });

runApproversConformance("Code default (local owner)", {
  create: async () => createLocalOwnerApprovers({ owner }),
  request: { companyId: owner.companyId, kind: "plan", subject: { type: "task", id: "t1" }, revision: 2, artifactDigest: "a".repeat(64) },
  acceptable: { method: LOCAL_SESSION_METHOD, principal: owner, evidence: { session: "s1" } },
});

runApproversConformance("Code default (repository collaborator by comment)", {
  create: async () => createLocalOwnerApprovers({ owner, isCollaborator: (account) => account.accountId === "collab" }),
  request: { companyId: owner.companyId, kind: "design", subject: { type: "task", id: "t1" } },
  acceptable: { method: CODE_HOST_COMMENT_METHOD, account: { provider: "any-code-host", tenant: "", accountId: "collab" }, evidence: { commentId: "c1" } },
});

runIdentityConformance("Code default (local owner)", {
  create: async () => createLocalOwnerIdentity({ isValidSession: (value) => value === SESSION, linkedAccounts: [{ provider: "any-tracker", tenant: "ws", accountId: "owner-account" }] }),
  valid: { credential: { scheme: LOCAL_SESSION_SCHEME, value: SESSION }, principal: { companyId: owner.companyId, personId: owner.personId } },
  linkedAccount: { provider: "any-tracker", tenant: "ws", accountId: "owner-account" },
});

const table: PriceTable = { currency: "USD", models: { "anthropic/model-a": { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 300_000 } } };
const known: ModelUsage = { provider: "anthropic", modelId: "model-a", tokens: { input: 1_000, output: 500, cacheRead: 2_000, cacheWrite: 0 } };
const entryOf = (usage: ModelUsage): MeterEntry => ({ companyId: owner.companyId, at: "2026-11-09T10:00:00.000Z", usage, taskId: "t1" });

runMeteringConformance("Code default (tokens times a price table)", {
  create: async () => createPriceTableMetering(table),
  known,
  unknown: { provider: "other", modelId: "model-z", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  entry: entryOf,
});

runModelKeyStoreConformance("memory", { create: async (keys) => createMemoryModelKeyStore(keys) });
runModelKeyStoreConformance("environment", {
  create: async (keys) => createEnvironmentModelKeyStore(Object.fromEntries(Object.entries(keys).map(([provider, key]) => [environmentVariableFor(provider), key])), Object.keys(keys)),
});
runModelKeyStoreConformance("local file", {
  async create(keys) {
    const directory = await mkdtemp(join(tmpdir(), "model-keys-"));
    const path = join(directory, "keys.json");
    await writeFile(path, JSON.stringify(keys));
    await chmod(path, 0o600);
    return createFileModelKeyStore(path);
  },
});

describe("Code defaults", () => {
  it("prices tokens times the table", async () => {
    // 1000 input at 3.00 per million, 500 output at 15.00, 2000 cache-read at 0.30 = 0.003 + 0.0075 + 0.0006 dollars
    expect(await createPriceTableMetering(table).price(known)).toEqual({ micros: 11_100, currency: "USD" });
  });

  it("tells the recorder about each priced entry", async () => {
    const seen: string[] = [];
    await createPriceTableMetering(table, (entry, result) => void seen.push(`${entry.taskId}:${result.source}`)).record(entryOf(known));
    expect(seen).toEqual(["t1:price-table"]);
  });

  it("lets the owner approve on their own request, and a stranger not at all", async () => {
    const approvers = createLocalOwnerApprovers({ owner });
    const request = { companyId: owner.companyId, kind: "merge", subject: { type: "task", id: "t" }, requestedBy: owner };
    expect((await approvers.requirement(request)).selfApprovalAllowed).toBe(true);
    expect((await approvers.verify(request, { method: LOCAL_SESSION_METHOD, principal: { ...owner, personId: "someone-else" }, evidence: {} })).approved).toBe(false);
    expect((await approvers.verify(request, { method: CODE_HOST_COMMENT_METHOD, account: { provider: "p", tenant: "", accountId: "x" }, evidence: {} })).approved).toBe(false);
  });

  it("refuses a comment from someone who is not a collaborator", async () => {
    const approvers = createLocalOwnerApprovers({ owner, isCollaborator: () => false });
    const verdict = await approvers.verify({ companyId: owner.companyId, kind: "design", subject: { type: "task", id: "t" } }, { method: CODE_HOST_COMMENT_METHOD, account: { provider: "p", tenant: "", accountId: "x" }, evidence: {} });
    expect(verdict).toEqual({ approved: false, reason: "not_a_collaborator" });
  });

  it("refuses a local session when no session check is configured", async () => {
    expect((await createLocalOwnerIdentity().authenticate({ scheme: LOCAL_SESSION_SCHEME, value: SESSION })).ok).toBe(false);
  });
});

describe("model key stores", () => {
  it("reads the key from an environment variable named for the provider", async () => {
    expect(environmentVariableFor("open-router")).toBe("OPEN_ROUTER_API_KEY");
    const store = createEnvironmentModelKeyStore({ ANTHROPIC_API_KEY: "  spaced  ", OPENAI_API_KEY: "" }, ["anthropic", "openai"]);
    expect((await store.get("anthropic"))?.reveal()).toBe("spaced");
    expect(await store.get("openai")).toBeUndefined();
    expect(await store.providers()).toEqual(["anthropic"]);
  });

  it("refuses a key file other users can read, and treats a missing file as no keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-keys-"));
    try {
      const path = join(directory, "keys.json");
      expect(await createFileModelKeyStore(path).providers()).toEqual([]);
      await writeFile(path, JSON.stringify({ anthropic: "k" }));
      await chmod(path, 0o644);
      await expect(createFileModelKeyStore(path).get("anthropic")).rejects.toThrow(/readable by other users/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tries the environment before the file when layered in that order", async () => {
    const store = createLayeredModelKeyStore([createMemoryModelKeyStore({ anthropic: "from-env" }), createMemoryModelKeyStore({ anthropic: "from-file", openai: "o" })]);
    expect((await store.get("anthropic"))?.reveal()).toBe("from-env");
    expect((await store.get("openai"))?.reveal()).toBe("o");
    expect(await store.providers()).toEqual(["anthropic", "openai"]);
  });
});

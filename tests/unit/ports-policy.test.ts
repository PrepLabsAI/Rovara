// Port lane W0: Code's defaults for the policy seams and the model key stores pass the shared conformance suites.
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
import { commentReads, freshComment } from "../support/comment-fakes.js";

const owner = localOwnerPrincipal();

runAdmissionConformance("Code default (allow all)", {
  create: async () => createAllowAllAdmission(),
  admissible: { companyId: owner.companyId, idempotencyKey: "k", action: "task.start", projectName: "web" },
  enforcesCost: false,
});

runAuditSinkConformance("Code default (writes nothing)", { create: async () => createNoopAuditSink() });

const SESSION_TOKEN = ["session", "value", "for", "tests"].join("-");
const COMMENT_ID = "comment-77";
const REQUEST = { companyId: owner.companyId, requestId: "req-1", kind: "plan", subject: { type: "task", id: "t1" }, projectName: "web", revision: 2, artifactDigest: "a".repeat(64) };
const COLLABORATOR = { provider: "any-code-host", tenant: "", accountId: "collab" };

runApproversConformance("Code default (local owner session)", {
  create: async () => createLocalOwnerApprovers({ owner, verifySession: (token) => token === SESSION_TOKEN }),
  request: REQUEST,
  acceptable: { proofId: "p", method: LOCAL_SESSION_METHOD, requestId: REQUEST.requestId, revision: REQUEST.revision, artifactDigest: REQUEST.artifactDigest, token: SESSION_TOKEN },
  forgedToken: "guessed-session",
});

const commentChecks = commentReads(freshComment(COLLABORATOR), { id: COMMENT_ID });
runApproversConformance("Code default (repository collaborator by comment)", {
  create: async () => createLocalOwnerApprovers({ owner, ...commentChecks }),
  request: REQUEST,
  acceptable: { proofId: "p", method: CODE_HOST_COMMENT_METHOD, requestId: REQUEST.requestId, revision: REQUEST.revision, artifactDigest: REQUEST.artifactDigest, token: COMMENT_ID, claimedAccount: COLLABORATOR },
  forgedToken: "comment-that-does-not-exist",
});

runIdentityConformance("Code default (local owner)", {
  create: async () => createLocalOwnerIdentity({ isValidSession: (value) => value === SESSION_TOKEN, linkedAccounts: [{ provider: "any-tracker", tenant: "ws", accountId: "owner-account" }] }),
  valid: { credential: { scheme: LOCAL_SESSION_SCHEME, value: SESSION_TOKEN }, principal: { companyId: owner.companyId, personId: owner.personId } },
  linkedAccount: { provider: "any-tracker", tenant: "ws", accountId: "owner-account" },
});

const table: PriceTable = { currency: "USD", models: { "anthropic/model-a": { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 300_000 } } };
const known: ModelUsage = { provider: "anthropic", modelId: "model-a", tokens: { input: 1_000, output: 500, cacheRead: 2_000, cacheWrite: 0 } };
const entryOf = (usage: ModelUsage): MeterEntry => ({ companyId: owner.companyId, entryId: "e1", at: "2026-11-09T10:00:00.000Z", usage, taskId: "t1" });

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
const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

runModelKeyStoreConformance("local file", {
  async create(keys) {
    const directory = await mkdtemp(join(tmpdir(), "model-keys-"));
    directories.push(directory);
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
    const approvers = createLocalOwnerApprovers({ owner, verifySession: (token) => token === SESSION_TOKEN });
    const request = { ...REQUEST, requestedBy: owner };
    const proof = { proofId: "p1", method: LOCAL_SESSION_METHOD, requestId: REQUEST.requestId, revision: REQUEST.revision, artifactDigest: REQUEST.artifactDigest, token: SESSION_TOKEN };
    expect((await approvers.requirement(request)).selfApprovalAllowed).toBe(true);
    expect((await approvers.verify(request, { ...proof, token: "someone-else" })).approved).toBe(false);
    expect((await approvers.verify(request, { ...proof, method: CODE_HOST_COMMENT_METHOD })).approved).toBe(false);
    expect((await approvers.verify(request, proof)).approved).toBe(true);
  });

  it("refuses a comment from a read-only collaborator, a comment that does not approve, and a mismatched account", async () => {
    const proof = { proofId: "p", method: CODE_HOST_COMMENT_METHOD, requestId: REQUEST.requestId, revision: REQUEST.revision, artifactDigest: REQUEST.artifactDigest, token: "c" };
    const lookup = (permission: "read" | "write", approves = true) => createLocalOwnerApprovers({ owner, ...commentReads(freshComment(COLLABORATOR, { permission, ...(approves ? {} : { body: "looks fine to me" }) })) });
    expect(await lookup("read").verify(REQUEST, proof)).toEqual({ approved: false, reason: "not_a_collaborator" });
    expect(await lookup("write", false).verify(REQUEST, { ...proof, proofId: "q" })).toEqual({ approved: false, reason: "no_approving_comment" });
    expect(await lookup("write").verify(REQUEST, { ...proof, proofId: "r", claimedAccount: { ...COLLABORATOR, accountId: "someone-else" } })).toEqual({ approved: false, reason: "account_mismatch" });
  });

  it("names the approving collaborator under their own provider, not the local owner's", async () => {
    const verdict = await createLocalOwnerApprovers({ owner, ...commentChecks }).verify(REQUEST, { proofId: "p", method: CODE_HOST_COMMENT_METHOD, requestId: REQUEST.requestId, revision: REQUEST.revision, artifactDigest: REQUEST.artifactDigest, token: COMMENT_ID });
    expect(verdict.approved && verdict.approver.provider).toBe("any-code-host");
  });

  it("refuses a local session when no session check is configured", async () => {
    expect((await createLocalOwnerIdentity().authenticate({ scheme: LOCAL_SESSION_SCHEME, value: SESSION_TOKEN })).ok).toBe(false);
  });
});

const CO = "org_aaaaaaaaaaaaaaaaaaaa";

describe("model key stores", () => {
  it("reads the key from an environment variable named for the provider", async () => {
    expect(environmentVariableFor("open-router")).toBe("OPEN_ROUTER_API_KEY");
    const store = createEnvironmentModelKeyStore({ ANTHROPIC_API_KEY: "  spaced  ", OPENAI_API_KEY: "" }, ["anthropic", "openai"]);
    expect((await store.get(CO, "anthropic"))?.reveal()).toBe("spaced");
    expect(await store.get(CO, "openai")).toBeUndefined();
    expect(await store.providers(CO)).toEqual(["anthropic"]);
  });

  it("refuses a key file other users can read, and treats a missing file as no keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-keys-"));
    try {
      const path = join(directory, "keys.json");
      expect(await createFileModelKeyStore(path).providers(CO)).toEqual([]);
      await writeFile(path, JSON.stringify({ anthropic: "k" }));
      await chmod(path, 0o644);
      await expect(createFileModelKeyStore(path).get(CO, "anthropic")).rejects.toThrow(/readable by other users/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("says nothing about a malformed key file's content, and refuses a link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-keys-"));
    directories.push(directory);
    const path = join(directory, "keys.json");
    const leaky = ["sk", "ant", "SECRET"].join("-");
    await writeFile(path, `{"anthropic": ${leaky}`);
    await chmod(path, 0o600);
    const error = await createFileModelKeyStore(path).get(CO, "anthropic").catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("the model key file is not valid JSON");
    expect((error as Error).message).not.toContain(leaky);
    const link = join(directory, "link.json");
    await symlink(path, link);
    await expect(createFileModelKeyStore(link).get(CO, "anthropic")).rejects.toThrow(/plain file/);
  });

  it("tries the environment before the file when layered in that order", async () => {
    const store = createLayeredModelKeyStore([createMemoryModelKeyStore({ anthropic: "from-env" }), createMemoryModelKeyStore({ anthropic: "from-file", openai: "o" })]);
    expect((await store.get(CO, "anthropic"))?.reveal()).toBe("from-env");
    expect((await store.get(CO, "openai"))?.reveal()).toBe("o");
    expect(await store.providers(CO)).toEqual(["anthropic", "openai"]);
  });
});
